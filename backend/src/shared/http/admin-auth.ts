import { RequestHandler } from "express";
import { AdminAuthService } from "../../modules/admin-auth/admin-auth.service";
import { AuditLogger } from "../audit/audit-logger";
import { Metrics } from "../observability/metrics";
import { AdminNotAuthenticatedError, AdminNotConfiguredError } from "./admin-errors";
import { ADMIN_COOKIE_NAME } from "./admin-session";
import { fingerprint, readSignedCookie } from "./session";

/**
 * Guard for routes that require an authenticated Admin Session.
 *
 * Lives in shared/http/ rather than modules/admin-auth/ for the same reason
 * require-auth.ts does: the whole point is that FUTURE admin modules apply it.
 * A guard living inside admin-auth/ that a future admin module had to import
 * would breach the module boundary rule the moment a second admin module exists.
 *
 * Usage — this is the contract Phase 0.2+ depends on:
 *
 *   router.use(adminAuth)   // at the top of any /api/admin/* router
 *
 * A factory rather than a bare handler so it can record the failed attempt, and
 * so the service (which may be null when admin is unconfigured) is injected
 * rather than imported.
 */

/**
 * Three ways this differs from createSessionMiddleware, all deliberate:
 *
 *  1. It REJECTS rather than degrading to anonymous. The user middleware is
 *     permissive because M1–M4 are public and must work with no cookie; there is
 *     no such thing as an anonymous admin.
 *
 *  2. It does NOT distinguish revoked from expired from unknown. The user side
 *     splits those to explain "you signed in on another device" (SESSION_REVOKED)
 *     — admin has no Session Replacement story, and one generic failure is what
 *     keeps the no-enumeration guarantee whole. All roads lead to
 *     AdminNotAuthenticatedError.
 *
 *  3. It never touches `req.auth`. See the note in admin-session.ts: populating
 *     it would authenticate M5 save.
 */
export function createAdminAuth(
  service: AdminAuthService | null,
  audit: AuditLogger,
  metrics: Metrics
): RequestHandler {
  return async (req, _res, next) => {
    try {
      // Admin switched off entirely — a server-state problem, not a credential
      // one, so 503 rather than 401 (nothing the caller sends could succeed).
      if (!service) return next(new AdminNotConfiguredError());

      const sessionId = readSignedCookie(req, ADMIN_COOKIE_NAME);
      if (!sessionId) return reject(req, "no_admin_session");

      const session = await service.authenticate(sessionId);
      if (!session) return reject(req, "admin_session_invalid");

      req.adminAuth = { username: session.username, adminSessionId: session.id };
      next();
    } catch (err) {
      next(err);
    }

    function reject(request: typeof req, reason: string) {
      audit.log({
        event: "admin_auth_failure",
        reason,
        // The full id is passed; the sink truncates it to 8 chars. Never log a
        // whole session id — it is a bearer credential.
        sessionId: readSignedCookie(request, ADMIN_COOKIE_NAME) ?? null,
        ...fingerprint(request),
      });
      metrics.inc("admin_login_failure", { reason });
      next(new AdminNotAuthenticatedError());
    }
  };
}
