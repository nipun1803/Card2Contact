import bcrypt from "bcrypt";
import cookieParser from "cookie-parser";
import express, { Express } from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { AdminAuthService } from "../../../src/modules/admin-auth/admin-auth.service";
import { MemoryAuditLogger } from "../../../src/shared/audit/audit-logger";
import { createAdminAuth } from "../../../src/shared/http/admin-auth";
import { ADMIN_COOKIE_NAME } from "../../../src/shared/http/admin-session";
import { COOKIE_NAME } from "../../../src/shared/http/session";
import { errorHandler } from "../../../src/shared/http/error-handler";
import { MemoryMetrics } from "../../../src/shared/observability/metrics";
import { InMemoryAdminSessionStore } from "../../../src/shared/store/admin-session-store";

/**
 * The admin guard, exercised through a real (minimal) Express app rather than a
 * hand-rolled req/res pair — the signed-cookie read only works with a real
 * cookieParser mounted, and faking it would test the fake.
 *
 * The highest-value case here is M7: the guard must never populate req.auth.
 */

const SECRET = "test-session-secret-at-least-32-chars-long";
const USERNAME = "admin";
const PASSWORD = "correct-horse";
const FAST_COST = 4;

const open: InMemoryAdminSessionStore[] = [];

afterEach(() => {
  while (open.length) open.pop()?.stop();
});

interface Harness {
  app: Express;
  service: AdminAuthService;
  store: InMemoryAdminSessionStore;
  audit: MemoryAuditLogger;
  metrics: MemoryMetrics;
  clock: { advance: (ms: number) => void };
}

/**
 * Mounts the guard on a probe route that echoes what it resolved.
 *
 * A `/mint` route issues real signed cookies via res.cookie(), so specs never
 * hand-craft a signature. This mirrors the convention in tests/integration/
 * auth.test.ts (sign in through the real route rather than forging a cookie):
 * a hand-signed cookie would exercise our own signing code instead of
 * cookie-parser's, and a forged one would fail the signature check rather than
 * the check under test — passing for the wrong reason.
 */
function harness(configured = true): Harness {
  const store = new InMemoryAdminSessionStore();
  open.push(store);

  let now = new Date("2026-07-16T09:00:00Z").getTime();
  store._setNow(() => new Date(now));

  const service = new AdminAuthService(
    { username: USERNAME, passwordHash: bcrypt.hashSync(PASSWORD, FAST_COST) },
    store
  );
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();

  const app = express();
  app.use(cookieParser(SECRET));

  // Test-only cookie minter: signs an arbitrary value under an arbitrary name,
  // exactly as the real routers do. Mounted BEFORE the guard so it stays open.
  app.get("/mint/:name/:value", (req, res) => {
    res.cookie(req.params.name, req.params.value, { signed: true, httpOnly: true });
    res.json({ ok: true });
  });

  app.use(createAdminAuth(configured ? service : null, audit, metrics));
  app.get("/probe", (req, res) => {
    res.json({
      adminAuth: req.adminAuth ?? null,
      // The escalation check: this must ALWAYS be null on an admin route.
      auth: req.auth ?? null,
    });
  });
  app.use(errorHandler);

  return {
    app,
    service,
    store,
    audit,
    metrics,
    clock: {
      advance: (ms: number) => {
        now += ms;
      },
    },
  };
}

/** A genuinely signed cookie header, produced by Express itself. */
async function signedCookie(h: Harness, name: string, value: string): Promise<string> {
  const res = await request(h.app).get(`/mint/${name}/${encodeURIComponent(value)}`);
  const setCookie = res.headers["set-cookie"] as unknown as string[];
  return setCookie[0].split(";")[0];
}

async function loginCookie(h: Harness): Promise<string> {
  const session = await h.service.login(USERNAME, PASSWORD, {
    device: null,
    browser: null,
    ip: null,
  });
  return signedCookie(h, ADMIN_COOKIE_NAME, session!.id);
}

describe("createAdminAuth — rejects everything that is not a live admin session", () => {
  it("M1: 401s a request with no admin cookie", async () => {
    const h = harness();

    const res = await request(h.app).get("/probe");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "ADMIN_NOT_AUTHENTICATED" });
  });

  it("M2: resolves req.adminAuth for a valid session", async () => {
    const h = harness();

    const res = await request(h.app).get("/probe").set("Cookie", await loginCookie(h));

    expect(res.status).toBe(200);
    expect(res.body.adminAuth).toMatchObject({ username: USERNAME });
    expect(res.body.adminAuth.adminSessionId).toEqual(expect.any(String));
  });

  it("M3: 401s an unknown session id", async () => {
    const h = harness();
    const cookie = await signedCookie(h, ADMIN_COOKIE_NAME, "never-issued");

    const res = await request(h.app).get("/probe").set("Cookie", cookie);

    expect(res.status).toBe(401);
  });

  it("M4: 401s an expired session (past the 8h Absolute Lifetime)", async () => {
    const h = harness();
    const cookie = await loginCookie(h);

    h.clock.advance(9 * 60 * 60 * 1000);

    const res = await request(h.app).get("/probe").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("M5: 401s a revoked session with the SAME error as unknown/expired", async () => {
    // The generic-failure guarantee: revoked, expired and unknown must be
    // indistinguishable to the client.
    const h = harness();
    const session = await h.service.login(USERNAME, PASSWORD, {
      device: null,
      browser: null,
      ip: null,
    });
    const cookie = await signedCookie(h, ADMIN_COOKIE_NAME, session!.id);
    await h.service.logout(session!.id);

    const revoked = await request(h.app).get("/probe").set("Cookie", cookie);
    const unknown = await request(h.app)
      .get("/probe")
      .set("Cookie", await signedCookie(h, ADMIN_COOKIE_NAME, "never-issued"));

    expect(revoked.status).toBe(401);
    expect(revoked.body).toEqual(unknown.body);
  });

  it("rejects an unsigned (tampered) cookie value", async () => {
    const h = harness();
    // A raw id with no signature — readSignedCookie must not honour it.
    const res = await request(h.app).get("/probe").set("Cookie", `${ADMIN_COOKIE_NAME}=raw-id`);

    expect(res.status).toBe(401);
  });

  it("rejects a cookie whose signature does not verify", async () => {
    const h = harness();
    // Take a real signed cookie and corrupt its signature: cookie-parser must
    // drop it from req.signedCookies rather than hand us the payload.
    const valid = await loginCookie(h);
    const tampered = valid.slice(0, -3) + "AAA";

    const res = await request(h.app).get("/probe").set("Cookie", tampered);

    expect(res.status).toBe(401);
  });

  it("M6: 503s every request when admin is unconfigured", async () => {
    const h = harness(false);

    const res = await request(h.app).get("/probe");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "ADMIN_NOT_CONFIGURED" });
  });
});

describe("createAdminAuth — isolation from the user session", () => {
  /**
   * M7, the escalation guard. requireAuth gates on req.auth being truthy and
   * createSaveLimiter's keyGenerator reads req.auth?.googleUserId — so if the
   * admin guard ever populated req.auth, an admin cookie would authenticate
   * POST /api/contacts/save as a user.
   */
  it("M7: never populates req.auth, even on a successful admin auth", async () => {
    const h = harness();

    const res = await request(h.app).get("/probe").set("Cookie", await loginCookie(h));

    expect(res.body.adminAuth).not.toBeNull();
    expect(res.body.auth).toBeNull();
  });

  it("M10: a user session cookie is not an admin cookie", async () => {
    const h = harness();
    // A perfectly valid-looking c2c_session — the admin guard must ignore it
    // entirely, since it reads only admin_session.
    const userCookie = await signedCookie(h, COOKIE_NAME, "some-user-session-id");

    const res = await request(h.app).get("/probe").set("Cookie", userCookie);

    expect(res.status).toBe(401);
  });

  it("M10b: an admin session id replayed under the user cookie name is ignored", async () => {
    const h = harness();
    const session = await h.service.login(USERNAME, PASSWORD, {
      device: null,
      browser: null,
      ip: null,
    });
    const replayed = await signedCookie(h, COOKIE_NAME, session!.id);

    const res = await request(h.app).get("/probe").set("Cookie", replayed);

    expect(res.status).toBe(401);
  });
});

describe("createAdminAuth — audit & metrics", () => {
  it("M8: audits a failure with a reason and counts it", async () => {
    const h = harness();

    await request(h.app).get("/probe");

    expect(h.audit.ofType("admin_auth_failure")).toHaveLength(1);
    expect(h.audit.ofType("admin_auth_failure")[0]).toMatchObject({
      reason: "no_admin_session",
    });
    expect(h.metrics.get("admin_login_failure", { reason: "no_admin_session" })).toBe(1);
  });

  it("audits an invalid session distinctly from a missing one", async () => {
    const h = harness();

    await request(h.app)
      .get("/probe")
      .set("Cookie", await signedCookie(h, ADMIN_COOKIE_NAME, "never-issued"));

    expect(h.audit.ofType("admin_auth_failure")[0]).toMatchObject({
      reason: "admin_session_invalid",
    });
  });

  it("does not audit a successful auth (the router logs admin_login instead)", async () => {
    const h = harness();

    await request(h.app).get("/probe").set("Cookie", await loginCookie(h));

    expect(h.audit.entries).toHaveLength(0);
  });

  it("M9: never writes a password or hash into the audit log", async () => {
    const h = harness();

    await request(h.app)
      .get("/probe")
      .set("Cookie", await signedCookie(h, ADMIN_COOKIE_NAME, "never-issued"));

    const dumped = JSON.stringify(h.audit.entries);
    expect(dumped).not.toContain(PASSWORD);
    expect(dumped).not.toContain("$2b$");
  });
});
