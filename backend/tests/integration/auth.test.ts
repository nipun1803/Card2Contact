import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * Integration test for the google-auth router + session middleware, with
 * google-auth-library mocked so no real OAuth happens. Covers sign-in, the
 * Session Conflict flow (single active session), status, and Session
 * Termination.
 */

const generateAuthUrl = vi.fn(() => "https://accounts.google.com/o/oauth2/auth?mock");
const getToken = vi.fn();
const verifyIdToken = vi.fn();

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    generateAuthUrl,
    getToken,
    verifyIdToken,
    setCredentials: vi.fn(),
    on: vi.fn(),
  })),
}));

// googleapis is imported by the sheets client used during first-login
// provisioning; stub the create/update calls. `drive` is needed because the
// client now constructs one for the trashed check (see isTrashed).
vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: {
        create: vi.fn(async () => ({ data: { spreadsheetId: "new-sheet" } })),
        values: {
          update: vi.fn(async () => ({})),
          append: vi.fn(async () => ({})),
          get: vi.fn(async () => ({ data: { values: [[]] } })),
        },
      },
    })),
    drive: vi.fn(() => ({
      files: { get: vi.fn(async () => ({ data: { trashed: false } })) },
    })),
  },
}));

import { createApp } from "../../src/app";
import { makeSessionStore, makeUserStore } from "../mocks/stores";
import { makeUser } from "../fixtures/contacts";
import type { UserStore } from "../../src/shared/store/user-store";
import type { SessionStore } from "../../src/shared/store/session-store";
import { MemoryAuditLogger } from "../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../src/shared/observability/metrics";

interface Ctx {
  app: ReturnType<typeof createApp>;
  userStore: UserStore;
  sessionStore: ReturnType<typeof makeSessionStore>;
  audit: MemoryAuditLogger;
  metrics: MemoryMetrics;
}

function ctx(overrides: { userStore?: UserStore; sessionStore?: SessionStore } = {}): Ctx {
  const userStore = overrides.userStore ?? makeUserStore();
  const sessionStore = (overrides.sessionStore ?? makeSessionStore()) as ReturnType<
    typeof makeSessionStore
  >;
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  return {
    app: createApp({ userStore, sessionStore, audit, metrics }),
    userStore,
    sessionStore,
    audit,
    metrics,
  };
}

/** Make the mocked OAuth exchange succeed for the given identity. */
function mockGoogleLogin(sub = "u1", email = "ada@example.com") {
  getToken.mockResolvedValue({
    tokens: { id_token: "idtok", access_token: "at", refresh_token: "rt", expiry_date: 1 },
  });
  verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub, email }) });
}

/**
 * supertest types `headers` loosely (set-cookie is `string`), but Node always
 * delivers an array here. One narrowing helper beats a cast at every call site.
 */
function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? (raw as string[]) : [raw as string];
}

/** Extract one cookie's value from a response's Set-Cookie headers. */
function cookieValue(
  res: { headers: Record<string, unknown> },
  name: string
): string | undefined {
  const header = setCookies(res).find((c) => c.startsWith(`${name}=`));
  const value = header?.split(";")[0].split("=")[1];
  return value ? decodeURIComponent(value) : undefined;
}

/** The full Set-Cookie header for one cookie, for replaying as a request Cookie. */
function cookieHeader(
  res: { headers: Record<string, unknown> },
  name: string
): string {
  const header = setCookies(res).find((c) => c.startsWith(`${name}=`));
  if (!header) throw new Error(`expected a ${name} cookie on the response`);
  return header;
}

/** The session id inside a signed `s:<id>.<sig>` cookie value. */
function sessionIdFrom(res: { headers: Record<string, unknown> }): string {
  const value = cookieValue(res, "c2c_session");
  if (!value) throw new Error("expected a c2c_session cookie on the response");
  return value.slice(2).split(".")[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/google", () => {
  it("redirects (302) to the Google consent URL", async () => {
    const res = await request(ctx().app).get("/api/auth/google");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("accounts.google.com");
  });
});

describe("GET /api/auth/google/callback — first sign-in", () => {
  it("rejects a callback without an authorization code (400)", async () => {
    const res = await request(ctx().app).get("/api/auth/google/callback");
    expect(res.status).toBe(400);
  });

  it("exchanges the code, sets a session cookie, and redirects to the frontend", async () => {
    mockGoogleLogin();
    // upsert returns a user WITHOUT a spreadsheet → triggers provisioning.
    // Provisioning keys off the RETURNED user's googleUserId (fixture:
    // "user-1"), not the id_token sub, so assert against the stored record's id.
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "user-1", spreadsheetId: null })),
      }),
    });

    const res = await request(c.app).get("/api/auth/google/callback?code=abc");

    expect(res.status).toBe(302);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/c2c_session=/);
    // Recreate Sheet contract: id, url, and title persisted together.
    expect(c.userStore.setSpreadsheet).toHaveBeenCalledWith("user-1", {
      id: "new-sheet",
      url: "https://docs.google.com/spreadsheets/d/new-sheet",
      title: "Card2Contact Contacts",
    });
  });

  /**
   * The direct regression on the old design, where the cookie value WAS the
   * google_user_id. A session cookie must be an opaque capability that proves
   * nothing about who you are.
   */
  it("puts an opaque session id in the cookie, never the google user id", async () => {
    mockGoogleLogin("u1", "ada@example.com");
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1" })),
      }),
    });

    const res = await request(c.app).get("/api/auth/google/callback?code=abc");
    const value = cookieValue(res, "c2c_session")!;

    expect(value).not.toContain("u1");
    // cookie-parser signs as `s:<value>.<sig>`; the id itself is 43 base64url chars.
    expect(value).toMatch(/^s:[A-Za-z0-9_-]{43}\./);
    const [sessionId] = value.slice(2).split(".");
    expect(c.sessionStore._sessions.get(sessionId)?.googleUserId).toBe("u1");
  });

  it("audits login + session_created and counts them", async () => {
    mockGoogleLogin();
    // spreadsheetId null = genuinely first sign-in, so this is `login` rather
    // than `oauth_reconnect` (see the next test).
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1", spreadsheetId: null })),
      }),
    });

    await request(c.app).get("/api/auth/google/callback?code=abc");

    expect(c.audit.ofType("login")).toHaveLength(1);
    expect(c.audit.ofType("session_created")).toHaveLength(1);
    expect(c.metrics.get("login_success")).toBe(1);
  });

  it("audits oauth_reconnect rather than login when the user already had a sheet", async () => {
    mockGoogleLogin();
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1", spreadsheetId: "sheet-1" })),
      }),
    });

    await request(c.app).get("/api/auth/google/callback?code=abc");

    expect(c.audit.ofType("oauth_reconnect")).toHaveLength(1);
    expect(c.audit.ofType("login")).toHaveLength(0);
  });
});

/**
 * Single active session. The new sign-in is staged, not activated — the old
 * device must keep working until the user chooses.
 */
describe("Session Conflict — callback with an existing Active Session", () => {
  async function withExistingSession() {
    mockGoogleLogin();
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1", spreadsheetId: "sheet-1" })),
        findById: vi.fn(async () => makeUser({ googleUserId: "u1", spreadsheetId: "sheet-1" })),
      }),
    });
    const existing = await c.sessionStore.create("u1", {
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.1",
    });
    return { c, existing };
  }

  it("redirects to /session-conflict with the other device's details", async () => {
    const { c } = await withExistingSession();

    const res = await request(c.app).get("/api/auth/google/callback?code=abc");

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/session-conflict");
    expect(res.headers.location).toContain("device=macOS");
    expect(res.headers.location).toContain("browser=Chrome");
    expect(res.headers.location).toContain("lastActive=");
  });

  // The old device's IP would land in browser history, Referer headers, and any
  // frontend error reporting.
  it("does not leak the other device's IP into the redirect URL", async () => {
    const { c } = await withExistingSession();

    const res = await request(c.app).get("/api/auth/google/callback?code=abc");

    expect(res.headers.location).not.toContain("203.0.113.1");
  });

  it("sets a pending cookie but NOT a session cookie", async () => {
    const { c } = await withExistingSession();

    const res = await request(c.app).get("/api/auth/google/callback?code=abc");

    expect(cookieValue(res, "c2c_pending")).toBeDefined();
    expect(cookieValue(res, "c2c_session")).toBeUndefined();
  });

  it("leaves the existing session Active — cancelling must not strand the user", async () => {
    const { c, existing } = await withExistingSession();

    await request(c.app).get("/api/auth/google/callback?code=abc");

    expect(await c.sessionStore.findActive(existing.id)).not.toBeNull();
    expect(await c.sessionStore.isRevoked(existing.id)).toBe(false);
  });

  it("audits the conflict", async () => {
    const { c } = await withExistingSession();

    await request(c.app).get("/api/auth/google/callback?code=abc");

    expect(c.audit.ofType("session_conflict")).toHaveLength(1);
  });
});

describe("POST /api/auth/session/continue — Session Replacement", () => {
  /**
   * Device A signs in for real (so we hold a properly signed cookie), then
   * device B signs in and hits the Session Conflict. Signing in through the
   * callback rather than hand-crafting a cookie is what makes the
   * SESSION_REVOKED assertion below meaningful — a forged cookie would be
   * rejected by the signature check, not by revocation, and the test would
   * pass for the wrong reason.
   */
  async function stagedConflict() {
    mockGoogleLogin();
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1", spreadsheetId: "sheet-1" })),
        findById: vi.fn(async () => makeUser({ googleUserId: "u1", spreadsheetId: "sheet-1" })),
      }),
    });

    // Device A: a real sign-in, no conflict yet.
    const deviceA = await request(c.app).get("/api/auth/google/callback?code=abc");
    const oldCookie = cookieHeader(deviceA, "c2c_session");
    const existingId = sessionIdFrom(deviceA);

    // Device B: same user, now an Active Session exists → conflict.
    const deviceB = await request(c.app).get("/api/auth/google/callback?code=abc");
    const pendingCookie = cookieHeader(deviceB, "c2c_pending");

    return { c, existing: { id: existingId }, pendingCookie, oldCookie };
  }

  it("activates the new session and returns ok", async () => {
    const { c, pendingCookie } = await stagedConflict();

    const res = await request(c.app)
      .post("/api/auth/session/continue")
      .set("Cookie", pendingCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(cookieValue(res, "c2c_session")).toBeDefined();
  });

  it("revokes the old session", async () => {
    const { c, existing, pendingCookie } = await stagedConflict();

    await request(c.app).post("/api/auth/session/continue").set("Cookie", pendingCookie);

    expect(await c.sessionStore.isRevoked(existing.id)).toBe(true);
    expect(c.sessionStore._sessions.get(existing.id)?.revokedReason).toBe(
      "replaced_by_new_login"
    );
  });

  it("leaves exactly one Active Session for the user", async () => {
    const { c, pendingCookie } = await stagedConflict();

    await request(c.app).post("/api/auth/session/continue").set("Cookie", pendingCookie);

    const active = [...c.sessionStore._sessions.values()].filter((s) => s.revokedAt === null);
    expect(active).toHaveLength(1);
  });

  // Atomicity: one Session Conflict must never mint two sessions.
  it("rejects a second Continue with the same pending cookie", async () => {
    const { c, pendingCookie } = await stagedConflict();

    const first = await request(c.app)
      .post("/api/auth/session/continue")
      .set("Cookie", pendingCookie);
    const second = await request(c.app)
      .post("/api/auth/session/continue")
      .set("Cookie", pendingCookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it("rejects Continue with no pending cookie", async () => {
    const { c } = await stagedConflict();
    const res = await request(c.app).post("/api/auth/session/continue");
    expect(res.status).toBe(401);
  });

  it("audits the replacement with the revoked count", async () => {
    const { c, pendingCookie } = await stagedConflict();

    await request(c.app).post("/api/auth/session/continue").set("Cookie", pendingCookie);

    expect(c.audit.ofType("session_replaced")).toEqual([
      expect.objectContaining({ googleUserId: "u1", revokedCount: 1 }),
    ]);
    expect(c.metrics.get("session_revoked", { reason: "replaced_by_new_login" })).toBe(1);
  });

  /**
   * The end-to-end proof of the revoked-device experience: the old device's
   * next request to the PUBLIC /status gets a specific SESSION_REVOKED rather
   * than silently degrading to signed-out.
   */
  it("makes the old device's next /status return 401 SESSION_REVOKED", async () => {
    const { c, pendingCookie, oldCookie } = await stagedConflict();

    const before = await request(c.app).get("/api/auth/google/status").set("Cookie", oldCookie);
    expect(before.body.authenticated).toBe(true);

    await request(c.app).post("/api/auth/session/continue").set("Cookie", pendingCookie);

    const after = await request(c.app).get("/api/auth/google/status").set("Cookie", oldCookie);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("SESSION_REVOKED");
  });
});

describe("POST /api/auth/session/cancel", () => {
  /** Device A signs in, device B collides — see the Continue block's note. */
  async function stagedConflict() {
    mockGoogleLogin();
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1", spreadsheetId: "sheet-1" })),
        findById: vi.fn(async () => makeUser({ googleUserId: "u1", spreadsheetId: "sheet-1" })),
      }),
    });

    const deviceA = await request(c.app).get("/api/auth/google/callback?code=abc");
    const existingId = sessionIdFrom(deviceA);

    const deviceB = await request(c.app).get("/api/auth/google/callback?code=abc");
    const pendingCookie = cookieHeader(deviceB, "c2c_pending");

    return { c, existing: { id: existingId }, pendingCookie };
  }

  it("keeps the existing session working and issues no new one", async () => {
    const { c, existing, pendingCookie } = await stagedConflict();

    const res = await request(c.app)
      .post("/api/auth/session/cancel")
      .set("Cookie", pendingCookie);

    expect(res.status).toBe(200);
    expect(await c.sessionStore.findActive(existing.id)).not.toBeNull();
    expect(cookieValue(res, "c2c_session")).toBeUndefined();
  });

  it("discards the pending session so Continue can no longer use it", async () => {
    const { c, pendingCookie } = await stagedConflict();

    await request(c.app).post("/api/auth/session/cancel").set("Cookie", pendingCookie);
    const res = await request(c.app)
      .post("/api/auth/session/continue")
      .set("Cookie", pendingCookie);

    expect(res.status).toBe(401);
    expect(c.sessionStore._pending.size).toBe(0);
  });

  it("is idempotent with no pending cookie", async () => {
    const { c } = await stagedConflict();
    const res = await request(c.app).post("/api/auth/session/cancel");
    expect(res.status).toBe(200);
  });

  it("audits the cancellation", async () => {
    const { c, pendingCookie } = await stagedConflict();

    await request(c.app).post("/api/auth/session/cancel").set("Cookie", pendingCookie);

    expect(c.audit.ofType("session_conflict_cancelled")).toHaveLength(1);
  });
});

describe("GET /api/auth/google/status", () => {
  it("reports authenticated:false with no cookie", async () => {
    const res = await request(ctx().app).get("/api/auth/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("reports authenticated:true and echoes sheet + count for a known user", async () => {
    mockGoogleLogin();
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1" })),
        findById: vi.fn(async () =>
          makeUser({ googleUserId: "u1", spreadsheetId: "sheet-1", savedContactsCount: 5 })
        ),
      }),
    });

    const login = await request(c.app).get("/api/auth/google/callback?code=abc");
    const res = await request(c.app)
      .get("/api/auth/google/status")
      .set("Cookie", cookieHeader(login, "c2c_session"));

    expect(res.body).toMatchObject({
      authenticated: true,
      email: "ada@analyticalengines.com",
      savedContactsCount: 5,
      spreadsheetUrl: expect.stringContaining("sheet-1"),
    });
  });

  it("flags needsReconnect when tokens were cleared", async () => {
    mockGoogleLogin();
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1" })),
        findById: vi.fn(async () =>
          makeUser({ googleUserId: "u1", accessToken: null, refreshToken: null })
        ),
      }),
    });

    const login = await request(c.app).get("/api/auth/google/callback?code=abc");
    const res = await request(c.app)
      .get("/api/auth/google/status")
      .set("Cookie", cookieHeader(login, "c2c_session"));

    expect(res.body.needsReconnect).toBe(true);
  });
});

describe("POST /api/auth/logout — Session Termination", () => {
  it("clears the session cookie and returns ok", async () => {
    const res = await request(ctx().app).post("/api/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["set-cookie"]?.[0]).toMatch(/c2c_session=;/);
  });

  /**
   * Before server-side sessions, logout only cleared the cookie — the id stayed
   * valid forever, so anyone who had captured it could keep using it. Now the
   * revocation IS the logout.
   */
  it("revokes the session server-side, so the same cookie 401s afterwards", async () => {
    mockGoogleLogin();
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1" })),
        findById: vi.fn(async () => makeUser({ googleUserId: "u1" })),
      }),
    });
    const login = await request(c.app).get("/api/auth/google/callback?code=abc");
    const cookie = cookieHeader(login, "c2c_session");

    await request(c.app).post("/api/auth/logout").set("Cookie", cookie);
    const after = await request(c.app).get("/api/auth/google/status").set("Cookie", cookie);

    // Not a silent downgrade to authenticated:false — an explicit rejection.
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("SESSION_REVOKED");
  });

  it("audits logout + session_terminated", async () => {
    mockGoogleLogin();
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1" })),
        findById: vi.fn(async () => makeUser({ googleUserId: "u1" })),
      }),
    });
    const login = await request(c.app).get("/api/auth/google/callback?code=abc");

    await request(c.app).post("/api/auth/logout").set("Cookie", cookieHeader(login, "c2c_session"));

    expect(c.audit.ofType("logout")).toHaveLength(1);
    expect(c.audit.ofType("session_terminated")).toEqual([
      expect.objectContaining({ reason: "logout" }),
    ]);
    expect(c.metrics.get("session_revoked", { reason: "logout" })).toBe(1);
  });
});

/**
 * The audit field policy, enforced end-to-end: an audit log must not leak the
 * very things it exists to protect.
 */
describe("audit field policy", () => {
  it("never records a token, an email, or a full session id", async () => {
    mockGoogleLogin();
    const c = ctx({
      userStore: makeUserStore({
        upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1" })),
        findById: vi.fn(async () => makeUser({ googleUserId: "u1" })),
      }),
    });
    const login = await request(c.app).get("/api/auth/google/callback?code=abc");
    await request(c.app).post("/api/auth/logout").set("Cookie", cookieHeader(login, "c2c_session"));

    const dumped = JSON.stringify(c.audit.entries);
    expect(dumped).not.toContain("access-token");
    expect(dumped).not.toContain("refresh-token");
    expect(dumped).not.toContain("ada@analyticalengines.com");

    // MemoryAuditLogger keeps full ids for test correlation; the stdout sink is
    // what truncates. Assert the policy where it is enforced.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { StdoutAuditLogger } = await import("../../src/shared/audit/audit-logger");
    new StdoutAuditLogger().log(c.audit.entries.find((e) => e.sessionId)!);
    const emitted = logSpy.mock.calls[0][0] as string;
    const fullId = c.audit.entries.find((e) => e.sessionId)!.sessionId!;
    expect(emitted).not.toContain(fullId);
    expect(JSON.parse(emitted).sessionId).toHaveLength(8);
    logSpy.mockRestore();
  });
});
