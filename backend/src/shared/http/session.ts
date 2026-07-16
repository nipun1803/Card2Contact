import { Request, RequestHandler, Response } from "express";
import { UserRecord, UserStore } from "../store/user-store";
import {
  PENDING_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SessionFingerprint,
  SessionStore,
} from "../store/session-store";
import { AuditLogger } from "../audit/audit-logger";
import { Metrics } from "../observability/metrics";
import { SessionRevokedError } from "./pipeline-errors";
import { parseUserAgent } from "./user-agent";

/** Resolved auth context attached to a request by the session middleware. */
export interface AuthContext {
  googleUserId: string;
  user: UserRecord;
  /** The Active Session this request authenticated with. */
  sessionId: string;
}

// Make req.auth available and typed across the app.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export const COOKIE_NAME = "c2c_session";

/**
 * Carries a Pending Session id while the user decides a Session Conflict. A
 * second cookie is unavoidable: the conflict page has no Active Session by
 * construction, so Continue/Cancel cannot authenticate the normal way.
 */
export const PENDING_COOKIE_NAME = "c2c_pending";

const isProd = () => process.env.NODE_ENV === "production";

/**
 * Cookie policy, shared by both USER cookies (c2c_session, c2c_pending).
 *
 * The admin cookie deliberately does NOT use this — it has its own policy in
 * shared/http/admin-session.ts with sameSite "strict", because the "lax"
 * requirement below is specific to the Google OAuth redirect and does not apply
 * to a same-site login POST. Do not unify the two: widening this to admin, or
 * flipping this to "strict" for consistency, breaks the OAuth landing.
 *
 * sameSite "lax" is REQUIRED, not incidental: the session cookie is set during
 * the GET redirect back from accounts.google.com, which is a cross-site
 * top-level navigation. "strict" would make the browser withhold the cookie on
 * that first landing request — the user would arrive signed out and bounce back
 * to /login forever. "lax" sends cookies on top-level GET navigations (exactly
 * this case) but not on cross-site POST/XHR, which is the CSRF protection we
 * want. It remains correct now the value is an opaque id.
 *
 * secure is prod-only: a Secure cookie is silently dropped over plain-HTTP
 * localhost, so dev would break. In prod nginx terminates TLS and redirects
 * :80 -> :443, so no plaintext hop exists.
 *
 * signed makes the cookie tamper-evident via SESSION_SECRET; httpOnly keeps it
 * out of JS entirely (the frontend never handles credentials).
 */
function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    signed: true,
    sameSite: "lax" as const,
    secure: isProd(),
    path: "/",
    maxAge,
  };
}

/** clearCookie must match the original attributes or the browser keeps it. */
function clearOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: isProd(), path: "/" };
}

/**
 * Set the session cookie. maxAge matches SESSION_ABSOLUTE_MS so the browser
 * discards the cookie at the same moment the server stops honouring it — the
 * two must not drift.
 */
export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(COOKIE_NAME, sessionId, cookieOptions(SESSION_ABSOLUTE_MS));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, clearOptions());
}

export function setPendingCookie(res: Response, pendingId: string): void {
  res.cookie(PENDING_COOKIE_NAME, pendingId, cookieOptions(PENDING_TTL_MS));
}

export function clearPendingCookie(res: Response): void {
  res.clearCookie(PENDING_COOKIE_NAME, clearOptions());
}

/** Read a signed cookie, or undefined if absent/unsigned/tampered. */
export function readSignedCookie(req: Request, name: string): string | undefined {
  const value = req.signedCookies?.[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Device fingerprint for a new session. `req.ip` is only trustworthy because
 * app.ts sets `trust proxy` to 1 — see the reasoning there.
 */
export function fingerprint(req: Request): SessionFingerprint {
  const { device, browser } = parseUserAgent(req.get("user-agent"));
  return { device, browser, ip: req.ip ?? null };
}

/**
 * Only write last_activity_at at most once a minute per session. A 30-day Idle
 * Timeout doesn't need second precision, and this turns a DB write on every
 * request into one write per minute per active user.
 */
const TOUCH_THROTTLE_MS = 60 * 1000;

/**
 * Resolves the current session + user and attaches `req.auth`.
 *
 * Rejection policy — the subtle part. The middleware stays permissive for
 * ANONYMOUS requests: M1–M4 are public and must work with no cookie at all, so
 * "no cookie", "unknown id", "expired session", and "session for a deleted
 * user" all fall through to next() with req.auth unset, exactly as before.
 *
 * It rejects EXACTLY ONE case: a signed cookie naming a session we know was
 * revoked. That is not an anonymous request — it is a client that believes it
 * is signed in, and the honest answer is "your session was ended elsewhere",
 * not a silent downgrade to signed-out.
 *
 * This rejection cannot live in requireAuth. requireAuth guards only
 * POST /api/contacts/save, but the endpoint that actually notices a revocation
 * is GET /api/auth/google/status — the one React Query refetches on window
 * focus, and one that must stay public so it can answer "you are signed out".
 * If the 401 came from requireAuth, a revoked device would sit on the dashboard
 * showing stale data until it happened to try a save. Rejecting here is what
 * lets refetchOnWindowFocus surface the Session Replacement promptly, with no
 * polling.
 *
 * Note expiry is NOT revocation: an expired session degrades to anonymous and
 * the user simply signs in again, with no "you signed in elsewhere" message.
 */
export function createSessionMiddleware(
  userStore: UserStore,
  sessionStore: SessionStore,
  audit: AuditLogger,
  metrics: Metrics
): RequestHandler {
  return async (req, res, next) => {
    try {
      /**
       * Admin routes are not part of the user session model — skip entirely.
       *
       * This is load-bearing, not tidiness. This middleware is GLOBAL, and the
       * rejection below fires for any request whose cookie names a revoked
       * session — regardless of path. Without this guard, an operator whose
       * *Google* session was replaced on another device would get
       * 401 SESSION_REVOKED from the *admin* panel: an unrelated identity
       * system's failure, with a message ("you signed in on another device")
       * that makes no sense there. Verified: it reproduces without this line.
       *
       * The invariant in CLAUDE.md — "SessionRevokedError is raised by the
       * session middleware, not requireAuth" — is untouched. Every non-admin
       * path still gets the exact same treatment, which is what the /status
       * revocation flow depends on. Admin routes simply have no user session to
       * resolve: they authenticate via `admin_session` in createAdminAuth, and
       * `req.auth` must stay unset there anyway (see shared/http/admin-session.ts).
       *
       * Preferred over mounting the admin router before this middleware: that
       * would also put it before cookieParser, breaking its signed-cookie read.
       * It also saves admin routes a sessionStore lookup they never use.
       */
      if (req.path.startsWith("/api/admin")) return next();

      const sessionId = readSignedCookie(req, COOKIE_NAME);
      if (!sessionId) return next(); // anonymous: the common case for M1–M4

      const session = await sessionStore.findActive(sessionId);
      if (!session) {
        // Distinguish revoked (tell them) from unknown/expired (anonymous).
        if (await sessionStore.isRevoked(sessionId)) {
          // Stop the dead id being re-sent on every subsequent request.
          clearSessionCookie(res);
          audit.log({
            event: "auth_failure",
            reason: "session_revoked",
            sessionId,
            ...fingerprint(req),
          });
          metrics.inc("auth_failure", { reason: "session_revoked" });
          return next(new SessionRevokedError());
        }
        clearSessionCookie(res);
        return next();
      }

      const user = await userStore.findById(session.googleUserId);
      // An orphaned session (user row gone) is treated as anonymous rather than
      // an error — same as the pre-session behaviour for a stale cookie.
      if (!user) return next();

      req.auth = { googleUserId: session.googleUserId, user, sessionId };

      if (Date.now() - session.lastActivityAt.getTime() > TOUCH_THROTTLE_MS) {
        // Fire-and-forget with an explicit catch: a failed touch must never
        // fail the request, but it must never become an unhandled rejection
        // either.
        void sessionStore
          .touch(sessionId)
          .catch((err) => console.warn("[session] touch failed", err));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
