import bcrypt from "bcrypt";
import { describe, expect, it } from "vitest";
import {
  BCRYPT_HASH_SHAPE,
  resolveAdminConfig,
} from "../../../src/modules/admin-auth/admin-auth.config";

/**
 * resolveAdminConfig is the boot-time gate that decides whether the admin panel
 * exists at all, and it is the only thing standing between a mistyped `.env` and
 * an admin account nobody can sign in to (or, worse, one guarded by a value that
 * was never a hash).
 *
 * Hashes are generated at runtime rather than committed as literals: a real
 * `$2b$` string in the repo would trip the gitleaks CI job, and generating them
 * also proves the regex accepts what bcrypt actually emits rather than what we
 * think it emits. Cost 4 (bcrypt's minimum) keeps this suite fast — the shape is
 * what's under test, not the work factor.
 */

const FAST_COST = 4;
const hash = (pw: string, cost = FAST_COST) => bcrypt.hashSync(pw, cost);

/** Only the vars under test — never inherit the ambient environment. */
const env = (vars: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  vars as NodeJS.ProcessEnv;

describe("resolveAdminConfig — the feature switch", () => {
  it("C1: returns null when neither var is set (admin panel off)", () => {
    // The path every pre-existing deployment and the whole test suite takes.
    expect(resolveAdminConfig(env())).toBeNull();
  });

  it("C2: returns the config when both are set and valid", () => {
    const passwordHash = hash("s3cret");

    expect(
      resolveAdminConfig(env({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: passwordHash }))
    ).toEqual({ username: "admin", passwordHash });
  });

  it("treats both-blank as both-unset rather than half-configured", () => {
    expect(resolveAdminConfig(env({ ADMIN_USERNAME: "", ADMIN_PASSWORD_HASH: "" }))).toBeNull();
    expect(
      resolveAdminConfig(env({ ADMIN_USERNAME: "   ", ADMIN_PASSWORD_HASH: "  " }))
    ).toBeNull();
  });

  it("trims the username so a stray .env space cannot make login impossible", () => {
    expect(
      resolveAdminConfig(env({ ADMIN_USERNAME: " admin ", ADMIN_PASSWORD_HASH: hash("pw") }))
    ).toMatchObject({ username: "admin" });
  });
});

describe("resolveAdminConfig — half-configured must fail loudly, not silently disable", () => {
  it("C3: throws naming ADMIN_PASSWORD_HASH when only the username is set", () => {
    expect(() => resolveAdminConfig(env({ ADMIN_USERNAME: "admin" }))).toThrow(
      /ADMIN_PASSWORD_HASH is missing/
    );
  });

  it("C4: throws naming ADMIN_USERNAME when only the hash is set", () => {
    expect(() => resolveAdminConfig(env({ ADMIN_PASSWORD_HASH: hash("pw") }))).toThrow(
      /ADMIN_USERNAME is missing/
    );
  });

  it("C5: throws when the username is blank but a hash is present", () => {
    // Blank-but-present is the same mistake as absent, and must not be read as
    // "off" while a hash sits there advertising intent to turn it on.
    expect(() =>
      resolveAdminConfig(env({ ADMIN_USERNAME: "   ", ADMIN_PASSWORD_HASH: hash("pw") }))
    ).toThrow(/ADMIN_USERNAME is missing/);
  });

  it("C7: throws when the hash is blank but a username is present", () => {
    expect(() =>
      resolveAdminConfig(env({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: "  " }))
    ).toThrow(/ADMIN_PASSWORD_HASH is missing/);
  });
});

describe("resolveAdminConfig — a non-bcrypt hash must never boot", () => {
  /**
   * C6, the catastrophic case. bcrypt.compare() against a plaintext value does
   * not throw — it returns false forever. Booting with one means an admin who
   * types the exactly-correct password is rejected with no cause anywhere.
   */
  it("C6: throws when ADMIN_PASSWORD_HASH holds a plaintext password", () => {
    expect(() =>
      resolveAdminConfig(env({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: "password123" }))
    ).toThrow(/not a bcrypt hash/);
  });

  it("C6b: the error names the variable but never echoes its value", () => {
    // The message reaches stdout; a credential must not ride along.
    try {
      resolveAdminConfig(
        env({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: "sup3r-secret-plaintext" })
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("ADMIN_PASSWORD_HASH");
      expect((err as Error).message).not.toContain("sup3r-secret-plaintext");
    }
  });

  it.each([
    ["truncated", "$2b$12$tooshort"],
    ["md5 crypt", "$1$abcdefgh$0123456789012345678901"],
    ["argon2", "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaA"],
    ["sha-512 crypt", "$6$rounds=656000$salt$hash"],
    ["missing cost", "$2b$$" + "a".repeat(53)],
    ["one-digit cost", "$2b$4$" + "a".repeat(53)],
    ["bad variant", "$2z$12$" + "a".repeat(53)],
    ["hash with a space", "$2b$12$" + "a".repeat(52) + " "],
    ["empty-ish", "$"],
  ])("C8: throws on a %s value", (_label, value) => {
    expect(() =>
      resolveAdminConfig(env({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: value }))
    ).toThrow(/not a bcrypt hash/);
  });
});

describe("BCRYPT_HASH_SHAPE — accepts what bcrypt actually produces", () => {
  /**
   * C9. Guards against over-tightening the regex: it must accept real output at
   * any cost, or a correctly-configured admin fails to boot. Costs 4 and 12
   * bracket the range (4 = bcrypt's minimum, 12 = what we tell operators to use).
   */
  it.each([4, 10, 12])("C9: accepts a real bcrypt hash at cost %i", (cost) => {
    const real = hash("a-real-password", cost);

    expect(BCRYPT_HASH_SHAPE.test(real)).toBe(true);
    expect(
      resolveAdminConfig(env({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: real }))
    ).toMatchObject({ passwordHash: real });
  });

  it("C9b: accepts the $2a$ and $2y$ variants seen in the wild", () => {
    const real = hash("pw");
    for (const variant of ["$2a$", "$2y$"]) {
      expect(BCRYPT_HASH_SHAPE.test(variant + real.slice(4))).toBe(true);
    }
  });

  it("a hash accepted here still verifies with bcrypt (end-to-end sanity)", () => {
    const config = resolveAdminConfig(
      env({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: hash("correct-horse") })
    );

    expect(bcrypt.compareSync("correct-horse", config!.passwordHash)).toBe(true);
    expect(bcrypt.compareSync("wrong-horse", config!.passwordHash)).toBe(false);
  });
});
