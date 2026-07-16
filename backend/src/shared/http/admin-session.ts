import { Response } from "express";
import { ADMIN_SESSION_ABSOLUTE_MS } from "../store/admin-session-store";

/**
 * Admin session cookie policy.
 *
 * Deliberately NOT folded into session.ts. That file's `cookieOptions` is shared
 * by both user cookies and is documented as such; adding a third policy with a
 * DIFFERENT sameSite would either force it to take a parameter (touching the
 * Google OAuth flow to serve admin) or invite a future edit that "unifies" the
 * two and silently breaks the OAuth redirect landing. Separate file, separate
 * policy, cross-referenced both ways.
 *
 * See docs/modules/admin/Admin-Authentication.md.
 */

/**
 * Named per the Phase 0.1 requirement. Note it does NOT carry the `c2c_` prefix
 * the user cookies use (`c2c_session`, `c2c_pending`) — recorded here as a
 * decision, not an oversight: the prefix is a convention, nothing reads it, and
 * renaming a cookie later logs every admin out. Do not "fix" it.
 */
export const ADMIN_COOKIE_NAME = "admin_session";

const isProd = () => process.env.NODE_ENV === "production";

/**
 * Cookie policy for the Admin Session.
 *
 * sameSite "strict" — and this is the one real divergence from the user cookie,
 * which uses "lax". That "lax" is not a preference: session.ts documents it as
 * REQUIRED because the user's cookie is set during the cross-site top-level
 * redirect back from accounts.google.com, and "strict" would make the browser
 * withhold it on that landing request, looping the user at /login forever.
 *
 * Admin login has no redirect. It is a same-site fetch POST from our own page,
 * so "strict" is available for free — and it is strictly stronger: the cookie is
 * never sent on ANY cross-site request, including top-level navigation. That
 * closes CSRF for admin routes outright, rather than relying on the app's
 * documented "lax-only, no CSRF tokens" posture.
 *
 * path "/" rather than "/api/admin". Cookie path is NOT a security boundary —
 * any same-origin page can trigger a request to any path — and scoping it would
 * silently break the first future admin route that lands outside that prefix.
 * The real boundary is that createAdminAuth reads only this cookie and the user
 * middleware reads only c2c_session, which is testable and tested.
 *
 * secure is prod-only for the same reason as the user cookie: a Secure cookie is
 * dropped over plain-HTTP localhost, so dev would break.
 *
 * signed uses the same SESSION_SECRET via the one mounted cookieParser. A second
 * secret would need cookieParser(["a","b"]) — which makes BOTH secrets valid for
 * BOTH cookies, actively removing the distinction it appears to add. The
 * isolation lives in the cookie name and the store lookup, not the signature:
 * the signature only proves we minted the value; the value still has to name a
 * live session in the admin store.
 *
 * maxAge comes from ADMIN_SESSION_ABSOLUTE_MS so the browser discards the cookie
 * at the same instant the server stops honouring it. These two MUST NOT drift —
 * both derive from that one constant for exactly this reason.
 */
function adminCookieOptions() {
  return {
    httpOnly: true,
    signed: true,
    sameSite: "strict" as const,
    secure: isProd(),
    path: "/",
    maxAge: ADMIN_SESSION_ABSOLUTE_MS,
  };
}

/** clearCookie must match the original attributes or the browser keeps it. */
function adminClearOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: isProd(),
    path: "/",
  };
}

export function setAdminSessionCookie(res: Response, sessionId: string): void {
  res.cookie(ADMIN_COOKIE_NAME, sessionId, adminCookieOptions());
}

export function clearAdminSessionCookie(res: Response): void {
  res.clearCookie(ADMIN_COOKIE_NAME, adminClearOptions());
}

/** Resolved admin context attached to a request by createAdminAuth. */
export interface AdminAuthContext {
  username: string;
  /** The Admin Session this request authenticated with. */
  adminSessionId: string;
}

/**
 * `req.adminAuth`, deliberately distinct from `req.auth`.
 *
 * Never merge the two. `requireAuth` gates on `req.auth` being truthy and
 * createSaveLimiter's keyGenerator reads `req.auth?.googleUserId` — so an admin
 * populating `req.auth` would authenticate POST /api/contacts/save as a user.
 * That is a privilege escalation, and the separation is what prevents it.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminAuth?: AdminAuthContext;
    }
  }
}
