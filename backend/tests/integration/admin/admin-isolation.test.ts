import bcrypt from "bcrypt";
import request from "supertest";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE HIGHEST-VALUE ADMIN SUITE.
 *
 * Admin auth and Google auth are two independent identity systems sharing one
 * Express app, one cookie parser, and one signing secret. A regression that lets
 * either authenticate the other's routes is a privilege escalation, not a bug:
 * an admin cookie writing to a user's Google Sheet, or a signed-in end user
 * reaching an operator surface.
 *
 * Nothing in the code makes that impossible by construction — it is prevented by
 * three separate choices (a distinct cookie name, a distinct store, and a
 * distinct request property), any of which a future refactor could quietly
 * undo. These tests are what make that undo loud.
 *
 * Both sessions here are minted through the REAL routes (the Google callback and
 * the admin login), never hand-crafted: a forged cookie would fail on its
 * signature rather than on the check under test, and would pass for the wrong
 * reason.
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

vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: {
        create: vi.fn(async () => ({ data: { spreadsheetId: "new-sheet" } })),
        values: {
          update: vi.fn(async () => ({})),
          append: vi.fn(async () => ({})),
          get: vi.fn(async () => ({ data: { values: [["Name"]] } })),
        },
      },
    })),
    drive: vi.fn(() => ({ files: { get: vi.fn(async () => ({ data: { trashed: false } })) } })),
  },
}));

import { createApp } from "../../../src/app";
import { makeSessionStore, makeUserStore } from "../../mocks/stores";
import { makeUser } from "../../fixtures/contacts";
import { InMemoryAdminSessionStore } from "../../../src/shared/store/admin-session-store";

const ADMIN_USER = "admin";
const ADMIN_PASS = "correct-horse-battery-staple";

/** The signed-in user's id. Taken from the fixture so it cannot drift. */
const GOOGLE_USER_ID = makeUser().googleUserId;

const ENV = { ...process.env };
const open: InMemoryAdminSessionStore[] = [];

interface Ctx {
  app: Express;
  sessionStore: ReturnType<typeof makeSessionStore>;
}

function ctx(): Ctx {
  const adminSessionStore = new InMemoryAdminSessionStore();
  open.push(adminSessionStore);

  const sessionStore = makeSessionStore();
  const userStore = makeUserStore({
    findById: vi.fn(async () => makeUser()),
    upsertOnLogin: vi.fn(async () => makeUser()),
  });

  const app = createApp({
    userStore,
    sessionStore,
    audit: { log: () => {} },
    metrics: { inc: () => {} },
    adminSessionStore,
  });
  return { app, sessionStore };
}

/** Sign in through the REAL Google callback; returns the c2c_session cookie. */
async function googleLogin(app: Express): Promise<string> {
  getToken.mockResolvedValue({
    tokens: { id_token: "idtok", access_token: "at", refresh_token: "rt", expiry_date: 1 },
  });
  verifyIdToken.mockResolvedValue({
    getPayload: () => ({ sub: GOOGLE_USER_ID, email: makeUser().email }),
  });

  const res = await request(app).get("/api/auth/google/callback?code=abc");
  const setCookie = (res.headers["set-cookie"] as unknown as string[]) ?? [];
  const session = setCookie.find((c) => c.startsWith("c2c_session="));
  if (!session) throw new Error(`no user session cookie issued: ${JSON.stringify(setCookie)}`);
  return session.split(";")[0];
}

/** Log in through the REAL admin route; returns the admin_session cookie. */
async function adminLogin(app: Express): Promise<string> {
  const res = await request(app)
    .post("/api/admin/auth/login")
    .send({ username: ADMIN_USER, password: ADMIN_PASS });
  const setCookie = res.headers["set-cookie"] as unknown as string[];
  if (!setCookie) throw new Error(`no admin cookie issued: ${res.status}`);
  return setCookie[0].split(";")[0];
}

beforeEach(() => {
  process.env.ADMIN_USERNAME = ADMIN_USER;
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASS, 4);
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ENV };
  while (open.length) open.pop()?.stop();
});

describe("an admin session cannot authenticate user routes", () => {
  /**
   * X1. The escalation that matters most: requireAuth gates on req.auth, and the
   * admin guard must never populate it. If this fails, an operator's cookie can
   * write rows into an end user's Google Sheet.
   */
  it("X1: 401s POST /api/contacts/save with an admin cookie", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);

    const res = await request(app)
      .post("/api/contacts/save")
      .set("Cookie", admin)
      .send({ cardId: "c1", contact: { name: "Jane" } });

    expect(res.status).toBe(401);
  });

  it("X2: an admin cookie is anonymous to /api/auth/google/status", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);

    const res = await request(app).get("/api/auth/google/status").set("Cookie", admin);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("X5: an admin session id replayed as c2c_session does not authenticate", async () => {
    // The two stores are separate: an id minted by one is meaningless to the
    // other, even though both cookies are signed with the same secret. This is
    // why isolation lives in the store lookup, not the signature.
    const { app } = ctx();
    const admin = await adminLogin(app);
    const adminValue = admin.split("=")[1];

    const res = await request(app)
      .get("/api/auth/google/status")
      .set("Cookie", `c2c_session=${adminValue}`);

    expect(res.body).toEqual({ authenticated: false });
  });
});

describe("a user session cannot authenticate admin routes", () => {
  it("X3: 401s GET /api/admin/auth/me with a user cookie", async () => {
    const { app } = ctx();
    const user = await googleLogin(app);

    const res = await request(app).get("/api/admin/auth/me").set("Cookie", user);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "ADMIN_NOT_AUTHENTICATED" });
  });

  it("X6: a user session id replayed as admin_session does not authenticate", async () => {
    const { app } = ctx();
    const user = await googleLogin(app);
    const userValue = user.split("=")[1];

    const res = await request(app)
      .get("/api/admin/auth/me")
      .set("Cookie", `admin_session=${userValue}`);

    expect(res.status).toBe(401);
  });
});

describe("the two systems coexist without contaminating each other", () => {
  /**
   * X4. The proof they are orthogonal rather than merely ordered: one browser,
   * both cookies, each route resolving its own identity and ignoring the other.
   */
  it("X4: with BOTH cookies, each route authenticates its own identity", async () => {
    const { app } = ctx();
    const user = await googleLogin(app);
    const admin = await adminLogin(app);
    const both = `${user}; ${admin}`;

    const me = await request(app).get("/api/admin/auth/me").set("Cookie", both);
    const status = await request(app).get("/api/auth/google/status").set("Cookie", both);

    expect(me.status).toBe(200);
    expect(me.body).toEqual({ username: ADMIN_USER });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ authenticated: true });
  });

  it("X7: admin logout leaves the user session untouched", async () => {
    const { app } = ctx();
    const user = await googleLogin(app);
    const admin = await adminLogin(app);

    await request(app).post("/api/admin/auth/logout").set("Cookie", `${user}; ${admin}`);

    const status = await request(app).get("/api/auth/google/status").set("Cookie", user);
    expect(status.body).toMatchObject({ authenticated: true });
  });

  it("X8: user logout leaves the admin session untouched", async () => {
    const { app } = ctx();
    const user = await googleLogin(app);
    const admin = await adminLogin(app);

    await request(app).post("/api/auth/logout").set("Cookie", `${user}; ${admin}`);

    const me = await request(app).get("/api/admin/auth/me").set("Cookie", admin);
    expect(me.status).toBe(200);
  });
});

describe("X9: a revoked Google session must not break the admin panel", () => {
  /**
   * The bug this whole guard exists for — confirmed empirically before the fix:
   * createSessionMiddleware is GLOBAL and rejects any request whose cookie names
   * a revoked session, whatever the path. Without the /api/admin early-return,
   * an operator whose Google session was replaced on another device is locked
   * out of the admin panel, and told "you signed in on another device" — which
   * is true, and completely irrelevant to the admin route they asked for.
   *
   * Deleting that guard fails this test.
   */
  it("X9: /api/admin/auth/me still works when the user's session was revoked", async () => {
    const { app, sessionStore } = ctx();
    const user = await googleLogin(app);
    const admin = await adminLogin(app);

    // Session Replacement: the operator signed in as a user somewhere else.
    const revoked = await sessionStore.revokeAllForUser(GOOGLE_USER_ID, "replaced_by_new_login");
    expect(revoked).toBeGreaterThan(0);

    const me = await request(app).get("/api/admin/auth/me").set("Cookie", `${user}; ${admin}`);

    expect(me.status).toBe(200);
    expect(me.body).toEqual({ username: ADMIN_USER });
  });

  it("X9b: the user route still reports the revocation (the guard did not widen)", async () => {
    // The other half: the fix must not have suppressed SESSION_REVOKED anywhere
    // it is genuinely needed. /status is what the frontend polls on window focus.
    const { app, sessionStore } = ctx();
    const user = await googleLogin(app);
    await sessionStore.revokeAllForUser(GOOGLE_USER_ID, "replaced_by_new_login");

    const status = await request(app).get("/api/auth/google/status").set("Cookie", user);

    expect(status.status).toBe(401);
    expect(status.body).toMatchObject({ code: "SESSION_REVOKED" });
  });

  it("X9c: admin login itself works while a revoked user cookie is present", async () => {
    const { app, sessionStore } = ctx();
    const user = await googleLogin(app);
    await sessionStore.revokeAllForUser(GOOGLE_USER_ID, "replaced_by_new_login");

    const res = await request(app)
      .post("/api/admin/auth/login")
      .set("Cookie", user)
      .send({ username: ADMIN_USER, password: ADMIN_PASS });

    expect(res.status).toBe(200);
  });
});
