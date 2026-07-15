import { RequestHandler, Response } from "express";
import { UserRecord, UserStore } from "../store/user-store";

/** Resolved auth context attached to a request by the session middleware. */
export interface AuthContext {
  googleUserId: string;
  user: UserRecord;
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

const COOKIE_NAME = "c2c_session";
const isProd = () => process.env.NODE_ENV === "production";

/**
 * Set the signed session cookie. Signed so it can't be forged, httpOnly so JS
 * can't read it (the frontend never handles tokens), sameSite:"lax" so it
 * survives the top-level redirect back from Google's consent screen, and secure
 * only in production (a secure cookie is dropped over plain-HTTP localhost).
 */
export function setSessionCookie(res: Response, googleUserId: string): void {
  res.cookie(COOKIE_NAME, googleUserId, {
    httpOnly: true,
    signed: true,
    sameSite: "lax",
    secure: isProd(),
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: isProd() });
}

/**
 * Resolves the current user from the signed cookie and attaches `req.auth`.
 * Does NOT reject unauthenticated requests — the pipeline's M1–M4 endpoints
 * stay public; only M5 gates on auth via `requireAuth`. A cookie referencing a
 * user that no longer exists is treated as anonymous.
 */
export function createSessionMiddleware(userStore: UserStore): RequestHandler {
  return async (req, _res, next) => {
    try {
      const googleUserId = req.signedCookies?.[COOKIE_NAME] as string | undefined;
      if (googleUserId) {
        const user = await userStore.findById(googleUserId);
        if (user) {
          req.auth = { googleUserId, user };
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
