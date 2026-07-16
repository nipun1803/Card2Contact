import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * The cross-cutting behaviour of a revoked session, proven at the HTTP layer.
 *
 * The design decision under test: the session middleware — not requireAuth —
 * rejects revoked sessions. requireAuth guards only POST /api/contacts/save,
 * but the endpoint that actually notices a Session Replacement is the PUBLIC
 * GET /api/auth/google/status (refetched on window focus). If the 401 came from
 * requireAuth, a revoked device would sit on the dashboard showing stale data
 * until it happened to try a save.
 *
 * The counterweight: the middleware must stay permissive for genuinely
 * anonymous requests, or the public M1–M4 pipeline breaks for logged-out users.
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
import { MemoryAuditLogger } from "../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../src/shared/observability/metrics";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function setup() {
  const sessionStore = makeSessionStore();
  const userStore = makeUserStore({
    upsertOnLogin: vi.fn(async () => makeUser({ googleUserId: "u1" })),
    findById: vi.fn(async () => makeUser({ googleUserId: "u1" })),
  });
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const app = createApp({ userStore, sessionStore, audit, metrics });

  // Sign in for a genuinely signed cookie — a hand-crafted one would be
  // rejected by the signature check rather than by revocation, and every
  // assertion below would pass for the wrong reason.
  const login = await request(app).get("/api/auth/google/callback?code=abc");
  const cookie = (login.headers["set-cookie"] as unknown as string[]).find((c) =>
    c.startsWith("c2c_session=")
  )!;
  const sessionId = decodeURIComponent(cookie.split(";")[0].split("=")[1])
    .slice(2)
    .split(".")[0];

  return { app, sessionStore, audit, metrics, cookie, sessionId };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a revoked session is rejected everywhere it is presented", () => {
  // The one that matters: /status is public and is what React Query refetches
  // on window focus, so this is how the revoked device finds out at all.
  it("401s SESSION_REVOKED on the public /status", async () => {
    const { app, sessionStore, cookie, sessionId } = await setup();
    await sessionStore.revoke(sessionId, "replaced_by_new_login");

    const res = await request(app).get("/api/auth/google/status").set("Cookie", cookie);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REVOKED");
    expect(res.body.error).toMatch(/another device/i);
  });

  // The message must be honest about WHY the session ended. Reusing the
  // "another device" wording for an admin's Revoke Access / Force Logout
  // would tell the user something false — nobody signed in anywhere.
  it("401s a DIFFERENT message — not 'another device' — when an admin revoked it", async () => {
    const { app, sessionStore, cookie, sessionId } = await setup();
    await sessionStore.revoke(sessionId, "user_revoked");

    const res = await request(app).get("/api/auth/google/status").set("Cookie", cookie);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REVOKED");
    expect(res.body.error).toMatch(/administrator/i);
    expect(res.body.error).not.toMatch(/another device/i);
  });

  it("still says 'another device' for a real Session Replacement (logout reason unaffected)", async () => {
    const { app, sessionStore, cookie, sessionId } = await setup();
    await sessionStore.revoke(sessionId, "logout");

    const res = await request(app).get("/api/auth/google/status").set("Cookie", cookie);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/another device/i);
  });

  it("401s SESSION_REVOKED on the guarded /contacts/save", async () => {
    const { app, sessionStore, cookie, sessionId } = await setup();
    await sessionStore.revoke(sessionId, "replaced_by_new_login");

    const res = await request(app)
      .post("/api/contacts/save")
      .set("Cookie", cookie)
      .send({ cardId: "card-1", contact: {} });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REVOKED");
  });

  // Even on routes that never required auth: presenting a revoked cookie is an
  // affirmative claim to be signed in, and deserves an honest answer.
  it("401s SESSION_REVOKED on the public M1 upload", async () => {
    const { app, sessionStore, cookie, sessionId } = await setup();
    await sessionStore.revoke(sessionId, "logout");

    const res = await request(app)
      .post("/api/cards")
      .set("Cookie", cookie)
      .field("mode", "single")
      .attach("frontImage", PNG, "card.png");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REVOKED");
  });

  it("clears the cookie so the dead id stops being re-sent", async () => {
    const { app, sessionStore, cookie, sessionId } = await setup();
    await sessionStore.revoke(sessionId, "logout");

    const res = await request(app).get("/api/auth/google/status").set("Cookie", cookie);

    expect((res.headers["set-cookie"] as unknown as string[])[0]).toMatch(/c2c_session=;/);
  });

  it("audits and counts the rejection", async () => {
    const { app, sessionStore, audit, metrics, cookie, sessionId } = await setup();
    await sessionStore.revoke(sessionId, "replaced_by_new_login");

    await request(app).get("/api/auth/google/status").set("Cookie", cookie);

    expect(audit.ofType("auth_failure")).toEqual([
      expect.objectContaining({ reason: "session_revoked" }),
    ]);
    expect(metrics.get("auth_failure", { reason: "session_revoked" })).toBe(1);
  });
});

/**
 * The permissiveness regression. If the middleware rejected more broadly than
 * "a cookie naming a known-revoked session", the public pipeline would break
 * for every logged-out user.
 */
describe("anonymous requests still work", () => {
  // The scan pipeline is now metered per user (License Management), so M1 upload
  // requires a signed-in user. A cookieless upload is 401 NotAuthenticated —
  // NOT SESSION_REVOKED (that is only for a cookie naming a known-revoked
  // session). This documents the M1 auth change without weakening the
  // middleware's "unknown/absent cookie ⇒ anonymous, never revoked" rule.
  it("401s a cookieless M1 upload as NotAuthenticated (not SESSION_REVOKED)", async () => {
    const { app } = await setup();

    const res = await request(app)
      .post("/api/cards")
      .field("mode", "single")
      .attach("frontImage", PNG, "card.png");

    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
  });

  it("answers /status with authenticated:false and no error", async () => {
    const { app } = await setup();
    const res = await request(app).get("/api/auth/google/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("401s NotAuthenticated — not SESSION_REVOKED — on a guarded route", async () => {
    const { app } = await setup();

    const res = await request(app)
      .post("/api/contacts/save")
      .send({ cardId: "card-1", contact: {} });

    expect(res.status).toBe(401);
    // Never signed in is a different story from signed out elsewhere.
    expect(res.body.code).toBeUndefined();
  });

  it("treats an unknown session id as anonymous rather than revoked", async () => {
    const { app } = await setup();
    // A syntactically valid but unknown id: unknown is not revoked.
    const res = await request(app)
      .get("/api/auth/google/status")
      .set("Cookie", "c2c_session=s%3Aunknown-id.badsig");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });
});

/**
 * Expiry is not revocation: an expired session gets a clean signed-out state
 * and a normal /login, not "you signed in on another device".
 */
describe("an expired session degrades to anonymous, not revoked", () => {
  it("answers /status with authenticated:false after the Absolute Lifetime", async () => {
    const { app, sessionStore, cookie } = await setup();
    const clock = Date.now() + 8 * 24 * 60 * 60 * 1000;
    sessionStore._setNow(() => new Date(clock));

    const res = await request(app).get("/api/auth/google/status").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });
});
