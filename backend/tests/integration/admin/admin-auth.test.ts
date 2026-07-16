import bcrypt from "bcrypt";
import request from "supertest";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The external SDK boundaries createApp constructs internally. Mocked before
 * importing the app helper — see tests/helpers/app.ts.
 */
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(() => ({
    generateAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/auth?mock"),
    setCredentials: vi.fn(),
    getToken: vi.fn(),
    verifyIdToken: vi.fn(),
  })),
}));
vi.mock("googleapis", () => ({ google: { sheets: vi.fn(), drive: vi.fn() } }));

import { buildTestApp } from "../../helpers/app";
import { MemoryAuditLogger, StdoutAuditLogger } from "../../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../../src/shared/observability/metrics";
import { InMemoryAdminSessionStore } from "../../../src/shared/store/admin-session-store";

/**
 * The admin auth router over HTTP.
 *
 * ADMIN_* is set per-file rather than in tests/helpers/env.ts, deliberately: the
 * global setup must NOT define them, so that (a) the unconfigured→503 path stays
 * the default the rest of the suite exercises, and (b) no live admin credential
 * exists across specs that have nothing to do with admin.
 *
 * The password hash is generated at runtime at cost 4 — never a committed `$2b$`
 * literal (gitleaks scans for those), and fast enough not to slow the suite.
 */

const USERNAME = "admin";
const PASSWORD = "correct-horse-battery-staple";

const ENV = { ...process.env };
const open: InMemoryAdminSessionStore[] = [];

interface Ctx {
  app: Express;
  audit: MemoryAuditLogger;
  metrics: MemoryMetrics;
  store: InMemoryAdminSessionStore;
  advance: (ms: number) => void;
}

function ctx(): Ctx {
  const store = new InMemoryAdminSessionStore();
  open.push(store);
  let now = new Date("2026-07-16T09:00:00Z").getTime();
  store._setNow(() => new Date(now));

  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const app = buildTestApp({ audit, metrics, adminSessionStore: store });

  return { app, audit, metrics, store, advance: (ms) => (now += ms) };
}

/** Log in and return the raw `admin_session=...` cookie pair. */
async function login(app: Express): Promise<string> {
  const res = await request(app)
    .post("/api/admin/auth/login")
    .send({ username: USERNAME, password: PASSWORD });
  const setCookie = res.headers["set-cookie"] as unknown as string[];
  return setCookie[0].split(";")[0];
}

beforeEach(() => {
  process.env.ADMIN_USERNAME = USERNAME;
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
});

afterEach(() => {
  process.env = { ...ENV };
  while (open.length) open.pop()?.stop();
  vi.clearAllMocks();
});

describe("POST /api/admin/auth/login — success", () => {
  it("I1: returns 200 with the username and sets a session cookie", async () => {
    const { app } = ctx();

    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: USERNAME, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: USERNAME });
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("I2: the cookie is signed, httpOnly, SameSite=Strict, Path=/, 8h", async () => {
    const { app } = ctx();

    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: USERNAME, password: PASSWORD });
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0];

    expect(cookie).toMatch(/^admin_session=s%3A/); // signed
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/); // NOT Lax — admin has no OAuth redirect
    expect(cookie).toMatch(/Path=\//);
    // 8h in seconds — must equal ADMIN_SESSION_ABSOLUTE_MS or the browser and
    // the server disagree about when the session dies.
    expect(cookie).toMatch(/Max-Age=28800/);
  });

  it("I2b: omits Secure outside production (a Secure cookie is dropped over http://localhost)", async () => {
    const { app } = ctx();

    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: USERNAME, password: PASSWORD });

    expect((res.headers["set-cookie"] as unknown as string[])[0]).not.toMatch(/Secure/);
  });

  it("I2c: sets Secure in production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { app } = ctx();
      const res = await request(app)
        .post("/api/admin/auth/login")
        .send({ username: USERNAME, password: PASSWORD });

      expect((res.headers["set-cookie"] as unknown as string[])[0]).toMatch(/Secure/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("POST /api/admin/auth/login — failure is generic and identical", () => {
  it("I3: 401s a wrong password and sets NO cookie", async () => {
    const { app } = ctx();

    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: USERNAME, password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials", code: "ADMIN_INVALID_CREDENTIALS" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("I4: 401s a wrong username", async () => {
    const { app } = ctx();

    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: "not-the-admin", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  /**
   * I6 — the single assertion that pins the whole no-enumeration guarantee. If
   * any failure mode ever answers differently from the others, an attacker can
   * tell when they have found the username and only has to guess one secret.
   */
  it("I6: every CREDENTIAL failure mode returns a byte-identical response", async () => {
    const { app } = ctx();

    const responses = await Promise.all([
      // Right username, wrong password.
      request(app).post("/api/admin/auth/login").send({ username: USERNAME, password: "wrong" }),
      // Wrong username, right password — must not be distinguishable from above.
      request(app).post("/api/admin/auth/login").send({ username: "wrong", password: PASSWORD }),
      // Both wrong.
      request(app).post("/api/admin/auth/login").send({ username: "wrong", password: "wrong" }),
      // A username that differs only in case.
      request(app).post("/api/admin/auth/login").send({ username: "ADMIN", password: PASSWORD }),
    ]);

    const shapes = new Set(responses.map((r) => `${r.status}:${JSON.stringify(r.body)}`));
    expect(shapes.size).toBe(1);
  });

  /**
   * A malformed request is NOT a credential failure and is deliberately
   * distinguishable: 400 "username is required" vs 401 "Invalid credentials".
   *
   * This leaks nothing — the caller already knows they sent an empty field, so
   * the response tells them nothing about the credential. Collapsing it into the
   * generic 401 would only make a client bug look like a wrong password.
   */
  it("distinguishes a malformed request (400) from a wrong credential (401)", async () => {
    const { app } = ctx();

    const malformed = await request(app).post("/api/admin/auth/login").send({ username: "" });
    const wrong = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: "wrong", password: "wrong" });

    expect(malformed.status).toBe(400);
    expect(wrong.status).toBe(401);
  });
});

describe("POST /api/admin/auth/login — input validation", () => {
  it.each([
    ["I7: missing username", { password: PASSWORD }],
    ["I8: missing password", { username: USERNAME }],
    ["I9: empty body", {}],
  ])("%s → 400", async (_label, body) => {
    const { app } = ctx();
    const res = await request(app).post("/api/admin/auth/login").send(body);
    expect(res.status).toBe(400);
  });

  it.each([
    ["number", 42],
    ["object", { nested: true }],
    ["array", ["a"]],
    ["null", null],
    ["boolean", true],
  ])("I10/I11: 400s a %s username or password without crashing", async (_label, value) => {
    const { app } = ctx();

    const u = await request(app).post("/api/admin/auth/login").send({ username: value, password: PASSWORD });
    const p = await request(app).post("/api/admin/auth/login").send({ username: USERNAME, password: value });

    expect(u.status).toBe(400);
    expect(p.status).toBe(400);
  });

  it("I12: 400s an over-long credential before doing any bcrypt work", async () => {
    // Deterministic and cheap: hashing a huge string on an unauthenticated
    // endpoint is a free DoS.
    const { app } = ctx();
    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: USERNAME, password: "x".repeat(257) });

    expect(res.status).toBe(400);
  });

  it("I12b: accepts a credential at exactly the 256-char boundary", async () => {
    const { app } = ctx();
    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: USERNAME, password: "x".repeat(256) });

    // Wrong password, but validated rather than rejected — proves the boundary
    // is 256 inclusive, not off by one.
    expect(res.status).toBe(401);
  });

  /**
   * I12c. A body over express.json()'s 100kb default is a 413 — the client's
   * fault, reported as such. (This used to be a generic 500 app-wide, which sent
   * an operator hunting through server logs for their own oversized request; the
   * shared errorHandler now honours body-parser's status.)
   */
  it("I12c: 413s a body beyond express.json()'s 100kb limit", async () => {
    const { app } = ctx();
    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: USERNAME, password: "x".repeat(200_000) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "Request body is too large" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("I12d: 400s a malformed JSON body rather than 500ing", async () => {
    const { app } = ctx();
    const res = await request(app)
      .post("/api/admin/auth/login")
      .set("Content-Type", "application/json")
      .send("{not valid json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Request body is not valid JSON" });
  });
});

describe("GET /api/admin/auth/me", () => {
  it("I13: returns the username for a live session", async () => {
    const { app } = ctx();
    const cookie = await login(app);

    const res = await request(app).get("/api/admin/auth/me").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: USERNAME });
  });

  it("I14: 401s with no cookie", async () => {
    const { app } = ctx();

    const res = await request(app).get("/api/admin/auth/me");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "ADMIN_NOT_AUTHENTICATED" });
  });

  it("I15: 401s a tampered cookie", async () => {
    const { app } = ctx();
    const cookie = await login(app);
    const tampered = cookie.slice(0, -3) + "AAA";

    const res = await request(app).get("/api/admin/auth/me").set("Cookie", tampered);

    expect(res.status).toBe(401);
  });

  it("I17: 401s an expired session (past 8h)", async () => {
    const { app, advance } = ctx();
    const cookie = await login(app);

    advance(8 * 60 * 60 * 1000 + 1);

    const res = await request(app).get("/api/admin/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("stays valid just under 8h", async () => {
    const { app, advance } = ctx();
    const cookie = await login(app);

    advance(7 * 60 * 60 * 1000);

    const res = await request(app).get("/api/admin/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/admin/auth/logout", () => {
  it("I19: clears the cookie and kills the session", async () => {
    const { app } = ctx();
    const cookie = await login(app);

    const out = await request(app).post("/api/admin/auth/logout").set("Cookie", cookie);

    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    // Cleared: an expiry in the past / Max-Age=0.
    expect((out.headers["set-cookie"] as unknown as string[])[0]).toMatch(
      /admin_session=;|Max-Age=0|Expires=Thu, 01 Jan 1970/
    );

    // I18: and the session really is gone server-side.
    const after = await request(app).get("/api/admin/auth/me").set("Cookie", cookie);
    expect(after.status).toBe(401);
  });

  it("I20: is idempotent — twice succeeds, and audits exactly one logout", async () => {
    const { app, audit } = ctx();
    const cookie = await login(app);

    const first = await request(app).post("/api/admin/auth/logout").set("Cookie", cookie);
    const second = await request(app).post("/api/admin/auth/logout").set("Cookie", cookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The second had no session to end — logging it would double-count.
    expect(audit.ofType("admin_logout")).toHaveLength(1);
  });

  it("I21: 200s with no cookie at all (never 401)", async () => {
    // Telling someone they cannot log out because they are not logged in is
    // hostile and pointless.
    const { app } = ctx();

    const res = await request(app).post("/api/admin/auth/logout");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("I22: 200s a tampered cookie and audits nothing", async () => {
    const { app, audit } = ctx();

    const res = await request(app)
      .post("/api/admin/auth/logout")
      .set("Cookie", "admin_session=s%3Agarbage.signature");

    expect(res.status).toBe(200);
    expect(audit.ofType("admin_logout")).toHaveLength(0);
  });
});

describe("admin routes when unconfigured", () => {
  beforeEach(() => {
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD_HASH;
  });

  it("I23: 503s all three endpoints", async () => {
    const { app } = ctx();

    const login503 = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: "admin", password: "whatever" });
    const me = await request(app).get("/api/admin/auth/me");
    const out = await request(app).post("/api/admin/auth/logout");

    for (const res of [login503, me, out]) {
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: "ADMIN_NOT_CONFIGURED" });
    }
  });

  it("I23b: never authenticates, even with credentials that would be correct", async () => {
    const { app } = ctx();

    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ username: USERNAME, password: PASSWORD });

    expect(res.status).toBe(503);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("admin auth — audit & metrics", () => {
  it("I24/I28: audits a successful login with the fingerprint, and counts it", async () => {
    const { app, audit, metrics } = ctx();

    await request(app)
      .post("/api/admin/auth/login")
      .set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0")
      .send({ username: USERNAME, password: PASSWORD });

    expect(audit.ofType("admin_login")).toEqual([
      expect.objectContaining({
        adminUsername: USERNAME,
        outcome: "success",
        sessionId: expect.any(String),
      }),
    ]);
    expect(metrics.get("admin_login_success")).toBe(1);
  });

  it("I25/I28b: audits a failed login with the attempted username", async () => {
    const { app, audit, metrics } = ctx();

    await request(app)
      .post("/api/admin/auth/login")
      .send({ username: "intruder", password: "guess" });

    expect(audit.ofType("admin_auth_failure")).toEqual([
      expect.objectContaining({ adminUsername: "intruder", reason: "invalid_credentials" }),
    ]);
    expect(metrics.get("admin_login_failure", { reason: "invalid_credentials" })).toBe(1);
  });

  /**
   * I26 — the field-policy suite, mirroring the one in integration/auth.test.ts.
   * The audit log must be safe to read: it records that a credential check
   * happened and how it came out, never the credential.
   */
  it("I26: never writes the password, the hash, or a bcrypt marker to the audit log", async () => {
    const { app, audit } = ctx();

    await request(app).post("/api/admin/auth/login").send({ username: USERNAME, password: PASSWORD });
    await request(app).post("/api/admin/auth/login").send({ username: USERNAME, password: "wrong" });
    const cookie = await login(app);
    await request(app).post("/api/admin/auth/logout").set("Cookie", cookie);

    const dumped = JSON.stringify(audit.entries);
    expect(dumped).not.toContain(PASSWORD);
    expect(dumped).not.toContain("$2b$");
    expect(dumped).not.toContain(process.env.ADMIN_PASSWORD_HASH);
  });

  it("I27: the admin session id is truncated to 8 chars at the sink", async () => {
    // Reuses AuditEntry.sessionId, so it inherits StdoutAuditLogger's truncation
    // for free — but a regression here would put a live bearer credential in
    // `docker logs`, so assert it rather than assume it.
    const { app, audit } = ctx();
    await request(app).post("/api/admin/auth/login").send({ username: USERNAME, password: PASSWORD });

    const entry = audit.ofType("admin_login")[0];
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    new StdoutAuditLogger().log(entry);
    spy.mockRestore();

    const emitted = JSON.parse(lines[0]);
    expect(emitted.sessionId).toHaveLength(8);
    expect(entry.sessionId!.length).toBeGreaterThan(8); // the full id was passed in
  });

  it("does not audit an admin_login on a failed attempt", async () => {
    const { app, audit } = ctx();

    await request(app).post("/api/admin/auth/login").send({ username: USERNAME, password: "wrong" });

    expect(audit.ofType("admin_login")).toHaveLength(0);
  });
});
