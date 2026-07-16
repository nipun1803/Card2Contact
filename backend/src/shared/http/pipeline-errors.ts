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

/**
 * Thrown when a request presents a session that was explicitly revoked. Two
 * distinct causes share this error: Session Replacement (the user signed in
 * on another device) and an admin's Revoke Access / Force Logout. Distinct
 * from NotAuthenticatedError (never signed in): this user WAS signed in and
 * was signed out, so the frontend explains why rather than bouncing to
 * /login silently. 401 with `code: "SESSION_REVOKED"`.
 *
 * The message must not claim "another device" for an admin-initiated revoke —
 * that is simply false, and confusing enough that a user might suspect their
 * account was compromised when in fact an operator acted on it. The reason
 * passed in picks the honest message; it is not itself exposed to the client
 * (see `RevokeReason`'s doc comment — "never to the client" — and the admin
 * username is never named here either, matching how audit entries never
 * surface the acting admin to the affected user).
 *
 * Note this is raised by the session middleware, not by requireAuth: the
 * endpoint that actually notices a revocation is the public
 * GET /api/auth/google/status (refetched on window focus), which never passes
 * through requireAuth. An expired session is NOT this error — expiry is not
 * revocation, and degrades to anonymous instead.
 */
export class SessionRevokedError extends Error {
  readonly code = "SESSION_REVOKED";
  constructor(reason?: "replaced_by_new_login" | "user_revoked" | "logout") {
    super(
      reason === "user_revoked"
        ? "Your session was ended by an administrator"
        : "Your session was ended because you signed in on another device"
    );
    this.name = "SessionRevokedError";
  }
}

/**
 * Thrown when a disabled user's Google OAuth callback would otherwise create a
 * new session, or an M5 action is attempted by a user disabled mid-session.
 * Distinct from SessionRevokedError (a specific session was ended) and
 * ReauthRequiredError (Google itself rejected the tokens): this is an admin
 * decision, not a session or token lifecycle event. 403 — the credential is
 * valid, but access is administratively denied.
 */
export class UserDisabledError extends Error {
  readonly code = "USER_DISABLED";
  constructor(message = "This account has been disabled") {
    super(message);
    this.name = "UserDisabledError";
  }
}
