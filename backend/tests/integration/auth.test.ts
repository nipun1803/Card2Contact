import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * Integration test for the google-auth router + session middleware, with
 * google-auth-library mocked so no real OAuth happens. Covers:
 *   - GET /api/auth/google → 302 redirect to Google's consent screen
 *   - GET /api/auth/google/callback → exchanges code, sets session cookie,
 *     provisions a sheet on first login, redirects to the frontend
 *   - GET /api/auth/google/status → reflects authenticated state
 *   - POST /api/auth/logout → clears the cookie
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
// provisioning; stub the create/update calls.
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
  },
}));

import { createApp } from "../../src/app";
import { makeUserStore } from "../mocks/stores";
import { makeUser } from "../fixtures/contacts";
import type { UserStore } from "../../src/shared/store/user-store";

function appWith(userStore: UserStore) {
  return createApp({ userStore });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/google", () => {
  it("redirects (302) to the Google consent URL", async () => {
    const res = await request(appWith(makeUserStore())).get("/api/auth/google");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("accounts.google.com");
  });
});

describe("GET /api/auth/google/callback", () => {
  it("rejects a callback without an authorization code (400)", async () => {
    const res = await request(appWith(makeUserStore())).get("/api/auth/google/callback");
    expect(res.status).toBe(400);
  });

  it("exchanges the code, sets a session cookie, and redirects to the frontend", async () => {
    getToken.mockResolvedValue({
      tokens: { id_token: "idtok", access_token: "at", refresh_token: "rt", expiry_date: 1 },
    });
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "u1", email: "ada@example.com" }),
    });
    // upsert returns a user WITHOUT a spreadsheet → triggers provisioning.
    // Provisioning keys off the RETURNED user's googleUserId (fixture: "user-1"),
    // not the id_token sub, so assert against the stored record's id.
    const userStore = makeUserStore({
      upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "user-1", spreadsheetId: null })),
    });

    const res = await request(appWith(userStore)).get(
      "/api/auth/google/callback?code=abc",
    );

    expect(res.status).toBe(302);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/c2c_session=/);
    expect(userStore.setSpreadsheetId).toHaveBeenCalledWith("user-1", "new-sheet");
  });
});

describe("GET /api/auth/google/status", () => {
  it("reports authenticated:false with no cookie", async () => {
    const res = await request(appWith(makeUserStore())).get("/api/auth/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("reports authenticated:true and echoes sheet + count for a known user", async () => {
    const userStore = makeUserStore({
      findById: vi.fn(async () => makeUser({ spreadsheetId: "sheet-1", savedContactsCount: 5 })),
    });
    const app = appWith(userStore);

    // Obtain a valid signed cookie by logging in through the callback first.
    getToken.mockResolvedValue({
      tokens: { id_token: "idtok", access_token: "at", refresh_token: "rt", expiry_date: 1 },
    });
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "u1", email: "ada@example.com" }) });
    const login = await request(app).get("/api/auth/google/callback?code=abc");
    const cookie = login.headers["set-cookie"];

    const res = await request(app).get("/api/auth/google/status").set("Cookie", cookie);

    expect(res.body).toMatchObject({
      authenticated: true,
      email: "ada@analyticalengines.com",
      savedContactsCount: 5,
      spreadsheetUrl: expect.stringContaining("sheet-1"),
    });
  });

  it("flags needsReconnect when tokens were cleared", async () => {
    const userStore = makeUserStore({
      findById: vi.fn(async () =>
        makeUser({ accessToken: null, refreshToken: null }),
      ),
      upsertOnLogin: vi.fn(async () => makeUser()),
    });
    const app = appWith(userStore);
    getToken.mockResolvedValue({ tokens: { id_token: "t", access_token: "at", refresh_token: "rt" } });
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "u1", email: "e@x.com" }) });
    const login = await request(app).get("/api/auth/google/callback?code=abc");

    const res = await request(app)
      .get("/api/auth/google/status")
      .set("Cookie", login.headers["set-cookie"]);

    expect(res.body.needsReconnect).toBe(true);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie and returns ok", async () => {
    const res = await request(appWith(makeUserStore())).post("/api/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["set-cookie"]?.[0]).toMatch(/c2c_session=;/);
  });
});
