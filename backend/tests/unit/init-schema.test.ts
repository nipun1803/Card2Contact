import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import type { Pool } from "pg";
import { initSchema, wipePlaintextTokens } from "../../src/shared/db/init";
import { AesGcmTokenCodec } from "../../src/shared/store/token-codec";

/**
 * Schema init against a fake `pg` Pool. The DDL assertions only check that the
 * right objects are created idempotently; the interesting tests are for the
 * Token Cutover wipe, which is the one irreversible statement in the system and
 * the one that — if its predicate were wrong — would sign every user out on
 * every restart, forever.
 */
function recordingPool(): { pool: Pool; sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const pool = {
    query: vi.fn(async (q: string, p?: unknown[]) => {
      sql.push(q);
      params.push(p ?? []);
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
  return { pool, sql, params };
}

const joined = (sql: string[]) => sql.join("\n");

describe("initSchema", () => {
  it("creates every table and index with IF NOT EXISTS so it is safe on every boot", async () => {
    const { pool, sql } = recordingPool();
    await initSchema(pool);
    const all = joined(sql);

    expect(all).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS sessions");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS pending_sessions");
    expect(all).toContain("CREATE INDEX IF NOT EXISTS sessions_user_active_idx");
    expect(all).toContain("CREATE INDEX IF NOT EXISTS sessions_last_activity_idx");
    expect(all).toContain("CREATE INDEX IF NOT EXISTS pending_sessions_expires_idx");

    // Every DDL statement must be idempotent — there is no migration tool, so
    // initSchema re-runs in full on each boot.
    const ddl = sql.filter((s) => /CREATE (TABLE|INDEX)|ALTER TABLE/.test(s));
    for (const statement of ddl) {
      expect(statement).toMatch(/IF NOT EXISTS/);
    }
  });

  it("adds the spreadsheet url/title columns additively", async () => {
    const { pool, sql } = recordingPool();
    await initSchema(pool);
    const all = joined(sql);
    expect(all).toContain("ADD COLUMN IF NOT EXISTS spreadsheet_url");
    expect(all).toContain("ADD COLUMN IF NOT EXISTS spreadsheet_title");
  });

  it("adds the Admin User Management disable/restore columns additively", async () => {
    const { pool, sql } = recordingPool();
    await initSchema(pool);
    const all = joined(sql);
    expect(all).toContain("ADD COLUMN IF NOT EXISTS disabled_at");
    expect(all).toContain("ADD COLUMN IF NOT EXISTS disabled_by");
    expect(all).toContain("ADD COLUMN IF NOT EXISTS restored_at");
    expect(all).toContain("ADD COLUMN IF NOT EXISTS restored_by");
    expect(all).toContain("CREATE INDEX IF NOT EXISTS users_disabled_idx");
  });

  it("creates the audit_log table with both indexes and no FK to users", async () => {
    const { pool, sql } = recordingPool();
    await initSchema(pool);
    const all = joined(sql);
    expect(all).toContain("CREATE TABLE IF NOT EXISTS audit_log");
    expect(all).toContain("CREATE INDEX IF NOT EXISTS audit_log_user_ts_idx");
    expect(all).toContain("CREATE INDEX IF NOT EXISTS audit_log_ts_idx");

    const auditLogDdl = sql.find((s) => s.includes("CREATE TABLE IF NOT EXISTS audit_log"))!;
    expect(auditLogDdl).not.toContain("REFERENCES users");
  });

  it("cascades sessions when a user row is deleted, so none are orphaned", async () => {
    const { pool, sql } = recordingPool();
    await initSchema(pool);
    const sessionsDdl = sql.find((s) => s.includes("CREATE TABLE IF NOT EXISTS sessions"))!;
    const pendingDdl = sql.find((s) =>
      s.includes("CREATE TABLE IF NOT EXISTS pending_sessions")
    )!;
    expect(sessionsDdl).toContain("REFERENCES users(google_user_id) ON DELETE CASCADE");
    expect(pendingDdl).toContain("REFERENCES users(google_user_id) ON DELETE CASCADE");
  });

  it("runs the Token Cutover wipe as part of init", async () => {
    const { pool, sql } = recordingPool();
    await initSchema(pool);
    expect(joined(sql)).toContain("SET access_token = NULL");
  });
});

/**
 * The wipe predicate, exercised for real.
 *
 * Asserting the SQL merely *contains* "!~" would pass even with a broken
 * regex — it proves we wrote a query, not that the query is right. Instead we
 * pull the pattern out of the actual bound parameter and evaluate it against
 * genuine Google token shapes and genuine AesGcmTokenCodec output, so a wrong
 * predicate fails the test.
 */
describe("wipePlaintextTokens — the predicate", () => {
  async function boundPattern(): Promise<RegExp> {
    const { pool, params } = recordingPool();
    await wipePlaintextTokens(pool);
    const shape = params[0][0] as string;
    return new RegExp(shape);
  }

  it("does not match real Google access/refresh tokens (they get wiped)", async () => {
    const pattern = await boundPattern();
    // Representative real-world shapes. Neither contains a colon.
    const accessToken = "ya29.a0AfB_byC3xKq9Zm2vN8pLr4TjWs6HgFd1QeRtYuIoP";
    const refreshToken = "1//0gLxKq9Zm2vN8pLr4TjWs6HgFd1QeRtYuIoPaSdFgHjKl";
    expect(pattern.test(accessToken)).toBe(false);
    expect(pattern.test(refreshToken)).toBe(false);
  });

  it("matches real AesGcmTokenCodec output (it survives)", async () => {
    const pattern = await boundPattern();
    const codec = new AesGcmTokenCodec(randomBytes(32));
    // Run several: the IV is random per call, so one pass could be luck.
    for (const plaintext of ["ya29.short", "1//0gL" + "x".repeat(200), "a"]) {
      expect(pattern.test(codec.encode(plaintext))).toBe(true);
    }
  });

  it("nulls both token columns when either is plaintext", async () => {
    const { pool, sql } = recordingPool();
    await wipePlaintextTokens(pool);
    const statement = sql[0];
    expect(statement).toContain("access_token = NULL");
    expect(statement).toContain("refresh_token = NULL");
    expect(statement).toContain("token_expiry = NULL");
    // OR, not AND: a row with one plaintext column is incoherent, and
    // half-wiping it would leave decode() throwing on the survivor.
    expect(statement).toMatch(/access_token\s+!~ \$1\)?\s*\n?\s*OR/);
  });

  it("skips rows whose tokens are already NULL", async () => {
    const pattern = await boundPattern();
    // The SQL guards with IS NOT NULL; the predicate itself would not match "".
    expect(pattern.test("")).toBe(false);
  });
});

/**
 * The regression this whole design exists to prevent: initSchema runs on every
 * boot, so a wipe that isn't self-limiting logs everyone out on every restart.
 */
describe("wipePlaintextTokens — idempotency across restarts", () => {
  /** A tiny in-memory `users` table that actually applies the wipe predicate. */
  function simulatedPool(rows: Array<{ access_token: string | null; refresh_token: string | null }>) {
    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (!sql.includes("SET access_token = NULL")) return { rows: [], rowCount: 0 };
        const pattern = new RegExp(params![0] as string);
        let rowCount = 0;
        for (const row of rows) {
          const bad =
            (row.access_token !== null && !pattern.test(row.access_token)) ||
            (row.refresh_token !== null && !pattern.test(row.refresh_token));
          if (bad) {
            row.access_token = null;
            row.refresh_token = null;
            rowCount++;
          }
        }
        return { rows: [], rowCount };
      }),
    } as unknown as Pool;
  }

  it("wipes plaintext on the first run and nothing on the second", async () => {
    const codec = new AesGcmTokenCodec(randomBytes(32));
    const rows = [
      // Pre-cutover user: plaintext tokens, must be wiped.
      { access_token: "ya29.plaintext-access", refresh_token: "1//plaintext-refresh" },
      // Already-migrated user: must survive untouched, on this boot and every
      // boot after. If this row is ever nulled, every user is signed out of
      // Google on every restart.
      { access_token: codec.encode("ya29.encrypted"), refresh_token: codec.encode("1//encrypted") },
    ];
    const survivor = { ...rows[1] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pool = simulatedPool(rows);
    await wipePlaintextTokens(pool);

    expect(rows[0]).toEqual({ access_token: null, refresh_token: null });
    expect(rows[1]).toEqual(survivor);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 user(s)"));

    // Second boot: zero rows affected, so nobody is signed out again.
    warn.mockClear();
    await wipePlaintextTokens(pool);
    expect(rows[1]).toEqual(survivor);
    expect(warn).not.toHaveBeenCalled();

    // ...and a third, for good measure.
    await wipePlaintextTokens(pool);
    expect(rows[1]).toEqual(survivor);
    warn.mockRestore();
  });

  it("re-wipes a restored plaintext backup (why we use a predicate, not a marker)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A marker column would claim "already migrated" here and let plaintext
    // flow into decode(). Reading the data instead of a claim about it means
    // the restored row is correctly wiped.
    const rows = [{ access_token: "ya29.restored-from-backup", refresh_token: "1//restored" }];
    await wipePlaintextTokens(simulatedPool(rows));
    expect(rows[0]).toEqual({ access_token: null, refresh_token: null });
    warn.mockRestore();
  });

  it("wipes a half-encrypted row entirely", async () => {
    const codec = new AesGcmTokenCodec(randomBytes(32));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = [{ access_token: codec.encode("ya29.enc"), refresh_token: "1//still-plaintext" }];
    await wipePlaintextTokens(simulatedPool(rows));
    expect(rows[0]).toEqual({ access_token: null, refresh_token: null });
    warn.mockRestore();
  });

  it("is silent when there is nothing to wipe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await wipePlaintextTokens(simulatedPool([]));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
