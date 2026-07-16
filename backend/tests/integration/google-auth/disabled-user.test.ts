import { describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Admin User Management (Phase 1): a disabled user must not be able to create
 * a new Google session (sign-in or Reconnect), even though their OAuth
 * callback exchange itself succeeds.
 */

const getToken = vi.fn();
const verifyIdToken = vi.fn();

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    generateAuthUrl: vi.fn(),
    getToken,
    verifyIdToken,
    setCredentials: vi.fn(),
    on: vi.fn(),
  })),
}));
vi.mock("googleapis", () => ({ google: { sheets: vi.fn(), drive: vi.fn() } }));

import { createApp } from "../../../src/app";
import { makeSessionStore, makeUserStore } from "../../mocks/stores";
import { makeUser } from "../../fixtures/contacts";
import { MemoryAuditLogger } from "../../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../../src/shared/observability/metrics";

function mockGoogleLogin(sub = "u1", email = "ada@example.com") {
  getToken.mockResolvedValue({
    tokens: { id_token: "idtok", access_token: "at", refresh_token: "rt", expiry_date: 1 },
  });
  verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub, email }) });
}

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? (raw as string[]) : [raw as string];
}

describe("a disabled user's OAuth callback", () => {
  it("D1: gets 403 USER_DISABLED and no session cookie is set", async () => {
    const disabledUser = makeUser({ disabledAt: new Date(), disabledBy: "admin" });
    const userStore = makeUserStore({ upsertOnLogin: vi.fn(async () => disabledUser) });
    const sessionStore = makeSessionStore();
    const audit = new MemoryAuditLogger();
    const metrics = new MemoryMetrics();
    const app = createApp({ userStore, sessionStore, audit, metrics });
    mockGoogleLogin(disabledUser.googleUserId, disabledUser.email);

    const res = await request(app).get("/api/auth/google/callback?code=abc");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "USER_DISABLED" });
    expect(setCookies(res).some((c) => c.startsWith("c2c_session="))).toBe(false);
  });

  it("D2: logs auth_failure with reason user_disabled", async () => {
    const disabledUser = makeUser({ disabledAt: new Date(), disabledBy: "admin" });
    const userStore = makeUserStore({ upsertOnLogin: vi.fn(async () => disabledUser) });
    const sessionStore = makeSessionStore();
    const audit = new MemoryAuditLogger();
    const metrics = new MemoryMetrics();
    const app = createApp({ userStore, sessionStore, audit, metrics });
    mockGoogleLogin(disabledUser.googleUserId, disabledUser.email);

    await request(app).get("/api/auth/google/callback?code=abc");

    const entries = audit.ofType("auth_failure");
    expect(entries.some((e) => e.reason === "user_disabled")).toBe(true);
    expect(metrics.get("auth_failure", { reason: "user_disabled" })).toBe(1);
  });

  it("does not create a new session even if one already exists (no Session Conflict entered)", async () => {
    const disabledUser = makeUser({ disabledAt: new Date(), disabledBy: "admin" });
    const userStore = makeUserStore({ upsertOnLogin: vi.fn(async () => disabledUser) });
    const sessionStore = makeSessionStore();
    sessionStore._seed({ googleUserId: disabledUser.googleUserId });
    const app = createApp({
      userStore,
      sessionStore,
      audit: { log: () => {} },
      metrics: { inc: () => {} },
    });
    mockGoogleLogin(disabledUser.googleUserId, disabledUser.email);

    const res = await request(app).get("/api/auth/google/callback?code=abc");

    expect(res.status).toBe(403);
    expect(sessionStore.createPending).not.toHaveBeenCalled();
  });
});

describe("an active (non-disabled) user's OAuth callback", () => {
  it("still succeeds normally — the gate doesn't over-block", async () => {
    const activeUser = makeUser({ disabledAt: null });
    const userStore = makeUserStore({ upsertOnLogin: vi.fn(async () => activeUser) });
    const sessionStore = makeSessionStore();
    const app = createApp({
      userStore,
      sessionStore,
      audit: { log: () => {} },
      metrics: { inc: () => {} },
    });
    mockGoogleLogin(activeUser.googleUserId, activeUser.email);

    const res = await request(app).get("/api/auth/google/callback?code=abc");

    expect(res.status).toBe(302);
    expect(setCookies(res).some((c) => c.startsWith("c2c_session="))).toBe(true);
  });
});
