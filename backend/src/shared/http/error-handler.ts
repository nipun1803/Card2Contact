import { ErrorRequestHandler } from "express";
import { CardNotFoundError } from "../store/card-session-store";
import {
  NotAuthenticatedError,
  PipelineOrderError,
  QuotaExceededError,
  ReauthRequiredError,
  ScanBlockedError,
  SessionRevokedError,
  UserDisabledError,
  ValidationError,
} from "./pipeline-errors";
import {
  AdminInvalidCredentialsError,
  AdminNotAuthenticatedError,
  AdminNotConfiguredError,
} from "./admin-errors";
import { UserNotFoundError } from "../../modules/admin-users/admin-users.service";
import {
  LicenseUserNotFoundError,
  LicenseValidationError,
  TierNotFoundError,
} from "../../modules/admin-licenses/admin-licenses.service";
import { RequestValidationError } from "../../modules/licensing/licensing.service";
import { DuplicatePendingRequestError } from "../store/tier-request-store";

/**
 * Errors thrown by `express.json()` (body-parser) rather than by our own code.
 *
 * They are plain Errors carrying a `type` discriminator and the correct HTTP
 * `status` already — we only have to honour it. Identified by `type` rather than
 * by class: body-parser does not export its error constructors, and `status`
 * alone is too loose a signal to trust on an arbitrary thrown value.
 */
interface BodyParserError extends Error {
  type: string;
  status: number;
}

const BODY_PARSER_TYPES: Record<string, string> = {
  // Body over express.json()'s 100kb default.
  "entity.too.large": "Request body is too large",
  // Malformed JSON — a client bug, not a server one.
  "entity.parse.failed": "Request body is not valid JSON",
  "encoding.unsupported": "Unsupported content encoding",
};

function asBodyParserError(err: unknown): BodyParserError | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as Partial<BodyParserError>;
  if (typeof candidate.type !== "string" || typeof candidate.status !== "number") return null;
  return candidate.type in BODY_PARSER_TYPES ? (candidate as BodyParserError) : null;
}

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
  if (err instanceof SessionRevokedError) {
    // Before NotAuthenticatedError: both are 401, and the specific case must
    // win so the frontend can explain *why* the user was signed out.
    res.status(401).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof UserDisabledError) {
    // 403, not 401: the credential is valid, access is administratively denied.
    res.status(403).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof QuotaExceededError) {
    // 402: signed-in but out of scan allowance. Resolvable by an admin grant.
    res.status(402).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ScanBlockedError) {
    // 403 like UserDisabledError, but a DISTINCT code: scanning-only block, login
    // intact. Clients must branch on `code`, never on the shared 403 status.
    res.status(403).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof UserNotFoundError) {
    res.status(404).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof LicenseUserNotFoundError) {
    // 404, distinct code from USER_NOT_FOUND — the license surface names its own.
    res.status(404).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof LicenseValidationError) {
    // 400 — a bad limit/amount/delta or unknown grant, with a machine code so
    // the admin UI can surface the specific field error.
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof TierNotFoundError) {
    res.status(404).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof RequestValidationError) {
    // 400 — a malformed upgrade request (unknown tier, missing custom reason).
    // Distinct code from LICENSE_INVALID so the user surface names its own.
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof DuplicatePendingRequestError) {
    // 409 — a state conflict, not a bad request: the user already has one open.
    res.status(409).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof AdminNotConfiguredError) {
    // 503, not 401: no credential could succeed — the admin panel is switched
    // off server-side. The only non-4xx/500 domain error in the app.
    res.status(503).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof AdminInvalidCredentialsError) {
    // Generic by design — never reveals whether the username or the password
    // was wrong. See shared/http/admin-errors.ts.
    res.status(401).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof AdminNotAuthenticatedError) {
    // Kept with the other specific 401s, before the generic one below.
    res.status(401).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json({ error: err.message });
    return;
  }

  /**
   * Body-parser rejections, LAST among the handled cases and before the 500.
   *
   * These are client faults that were previously reported as "Internal server
   * error" — a lie that sends an operator hunting through server logs for their
   * own oversized or malformed request. body-parser already knows the right
   * status (413 / 400); honour it rather than swallowing it.
   *
   * Deliberately generic messages rather than err.message: body-parser's text
   * echoes limits and parse offsets, which is detail a client neither needs nor
   * should be handed.
   */
  const bodyError = asBodyParserError(err);
  if (bodyError) {
    res.status(bodyError.status).json({ error: BODY_PARSER_TYPES[bodyError.type] });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
