import bcrypt from "bcrypt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAuthService } from "../../../src/modules/admin-auth/admin-auth.service";
import { BCRYPT_HASH_SHAPE } from "../../../src/modules/admin-auth/admin-auth.config";
import { InMemoryAdminSessionStore } from "../../../src/shared/store/admin-session-store";

/**
 * The security core of the admin module. Two properties matter more than the
 * happy path:
 *
 *   1. Every failure is indistinguishable — no return value, and no *timing*,
 *      reveals whether the username or the password was wrong.
 *   2. Exactly one bcrypt.compare runs on every path. That is what makes (1)
 *      true in the time domain, and it is asserted STRUCTURALLY (by call count)
 *      rather than by wall-clock: a timing assertion is flaky under CI load and
 *      would get skipped, which is worse than no test at all.
 *
 * Hashes are generated at runtime (never committed — gitleaks scans for `$2b$`)
 * at cost 4 to keep the suite fast; the work factor is not what's under test.
 */

const FAST_COST = 4;
const USERNAME = "admin";
const PASSWORD = "correct-horse-battery-staple";

const FP = { device: "macOS", browser: "Chrome", ip: "203.0.113.1" };

/** Service under test with a real in-memory store — nothing worth faking here. */
function harness(username = USERNAME, password = PASSWORD) {
  const store = new InMemoryAdminSessionStore();
  const service = new AdminAuthService(
    { username, passwordHash: bcrypt.hashSync(password, FAST_COST) },
    store
  );
  return { service, store };
}

const open: InMemoryAdminSessionStore[] = [];
function tracked() {
  const h = harness();
  open.push(h.store);
  return h;
}

afterEach(() => {
  while (open.length) open.pop()?.stop();
  vi.restoreAllMocks();
});

describe("AdminAuthService.verifyCredentials", () => {
  it("S1: accepts the correct username and password", async () => {
    const { service } = tracked();
    expect(await service.verifyCredentials(USERNAME, PASSWORD)).toBe(true);
  });

  it("S2: rejects the correct username with a wrong password", async () => {
    const { service } = tracked();
    expect(await service.verifyCredentials(USERNAME, "wrong")).toBe(false);
  });

  it("S3: rejects a wrong username with the correct password", async () => {
    const { service } = tracked();
    expect(await service.verifyCredentials("wrong-user", PASSWORD)).toBe(false);
  });

  it("S4: rejects when both are wrong", async () => {
    const { service } = tracked();
    expect(await service.verifyCredentials("wrong-user", "wrong")).toBe(false);
  });

  it("S5: the username is compared exactly — case matters", async () => {
    const { service } = tracked();
    expect(await service.verifyCredentials("ADMIN", PASSWORD)).toBe(false);
    expect(await service.verifyCredentials("Admin", PASSWORD)).toBe(false);
  });

  it("S6: the submitted username is not trimmed", async () => {
    // resolveAdminConfig trims the CONFIGURED value once, at boot. The SUBMITTED
    // value is attacker-controlled and must match exactly.
    const { service } = tracked();
    expect(await service.verifyCredentials(" admin", PASSWORD)).toBe(false);
    expect(await service.verifyCredentials("admin ", PASSWORD)).toBe(false);
  });

  it("S9: rejects an empty password", async () => {
    const { service } = tracked();
    expect(await service.verifyCredentials(USERNAME, "")).toBe(false);
  });

  it("rejects an empty username", async () => {
    const { service } = tracked();
    expect(await service.verifyCredentials("", PASSWORD)).toBe(false);
  });

  it("S10: rejects a very long password without throwing", async () => {
    // bcrypt truncates at 72 bytes; a 10k-char input must be a plain `false`,
    // never a crash the caller has to handle.
    const { service } = tracked();
    await expect(service.verifyCredentials(USERNAME, "x".repeat(10_000))).resolves.toBe(false);
  });

  it("handles a unicode password correctly (byte-length, not char-length)", async () => {
    // timingSafeEqualStr compares Buffers; a multi-byte password must still
    // round-trip rather than throw on a length mismatch.
    const pw = "pässwörd–🔐";
    const { service } = harness(USERNAME, pw);
    expect(await service.verifyCredentials(USERNAME, pw)).toBe(true);
    expect(await service.verifyCredentials(USERNAME, "pässwörd–🔓")).toBe(false);
  });
});

describe("AdminAuthService — no user-enumeration oracle", () => {
  /**
   * S7, the one that matters. If a future refactor adds
   * `if (!usernameOk) return false` before the compare, the wrong-username path
   * returns in microseconds while the wrong-password path takes ~100ms — a
   * remotely measurable signal for "this username exists".
   *
   * Asserting the call COUNT catches that refactor deterministically, where a
   * wall-clock assertion would be flaky.
   */
  it("S7: runs exactly one bcrypt.compare on the wrong-username path", async () => {
    const { service } = tracked();
    const spy = vi.spyOn(bcrypt, "compare");

    await service.verifyCredentials("wrong-user", PASSWORD);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("S7b: runs exactly one bcrypt.compare on the wrong-password path", async () => {
    const { service } = tracked();
    const spy = vi.spyOn(bcrypt, "compare");

    await service.verifyCredentials(USERNAME, "wrong");

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("S7c: runs exactly one bcrypt.compare on the success path", async () => {
    const { service } = tracked();
    const spy = vi.spyOn(bcrypt, "compare");

    await service.verifyCredentials(USERNAME, PASSWORD);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("S7d: compares against a DIFFERENT hash when the username misses", async () => {
    // The dummy-hash substitution itself: same work, different secret. If the
    // real hash were used for an unknown username the compare would still run,
    // but this pins the intent.
    const { service } = tracked();
    const spy = vi.spyOn(bcrypt, "compare");

    await service.verifyCredentials(USERNAME, "wrong");
    const realHash = spy.mock.calls[0][1];
    spy.mockClear();

    await service.verifyCredentials("wrong-user", "wrong");
    const dummyHash = spy.mock.calls[0][1];

    expect(dummyHash).not.toBe(realHash);
  });

  it("S8: the dummy hash is a real bcrypt hash", async () => {
    // A malformed dummy would make compare() fail fast and silently restore the
    // oracle S7 exists to prevent — while every other test still passed.
    const { service } = tracked();
    const spy = vi.spyOn(bcrypt, "compare");

    await service.verifyCredentials("wrong-user", "anything");

    expect(BCRYPT_HASH_SHAPE.test(String(spy.mock.calls[0][1]))).toBe(true);
  });

  it("S7e: an empty username still costs a full compare", async () => {
    const { service } = tracked();
    const spy = vi.spyOn(bcrypt, "compare");

    await service.verifyCredentials("", "");

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("AdminAuthService.login", () => {
  it("S1b: mints a session for correct credentials", async () => {
    const { service, store } = tracked();

    const session = await service.login(USERNAME, PASSWORD, FP);

    expect(session).not.toBeNull();
    expect(await store.findActive(session!.id)).toMatchObject({ username: USERNAME });
  });

  it("records the fingerprint on the session", async () => {
    const { service } = tracked();

    const session = await service.login(USERNAME, PASSWORD, FP);

    expect(session).toMatchObject({ device: "macOS", browser: "Chrome", ip: "203.0.113.1" });
  });

  it("S2b/S3b/S4b: returns null and mints NO session for any bad credential", async () => {
    const { service, store } = tracked();

    expect(await service.login(USERNAME, "wrong", FP)).toBeNull();
    expect(await service.login("wrong-user", PASSWORD, FP)).toBeNull();
    expect(await service.login("wrong-user", "wrong", FP)).toBeNull();

    // A failed login must not leave a session behind.
    expect(await store.purgeExpired()).toBe(0);
  });

  it("stores the CONFIGURED username, never the submitted string", async () => {
    // They are equal by definition once the compare passes — but taking the
    // config value means a session record can never carry caller-supplied data.
    const { service } = tracked();
    const spy = vi.spyOn(bcrypt, "compare");

    const session = await service.login(USERNAME, PASSWORD, FP);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(session!.username).toBe(USERNAME);
  });

  it("issues a distinct session per login", async () => {
    const { service } = tracked();

    const first = await service.login(USERNAME, PASSWORD, FP);
    const second = await service.login(USERNAME, PASSWORD, FP);

    expect(first!.id).not.toBe(second!.id);
  });

  it("does not revoke an existing session on a second login (no Session Conflict)", async () => {
    // Unlike the user flow, admin has no single-active-session rule: an operator
    // on a phone and a laptop must not knock each other out.
    const { service, store } = tracked();

    const first = await service.login(USERNAME, PASSWORD, FP);
    await service.login(USERNAME, PASSWORD, FP);

    expect(await store.findActive(first!.id)).not.toBeNull();
  });
});

describe("AdminAuthService.authenticate / logout", () => {
  it("S11: resolves a valid session id", async () => {
    const { service } = tracked();
    const session = await service.login(USERNAME, PASSWORD, FP);

    expect(await service.authenticate(session!.id)).toMatchObject({ username: USERNAME });
  });

  it("S12: returns null after logout", async () => {
    const { service } = tracked();
    const session = await service.login(USERNAME, PASSWORD, FP);

    await service.logout(session!.id);

    expect(await service.authenticate(session!.id)).toBeNull();
  });

  it("S13: returns null for an unknown session id", async () => {
    const { service } = tracked();
    expect(await service.authenticate("never-issued")).toBeNull();
  });

  it("logout is idempotent and never throws on an unknown id", async () => {
    const { service } = tracked();
    await expect(service.logout("never-issued")).resolves.toBeUndefined();
  });

  it("logout revokes only the targeted session", async () => {
    const { service } = tracked();
    const keep = await service.login(USERNAME, PASSWORD, FP);
    const drop = await service.login(USERNAME, PASSWORD, FP);

    await service.logout(drop!.id);

    expect(await service.authenticate(keep!.id)).not.toBeNull();
    expect(await service.authenticate(drop!.id)).toBeNull();
  });
});
