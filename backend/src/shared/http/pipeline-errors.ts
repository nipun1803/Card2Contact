/**
 * Cross-cutting error conventions shared by all module routers. This is the
 * one place pipeline-ordering rules live, so no module reinvents its own
 * error shape.
 */
export class PipelineOrderError extends Error {
  constructor(public readonly missingStep: string) {
    super(`Cannot proceed: required step not yet completed — ${missingStep}`);
    this.name = "PipelineOrderError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Thrown when an endpoint requires an active Google login that hasn't happened yet (M5 §5). */
export class NotAuthenticatedError extends Error {
  constructor(message = "Google login required — visit GET /api/auth/google") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

/**
 * Thrown when a user's stored Google authorization is no longer usable — the
 * refresh token was revoked or expired (Google returns `invalid_grant`). Unlike
 * NotAuthenticatedError (never logged in), this means a previously-valid session
 * must re-consent. The router surfaces it as 401 with a machine-readable
 * `code: "REAUTH_REQUIRED"` so the frontend can prompt "Reconnect Google Sheets"
 * instead of failing silently (see M5's error-recovery notes).
 */
export class ReauthRequiredError extends Error {
  readonly code = "REAUTH_REQUIRED";
  constructor(message = "Google access was revoked or expired — please reconnect") {
    super(message);
    this.name = "ReauthRequiredError";
  }
}
