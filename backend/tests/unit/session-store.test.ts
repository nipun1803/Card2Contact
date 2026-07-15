import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  PENDING_TTL_MS,
  PgSessionStore,
  REVOKED_RETENTION_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  newSessionId,
} from "../../src/shared/store/session-store";

/**
 * PgSessionStore against a fake `pg` Pool.
 *
 * Expiry is computed with SQL now(), so unlike the Token Cutover predicate we
 * cannot evaluate it in JS here — these tests assert that the correct bounds
 * are bound as parameters and that the SQL has the shape the design requires
 * (atomic consume, soft-delete revoke, both lifetime bounds). The behavioural
 * proof that a 6-day session lives and a 7-day one dies lives in the in-memory
 * fake's tests, which reimplement the predicate and back every integration test.
 */
function fakePool(
  queryImpl: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number } = () => ({
    rows: [],
    rowCount: 0,
  })
): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return queryImpl(sql, params);
    }),
  } as unknown as Pool;
  return { pool, calls };
}

const row = {
  id: "sess-1",
  google_user_id: "u1",
  device: "macOS",
  browser: "Chrome",
  ip: "203.0.113.4",
  created_at: new Date("2026-07-15T10:00:00Z"),
  last_activity_at: new Date("2026-07-15T10:05:00Z"),
};

describe("newSessionId", () => {
  it("is base64url, 256 bits of entropy, and unique per call", () => {
    const id = newSessionId();
    // 32 bytes base64url-encoded, no padding.
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(id, "base64url")).toHaveLength(32);

    const ids = new Set(Array.from({ length: 1000 }, newSessionId));
    expect(ids.size).toBe(1000);
  });

  // The old design put the google_user_id in the cookie. The whole point of an
  // opaque id is that the cookie proves nothing about who you are.
  it("does not encode any user-identifying input", () => {
    expect(newSessionId.length).toBe(0);
  });
});

describe("PgSessionStore.findActive", () => {
  it("requires not-revoked and binds BOTH lifetime bounds", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [row] }));
    await new PgSessionStore(pool).findActive("sess-1");

    const { sql, params } = calls[0];
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("last_activity_at >"); // Idle Timeout
    expect(sql).toContain("created_at       >"); // Absolute Lifetime
    expect(params).toEqual(["sess-1", SESSION_IDLE_MS, SESSION_ABSOLUTE_MS]);
  });

  it("maps a row to a SessionRecord", async () => {
    const { pool } = fakePool(() => ({ rows: [row] }));
    expect(await new PgSessionStore(pool).findActive("sess-1")).toEqual({
      id: "sess-1",
      googleUserId: "u1",
      device: "macOS",
      browser: "Chrome",
      ip: "203.0.113.4",
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
    });
  });

  it("returns null when no row matches", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    expect(await new PgSessionStore(pool).findActive("gone")).toBeNull();
  });
});

describe("PgSessionStore.findActiveForUser", () => {
  it("applies the same Active predicate and takes the most recent", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [row] }));
    await new PgSessionStore(pool).findActiveForUser("u1");

    const { sql, params } = calls[0];
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("ORDER BY last_activity_at DESC");
    expect(sql).toContain("LIMIT 1");
    expect(params).toEqual(["u1", SESSION_IDLE_MS, SESSION_ABSOLUTE_MS]);
  });
});

describe("PgSessionStore.isRevoked", () => {
  // The distinction this method exists for: revoked means "tell the user",
  // expired/unknown means "treat as anonymous". It must NOT apply the lifetime
  // bounds, or an expired-then-revoked session would report as not-revoked.
  it("checks only revoked_at, never the lifetime bounds", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ "?column?": 1 }] }));
    expect(await new PgSessionStore(pool).isRevoked("sess-1")).toBe(true);

    const { sql, params } = calls[0];
    expect(sql).toContain("revoked_at IS NOT NULL");
    expect(sql).not.toContain("last_activity_at");
    expect(sql).not.toContain("created_at");
    expect(params).toEqual(["sess-1"]);
  });

  it("is false for an unknown id", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    expect(await new PgSessionStore(pool).isRevoked("never-existed")).toBe(false);
  });
});

describe("PgSessionStore.revoke", () => {
  it("soft-deletes with a reason and keeps the first revocation's timestamp", async () => {
    const { pool, calls } = fakePool();
    await new PgSessionStore(pool).revoke("sess-1", "logout");

    const { sql, params } = calls[0];
    expect(sql).toContain("SET revoked_at = now()");
    expect(sql).toContain("revoked_reason = $2");
    // Re-revoking must not overwrite the original timestamp/reason.
    expect(sql).toContain("revoked_at IS NULL");
    expect(params).toEqual(["sess-1", "logout"]);
    // Soft delete: the row must survive so isRevoked can answer later.
    expect(sql).not.toContain("DELETE");
  });
});

describe("PgSessionStore.revokeAllForUser", () => {
  it("revokes every active session and returns the count", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 3 }));
    const revoked = await new PgSessionStore(pool).revokeAllForUser(
      "u1",
      "replaced_by_new_login"
    );

    expect(revoked).toBe(3);
    const { sql, params } = calls[0];
    expect(sql).toContain("revoked_at IS NULL");
    expect(params).toEqual(["u1", "replaced_by_new_login"]);
  });

  it("returns 0 when the user had no active session", async () => {
    const { pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    expect(await new PgSessionStore(pool).revokeAllForUser("u1", "logout")).toBe(0);
  });
});

describe("PgSessionStore.consumePending", () => {
  // The atomicity that prevents one Session Conflict minting two sessions.
  it("is a single DELETE ... RETURNING with the expiry check inline", async () => {
    const { pool, calls } = fakePool(() => ({
      rows: [{ id: "p1", google_user_id: "u1", device: null, browser: null, ip: null }],
    }));
    await new PgSessionStore(pool).consumePending("p1");

    const { sql, params } = calls[0];
    expect(sql).toContain("DELETE FROM pending_sessions");
    expect(sql).toContain("RETURNING");
    // No TOCTOU gap: freshness is checked in the same statement that consumes.
    expect(sql).toContain("expires_at > now()");
    expect(params).toEqual(["p1"]);
    expect(calls).toHaveLength(1);
  });

  it("returns null for an expired or unknown pending id", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    expect(await new PgSessionStore(pool).consumePending("stale")).toBeNull();
  });
});

describe("PgSessionStore.createPending", () => {
  it("sets expiry from PENDING_TTL_MS", async () => {
    const { pool, calls } = fakePool(() => ({
      rows: [{ id: "p1", google_user_id: "u1", device: "iPhone", browser: "Safari", ip: "1.2.3.4" }],
    }));
    await new PgSessionStore(pool).createPending("u1", {
      device: "iPhone",
      browser: "Safari",
      ip: "1.2.3.4",
    });
    expect(calls[0].params).toContain(PENDING_TTL_MS);
  });
});

describe("PgSessionStore.purgeExpired", () => {
  it("retains revoked rows for the retention window, then drops them", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 2 }));
    const result = await new PgSessionStore(pool).purgeExpired();

    expect(result).toEqual({ sessions: 2, pending: 2 });
    const sessionsPurge = calls[0];
    expect(sessionsPurge.params).toEqual([
      REVOKED_RETENTION_MS,
      SESSION_IDLE_MS,
      SESSION_ABSOLUTE_MS,
    ]);
    // Both un-revoked expiry paths must be reclaimed, not just the idle one.
    expect(sessionsPurge.sql).toContain("last_activity_at <");
    expect(sessionsPurge.sql).toContain("created_at       <");
    expect(calls[1].sql).toContain("DELETE FROM pending_sessions WHERE expires_at < now()");
  });
});

describe("session lifetime constants", () => {
  // The relationship the whole two-bound design rests on. If Absolute ever
  // exceeded Idle, Absolute would stop being the binding constraint and the
  // comments (and the security guarantee) would silently become false.
  it("Absolute Lifetime is the binding constraint", () => {
    expect(SESSION_ABSOLUTE_MS).toBeLessThan(SESSION_IDLE_MS);
  });

  it("matches the documented values", () => {
    expect(SESSION_ABSOLUTE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(SESSION_IDLE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(PENDING_TTL_MS).toBe(5 * 60 * 1000);
  });
});
