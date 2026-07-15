import { ErrorRequestHandler } from "express";
import { CardNotFoundError } from "../store/card-session-store";
import {
  NotAuthenticatedError,
  PipelineOrderError,
  ReauthRequiredError,
  ValidationError,
} from "./pipeline-errors";

/** Registered once in the app entrypoint; converts thrown domain errors to HTTP responses. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof CardNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof PipelineOrderError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof ReauthRequiredError) {
    // 401 with a machine-readable code so the frontend can prompt "reconnect"
    // rather than treating it as a generic auth failure.
    res.status(401).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json({ error: err.message });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
