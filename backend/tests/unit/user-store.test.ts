import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import type { Pool } from "pg";
import { PgUserStore } from "../../src/shared/store/user-store";
import { AesGcmTokenCodec, IdentityTokenCodec } from "../../src/shared/store/token-codec";

/**
 * PgUserStore against a fake `pg` Pool. We assert the row→record mapping
 * (including pg's BIGINT-as-string → number coercion and codec decode) and that
 * the right SQL params are bound. We do NOT test Postgres itself — the real DB
 * is exercised by the integration/live suite.
 */
function fakePool(queryImpl: (sql: string, params?: unknown[]) => { rows: unknown[] }): Pool {
  return { query: vi.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params)) } as unknown as Pool;
}

const codec = new IdentityTokenCodec();

const dbRow = {
  google_user_id: "u1",
  email: "ada@example.com",
  spreadsheet_id: "sheet-1",
  spreadsheet_url: "https://docs.google.com/spreadsheets/d/sheet-1",
  spreadsheet_title: "Card2Contact Contacts",
  access_token: "at",
  refresh_token: "rt",
  token_expiry: "1700000000000", // pg returns BIGINT as a string
  saved_contacts_count: 3,
};

describe("PgUserStore.findById", () => {
  it("maps a row to a UserRecord, coercing BIGINT string to number", async () => {
    const store = new PgUserStore(fakePool(() => ({ rows: [dbRow] })), codec);
    const user = await store.findById("u1");
    expect(user).toEqual({
      googleUserId: "u1",
      email: "ada@example.com",
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
      spreadsheetTitle: "Card2Contact Contacts",
      accessToken: "at",
      refreshToken: "rt",
      tokenExpiry: 1700000000000,
      savedContactsCount: 3,
    });
    expect(typeof user!.tokenExpiry).toBe("number");
  });

  it("returns null when no row is found", async () => {
    const store = new PgUserStore(fakePool(() => ({ rows: [] })), codec);
    expect(await store.findById("ghost")).toBeNull();
  });

  it("maps null token columns to null (not the string 'null')", async () => {
    const store = new PgUserStore(
      fakePool(() => ({
        rows: [{ ...dbRow, access_token: null, refresh_token: null, token_expiry: null }],
      })),
      codec,
    );
    const user = await store.findById("u1");
    expect(user!.accessToken).toBeNull();
    expect(user!.refreshToken).toBeNull();
    expect(user!.tokenExpiry).toBeNull();
  });
});

describe("PgUserStore.upsertOnLogin", () => {
  it("binds the identity + token params in order and returns the mapped record", async () => {
    let capturedParams: unknown[] | undefined;
    const store = new PgUserStore(
      fakePool((_sql, params) => {
        capturedParams = params;
        return { rows: [dbRow] };
      }),
      codec,
    );

    await store.upsertOnLogin({
      googleUserId: "u1",
      email: "ada@example.com",
      accessToken: "at",
      refreshToken: "rt",
      tokenExpiry: 1700000000000,
    });

    expect(capturedParams).toEqual(["u1", "ada@example.com", "at", "rt", 1700000000000]);
  });

  it("uses COALESCE so a login without a new refresh token preserves the stored one", async () => {
    let capturedSql = "";
    const store = new PgUserStore(
      fakePool((sql) => {
        capturedSql = sql;
        return { rows: [dbRow] };
      }),
      codec,
    );

    await store.upsertOnLogin({
      googleUserId: "u1",
      email: "e@x.com",
      accessToken: "at",
      refreshToken: null,
      tokenExpiry: null,
    });

    expect(capturedSql).toMatch(/COALESCE\(EXCLUDED\.refresh_token,\s*users\.refresh_token\)/i);
  });
});

describe("PgUserStore.incrementSavedContactsCount", () => {
  it("returns the new count from the RETURNING clause", async () => {
    const store = new PgUserStore(
      fakePool(() => ({ rows: [{ saved_contacts_count: 4 }] })),
      codec,
    );
    expect(await store.incrementSavedContactsCount("u1")).toBe(4);
  });
});

describe("PgUserStore.clearTokens", () => {
  it("issues an UPDATE that nulls the token columns", async () => {
    let capturedSql = "";
    const store = new PgUserStore(
      fakePool((sql) => {
        capturedSql = sql;
        return { rows: [] };
      }),
      codec,
    );
    await store.clearTokens("u1");
    expect(capturedSql).toMatch(/access_token\s*=\s*NULL/i);
    expect(capturedSql).toMatch(/refresh_token\s*=\s*NULL/i);
  });
});

describe("PgUserStore.setSpreadsheet", () => {
  it("persists id, url, and title together", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] | undefined;
    const store = new PgUserStore(
      fakePool((sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] };
      }),
      codec,
    );

    await store.setSpreadsheet("u1", {
      id: "new-sheet",
      url: "https://docs.google.com/spreadsheets/d/new-sheet",
      title: "Card2Contact Contacts",
    });

    // All three in one statement: a Recreate Sheet that updated the id but left
    // a stale url would point the user at the sheet we just abandoned.
    expect(capturedSql).toMatch(/spreadsheet_id\s*=\s*\$2/i);
    expect(capturedSql).toMatch(/spreadsheet_url\s*=\s*\$3/i);
    expect(capturedSql).toMatch(/spreadsheet_title\s*=\s*\$4/i);
    expect(capturedParams).toEqual([
      "u1",
      "new-sheet",
      "https://docs.google.com/spreadsheets/d/new-sheet",
      "Card2Contact Contacts",
    ]);
  });
});

/**
 * Post-cutover a decode failure means the key rotated or the row was tampered
 * with. Throwing would escape into the session middleware and 500 every
 * request, locking the user out with no way back in; degrading to null routes
 * them to the existing Reconnect flow instead. This is the resilience the
 * rollback plan depends on for a wrong-but-valid TOKEN_ENCRYPTION_KEY.
 */
describe("PgUserStore token decode resilience", () => {
  /** A codec that fails to decrypt, as a wrong key would. */
  const brokenCodec = {
    encode: (s: string) => s,
    decode: () => {
      throw new Error("Unsupported state or unable to authenticate data");
    },
  };

  it("degrades an undecodable token to null instead of throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new PgUserStore(fakePool(() => ({ rows: [dbRow] })), brokenCodec);

    const user = await store.findById("u1");

    expect(user).not.toBeNull();
    expect(user!.accessToken).toBeNull();
    expect(user!.refreshToken).toBeNull();
    // The rest of the record must survive — the user is still identified.
    expect(user!.email).toBe("ada@example.com");
    expect(user!.spreadsheetId).toBe("sheet-1");
    errorSpy.mockRestore();
  });

  // Both degrade together, so /status's `accessToken === null &&
  // refreshToken === null` check fires and the user sees the Reconnect prompt.
  it("produces the needsReconnect state rather than a partial one", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new PgUserStore(fakePool(() => ({ rows: [dbRow] })), brokenCodec);

    const user = await store.findById("u1");
    expect(user!.accessToken === null && user!.refreshToken === null).toBe(true);
    errorSpy.mockRestore();
  });

  it("logs loudly, since this always indicates an operational problem", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new PgUserStore(fakePool(() => ({ rows: [dbRow] })), brokenCodec);

    await store.findById("u1");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("failed to decode"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("u1"));
    errorSpy.mockRestore();
  });
});

describe("PgUserStore with AesGcmTokenCodec", () => {
  const aes = new AesGcmTokenCodec(randomBytes(32));

  it("round-trips tokens: ciphertext to the DB, plaintext to the caller", async () => {
    let stored: unknown[] | undefined;
    /**
     * Echo back the row the store just asked us to write, the way a real
     * INSERT ... RETURNING does. Returning the static `dbRow` here would hand
     * back plaintext tokens the store never wrote, silently exercising the
     * decode-failure path while the assertions below still passed.
     */
    const writeStore = new PgUserStore(
      fakePool((_sql, params) => {
        stored = params;
        const [google_user_id, email, access_token, refresh_token, token_expiry] =
          params as [string, string, string, string, number];
        return {
          rows: [
            {
              ...dbRow,
              google_user_id,
              email,
              access_token,
              refresh_token,
              token_expiry: String(token_expiry),
            },
          ],
        };
      }),
      aes,
    );

    const returned = await writeStore.upsertOnLogin({
      googleUserId: "u1",
      email: "ada@example.com",
      accessToken: "ya29.real-access-token",
      refreshToken: "1//real-refresh-token",
      tokenExpiry: 1700000000000,
    });

    // The caller gets plaintext back from the write, not ciphertext.
    expect(returned.accessToken).toBe("ya29.real-access-token");
    expect(returned.refreshToken).toBe("1//real-refresh-token");

    const [, , encodedAccess, encodedRefresh] = stored as string[];
    // ...while what reached the DB is neither plaintext nor decodable without
    // the key, and is shaped as the Token Cutover predicate expects.
    expect(encodedAccess).not.toBe("ya29.real-access-token");
    expect(encodedRefresh).not.toBe("1//real-refresh-token");
    expect(encodedAccess).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(encodedRefresh).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);

    const readStore = new PgUserStore(
      fakePool(() => ({
        rows: [{ ...dbRow, access_token: encodedAccess, refresh_token: encodedRefresh }],
      })),
      aes,
    );
    const user = await readStore.findById("u1");
    expect(user!.accessToken).toBe("ya29.real-access-token");
    expect(user!.refreshToken).toBe("1//real-refresh-token");
  });

  it("degrades to null when the key does not match the ciphertext", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ciphertext = aes.encode("ya29.token");
    // A different, equally valid key — the wrong-but-valid key scenario.
    const wrongKeyStore = new PgUserStore(
      fakePool(() => ({ rows: [{ ...dbRow, access_token: ciphertext, refresh_token: ciphertext }] })),
      new AesGcmTokenCodec(randomBytes(32)),
    );

    const user = await wrongKeyStore.findById("u1");
    expect(user!.accessToken).toBeNull();
    errorSpy.mockRestore();
  });
});

describe("PgUserStore spreadsheet url fallback", () => {
  it("derives the url for rows written before the column existed", async () => {
    const store = new PgUserStore(
      fakePool(() => ({ rows: [{ ...dbRow, spreadsheet_url: null }] })),
      codec,
    );
    const user = await store.findById("u1");
    expect(user!.spreadsheetUrl).toBe("https://docs.google.com/spreadsheets/d/sheet-1");
  });

  it("leaves the url null when there is no spreadsheet at all", async () => {
    const store = new PgUserStore(
      fakePool(() => ({ rows: [{ ...dbRow, spreadsheet_id: null, spreadsheet_url: null }] })),
      codec,
    );
    const user = await store.findById("u1");
    expect(user!.spreadsheetUrl).toBeNull();
  });

  it("prefers the stored url over the derived one", async () => {
    const store = new PgUserStore(
      fakePool(() => ({ rows: [{ ...dbRow, spreadsheet_url: "https://stored.example/x" }] })),
      codec,
    );
    const user = await store.findById("u1");
    expect(user!.spreadsheetUrl).toBe("https://stored.example/x");
  });
});
