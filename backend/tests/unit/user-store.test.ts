import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgUserStore } from "../../src/shared/store/user-store";
import { IdentityTokenCodec } from "../../src/shared/store/token-codec";

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
