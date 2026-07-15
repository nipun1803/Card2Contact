import { RequestHandler } from "express";
import { NotAuthenticatedError } from "./pipeline-errors";
import { AuditLogger } from "../audit/audit-logger";
import { Metrics } from "../observability/metrics";
import { fingerprint } from "./session";

/**
 * Guard for endpoints that require a signed-in user (currently only M5 save).
 * Relies on `createSessionMiddleware` having run first to populate `req.auth`.
 * Throws NotAuthenticatedError (→ 401) when absent, via the central handler.
 *
 * A factory rather than a bare handler so it can record the failed attempt.
 *
 * It deliberately does NOT handle revoked sessions: the middleware rejects
 * those before any route runs, because the endpoint that detects a Session
 * Replacement (/status) is public and never reaches this guard.
 */
export function createRequireAuth(audit: AuditLogger, metrics: Metrics): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      audit.log({
        event: "auth_failure",
        reason: "not_authenticated",
        ...fingerprint(req),
      });
      metrics.inc("auth_failure", { reason: "not_authenticated" });
      next(new NotAuthenticatedError());
      return;
    }
    next();
  };
}
