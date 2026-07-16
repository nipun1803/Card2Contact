import { describe, expect, it, vi } from "vitest";
import { PgAuditLogger } from "../../../src/shared/audit/pg-audit-logger";

function makePool(queryImpl?: (...args: unknown[]) => unknown) {
  return { query: vi.fn(queryImpl ?? (async () => ({ rows: [{ count: "0" }] }))) };
}

describe("PgAuditLogger.log", () => {
  it("P1: inserts into audit_log and truncates sessionId to 8 chars", async () => {
    const pool = makePool();
    const logger = new PgAuditLogger(pool as never);

    logger.log({ event: "login", googleUserId: "u1", sessionId: "0123456789abcdef" });
    await Promise.resolve(); // let the fire-and-forget insert's promise settle

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO audit_log");
    expect(params[3]).toBe("01234567"); // session_id param, truncated
  });

  it("P2: a rejected pool.query does not throw synchronously", async () => {
    const pool = { query: vi.fn(() => Promise.reject(new Error("db down"))) };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new PgAuditLogger(pool as never);

    expect(() => logger.log({ event: "login", googleUserId: "u1" })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("P3: still writes to stdout", async () => {
    const pool = makePool();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new PgAuditLogger(pool as never);

    logger.log({ event: "login", googleUserId: "u1" });

    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("PgAuditLogger.query", () => {
  it("paginates via a cursor and reports nextCursor when there's more", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: 3 - i,
      ts: new Date(`2026-01-0${3 - i}T00:00:00.000Z`),
      event: "login",
      google_user_id: "u1",
      admin_username: null,
      session_id: null,
      device: null,
      browser: null,
      ip: null,
      outcome: null,
      reason: null,
      card_id: null,
      revoked_count: null,
    }));
    const pool = makePool(async (sql: unknown) => {
      if (typeof sql === "string" && sql.includes("COUNT(*)")) return { rows: [{ count: "3" }] };
      return { rows };
    });
    const logger = new PgAuditLogger(pool as never);

    const result = await logger.query({ googleUserId: "u1", limit: 2 });

    expect(result.total).toBe(3);
    expect(result.entries).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns nextCursor: null on the last page", async () => {
    const pool = makePool(async (sql: unknown) => {
      if (typeof sql === "string" && sql.includes("COUNT(*)")) return { rows: [{ count: "1" }] };
      return {
        rows: [
          {
            id: 1,
            ts: new Date("2026-01-01T00:00:00.000Z"),
            event: "login",
            google_user_id: "u1",
            admin_username: null,
            session_id: null,
            device: null,
            browser: null,
            ip: null,
            outcome: null,
            reason: null,
            card_id: null,
            revoked_count: null,
          },
        ],
      };
    });
    const logger = new PgAuditLogger(pool as never);

    const result = await logger.query({ googleUserId: "u1", limit: 20 });

    expect(result.nextCursor).toBeNull();
  });
});
