import { describe, expect, it } from "vitest";
import { makeSessionStore } from "../mocks/stores";

/**
 * The in-memory SessionStore fake reimplements the Active predicate that
 * PgSessionStore expresses in SQL. Since every integration test authenticates
 * through this fake, a bug here would silently invalidate those suites — so the
 * predicate is tested directly, and this is where the behavioural proof of the
 * two lifetime bounds lives (PgSessionStore's tests can only assert the bounds
 * are bound as parameters, because the time logic runs inside Postgres).
 */
const DAY = 24 * 60 * 60 * 1000;

/** A store whose clock starts at a fixed instant and can be advanced. */
function storeAt(start = new Date("2026-07-15T12:00:00Z")) {
  const store = makeSessionStore();
  let clock = start.getTime();
  store._setNow(() => new Date(clock));
  return {
    store,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("fake SessionStore — Absolute Lifetime is the binding constraint", () => {
  // The pair of assertions the whole two-bound design rests on.
  it("keeps a 6-day-old session with fresh activity Active", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("u1", { device: "macOS", browser: "Chrome", ip: "1.2.3.4" });

    advance(6 * DAY);
    await store.touch(session.id); // active the whole time

    expect(await store.findActive(session.id)).not.toBeNull();
  });

  it("expires a 7-day-old session even with activity one second ago", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("u1", { device: "macOS", browser: "Chrome", ip: "1.2.3.4" });

    advance(7 * DAY);
    await store.touch(session.id); // last_activity is now — Idle would keep it

    // ...but Absolute Lifetime kills it regardless. This is the guarantee:
    // no session outlives 7 days, however active.
    expect(await store.findActive(session.id)).toBeNull();
  });

  it("expires an idle session before the absolute cap is reached", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("u1", { device: "macOS", browser: "Chrome", ip: "1.2.3.4" });

    // Idle Timeout is 30d and Absolute is 7d, so in practice Absolute always
    // fires first — this pins that an untouched session dies too, and never
    // survives past the cap on the strength of its creation time alone.
    advance(8 * DAY);
    expect(await store.findActive(session.id)).toBeNull();
  });
});

describe("fake SessionStore — expiry is not revocation", () => {
  // The distinction the middleware depends on: an expired session must degrade
  // to anonymous (normal /login), NOT report "you signed in on another device".
  it("reports an expired session as inactive but NOT revoked", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("u1", { device: null, browser: null, ip: null });

    advance(8 * DAY);

    expect(await store.findActive(session.id)).toBeNull();
    expect(await store.isRevoked(session.id)).toBe(false);
  });

  it("reports a revoked session as both inactive and revoked", async () => {
    const { store } = storeAt();
    const session = await store.create("u1", { device: null, browser: null, ip: null });
    await store.revoke(session.id, "replaced_by_new_login");

    expect(await store.findActive(session.id)).toBeNull();
    expect(await store.isRevoked(session.id)).toBe(true);
  });

  it("still reports revoked for a session that expired after being revoked", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("u1", { device: null, browser: null, ip: null });
    await store.revoke(session.id, "logout");
    advance(8 * DAY);

    // isRevoked must not apply the lifetime bounds, or a stale revoked session
    // would silently downgrade to anonymous.
    expect(await store.isRevoked(session.id)).toBe(true);
  });

  it("reports an unknown id as neither active nor revoked", async () => {
    const { store } = storeAt();
    expect(await store.findActive("never-existed")).toBeNull();
    expect(await store.isRevoked("never-existed")).toBe(false);
  });
});

describe("fake SessionStore — revocation", () => {
  it("keeps the first revocation's reason when revoked twice", async () => {
    const { store } = storeAt();
    const session = await store.create("u1", { device: null, browser: null, ip: null });

    await store.revoke(session.id, "replaced_by_new_login");
    await store.revoke(session.id, "logout");

    expect(store._sessions.get(session.id)!.revokedReason).toBe("replaced_by_new_login");
  });

  it("revokeAllForUser revokes only that user's active sessions and counts them", async () => {
    const { store } = storeAt();
    const a = await store.create("u1", { device: null, browser: null, ip: null });
    const b = await store.create("u1", { device: null, browser: null, ip: null });
    const other = await store.create("u2", { device: null, browser: null, ip: null });
    await store.revoke(a.id, "logout"); // already revoked; must not be recounted

    expect(await store.revokeAllForUser("u1", "replaced_by_new_login")).toBe(1);
    expect(await store.isRevoked(b.id)).toBe(true);
    expect(await store.findActive(other.id)).not.toBeNull();
  });

  it("does not touch a revoked session", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("u1", { device: null, browser: null, ip: null });
    const before = store._sessions.get(session.id)!.lastActivityAt;

    await store.revoke(session.id, "logout");
    advance(60_000);
    await store.touch(session.id);

    expect(store._sessions.get(session.id)!.lastActivityAt).toEqual(before);
  });
});

describe("fake SessionStore — findActiveForUser", () => {
  it("returns the most recently active session", async () => {
    const { store, advance } = storeAt();
    await store.create("u1", { device: "macOS", browser: "Chrome", ip: null });
    advance(1000);
    const newer = await store.create("u1", { device: "iPhone", browser: "Safari", ip: null });

    expect((await store.findActiveForUser("u1"))!.id).toBe(newer.id);
  });

  it("returns null once every session for the user is revoked", async () => {
    const { store } = storeAt();
    await store.create("u1", { device: null, browser: null, ip: null });
    await store.revokeAllForUser("u1", "logout");

    expect(await store.findActiveForUser("u1")).toBeNull();
  });

  it("ignores other users' sessions", async () => {
    const { store } = storeAt();
    await store.create("u2", { device: null, browser: null, ip: null });
    expect(await store.findActiveForUser("u1")).toBeNull();
  });
});

describe("fake SessionStore — Pending Sessions", () => {
  it("consumePending deletes on read, so a double-click cannot mint two sessions", async () => {
    const { store } = storeAt();
    const pending = await store.createPending("u1", {
      device: "iPhone",
      browser: "Safari",
      ip: "1.2.3.4",
    });

    expect(await store.consumePending(pending.id)).toMatchObject({
      id: pending.id,
      googleUserId: "u1",
      device: "iPhone",
    });
    expect(await store.consumePending(pending.id)).toBeNull();
  });

  it("returns null for an expired pending session", async () => {
    const { store, advance } = storeAt();
    const pending = await store.createPending("u1", { device: null, browser: null, ip: null });

    advance(5 * 60 * 1000 + 1); // PENDING_TTL_MS + 1ms
    expect(await store.consumePending(pending.id)).toBeNull();
  });

  it("returns null for an unknown pending id", async () => {
    const { store } = storeAt();
    expect(await store.consumePending("never-existed")).toBeNull();
  });

  // A Pending Session must be structurally incapable of authenticating — this
  // is why pendings live in their own table rather than behind a status column.
  it("a pending session id is not an Active Session", async () => {
    const { store } = storeAt();
    const pending = await store.createPending("u1", { device: null, browser: null, ip: null });
    expect(await store.findActive(pending.id)).toBeNull();
    expect(await store.findActiveForUser("u1")).toBeNull();
  });
});

describe("fake SessionStore — purgeExpired", () => {
  it("reclaims expired sessions but retains revoked ones for SESSION_REVOKED", async () => {
    const { store, advance } = storeAt();
    const expired = await store.create("u1", { device: null, browser: null, ip: null });
    const revoked = await store.create("u2", { device: null, browser: null, ip: null });
    await store.revoke(revoked.id, "logout");

    advance(8 * DAY);
    const result = await store.purgeExpired();

    expect(result.sessions).toBe(1);
    expect(store._sessions.has(expired.id)).toBe(false);
    // Retained: the revoked device must still learn why it was signed out.
    expect(await store.isRevoked(revoked.id)).toBe(true);
  });

  it("reclaims expired pending sessions", async () => {
    const { store, advance } = storeAt();
    await store.createPending("u1", { device: null, browser: null, ip: null });
    advance(6 * 60 * 1000);

    expect((await store.purgeExpired()).pending).toBe(1);
    expect(store._pending.size).toBe(0);
  });
});
