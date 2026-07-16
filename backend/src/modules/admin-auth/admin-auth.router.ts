import { RequestHandler, Router } from "express";
import { AdminAuthService } from "./admin-auth.service";
import { AuditLogger } from "../../shared/audit/audit-logger";
import { Metrics } from "../../shared/observability/metrics";
import {
  AdminInvalidCredentialsError,
  AdminNotConfiguredError,
} from "../../shared/http/admin-errors";
import {
  clearAdminSessionCookie,
  setAdminSessionCookie,
  ADMIN_COOKIE_NAME,
} from "../../shared/http/admin-session";
import { fingerprint, readSignedCookie } from "../../shared/http/session";
import { ValidationError } from "../../shared/http/pipeline-errors";

/**
 * Admin authentication router — mounted at /api/admin (see app.ts), so these are
 * /api/admin/auth/login, /logout, and /me.
 *
 * The mount path is the contract: every future admin router mounts under
 * /api/admin and applies the exported `adminAuth` guard at its top, which is what
 * makes "protect all future /api/admin/* routes" a structural fact rather than a
 * naming convention.
 *
 * See docs/modules/admin/Admin-Authentication.md.
 */

/**
 * Credentials longer than this are rejected before any bcrypt work happens.
 *
 * bcrypt truncates at 72 bytes, so nothing above this could ever be a real
 * password — but hashing a 1MB string still costs real CPU, and an unauthenticated
 * endpoint that does unbounded work on request is a cheap DoS. express.json()'s
 * 100kb default catches the extreme case with a 413; this catches everything
 * between "plausible" and "abusive" with a deterministic 400.
 */
const MAX_CREDENTIAL_LENGTH = 256;

export interface AdminAuthRouterDeps {
  /**
   * Null when ADMIN_USERNAME/ADMIN_PASSWORD_HASH are unset — the admin panel is
   * switched off and every route answers 503. The router still mounts in that
   * case, deliberately: a real 503 from a real route beats a 404 that reads like
   * a typo'd URL, and the route table stays identical in every environment.
   */
  service: AdminAuthService | null;
  audit: AuditLogger;
  metrics: Metrics;
  /** Applied to the login route only. */
  loginLimiter: RequestHandler;
  /** The shared admin guard (shared/http/admin-auth.ts), applied to /auth/me. */
  adminAuth: RequestHandler;
}

/** Reject non-strings and over-long values before they reach bcrypt. */
function credential(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${field} is required`);
  }
  if (value.length > MAX_CREDENTIAL_LENGTH) {
    throw new ValidationError(`${field} is too long`);
  }
  return value;
}

export function createAdminAuthRouter(deps: AdminAuthRouterDeps): Router {
  const { service, audit, metrics, loginLimiter, adminAuth } = deps;
  const router = Router();

  /**
   * POST /api/admin/auth/login
   *
   * The limiter runs FIRST — before validation and before bcrypt — so a flood
   * costs us a counter increment rather than 100ms of hashing each.
   */
  router.post("/auth/login", loginLimiter, async (req, res, next) => {
    try {
      if (!service) throw new AdminNotConfiguredError();

      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = credential(body.username, "username");
      const password = credential(body.password, "password");

      const fp = fingerprint(req);
      const session = await service.login(username, password, fp);

      if (!session) {
        audit.log({
          event: "admin_auth_failure",
          reason: "invalid_credentials",
          // The ATTEMPTED username — the whole point of the entry. Never the
          // password, in any form.
          adminUsername: username,
          outcome: "failure",
          ...fp,
        });
        metrics.inc("admin_login_failure", { reason: "invalid_credentials" });
        // Generic and identical for every failure mode: wrong username, wrong
        // password, or both. See shared/http/admin-errors.ts.
        throw new AdminInvalidCredentialsError();
      }

      setAdminSessionCookie(res, session.id);
      audit.log({
        event: "admin_login",
        adminUsername: session.username,
        // Full id passed; the sink truncates to 8 chars.
        sessionId: session.id,
        outcome: "success",
        ...fp,
      });
      metrics.inc("admin_login_success");
      res.json({ username: session.username });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/admin/auth/logout — Session Termination.
   *
   * Deliberately NOT behind adminAuth: logout is idempotent and must always
   * succeed. A caller whose session already expired should get a clean {ok:true}
   * and a cleared cookie, not a 401 telling them they cannot log out because
   * they are not logged in. Mirrors POST /api/auth/logout, which also tolerates
   * a missing req.auth.
   */
  router.post("/auth/logout", async (req, res, next) => {
    try {
      if (!service) throw new AdminNotConfiguredError();

      const sessionId = readSignedCookie(req, ADMIN_COOKIE_NAME);
      if (sessionId) {
        // Only audit a logout that actually ended a session — otherwise a
        // double-clicked logout would log two terminations for one session.
        const session = await service.authenticate(sessionId);
        if (session) {
          await service.logout(sessionId);
          audit.log({
            event: "admin_logout",
            adminUsername: session.username,
            sessionId,
            ...fingerprint(req),
          });
        }
      }
      clearAdminSessionCookie(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/auth/me — who am I?
   *
   * The only route here behind adminAuth, and the template every future admin
   * route follows. 401 when there is no live Admin Session; the frontend's
   * useAdminAuth treats that as a definitive "not signed in", not an error.
   */
  router.get("/auth/me", adminAuth, (req, res) => {
    // adminAuth guarantees req.adminAuth is set, or it would have thrown.
    res.json({ username: req.adminAuth!.username });
  });

  return router;
}
