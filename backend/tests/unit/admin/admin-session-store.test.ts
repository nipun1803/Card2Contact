import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_ABSOLUTE_MS,
  InMemoryAdminSessionStore,
} from "../../../src/shared/store/admin-session-store";

/**
 * InMemoryAdminSessionStore is the PRODUCTION admin session store, not a test
 * double — so unlike session-store-fake.test.ts (which tests a fake because the
 * real predicate runs inside Postgres), this suite tests the real thing.
 *
 * The Absolute Lifetime is enforced here in JS, so this is where the behavioural
 * proof of the 8h bound lives, along with the two properties most likely to be
 * "fixed" into bugs later: that activity does NOT extend a session, and that
 * correctness never depends on the purge timer.
 */

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const FP = { device: "macOS", browser: "Chrome", ip: "203.0.113.1" };

/** Track stores so every test's purge timer is stopped, whatever it asserts. */
const open: InMemoryAdminSessionStore[] = [];

afterEach(() => {
  while (open.length) open.pop()?.stop();
});

/** A store whose clock starts at a fixed instant and can be advanced. */
function storeAt(start = new Date("2026-07-16T09:00:00Z")) {
  const store = new InMemoryAdminSessionStore();
  open.push(store);
  let clock = start.getTime();
  store._setNow(() => new Date(clock));
  return {
    store,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("InMemoryAdminSessionStore — create & find", () => {
  it("ST1: creates a session findable by its id, with a 256-bit opaque id", async () => {
    const { store } = storeAt();
    const session = await store.create("admin", FP);

    expect(await store.findActive(session.id)).toMatchObject({
      id: session.id,
      username: "admin",
    });
    // 32 random bytes as base64url — a bearer credential, never an identity.
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("ST2: mints a distinct id per session (no reuse or collision)", async () => {
    const { store } = storeAt();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add((await store.create("admin", FP)).id);

    expect(ids.size).toBe(50);
  });

  it("ST9: round-trips the device fingerprint onto the record", async () => {
    const { store } = storeAt();
    const session = await store.create("admin", {
      device: "Windows",
      browser: "Firefox",
      ip: "198.51.100.7",
    });

    expect(await store.findActive(session.id)).toMatchObject({
      device: "Windows",
      browser: "Firefox",
      ip: "198.51.100.7",
    });
  });

  it("returns null for an id that was never issued", async () => {
    const { store } = storeAt();
    expect(await store.findActive("never-issued")).toBeNull();
  });
});

describe("InMemoryAdminSessionStore — Absolute Lifetime (8h, the only bound)", () => {
  // The pair of assertions the whole expiry design rests on.
  it("ST3: keeps a session Active at 7h59m", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("admin", FP);

    advance(7 * HOUR + 59 * MINUTE);

    expect(await store.findActive(session.id)).not.toBeNull();
  });

  it("ST4: expires a session at 8h01m", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("admin", FP);

    advance(8 * HOUR + MINUTE);

    expect(await store.findActive(session.id)).toBeNull();
  });

  /**
   * The regression that matters most: admin sessions must NOT slide forward on
   * activity. A sliding window would keep a stolen cookie alive for exactly as
   * long as the thief kept using it — the inverse of what the bound is for.
   */
  it("does NOT extend a session's life on activity — no sliding renewal", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("admin", FP);

    // Busy right up to the cap: a lookup every hour.
    for (let i = 0; i < 7; i++) {
      advance(HOUR);
      expect(await store.findActive(session.id)).not.toBeNull();
    }
    advance(HOUR + MINUTE); // now past 8h from creation

    expect(await store.findActive(session.id)).toBeNull();
  });

  it("records lastActivityAt without letting it affect expiry", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("admin", FP);

    advance(2 * HOUR);
    const seen = await store.findActive(session.id);

    // Recorded (useful for audit)...
    expect(seen?.lastActivityAt.getTime()).toBeGreaterThan(seen!.createdAt.getTime());
    // ...but createdAt is what expiry reads, and it never moves.
    expect(seen?.createdAt).toEqual(session.createdAt);
  });

  it("exposes the 8h bound as the documented constant", () => {
    expect(ADMIN_SESSION_ABSOLUTE_MS).toBe(8 * HOUR);
  });
});

describe("InMemoryAdminSessionStore — revoke (Session Termination)", () => {
  it("ST5: a revoked session is no longer Active", async () => {
    const { store } = storeAt();
    const session = await store.create("admin", FP);

    await store.revoke(session.id);

    expect(await store.findActive(session.id)).toBeNull();
  });

  it("ST6: revoking twice is idempotent (a double-clicked logout must not fail)", async () => {
    const { store } = storeAt();
    const session = await store.create("admin", FP);

    await store.revoke(session.id);
    await expect(store.revoke(session.id)).resolves.toBeUndefined();
  });

  it("ST7: revoking an unknown id does not throw", async () => {
    const { store } = storeAt();
    await expect(store.revoke("never-issued")).resolves.toBeUndefined();
  });

  it("revokes only the targeted session", async () => {
    const { store } = storeAt();
    const keep = await store.create("admin", FP);
    const drop = await store.create("admin", FP);

    await store.revoke(drop.id);

    expect(await store.findActive(keep.id)).not.toBeNull();
    expect(await store.findActive(drop.id)).toBeNull();
  });
});

describe("InMemoryAdminSessionStore — purge is space, never correctness", () => {
  it("ST11: purgeExpired drops expired records and reports the count", async () => {
    const { store, advance } = storeAt();
    await store.create("admin", FP);
    await store.create("admin", FP);

    advance(9 * HOUR);
    const fresh = await store.create("admin", FP);

    expect(await store.purgeExpired()).toBe(2);
    // The still-active one survives.
    expect(await store.findActive(fresh.id)).not.toBeNull();
  });

  it("ST11b: purgeExpired keeps every still-active record", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("admin", FP);

    advance(HOUR);

    expect(await store.purgeExpired()).toBe(0);
    expect(await store.findActive(session.id)).not.toBeNull();
  });

  /**
   * The point of the whole purge design: an expired session is dead the instant
   * it expires, whether or not the timer ever fires. If this ever fails, the
   * store has started relying on the purge for correctness.
   */
  it("ST13: an expired-but-unpurged session is already rejected by findActive", async () => {
    const { store, advance } = storeAt();
    const session = await store.create("admin", FP);

    advance(9 * HOUR); // purge deliberately NOT called

    expect(await store.findActive(session.id)).toBeNull();
  });

  it("ST10/ST12: the purge timer is unref()'d and stoppable, so it never holds the process open", () => {
    const store = new InMemoryAdminSessionStore();
    // An unref()'d timer does not keep the event loop alive; Node exposes this
    // via hasRef(). Without it, vitest (and the app) would hang on shutdown.
    const timer = (store as unknown as { timer: { hasRef(): boolean } }).timer;

    expect(timer.hasRef()).toBe(false);

    store.stop();
  });
});
