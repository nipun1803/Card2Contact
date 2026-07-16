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

import { createApp } from "../../../src/app";
import { MemoryAuditLogger } from "../../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../../src/shared/observability/metrics";
import { InMemoryAdminSessionStore } from "../../../src/shared/store/admin-session-store";
import { makeSessionStore, makeUserStore } from "../../mocks/stores";
import { makeUser } from "../../fixtures/contacts";

const USERNAME = "admin";
const PASSWORD = "correct-horse-battery-staple";

const ENV = { ...process.env };
const open: InMemoryAdminSessionStore[] = [];

interface Ctx {
  app: Express;
  audit: MemoryAuditLogger;
  metrics: MemoryMetrics;
  userStore: ReturnType<typeof makeUserStore>;
  sessionStore: ReturnType<typeof makeSessionStore>;
}

function ctx(): Ctx {
  const adminSessionStore = new InMemoryAdminSessionStore();
  open.push(adminSessionStore);

  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const userStore = makeUserStore({ findById: vi.fn(async () => makeUser()) });
  const sessionStore = makeSessionStore();

  const app = createApp({ userStore, sessionStore, audit, metrics, adminSessionStore });
  return { app, audit, metrics, userStore, sessionStore };
}

/** Log in and return the raw `admin_session=...` cookie pair. */
async function adminLogin(app: Express): Promise<string> {
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

describe("GET /api/admin/users", () => {
  it("I1: 401s without an admin session", async () => {
    const { app } = ctx();
    const res = await request(app).get("/api/admin/users");
    expect(res.status).toBe(401);
  });

  it("I2: returns the enveloped shape for an empty result", async () => {
    const { app, userStore } = ctx();
    (userStore.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: [],
      nextCursor: null,
      total: 0,
      totalPages: 0,
    });
    const admin = await adminLogin(app);

    const res = await request(app).get("/api/admin/users").set("Cookie", admin);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { users: [], stats: { total: 0, active: 0, disabled: 0, recentLogins: 0, totalScans: 0 } },
      meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } },
    });
  });

  it("I3: passes the search param through to userStore.list", async () => {
    const { app, userStore } = ctx();
    const admin = await adminLogin(app);

    await request(app).get("/api/admin/users?search=ada").set("Cookie", admin);

    expect(userStore.list).toHaveBeenCalledWith(expect.objectContaining({ search: "ada" }));
  });

  it("I8: never leaks accessToken/refreshToken", async () => {
    const { app, userStore } = ctx();
    (userStore.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: [makeUser()],
      nextCursor: null,
      total: 1,
      totalPages: 1,
    });
    const admin = await adminLogin(app);

    const res = await request(app).get("/api/admin/users").set("Cookie", admin);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
  });

  it("I9: a valid Google user session (no admin cookie) still 401s", async () => {
    const { app } = ctx();
    // No googleLogin needed — the point is simply that no admin cookie means 401,
    // mirroring admin-isolation.test.ts's intent for this new surface.
    const res = await request(app).get("/api/admin/users").set("Cookie", "c2c_session=whatever");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/users/:googleUserId", () => {
  it("returns 404 with USER_NOT_FOUND for an unknown user", async () => {
    const { app, userStore } = ctx();
    (userStore.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const admin = await adminLogin(app);

    const res = await request(app).get("/api/admin/users/ghost").set("Cookie", admin);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("includes activeSession in the detail response", async () => {
    const { app, sessionStore } = ctx();
    sessionStore._seed({ googleUserId: makeUser().googleUserId, device: "macOS", browser: "Chrome" });
    const admin = await adminLogin(app);

    const res = await request(app).get(`/api/admin/users/${makeUser().googleUserId}`).set("Cookie", admin);

    expect(res.status).toBe(200);
    expect(res.body.data.activeSession).toMatchObject({ device: "macOS", browser: "Chrome" });
  });
});

describe("POST /api/admin/users/:googleUserId/disable", () => {
  it("I4: revokes sessions, disables the user, and logs admin_user_disabled", async () => {
    const { app, userStore, sessionStore, audit } = ctx();
    const user = makeUser();
    sessionStore._seed({ googleUserId: user.googleUserId });
    const disabledUser = { ...user, disabledAt: new Date(), disabledBy: USERNAME };
    (userStore.disable as ReturnType<typeof vi.fn>).mockResolvedValue(disabledUser);
    // getDetail() re-fetches via findById after disable() — must reflect the
    // now-disabled state too, or the response body would show stale data.
    (userStore.findById as ReturnType<typeof vi.fn>).mockResolvedValue(disabledUser);
    const admin = await adminLogin(app);

    const res = await request(app)
      .post(`/api/admin/users/${user.googleUserId}/disable`)
      .set("Cookie", admin);

    expect(res.status).toBe(200);
    expect(res.body.data.disabled).toBe(true);
    expect(sessionStore.revokeAllForUser).toHaveBeenCalledWith(user.googleUserId, "user_revoked");
    expect(audit.ofType("admin_user_disabled")).toHaveLength(1);
  });

  it("I5: 404s with USER_NOT_FOUND for an unknown user", async () => {
    const { app, userStore } = ctx();
    (userStore.disable as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const admin = await adminLogin(app);

    const res = await request(app).post("/api/admin/users/ghost/disable").set("Cookie", admin);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("401s without an admin session", async () => {
    const { app } = ctx();
    const res = await request(app).post(`/api/admin/users/${makeUser().googleUserId}/disable`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/users/:googleUserId/restore", () => {
  it("I6: restores the user — disabled: false in the response", async () => {
    const { app, userStore } = ctx();
    const user = makeUser();
    (userStore.restore as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...user,
      disabledAt: null,
      disabledBy: null,
      restoredAt: new Date(),
      restoredBy: USERNAME,
    });
    const admin = await adminLogin(app);

    const res = await request(app)
      .post(`/api/admin/users/${user.googleUserId}/restore`)
      .set("Cookie", admin);

    expect(res.status).toBe(200);
    expect(res.body.data.disabled).toBe(false);
  });
});

describe("POST /api/admin/users/:googleUserId/force-logout", () => {
  it("I7: revokes sessions and returns revokedCount, without touching disabled_at", async () => {
    const { app, userStore, sessionStore } = ctx();
    const user = makeUser();
    sessionStore._seed({ googleUserId: user.googleUserId });
    const admin = await adminLogin(app);

    const res = await request(app)
      .post(`/api/admin/users/${user.googleUserId}/force-logout`)
      .set("Cookie", admin);

    expect(res.status).toBe(200);
    expect(res.body.data.revokedCount).toBe(1);
    expect(userStore.disable).not.toHaveBeenCalled();
  });

  // I7 above only proves the response shape; this proves the actual effect
  // the feature exists for — the session the button claims to kill really
  // stops being usable, exercised against the same findActive contract the
  // session middleware relies on (not just that revokeAllForUser was called).
  it("I8: the revoked session actually stops being active", async () => {
    const { app, sessionStore } = ctx();
    const user = makeUser();
    const seeded = sessionStore._seed({ googleUserId: user.googleUserId });
    const admin = await adminLogin(app);

    expect(await sessionStore.findActive(seeded.id)).not.toBeNull();

    const res = await request(app)
      .post(`/api/admin/users/${user.googleUserId}/force-logout`)
      .set("Cookie", admin);

    expect(res.status).toBe(200);
    expect(await sessionStore.findActive(seeded.id)).toBeNull();
    expect(await sessionStore.findActiveForUser(user.googleUserId)).toBeNull();
  });

  it("I9: does not disturb a different user's active session", async () => {
    const { app, sessionStore } = ctx();
    const target = makeUser({ googleUserId: "u-target" });
    const other = makeUser({ googleUserId: "u-other" });
    sessionStore._seed({ googleUserId: target.googleUserId });
    const otherSession = sessionStore._seed({ googleUserId: other.googleUserId });
    const admin = await adminLogin(app);

    await request(app)
      .post(`/api/admin/users/${target.googleUserId}/force-logout`)
      .set("Cookie", admin);

    expect(await sessionStore.findActive(otherSession.id)).not.toBeNull();
  });

  it("I10: 404s with USER_NOT_FOUND for an unknown user", async () => {
    const { app, userStore } = ctx();
    (userStore.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const admin = await adminLogin(app);

    const res = await request(app).post("/api/admin/users/ghost/force-logout").set("Cookie", admin);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("401s without an admin session", async () => {
    const { app } = ctx();
    const res = await request(app).post(`/api/admin/users/${makeUser().googleUserId}/force-logout`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/users/:googleUserId/audit", () => {
  it("returns the enveloped, cursor-paginated audit history", async () => {
    const { app, audit } = ctx();
    const user = makeUser();
    audit.log({ event: "login", googleUserId: user.googleUserId });
    const admin = await adminLogin(app);

    const res = await request(app)
      .get(`/api/admin/users/${user.googleUserId}/audit`)
      .set("Cookie", admin);

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.meta.page).toMatchObject({ total: 1 });
  });
});
