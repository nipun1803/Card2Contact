import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * The refresh-token failure policy, end to end.
 *
 * Before this, `classifyGoogleError` threw ReauthRequiredError on
 * invalid_grant but NOTHING ever nulled the stored tokens — so
 * needsReconnect (which checks accessToken === null && refreshToken === null)
 * was permanently false and the proactive Reconnect prompt was unreachable.
 * These tests pin the closed loop.
 *
 * The other half of the policy: the session SURVIVES. Losing Google access is
 * not losing your card2contact session.
 */

const appendRow = vi.fn();

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
          append: appendRow,
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
    drive: vi.fn(() => ({
      files: { get: vi.fn(async () => ({ data: { trashed: false } })) },
    })),
  },
}));

import { createApp } from "../../src/app";
import { cardSessionStore } from "../../src/shared/store/card-session-store";
import { makeSessionStore, makeUserStore } from "../mocks/stores";
import { makeUser } from "../fixtures/contacts";
import { createEmptyContact } from "../../src/shared/types/contact";
import { MemoryAuditLogger } from "../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../src/shared/observability/metrics";
import type { UserRecord } from "../../src/shared/store/user-store";

/** Google's response when a refresh token has been revoked by the user. */
function invalidGrant() {
  return Object.assign(new Error("invalid_grant"), {
    response: { status: 400, data: { error: "invalid_grant" } },
  });
}

async function setup() {
  // Mutable so the store can reflect clearTokens the way Postgres would.
  let stored: UserRecord = makeUser({ googleUserId: "u1", spreadsheetId: "sheet-1" });

  const sessionStore = makeSessionStore();
  const userStore = makeUserStore({
    upsertOnLogin: vi.fn(async () => stored),
    findById: vi.fn(async () => stored),
    clearTokens: vi.fn(async () => {
      stored = { ...stored, accessToken: null, refreshToken: null, tokenExpiry: null };
    }),
  });
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const app = createApp({ userStore, sessionStore, audit, metrics });

  const login = await request(app).get("/api/auth/google/callback?code=abc");
  const cookie = (login.headers["set-cookie"] as unknown as string[]).find((c) =>
    c.startsWith("c2c_session=")
  )!;
  const sessionId = decodeURIComponent(cookie.split(";")[0].split("=")[1])
    .slice(2)
    .split(".")[0];

  // A confirmed card, ready for M5 to save.
  const session = cardSessionStore.create("single", Buffer.from("img"), null);
  cardSessionStore.update(session.cardId, {
    contact: { ...createEmptyContact(), name: "Ada" },
    confirmed: true,
  });

  return { app, userStore, sessionStore, audit, metrics, cookie, sessionId, cardId: session.cardId };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("save when Google rejects the refresh token", () => {
  it("returns 401 REAUTH_REQUIRED", async () => {
    const s = await setup();
    appendRow.mockRejectedValue(invalidGrant());

    const res = await request(s.app)
      .post("/api/contacts/save")
      .set("Cookie", s.cookie)
      .send({ cardId: s.cardId, contact: { name: "Ada" } });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("REAUTH_REQUIRED");
  });

  it("nulls the stored tokens", async () => {
    const s = await setup();
    appendRow.mockRejectedValue(invalidGrant());

    await request(s.app)
      .post("/api/contacts/save")
      .set("Cookie", s.cookie)
      .send({ cardId: s.cardId, contact: { name: "Ada" } });

    expect(s.userStore.clearTokens).toHaveBeenCalledWith("u1");
  });

  /**
   * The closed loop: before this policy, needsReconnect could never become
   * true, so the dashboard's Reconnect prompt was dead code.
   */
  it("makes /status report needsReconnect, so the prompt appears proactively", async () => {
    const s = await setup();
    appendRow.mockRejectedValue(invalidGrant());

    const before = await request(s.app).get("/api/auth/google/status").set("Cookie", s.cookie);
    expect(before.body.needsReconnect).toBe(false);

    await request(s.app)
      .post("/api/contacts/save")
      .set("Cookie", s.cookie)
      .send({ cardId: s.cardId, contact: { name: "Ada" } });

    const after = await request(s.app).get("/api/auth/google/status").set("Cookie", s.cookie);
    expect(after.body.needsReconnect).toBe(true);
  });

  // The other half of the policy. Only logout and Session Replacement revoke.
  it("leaves the session Active — the user stays signed in", async () => {
    const s = await setup();
    appendRow.mockRejectedValue(invalidGrant());

    await request(s.app)
      .post("/api/contacts/save")
      .set("Cookie", s.cookie)
      .send({ cardId: s.cardId, contact: { name: "Ada" } });

    expect(await s.sessionStore.isRevoked(s.sessionId)).toBe(false);
    const status = await request(s.app).get("/api/auth/google/status").set("Cookie", s.cookie);
    expect(status.status).toBe(200);
    expect(status.body.authenticated).toBe(true);
  });

  it("audits token_refresh_failed and counts both metrics", async () => {
    const s = await setup();
    appendRow.mockRejectedValue(invalidGrant());

    await request(s.app)
      .post("/api/contacts/save")
      .set("Cookie", s.cookie)
      .send({ cardId: s.cardId, contact: { name: "Ada" } });

    expect(s.audit.ofType("token_refresh_failed")).toEqual([
      expect.objectContaining({ googleUserId: "u1", reason: "invalid_grant" }),
    ]);
    expect(s.metrics.get("token_refresh_failure")).toBe(1);
    // Drives the "how often does Google access lapse?" signal.
    expect(s.metrics.get("reconnect_required")).toBe(1);
  });
});

describe("a successful save", () => {
  it("does not clear tokens or flag needsReconnect", async () => {
    const s = await setup();
    appendRow.mockResolvedValue({});

    const res = await request(s.app)
      .post("/api/contacts/save")
      .set("Cookie", s.cookie)
      .send({ cardId: s.cardId, contact: { name: "Ada" } });

    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(s.userStore.clearTokens).not.toHaveBeenCalled();

    const status = await request(s.app).get("/api/auth/google/status").set("Cookie", s.cookie);
    expect(status.body.needsReconnect).toBe(false);
  });

  it("audits contact_save with the cardId but no contact data", async () => {
    const s = await setup();
    appendRow.mockResolvedValue({});

    await request(s.app)
      .post("/api/contacts/save")
      .set("Cookie", s.cookie)
      .send({ cardId: s.cardId, contact: { name: "Ada" } });

    expect(s.audit.ofType("contact_save")).toEqual([
      expect.objectContaining({ googleUserId: "u1", cardId: s.cardId, outcome: "success" }),
    ]);
    // The scanned contact belongs to our user's customer — never ours to log.
    expect(JSON.stringify(s.audit.entries)).not.toContain("Ada");
  });
});
