import { RequestHandler } from "express";
import { NotAuthenticatedError } from "./pipeline-errors";

/**
 * Guard for endpoints that require a logged-in user (currently only M5 save).
 * Relies on `createSessionMiddleware` having run first to populate `req.auth`.
 * Throws NotAuthenticatedError (→ 401) when absent, via the central handler.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(new NotAuthenticatedError());
    return;
  }
  next();
};
