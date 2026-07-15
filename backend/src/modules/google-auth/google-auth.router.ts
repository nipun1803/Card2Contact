import { Router } from "express";
import { GoogleAuthService } from "./google-auth.service";
import { ValidationError } from "../../shared/http/pipeline-errors";
import { UserStore } from "../../shared/store/user-store";
import { SheetsProvisioner } from "../../shared/sheets/sheets-provisioner";
import { clearSessionCookie, setSessionCookie } from "../../shared/http/session";

/** Where the browser lands after a successful login. */
const FRONTEND_POST_LOGIN_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

/**
 * Auth router. Drives login/callback/status/logout and, on first login,
 * provisions the user's own spreadsheet via the injected SheetsProvisioner
 * (so this module never imports the google-sheets module). `spreadsheetTitle`
 * is passed in for the same reason — /status echoes it back to the frontend
 * without this module importing google-sheets.service for the constant.
 */
export function createGoogleAuthRouter(
  service: GoogleAuthService,
  userStore: UserStore,
  provisioner: SheetsProvisioner,
  spreadsheetTitle: string
): Router {
  const router = Router();

  // GET /api/auth/google — start (or re-)consent. Reused for "reconnect".
  router.get("/auth/google", (_req, res) => {
    res.redirect(service.buildConsentUrl());
  });

  // GET /api/auth/google/callback — exchange code, persist user, set session,
  // auto-create the user's sheet on first login.
  router.get("/auth/google/callback", async (req, res, next) => {
    try {
      const code = req.query.code;
      if (typeof code !== "string") {
        throw new ValidationError("Missing OAuth authorization code");
      }
      const identity = await service.handleCallback(code);
      const user = await userStore.upsertOnLogin({
        googleUserId: identity.googleUserId,
        email: identity.email,
        ...identity.tokens,
      });

      if (!user.spreadsheetId) {
        const authClient = service.authClientForUser(
          { accessToken: user.accessToken, refreshToken: user.refreshToken, tokenExpiry: user.tokenExpiry },
          (t) => void userStore.updateTokens(user.googleUserId, t)
        );
        await provisioner.ensureSpreadsheet(user, authClient);
      }

      setSessionCookie(res, identity.googleUserId);
      res.redirect(FRONTEND_POST_LOGIN_URL);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/auth/google/status — { authenticated, email?, needsReconnect?,
  // spreadsheetUrl?, spreadsheetTitle?, savedContactsCount? }.
  // needsReconnect: the user row exists but its tokens were cleared (revoked).
  // spreadsheetUrl/Title and savedContactsCount are omitted until the user has
  // a provisioned sheet (normally set on first login) — the dashboard degrades
  // gracefully (disabled link, "0 saved") until then.
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
            spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${user.spreadsheetId}`,
            spreadsheetTitle,
          }
        : {}),
      savedContactsCount: user.savedContactsCount,
    });
  });

  // POST /api/auth/logout — clear the session cookie only. The Google refresh
  // token stays in the DB so re-login is frictionless (we do NOT revoke it).
  router.post("/auth/logout", (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  return router;
}
