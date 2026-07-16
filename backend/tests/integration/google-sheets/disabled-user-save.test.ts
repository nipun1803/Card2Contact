import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * Admin User Management (Phase 1): the M5 save gate. A user disabled
 * mid-session (their session was NOT force-revoked, e.g. the admin used
 * disable() but this row is being re-read fresh) must not be able to save
 * contacts. `req.auth.user` already carries `disabledAt` — no extra store
 * call, the session middleware loaded the full record.
 */

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    generateAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/auth?mock"),
    getToken: vi.fn(async () => ({
      tokens: { id_token: "idtok", access_token: "at", refresh_token: "rt", expiry_date: 1 },
    })),
    verifyIdToken: vi.fn(async () => ({
      getPayload: () => ({ sub: "u1", email: "ada@example.com" }),
    })),
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
          get: vi.fn(async () => ({
            data: {
              values: [
                ["Name", "Designation", "Phone", "Email", "Company", "Address", "Note", "Category"],
              ],
            },
          })),
        },
      },
    })),
    drive: vi.fn(() => ({ files: { get: vi.fn(async () => ({ data: { trashed: false } })) } })),
  },
}));

import { createApp } from "../../../src/app";
import { cardSessionStore } from "../../../src/shared/store/card-session-store";
import { makeSessionStore, makeUserStore } from "../../mocks/stores";
import { makeUser } from "../../fixtures/contacts";
import { createEmptyContact } from "../../../src/shared/types/contact";
import type { UserRecord } from "../../../src/shared/store/user-store";

async function setup(disabled: boolean) {
  let stored: UserRecord = makeUser({
    googleUserId: "u1",
    spreadsheetId: "sheet-1",
    disabledAt: disabled ? new Date() : null,
    disabledBy: disabled ? "admin" : null,
  });

  const sessionStore = makeSessionStore();
  const userStore = makeUserStore({
    upsertOnLogin: vi.fn(async () => stored),
    findById: vi.fn(async () => stored),
  });
  const app = createApp({
    userStore,
    sessionStore,
    audit: { log: () => {} },
    metrics: { inc: () => {} },
  });

  // Log in while the user is NOT yet disabled — a disabled user's OAuth
  // callback is separately gated (see disabled-user.test.ts); this test
  // exercises "disabled mid-session", i.e. the M5 gate specifically.
  if (disabled) stored = { ...stored, disabledAt: null, disabledBy: null };
  const login = await request(app).get("/api/auth/google/callback?code=abc");
  const cookie = (login.headers["set-cookie"] as unknown as string[]).find((c) =>
    c.startsWith("c2c_session=")
  )!;

  // Now flip to disabled, simulating an admin action mid-session.
  if (disabled) stored = { ...stored, disabledAt: new Date(), disabledBy: "admin" };

  const session = cardSessionStore.create("single", Buffer.from("img"), null);
  cardSessionStore.update(session.cardId, {
    contact: { ...createEmptyContact(), name: "Ada" },
    confirmed: true,
  });

  return { app, cookie, cardId: session.cardId };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("M5 save gate — disabled user", () => {
  it("G1: 403s USER_DISABLED for a user disabled mid-session", async () => {
    const s = await setup(true);

    const res = await request(s.app)
      .post("/api/contacts/save")
      .set("Cookie", s.cookie)
      .send({ cardId: s.cardId, contact: { name: "Ada" } });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "USER_DISABLED" });
  });

  it("an active (non-disabled) user can still save normally", async () => {
    const s = await setup(false);

    const res = await request(s.app)
      .post("/api/contacts/save")
      .set("Cookie", s.cookie)
      .send({ cardId: s.cardId, contact: { name: "Ada" } });

    expect(res.status).toBe(200);
  });
});
