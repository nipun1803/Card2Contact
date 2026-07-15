import { RequestHandler } from "express";
import rateLimit, { Options, ipKeyGenerator } from "express-rate-limit";
import { AuditLogger } from "../audit/audit-logger";
import { Metrics } from "../observability/metrics";
import { fingerprint } from "./session";

/**
 * Per-endpoint rate limits.
 *
 * Keyed on req.ip, which is trustworthy ONLY because app.ts sets
 * `trust proxy` to 1 BEFORE these limiters mount. Without it every request
 * appears to come from nginx's container IP and one user would rate-limit
 * everyone. That ordering is load-bearing, not stylistic.
 *
 * In-memory store: a single backend container, matching the existing
 * "pipeline state is RAM-only" precedent. Counters reset on restart and do not
 * hold across replicas — an accepted bound (see the Security Guarantees:
 * this bounds accidental abuse and casual attacks, not a distributed one).
 */

const WINDOW_MS = 15 * 60 * 1000;

/** Disabled under test: integration specs fire dozens of requests from one
 *  fake IP and would trip a 429 spuriously. rate-limit.test.ts enables the
 *  limiters explicitly to test them. */
const isTest = () => process.env.NODE_ENV === "test";

export interface LimiterDeps {
  audit: AuditLogger;
  metrics: Metrics;
}

interface LimiterConfig {
  /** Label for the metric + audit entry. */
  endpoint: string;
  limit: number;
  /** Key on the authenticated user rather than the IP. */
  byUser?: boolean;
}

function makeLimiter(config: LimiterConfig, deps: LimiterDeps): RequestHandler {
  if (isTest()) {
    const passthrough: RequestHandler = (_req, _res, next) => next();
    return passthrough;
  }

  const options: Partial<Options> = {
    windowMs: WINDOW_MS,
    limit: config.limit,
    standardHeaders: true, // RateLimit-* (RFC draft)
    legacyHeaders: false, // no X-RateLimit-*
    keyGenerator: config.byUser
      ? /**
         * Authenticated: key on the user, so an office behind one NAT does not
         * share a budget.
         *
         * The unauthenticated fallback must go through ipKeyGenerator, which
         * normalises an IPv6 address to its /64 subnet. A single user typically
         * controls an entire /64, so keying on the raw address would let them
         * rotate through billions of addresses and bypass the limit entirely.
         * (In practice requireAuth runs first on the only user-keyed route, so
         * this branch is defence in depth.)
         */
        (req) => req.auth?.googleUserId ?? ipKeyGenerator(req.ip ?? "unknown")
      : undefined, // default: req.ip, already IPv6-safe (and correct given trust proxy: 1)
    handler: (req, res) => {
      deps.metrics.inc("rate_limit_exceeded", { endpoint: config.endpoint });
      deps.audit.log({
        event: "auth_failure",
        reason: "rate_limited",
        googleUserId: req.auth?.googleUserId ?? null,
        ...fingerprint(req),
      });
      // Match the app's error shape (see shared/http/error-handler.ts).
      res.status(429).json({ error: "Too many requests — please try again later" });
    },
  };

  return rateLimit(options);
}

/**
 * Sign-in is rare and human-paced. 10 per 15 min covers retries and a shared
 * NAT; beyond that it is scripted.
 */
export function createOAuthLimiter(deps: LimiterDeps): RequestHandler {
  return makeLimiter({ endpoint: "oauth", limit: 10 }, deps);
}

/**
 * Guards Session Conflict resolution against pending-id brute force. Pending
 * ids are 256-bit, so this is defence in depth rather than the primary control.
 */
export function createSessionLimiter(deps: LimiterDeps): RequestHandler {
  return makeLimiter({ endpoint: "session", limit: 20 }, deps);
}

/**
 * Uploads cost real money — every one becomes a Mistral OCR call. 30 per 15 min
 * is ~2/min, well above human scanning pace.
 */
export function createUploadLimiter(deps: LimiterDeps): RequestHandler {
  return makeLimiter({ endpoint: "upload", limit: 30 }, deps);
}

/**
 * Guards Google Sheets quota. Keyed on the user (the route is authenticated),
 * not the IP.
 */
export function createSaveLimiter(deps: LimiterDeps): RequestHandler {
  return makeLimiter({ endpoint: "save", limit: 60, byUser: true }, deps);
}
