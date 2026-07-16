import { RequestHandler, Router } from "express";
import { GoogleAuthService } from "./google-auth.service";
import { NotAuthenticatedError, UserDisabledError, ValidationError } from "../../shared/http/pipeline-errors";
import { UserStore, spreadsheetUrlFor } from "../../shared/store/user-store";
import { SessionStore } from "../../shared/store/session-store";
import { SheetsProvisioner } from "../../shared/sheets/sheets-provisioner";
import { AuditLogger } from "../../shared/audit/audit-logger";
import { Metrics } from "../../shared/observability/metrics";
import {
  PENDING_COOKIE_NAME,
  clearPendingCookie,
  clearSessionCookie,
  fingerprint,
  readSignedCookie,
  setPendingCookie,
  setSessionCookie,
} from "../../shared/http/session";

/** Where the browser lands after a successful sign-in. */
const FRONTEND_POST_LOGIN_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

export interface GoogleAuthRouterDeps {
  service: GoogleAuthService;
  userStore: UserStore;
  sessionStore: SessionStore;
  provisioner: SheetsProvisioner;
  audit: AuditLogger;
  metrics: Metrics;
  spreadsheetTitle: string;
  /** Applied to the OAuth start/callback routes. */
  oauthLimiter: RequestHandler;
  /** Applied to the Session Conflict resolution routes. */
  sessionLimiter: RequestHandler;
}

/**
 * Auth router. Drives sign-in/callback/status/logout, the Session Conflict flow
 * (single active session), and on first sign-in provisions the user's own
 * spreadsheet via the injected SheetsProvisioner (so this module never imports
 * the google-sheets module). `spreadsheetTitle` is passed in for the same
 * reason — /status echoes it back without importing google-sheets.service.
 */
export function createGoogleAuthRouter(deps: GoogleAuthRouterDeps): Router {
  const {
    service,
    userStore,
    sessionStore,
    provisioner,
    audit,
    metrics,
    spreadsheetTitle,
    oauthLimiter,
    sessionLimiter,
  } = deps;
  const router = Router();

  // GET /api/auth/google — start (or re-)consent. Reused for Reconnect.
  router.get("/auth/google", oauthLimiter, (_req, res) => {
    res.redirect(service.buildConsentUrl());
  });

  // GET /api/auth/google/callback — exchange code, persist user, then either
  // create the session or stage a Pending Session if one already exists.
  router.get("/auth/google/callback", oauthLimiter, async (req, res, next) => {
    try {
      const code = req.query.code;
      if (typeof code !== "string") {
        throw new ValidationError("Missing OAuth authorization code");
      }

      const identity = await service.handleCallback(code);

      /**
       * Tokens are persisted BEFORE the Session Conflict check, and
       * unconditionally. The OAuth authorization code is single-use and
       * short-lived: we cannot re-exchange it after the user clicks Continue,
       * so the tokens must land now or be lost.
       *
       * This is safe. Possessing tokens is not being signed in — nothing can
       * act as this user until a row exists in `sessions`, and the conflict
       * branch below deliberately does not create one.
       */
      const user = await userStore.upsertOnLogin({
        googleUserId: identity.googleUserId,
        email: identity.email,
        ...identity.tokens,
      });

      // Admin User Management: block a disabled user before any session work.
      // Checked before the Session Conflict branch so a disabled account's
      // existing session (if a background force-logout raced) is never
      // replaced/extended, and the pending-session flow is never entered.
      if (user.disabledAt) {
        const fp = fingerprint(req);
        audit.log({ event: "auth_failure", reason: "user_disabled", googleUserId: user.googleUserId, ...fp });
        metrics.inc("auth_failure", { reason: "user_disabled" });
        throw new UserDisabledError();
      }

      // A user who already has a sheet is re-consenting (Reconnect), not
      // signing in for the first time.
      const isReconnect = user.spreadsheetId !== null;

      if (!user.spreadsheetId) {
        const authClient = service.authClientForUser(
          {
            accessToken: user.accessToken,
            refreshToken: user.refreshToken,
            tokenExpiry: user.tokenExpiry,
          },
          (t) => {
            // See the M5 router: post-cutover encode() can throw, and an
            // unhandled rejection here could take the process down.
            void userStore
              .updateTokens(user.googleUserId, t)
              .catch((err) =>
                console.error("[auth] failed to persist refreshed tokens", err)
              );
          }
        );
        await provisioner.ensureSpreadsheet(user, authClient);
      }

      const fp = fingerprint(req);
      const existing = await sessionStore.findActiveForUser(user.googleUserId);

      if (existing) {
        // Single active session: stage the new session and let the user decide.
        // We do NOT revoke the old one yet — if they cancel, the device they
        // are still holding must keep working.
        const pending = await sessionStore.createPending(user.googleUserId, fp);
        setPendingCookie(res, pending.id);
        audit.log({
          event: "session_conflict",
          googleUserId: user.googleUserId,
          ...fp,
        });

        /**
         * The other device's details ride in the query string purely so the
         * page can render "Chrome on macOS, last active 3m ago". They are NOT
         * trusted for any decision — Continue re-reads the pending cookie
         * server-side. No IP: it would land in browser history, Referer
         * headers, and any frontend error reporting.
         */
        const params = new URLSearchParams({
          device: existing.device ?? "Unknown device",
          browser: existing.browser ?? "Unknown browser",
          lastActive: existing.lastActivityAt.toISOString(),
        });
        return res.redirect(`${FRONTEND_URL}/session-conflict?${params}`);
      }

      const session = await sessionStore.create(user.googleUserId, fp);
      setSessionCookie(res, session.id);
      audit.log({
        event: isReconnect ? "oauth_reconnect" : "login",
        googleUserId: user.googleUserId,
        sessionId: session.id,
        outcome: "success",
        ...fp,
      });
      audit.log({
        event: "session_created",
        googleUserId: user.googleUserId,
        sessionId: session.id,
        ...fp,
      });
      metrics.inc("login_success");
      metrics.inc("session_created");
      res.redirect(FRONTEND_POST_LOGIN_URL);
    } catch (err) {
      audit.log({ event: "auth_failure", reason: "oauth_callback_failed", ...fingerprint(req) });
      metrics.inc("login_failure", { reason: "oauth_callback_failed" });
      next(err);
    }
  });

  /**
   * POST /api/auth/session/continue — the user confirmed Session Replacement.
   *
   * Cannot use requireAuth: by construction the caller has no Active Session
   * (its session is pending). It authenticates via the short-lived signed
   * httpOnly c2c_pending cookie instead.
   */
  router.post("/auth/session/continue", sessionLimiter, async (req, res, next) => {
    try {
      const pendingId = readSignedCookie(req, PENDING_COOKIE_NAME);
      if (!pendingId) {
        throw new NotAuthenticatedError("No pending sign-in — please sign in again");
      }

      // Atomic: a double-clicked Continue cannot mint two sessions.
      const pending = await sessionStore.consumePending(pendingId);
      clearPendingCookie(res);
      if (!pending) {
        throw new NotAuthenticatedError("This sign-in request expired — please sign in again");
      }

      /**
       * Revoke BEFORE create. Crashing between the two in the reverse order
       * would leave two Active Sessions — the exact invariant this feature
       * exists to prevent. Failing this way round just means signing in again.
       */
      const revokedCount = await sessionStore.revokeAllForUser(
        pending.googleUserId,
        "replaced_by_new_login"
      );
      const session = await sessionStore.create(pending.googleUserId, {
        device: pending.device,
        browser: pending.browser,
        ip: pending.ip,
      });
      setSessionCookie(res, session.id);

      audit.log({
        event: "session_replaced",
        googleUserId: pending.googleUserId,
        sessionId: session.id,
        reason: "replaced_by_new_login",
        revokedCount,
        device: pending.device,
        browser: pending.browser,
        ip: pending.ip,
      });
      metrics.inc("session_revoked", { reason: "replaced_by_new_login" });
      metrics.inc("session_created");
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/auth/session/cancel — the user kept their other device. Discard
   * the Pending Session; the existing session is untouched and keeps working.
   * Tokens persisted during the callback stay: they are the same user's, and
   * the still-active session legitimately uses them.
   */
  router.post("/auth/session/cancel", sessionLimiter, async (req, res, next) => {
    try {
      const pendingId = readSignedCookie(req, PENDING_COOKIE_NAME);
      if (pendingId) {
        const pending = await sessionStore.consumePending(pendingId);
        if (pending) {
          audit.log({
            event: "session_conflict_cancelled",
            googleUserId: pending.googleUserId,
          });
        }
      }
      clearPendingCookie(res);
      // Idempotent: cancelling a pending session that is already gone is fine.
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/auth/google/status — { authenticated, email?, needsReconnect?,
  // spreadsheetUrl?, spreadsheetTitle?, savedContactsCount? }.
  // needsReconnect: the user row exists but its tokens were cleared (the M5
  // router nulls them when Google rejects a refresh).
  // Stays public: it must be able to answer "you are signed out". A revoked
  // session never reaches it — the session middleware rejects first.
  router.get("/auth/google/status", (req, res) => {
    if (!req.auth) {
      res.json({ authenticated: false });
      return;
    }
    const { user } = req.auth;
    res.json({
      authenticated: true,
      email: user.email,
      needsReconnect: user.refreshToken === null && user.accessToken === null,
      ...(user.spreadsheetId
        ? {
            // Prefer the stored url; derive for rows predating the column.
            spreadsheetUrl: user.spreadsheetUrl ?? spreadsheetUrlFor(user.spreadsheetId),
            spreadsheetTitle: user.spreadsheetTitle ?? spreadsheetTitle,
          }
        : {}),
      savedContactsCount: user.savedContactsCount,
    });
  });

  /**
   * POST /api/auth/logout — Session Termination.
   *
   * Revokes the server-side session, then clears the cookie. Previously this
   * only cleared the cookie, which meant the session id stayed valid forever:
   * anyone who had captured it could keep using it. With server-side sessions
   * the revocation IS the logout; clearing the cookie is cosmetic.
   *
   * The Google refresh token stays in the DB so signing in again is
   * frictionless (unchanged).
   */
  router.post("/auth/logout", async (req, res, next) => {
    try {
      if (req.auth) {
        const { sessionId, googleUserId } = req.auth;
        await sessionStore.revoke(sessionId, "logout");
        audit.log({
          event: "logout",
          googleUserId,
          sessionId,
          ...fingerprint(req),
        });
        audit.log({
          event: "session_terminated",
          googleUserId,
          sessionId,
          reason: "logout",
        });
        metrics.inc("session_revoked", { reason: "logout" });
      }
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
