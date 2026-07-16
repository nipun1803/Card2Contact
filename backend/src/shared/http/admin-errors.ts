/**
 * Admin authentication errors.
 *
 * Separate from pipeline-errors.ts, which is documented as "cross-cutting error
 * conventions shared by all module routers" — these serve exactly one module.
 * They live in shared/http/ rather than in modules/admin-auth/ so that
 * shared/http/error-handler.ts can import them without shared/ ever depending on
 * modules/ (every other file in shared/ imports only from shared/).
 *
 * All three carry a machine-readable `code`, so the frontend can never confuse
 * an admin 401 with the Google-session codes REAUTH_REQUIRED / SESSION_REVOKED.
 * See docs/modules/admin/Admin-Authentication.md.
 */

/**
 * Wrong username, wrong password, or both — the client is never told which.
 *
 * The message is deliberately generic and MUST stay byte-identical across every
 * failure mode: a distinguishable response is a user-enumeration oracle that
 * halves an attacker's search space. The service's constant-work bcrypt compare
 * closes the same oracle in the time domain (see admin-auth.service.ts).
 */
export class AdminInvalidCredentialsError extends Error {
  readonly code = "ADMIN_INVALID_CREDENTIALS";
  constructor(message = "Invalid credentials") {
    super(message);
    this.name = "AdminInvalidCredentialsError";
  }
}

/**
 * No admin session — absent, unknown, expired, or revoked cookie.
 *
 * Deliberately does NOT distinguish those cases. The user-session equivalent
 * splits revoked (SESSION_REVOKED) from expired precisely to explain "you signed
 * in on another device"; admin has no Session Replacement story to tell, and one
 * generic failure is what keeps the no-enumeration guarantee whole.
 */
export class AdminNotAuthenticatedError extends Error {
  readonly code = "ADMIN_NOT_AUTHENTICATED";
  constructor(message = "Admin login required") {
    super(message);
    this.name = "AdminNotAuthenticatedError";
  }
}

/**
 * ADMIN_USERNAME / ADMIN_PASSWORD_HASH are not configured, so the admin panel is
 * switched off entirely.
 *
 * 503, not 401: nothing the client sends could succeed — this is server state,
 * not a credential problem. It is the only non-4xx/500 domain error in the app.
 * The router still mounts when unconfigured so this is a real answer from a real
 * route, rather than a 404 that reads like a typo'd URL.
 */
export class AdminNotConfiguredError extends Error {
  readonly code = "ADMIN_NOT_CONFIGURED";
  constructor(message = "Admin access is not configured") {
    super(message);
    this.name = "AdminNotConfiguredError";
  }
}
