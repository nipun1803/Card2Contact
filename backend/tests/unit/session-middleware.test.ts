import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  COOKIE_NAME,
  createSessionMiddleware,
  fingerprint,
} from "../../src/shared/http/session";
import { createRequireAuth } from "../../src/shared/http/require-auth";
import {
  NotAuthenticatedError,
  SessionRevokedError,
} from "../../src/shared/http/pipeline-errors";
import { UserRecord, UserStore } from "../../src/shared/store/user-store";
import { SessionStore } from "../../src/shared/store/session-store";
import { MemoryAuditLogger } from "../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../src/shared/observability/metrics";
import { makeSessionStore, makeUserStore } from "../mocks/stores";

const user: UserRecord = {
  googleUserId: "u1",
  email: "ada@example.com",
  spreadsheetId: "sheet-1",
  spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
  spreadsheetTitle: "Card2Contact Contacts",
  accessToken: "at",
  refreshToken: "rt",
  tokenExpiry: null,
  savedContactsCount: 0,
};

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** A request carrying the given signed session cookie (or none). */
function makeReq(sessionId?: string, path = "/api/cards"): Request {
  return {
    signedCookies: sessionId ? { [COOKIE_NAME]: sessionId } : {},
    path,
    ip: "203.0.113.4",
    get: (name: string) => (name.toLowerCase() === "user-agent" ? CHROME_MAC : undefined),
  } as unknown as Request;
}

function makeRes(): Response & { clearCookie: ReturnType<typeof vi.fn> } {
  return { clearCookie: vi.fn(), cookie: vi.fn() } as unknown as Response & {
    clearCookie: ReturnType<typeof vi.fn>;
  };
}

interface Harness {
  sessions: ReturnType<typeof makeSessionStore>;
  users: UserStore;
  audit: MemoryAuditLogger;
  metrics: MemoryMetrics;
  run: (req: Request, res?: Response) => Promise<{ next: NextFunction; res: Response }>;
}

function harness(found: UserRecord | null = user): Harness {
  const sessions = makeSessionStore();
  const users = makeUserStore({ findById: vi.fn(async () => found) });
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const mw = createSessionMiddleware(users, sessions, audit, metrics);
  return {
    sessions,
    users,
    audit,
    metrics,
    async run(req, res = makeRes()) {
      const next = vi.fn() as unknown as NextFunction;
      await mw(req, res, next);
      return { next, res };
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe("createSessionMiddleware — the happy path", () => {
  it("populates req.auth, including the session id, for an Active Session", async () => {
    const h = harness();
    const session = await h.sessions.create("u1", {
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
    });

    const req = makeReq(session.id);
    const { next } = await h.run(req);

    expect(req.auth).toEqual({ googleUserId: "u1", user, sessionId: session.id });
    expect(next).toHaveBeenCalledWith();
  });
});

/**
 * The middleware must stay permissive for genuinely anonymous requests: M1–M4
 * are public and must work with no cookie at all.
 */
describe("createSessionMiddleware — permissive cases (anonymous, no error)", () => {
  it("passes through with no cookie", async () => {
    const h = harness();
    const req = makeReq();
    const { next } = await h.run(req);

    expect(req.auth).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  it("passes through for an unknown session id", async () => {
    const h = harness();
    const req = makeReq("never-existed");
    const { next, res } = await h.run(req);

    expect(req.auth).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
    expect((res as ReturnType<typeof makeRes>).clearCookie).toHaveBeenCalled();
  });

  it("passes through when the user row no longer exists (orphaned session)", async () => {
    const h = harness(null);
    const session = await h.sessions.create("u1", { device: null, browser: null, ip: null });
    const req = makeReq(session.id);
    const { next } = await h.run(req);

    expect(req.auth).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  // Expiry is not revocation: the user just signs in again, with no
  // "you signed in on another device" message.
  it("passes through for a session past its Absolute Lifetime, WITHOUT SessionRevokedError", async () => {
    const h = harness();
    let clock = Date.now();
    h.sessions._setNow(() => new Date(clock));
    const session = await h.sessions.create("u1", { device: null, browser: null, ip: null });

    clock += 8 * DAY;
    const req = makeReq(session.id);
    const { next } = await h.run(req);

    expect(req.auth).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
    expect(next).not.toHaveBeenCalledWith(expect.any(SessionRevokedError));
  });

  it("passes through for a session past its Idle Timeout, WITHOUT SessionRevokedError", async () => {
    const h = harness();
    let clock = Date.now();
    h.sessions._setNow(() => new Date(clock));
    // Created long ago and idle: both bounds blown, still not revoked.
    h.sessions._seed({
      id: "idle-session",
      googleUserId: "u1",
      createdAt: new Date(clock - 40 * DAY),
      lastActivityAt: new Date(clock - 31 * DAY),
    });

    const req = makeReq("idle-session");
    const { next } = await h.run(req);

    expect(req.auth).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });
});

/**
 * The Problem-1 regression suite. If SESSION_REVOKED came from requireAuth
 * instead of here, a revoked device would sit on the dashboard showing stale
 * data until it happened to try a save — because /status is public and never
 * reaches that guard.
 */
describe("createSessionMiddleware — the one rejection: a revoked session", () => {
  async function revokedHarness() {
    const h = harness();
    const session = await h.sessions.create("u1", {
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
    });
    await h.sessions.revoke(session.id, "replaced_by_new_login");
    return { h, session };
  }

  it("rejects with SessionRevokedError", async () => {
    const { h, session } = await revokedHarness();
    const req = makeReq(session.id);
    const { next } = await h.run(req);

    expect(next).toHaveBeenCalledWith(expect.any(SessionRevokedError));
    expect(req.auth).toBeUndefined();
  });

  it("carries the SESSION_REVOKED code the frontend switches on", async () => {
    const { h, session } = await revokedHarness();
    const { next } = await h.run(makeReq(session.id));

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.code).toBe("SESSION_REVOKED");
  });

  it("clears the cookie so the dead id is not re-sent on every request", async () => {
    const { h, session } = await revokedHarness();
    const { res } = await h.run(makeReq(session.id));

    expect((res as ReturnType<typeof makeRes>).clearCookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      expect.objectContaining({ httpOnly: true, path: "/" })
    );
  });

  it("audits the failure with the device fingerprint", async () => {
    const { h, session } = await revokedHarness();
    await h.run(makeReq(session.id));

    expect(h.audit.ofType("auth_failure")).toEqual([
      expect.objectContaining({
        event: "auth_failure",
        reason: "session_revoked",
        sessionId: session.id,
        device: "macOS",
        browser: "Chrome",
        ip: "203.0.113.4",
      }),
    ]);
  });

  it("records the metric", async () => {
    const { h, session } = await revokedHarness();
    await h.run(makeReq(session.id));

    expect(h.metrics.get("auth_failure", { reason: "session_revoked" })).toBe(1);
  });

  // A revoked session that has since expired must still report as revoked —
  // that is why isRevoked ignores the lifetime bounds.
  it("still rejects a revoked session that has since expired", async () => {
    const h = harness();
    let clock = Date.now();
    h.sessions._setNow(() => new Date(clock));
    const session = await h.sessions.create("u1", { device: null, browser: null, ip: null });
    await h.sessions.revoke(session.id, "logout");

    clock += 8 * DAY;
    const { next } = await h.run(makeReq(session.id));

    expect(next).toHaveBeenCalledWith(expect.any(SessionRevokedError));
  });
});

describe("createSessionMiddleware — activity touch throttling", () => {
  it("does not touch when activity is recent", async () => {
    const h = harness();
    const session = await h.sessions.create("u1", { device: null, browser: null, ip: null });
    await h.run(makeReq(session.id));

    expect(h.sessions.touch).not.toHaveBeenCalled();
  });

  it("touches once activity is older than the throttle window", async () => {
    const h = harness();
    h.sessions._seed({
      id: "stale-activity",
      googleUserId: "u1",
      createdAt: new Date(Date.now() - DAY),
      lastActivityAt: new Date(Date.now() - 61_000), // > 60s throttle
    });

    await h.run(makeReq("stale-activity"));

    expect(h.sessions.touch).toHaveBeenCalledWith("stale-activity");
  });

  // Fire-and-forget, but never an unhandled rejection.
  it("does not fail the request when the touch write fails", async () => {
    const h = harness();
    h.sessions._seed({
      id: "stale-activity",
      googleUserId: "u1",
      createdAt: new Date(Date.now() - DAY),
      lastActivityAt: new Date(Date.now() - 61_000),
    });
    h.sessions.touch = vi.fn(async () => {
      throw new Error("db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const req = makeReq("stale-activity");
    const { next } = await h.run(req);

    expect(req.auth).toBeDefined();
    expect(next).toHaveBeenCalledWith();
    await new Promise((r) => setImmediate(r)); // let the rejection settle
    expect(warn).toHaveBeenCalledWith("[session] touch failed", expect.any(Error));
    warn.mockRestore();
  });
});

describe("createSessionMiddleware — error propagation", () => {
  it("forwards an unexpected store failure to the error handler", async () => {
    const sessions = {
      findActive: vi.fn(async () => {
        throw new Error("db down");
      }),
    } as unknown as SessionStore;
    const mw = createSessionMiddleware(
      makeUserStore(),
      sessions,
      new MemoryAuditLogger(),
      new MemoryMetrics()
    );
    const next = vi.fn() as unknown as NextFunction;

    await mw(makeReq("some-id"), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("fingerprint", () => {
  it("parses the user agent and takes req.ip", () => {
    expect(fingerprint(makeReq())).toEqual({
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
    });
  });

  it("degrades to Unknown rather than throwing on a missing user agent", () => {
    const req = { ip: undefined, get: () => undefined } as unknown as Request;
    expect(fingerprint(req)).toEqual({
      device: "Unknown device",
      browser: "Unknown browser",
      ip: null,
    });
  });
});

describe("createRequireAuth", () => {
  let audit: MemoryAuditLogger;
  let metrics: MemoryMetrics;

  beforeEach(() => {
    audit = new MemoryAuditLogger();
    metrics = new MemoryMetrics();
  });

  it("passes through when req.auth is present", () => {
    const req = { auth: { googleUserId: "u1", user, sessionId: "s1" } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;

    createRequireAuth(audit, metrics)(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(audit.entries).toHaveLength(0);
  });

  it("errors with NotAuthenticatedError when req.auth is absent", () => {
    const next = vi.fn() as unknown as NextFunction;

    createRequireAuth(audit, metrics)(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(NotAuthenticatedError));
  });

  it("audits and counts the failed attempt", () => {
    const next = vi.fn() as unknown as NextFunction;

    createRequireAuth(audit, metrics)(makeReq(), makeRes(), next);

    expect(audit.ofType("auth_failure")).toEqual([
      expect.objectContaining({ reason: "not_authenticated", device: "macOS" }),
    ]);
    expect(metrics.get("auth_failure", { reason: "not_authenticated" })).toBe(1);
  });
});

/**
 * The X9 guard. This middleware is GLOBAL, so before the early-return existed a
 * request to /api/admin/* carrying a revoked c2c_session cookie was rejected
 * with SESSION_REVOKED — locking an operator out of the admin panel because
 * their unrelated *Google* session had been replaced on another device, with an
 * error message that makes no sense in that context.
 *
 * Both directions are pinned: admin paths skip, and every other path must still
 * reject exactly as before. Deleting the guard fails the first block; widening
 * it (e.g. to all of /api) fails the second.
 */
describe("createSessionMiddleware — /api/admin is outside the user session model", () => {
  it("skips a revoked session on an admin path instead of rejecting it", async () => {
    const h = harness();
    const session = await h.sessions.create("u1", {
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
    });
    await h.sessions.revoke(session.id, "replaced_by_new_login");

    const req = makeReq(session.id, "/api/admin/auth/me");
    const { next } = await h.run(req);

    // next() with no error — the admin router decides, not this middleware.
    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toBeUndefined();
  });

  it("does not resolve req.auth on an admin path even for a VALID user session", async () => {
    // An operator signed into both must not arrive at an admin route carrying a
    // user identity: requireAuth and createSaveLimiter both read req.auth.
    const h = harness();
    const session = await h.sessions.create("u1", {
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
    });

    const req = makeReq(session.id, "/api/admin/auth/me");
    const { next } = await h.run(req);

    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toBeUndefined();
  });

  it("does not touch the session store at all for an admin path", async () => {
    const h = harness();

    await h.run(makeReq("some-id", "/api/admin/anything"));

    expect(h.sessions.findActive).not.toHaveBeenCalled();
    expect(h.sessions.isRevoked).not.toHaveBeenCalled();
  });

  it("skips every /api/admin/* path, including future ones", async () => {
    const h = harness();
    const session = await h.sessions.create("u1", {
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
    });
    await h.sessions.revoke(session.id, "replaced_by_new_login");

    for (const path of ["/api/admin", "/api/admin/auth/login", "/api/admin/users/42"]) {
      const { next } = await h.run(makeReq(session.id, path));
      expect(next).toHaveBeenCalledWith();
    }
  });

  // The other direction: the guard must not have widened the skip.
  it("STILL rejects a revoked session on a non-admin path", async () => {
    const h = harness();
    const session = await h.sessions.create("u1", {
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
    });
    await h.sessions.revoke(session.id, "replaced_by_new_login");

    const { next } = await h.run(makeReq(session.id, "/api/auth/google/status"));

    expect(next).toHaveBeenCalledWith(expect.any(SessionRevokedError));
  });

  it("STILL resolves req.auth on a normal path", async () => {
    const h = harness();
    const session = await h.sessions.create("u1", {
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
    });

    const req = makeReq(session.id, "/api/contacts/save");
    await h.run(req);

    expect(req.auth).toMatchObject({ googleUserId: "u1" });
  });

  it("does not skip a path that merely mentions admin elsewhere", async () => {
    // startsWith, not includes — /api/cards/admin-notes is a user route.
    const h = harness();
    const session = await h.sessions.create("u1", {
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
    });
    await h.sessions.revoke(session.id, "replaced_by_new_login");

    const { next } = await h.run(makeReq(session.id, "/api/cards/admin-notes"));

    expect(next).toHaveBeenCalledWith(expect.any(SessionRevokedError));
  });
});
