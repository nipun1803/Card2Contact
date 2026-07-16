import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Express } from "express";
import request from "supertest";
import {
  createAdminLoginLimiter,
  createOAuthLimiter,
  createSaveLimiter,
  createUploadLimiter,
} from "../../src/shared/http/rate-limit";
import { MemoryAuditLogger } from "../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../src/shared/observability/metrics";

/**
 * The limiters are disabled under NODE_ENV=test (integration specs fire dozens
 * of requests from one fake IP and would otherwise 429 spuriously), so this is
 * the one suite that turns them on explicitly.
 */
const originalEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = "production";
});

afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

interface Harness {
  app: Express;
  audit: MemoryAuditLogger;
  metrics: MemoryMetrics;
}

/** An app with one limited route. `auth` seeds req.auth for user-keyed limits. */
function harness(
  makeLimiter: (deps: { audit: MemoryAuditLogger; metrics: MemoryMetrics }) => express.RequestHandler,
  auth?: { googleUserId: string }
): Harness {
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const app = express();
  app.set("trust proxy", 1);
  if (auth) {
    app.use((req, _res, next) => {
      req.auth = { googleUserId: auth.googleUserId } as NonNullable<typeof req.auth>;
      next();
    });
  }
  app.use(makeLimiter({ audit, metrics }));
  app.get("/x", (_req, res) => res.json({ ok: true }));
  app.post("/x", (_req, res) => res.json({ ok: true }));
  return { app, audit, metrics };
}

describe("limiters are disabled under test", () => {
  it("passes everything through when NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const h = harness(createOAuthLimiter);

    // Well past the 10/15min production limit.
    for (let i = 0; i < 15; i++) {
      const res = await request(h.app).get("/x");
      expect(res.status).toBe(200);
    }
    expect(h.metrics.get("rate_limit_exceeded", { endpoint: "oauth" })).toBe(0);
  });
});

describe("oauthLimiter (10 per 15 min per IP)", () => {
  it("allows the limit and blocks the next request", async () => {
    const h = harness(createOAuthLimiter);

    for (let i = 0; i < 10; i++) {
      expect((await request(h.app).get("/x")).status).toBe(200);
    }
    expect((await request(h.app).get("/x")).status).toBe(429);
  });

  it("returns a 429 body matching the app's error shape", async () => {
    const h = harness(createOAuthLimiter);
    for (let i = 0; i < 10; i++) await request(h.app).get("/x");

    const res = await request(h.app).get("/x");

    // Same `{ error }` shape the central error handler emits, so the frontend's
    // parser needs no special case.
    expect(res.body).toEqual({ error: expect.stringMatching(/too many requests/i) });
  });

  it("sends standard RateLimit headers, not legacy X-RateLimit ones", async () => {
    const h = harness(createOAuthLimiter);
    const res = await request(h.app).get("/x");

    expect(res.headers).toHaveProperty("ratelimit-limit");
    expect(res.headers).not.toHaveProperty("x-ratelimit-limit");
  });

  it("audits and counts the block", async () => {
    const h = harness(createOAuthLimiter);
    for (let i = 0; i < 10; i++) await request(h.app).get("/x");
    await request(h.app).get("/x");

    expect(h.metrics.get("rate_limit_exceeded", { endpoint: "oauth" })).toBe(1);
    expect(h.audit.ofType("auth_failure")).toEqual([
      expect.objectContaining({ reason: "rate_limited" }),
    ]);
  });
});

describe("uploadLimiter (30 per 15 min per IP)", () => {
  it("allows 30 and blocks the 31st", async () => {
    const h = harness(createUploadLimiter);

    for (let i = 0; i < 30; i++) {
      expect((await request(h.app).post("/x")).status).toBe(200);
    }
    expect((await request(h.app).post("/x")).status).toBe(429);
    expect(h.metrics.get("rate_limit_exceeded", { endpoint: "upload" })).toBe(1);
  });
});

/**
 * The save limiter keys on the authenticated user, not the IP: the route is
 * authenticated, and an office behind one NAT should not share a budget.
 */
describe("saveLimiter (60 per 15 min per USER)", () => {
  it("allows 60 and blocks the 61st for one user", async () => {
    const h = harness(createSaveLimiter, { googleUserId: "u1" });

    for (let i = 0; i < 60; i++) {
      expect((await request(h.app).post("/x")).status).toBe(200);
    }
    expect((await request(h.app).post("/x")).status).toBe(429);
  });

  it("keys on the user, so a second user from the same IP is unaffected", async () => {
    const audit = new MemoryAuditLogger();
    const metrics = new MemoryMetrics();
    const limiter = createSaveLimiter({ audit, metrics });

    // Both users share one limiter instance and one source IP — as an office
    // behind a single NAT would.
    let currentUser = "u1";
    const app = express();
    app.set("trust proxy", 1);
    app.use((req, _res, next) => {
      req.auth = { googleUserId: currentUser } as NonNullable<typeof req.auth>;
      next();
    });
    app.use(limiter);
    app.post("/x", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 60; i++) await request(app).post("/x");
    expect((await request(app).post("/x")).status).toBe(429);

    currentUser = "u2";
    expect((await request(app).post("/x")).status).toBe(200);
  });

  it("records the blocked user on the audit entry", async () => {
    const h = harness(createSaveLimiter, { googleUserId: "u1" });
    for (let i = 0; i < 60; i++) await request(h.app).post("/x");
    await request(h.app).post("/x");

    expect(h.audit.ofType("auth_failure")).toEqual([
      expect.objectContaining({ reason: "rate_limited", googleUserId: "u1" }),
    ]);
  });

  /**
   * A single user typically controls an entire IPv6 /64, so keying the
   * unauthenticated fallback on the raw address would let them rotate through
   * billions of addresses and bypass the limit. ipKeyGenerator normalises to
   * the /64 subnet — express-rate-limit warns loudly if a custom keyGenerator
   * skips it, and that warning is what this test pins.
   */
  it("does not warn about IPv6 bypass — the fallback normalises to the /64 subnet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(createSaveLimiter, { googleUserId: "u1" });

    await request(h.app).post("/x");

    const output = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(output).not.toMatch(/ERR_ERL_KEY_GEN_IPV6|ipKeyGenerator/);
    warn.mockRestore();
    error.mockRestore();
  });
});

/**
 * The admin login limiter. Tighter than the rest (5 vs OAuth's 10) because it
 * guards a password endpoint with a single, guessable username — where the OAuth
 * route is only a redirect with Google's own throttling behind it.
 *
 * Together with bcrypt cost 12 (~100ms/attempt) this is the PRIMARY control
 * against an anonymous guesser, not defence in depth: 5 attempts per 15 minutes
 * makes an online brute force useless.
 */
describe("adminLoginLimiter (5 per 15 min, per IP)", () => {
  it("allows 5 attempts and blocks the 6th", async () => {
    const h = harness(createAdminLoginLimiter);

    for (let i = 0; i < 5; i++) {
      expect((await request(h.app).get("/x")).status).toBe(200);
    }

    expect((await request(h.app).get("/x")).status).toBe(429);
  });

  it("returns the app's standard error shape on a 429", async () => {
    const h = harness(createAdminLoginLimiter);
    for (let i = 0; i < 5; i++) await request(h.app).get("/x");

    const res = await request(h.app).get("/x");

    expect(res.body).toEqual({ error: "Too many requests — please try again later" });
  });

  it("counts the block against the admin_login endpoint label", async () => {
    const h = harness(createAdminLoginLimiter);
    for (let i = 0; i < 6; i++) await request(h.app).get("/x");

    expect(h.metrics.get("rate_limit_exceeded", { endpoint: "admin_login" })).toBe(1);
  });

  /**
   * The documented asymmetry: a 429 audits as auth_failure{rate_limited}, NOT
   * admin_auth_failure, because the shared makeLimiter handler emits it and is
   * deliberately not parameterized for one caller. Pinned here so it reads as a
   * decision rather than a bug — the endpoint label above is what identifies it.
   */
  it("audits a rate-limited admin login as auth_failure{rate_limited}", async () => {
    const h = harness(createAdminLoginLimiter);
    for (let i = 0; i < 6; i++) await request(h.app).get("/x");

    expect(h.audit.ofType("auth_failure")).toEqual([
      expect.objectContaining({ reason: "rate_limited" }),
    ]);
    expect(h.audit.ofType("admin_auth_failure")).toHaveLength(0);
  });

  it("is disabled under NODE_ENV=test like every other limiter", async () => {
    process.env.NODE_ENV = "test";
    const h = harness(createAdminLoginLimiter);

    for (let i = 0; i < 20; i++) {
      expect((await request(h.app).get("/x")).status).toBe(200);
    }
  });
});
