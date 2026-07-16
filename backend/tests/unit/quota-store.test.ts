import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MemoryQuotaStore, PgQuotaStore } from "../../src/shared/store/quota-store";
import {
  LicenseSettings,
  MemoryLicenseSettingsStore,
} from "../../src/shared/store/license-settings-store";

/**
 * The metering behavior matrix. MemoryQuotaStore reimplements the exact
 * free-first-then-paid draw, per-grant expiry, idempotency, and Scan-Block that
 * PgQuotaStore expresses in SQL — so the behavioral proof of the consume policy
 * lives here (the Pg store's own tests can only assert SQL/param shape, since the
 * draw logic runs inside Postgres). A separate block below pins PgQuotaStore's
 * idempotency SQL ordering against a fake Pool.
 */

async function settings(over: Partial<LicenseSettings> = {}): Promise<LicenseSettings> {
  return new MemoryLicenseSettingsStore(over).get();
}

const USER = "u1";

describe("MemoryQuotaStore.consume — free/paid draw order", () => {
  it("draws free until the limit, then falls back to paid", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 2, defaultPaidLimit: 0 });
    await store.grantPaid(USER, { amount: 3, expiresAt: null, grantedBy: "admin" });

    const r1 = await store.consume(USER, "c1", s);
    const r2 = await store.consume(USER, "c2", s);
    const r3 = await store.consume(USER, "c3", s);
    const r4 = await store.consume(USER, "c4", s);

    expect(r1).toMatchObject({ ok: true, pool: "free" });
    expect(r2).toMatchObject({ ok: true, pool: "free" });
    expect(r3).toMatchObject({ ok: true, pool: "paid" }); // free exhausted → paid
    expect(r4).toMatchObject({ ok: true, pool: "paid" });
  });

  it("returns exhausted when both pools are empty", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 1 });
    await store.consume(USER, "c1", s); // uses the one free scan
    const r = await store.consume(USER, "c2", s);
    expect(r).toEqual({ ok: false, reason: "exhausted" });
  });

  it("draws only paid when free is disabled globally", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ freeEnabled: false, defaultFreeLimit: 5 });
    await store.grantPaid(USER, { amount: 1, expiresAt: null, grantedBy: "admin" });
    const r1 = await store.consume(USER, "c1", s);
    const r2 = await store.consume(USER, "c2", s);
    expect(r1).toMatchObject({ ok: true, pool: "paid" });
    expect(r2).toEqual({ ok: false, reason: "exhausted" }); // free never drawn
  });

  it("draws only free when paid is disabled globally", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ paidEnabled: false, defaultFreeLimit: 1 });
    await store.grantPaid(USER, { amount: 5, expiresAt: null, grantedBy: "admin" });
    const r1 = await store.consume(USER, "c1", s);
    const r2 = await store.consume(USER, "c2", s);
    expect(r1).toMatchObject({ ok: true, pool: "free" });
    expect(r2).toEqual({ ok: false, reason: "exhausted" }); // paid grant ignored
  });

  it("exhausts immediately when both pools are disabled", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ freeEnabled: false, paidEnabled: false });
    await store.grantPaid(USER, { amount: 5, expiresAt: null, grantedBy: "admin" });
    expect(await store.consume(USER, "c1", s)).toEqual({ ok: false, reason: "exhausted" });
  });

  it("bills a first-ever scanner (no pre-existing quota row)", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 1 });
    const r = await store.consume("brand-new", "c1", s);
    expect(r).toMatchObject({ ok: true, pool: "free" });
  });
});

describe("MemoryQuotaStore.consume — per-grant expiry (dated first)", () => {
  it("never draws an expired grant", async () => {
    const store = new MemoryQuotaStore();
    store._setNow(new Date("2026-07-01T00:00:00Z").getTime());
    const s = await settings({ defaultFreeLimit: 0 });
    await store.grantPaid(USER, {
      amount: 5,
      expiresAt: new Date("2026-06-01T00:00:00Z"), // already past
      grantedBy: "admin",
    });
    expect(await store.consume(USER, "c1", s)).toEqual({ ok: false, reason: "exhausted" });
  });

  it("draws the soonest-to-expire grant before a never-expiring one", async () => {
    const store = new MemoryQuotaStore();
    store._setNow(new Date("2026-07-01T00:00:00Z").getTime());
    const s = await settings({ defaultFreeLimit: 0 });
    const permanent = await store.grantPaid(USER, {
      amount: 1,
      expiresAt: null,
      grantedBy: "admin",
    });
    const expiring = await store.grantPaid(USER, {
      amount: 1,
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      grantedBy: "admin",
    });
    const r1 = await store.consume(USER, "c1", s);
    const r2 = await store.consume(USER, "c2", s);
    expect(r1).toMatchObject({ ok: true, pool: "paid", grantId: expiring }); // dated first
    expect(r2).toMatchObject({ ok: true, pool: "paid", grantId: permanent });
  });
});

describe("MemoryQuotaStore.consume — exactly-once (idempotency by cardId)", () => {
  it("bills the same cardId only once and replays the prior decision", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 5 });

    const first = await store.consume(USER, "card-A", s);
    const retry = await store.consume(USER, "card-A", s);

    expect(first).toMatchObject({ ok: true, pool: "free", idempotentReplay: false });
    expect(retry).toMatchObject({ ok: true, pool: "free", idempotentReplay: true });
    const eff = await store.getEffective(USER, s);
    expect(eff.freeUsed).toBe(1); // billed once despite two calls
  });

  it("does NOT permanently mark a card billed when the scan was refused", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 0, paidEnabled: true });

    const refused = await store.consume(USER, "card-B", s);
    expect(refused).toEqual({ ok: false, reason: "exhausted" });

    // Admin grants paid; the SAME card can now be billed (pending row rolled back).
    await store.grantPaid(USER, { amount: 1, expiresAt: null, grantedBy: "admin" });
    const now = await store.consume(USER, "card-B", s);
    expect(now).toMatchObject({ ok: true, pool: "paid", idempotentReplay: false });
  });
});

describe("MemoryQuotaStore — Scan-Block wins over remaining quota", () => {
  it("refuses a blocked user even with quota left", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 10 });
    await store.setScanBlocked(USER, true, "admin");
    expect(await store.consume(USER, "c1", s)).toEqual({ ok: false, reason: "blocked" });

    await store.setScanBlocked(USER, false, "admin");
    expect(await store.consume(USER, "c1", s)).toMatchObject({ ok: true, pool: "free" });
  });
});

describe("MemoryQuotaStore — admin ops reflected in getEffective", () => {
  it("free override changes the effective limit; removing it resets to default", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 10 });
    await store.setFreeOverride(USER, 2);
    expect((await store.getEffective(USER, s)).freeLimit).toBe(2);
    await store.setFreeOverride(USER, null);
    expect((await store.getEffective(USER, s)).freeLimit).toBe(10);
    expect((await store.getEffective(USER, s)).hasFreeOverride).toBe(false);
  });

  it("revoking a grant removes it from drawable paid; status becomes revoked", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 0 });
    const g = await store.grantPaid(USER, { amount: 3, expiresAt: null, grantedBy: "admin" });
    expect((await store.getEffective(USER, s)).paidRemaining).toBe(3);
    await store.revokeGrant(USER, g);
    const eff = await store.getEffective(USER, s);
    expect(eff.paidRemaining).toBe(0);
    expect(eff.paidGrants[0].status).toBe("revoked");
  });

  it("recalculate reconciles counters from the consumption ledger", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 5 });
    await store.consume(USER, "c1", s);
    await store.consume(USER, "c2", s);
    // Simulate drift: reset the counter without touching consumptions.
    await store.resetUsed(USER, "free");
    expect((await store.getEffective(USER, s)).freeUsed).toBe(0);
    await store.recalculate(USER);
    expect((await store.getEffective(USER, s)).freeUsed).toBe(2);
  });
});

/**
 * PgQuotaStore against a fake Pool — we can't run the draw (that logic is in
 * Postgres), but we CAN pin the load-bearing idempotency ordering: the dedup row
 * is claimed with INSERT ... ON CONFLICT DO NOTHING before any counter write.
 */
function fakePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params));
  return { pool: { query } as unknown as Pool, query };
}

describe("PgQuotaStore.consume — idempotency SQL ordering", () => {
  it("claims the quota_consumptions row FIRST via ON CONFLICT DO NOTHING", async () => {
    const seen: string[] = [];
    const { pool, query } = fakePool((sql) => {
      seen.push(sql);
      if (sql.includes("INSERT INTO quota_consumptions")) {
        // Simulate a retry: conflict → zero rows claimed.
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT pool, grant_id FROM quota_consumptions")) {
        return { rows: [{ pool: "free", grant_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = new PgQuotaStore(pool);
    const s = await settings({ defaultFreeLimit: 5 });

    const result = await store.consume(USER, "card-A", s);

    // First statement must be the dedup claim.
    expect(seen[0]).toContain("INSERT INTO quota_consumptions");
    expect(seen[0]).toContain("ON CONFLICT (google_user_id, card_id) DO NOTHING");
    // On conflict, it replays the prior decision without any UPDATE to counters.
    expect(result).toMatchObject({ ok: true, pool: "free", idempotentReplay: true });
    expect(query.mock.calls.every(([sql]) => !String(sql).includes("UPDATE scan_quotas"))).toBe(true);
  });
});

describe("MemoryLicenseSettingsStore", () => {
  it("applies a partial update and stamps the actor", async () => {
    const store = new MemoryLicenseSettingsStore({ defaultFreeLimit: 10 });
    const next = await store.update({ defaultFreeLimit: 25, enforcementEnabled: false }, "root");
    expect(next.defaultFreeLimit).toBe(25);
    expect(next.enforcementEnabled).toBe(false);
    expect(next.paidEnabled).toBe(true); // untouched
    expect(next.updatedBy).toBe("root");
  });
});

/**
 * Tier layer behavior — the load-bearing Phase 4 tests. assignTier takes an
 * already-resolved config (what the service computes from a Tier), so these
 * tests exercise the store's enforcement without a tier catalog, which is
 * exactly the config-not-name property: the store only ever sees is_unlimited /
 * scan_limit / expires_at, never a name.
 */
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function assignInput(over: Record<string, unknown> = {}) {
  return {
    googleUserId: USER,
    tierId: 1,
    tierName: "Professional",
    isUnlimited: false,
    scanLimit: 3,
    validityDays: 365,
    expiresAt: new Date(Date.now() + YEAR_MS),
    adminUsername: "root",
    previousTierId: null,
    previousTierName: null,
    ...over,
  } as Parameters<MemoryQuotaStore["assignTier"]>[0];
}

describe("MemoryQuotaStore — unlimited tier", () => {
  it("never blocks and never decrements, but records a consumption", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 0 }); // no free allowance
    await store.assignTier(
      assignInput({
        tierName: "Enterprise",
        isUnlimited: true,
        scanLimit: null,
        expiresAt: new Date(Date.now() + YEAR_MS),
      })
    );

    for (let i = 0; i < 50; i++) {
      const r = await store.consume(USER, `card-${i}`, s);
      expect(r).toMatchObject({ ok: true, pool: "unlimited" });
    }
    // Usage recorded (consumptions exist) but no counter moved.
    const eff = await store.getEffective(USER, s);
    expect(eff.unlimited).toBe(true);
    expect(eff.freeUsed).toBe(0);
    expect(eff.paidGrants).toHaveLength(0); // unlimited creates no grant
  });

  it("expired unlimited window falls back to Free", async () => {
    const store = new MemoryQuotaStore();
    store._setNow(new Date("2026-01-01T00:00:00Z").getTime());
    const s = await settings({ defaultFreeLimit: 1 });
    await store.assignTier(
      assignInput({
        isUnlimited: true,
        scanLimit: null,
        expiresAt: new Date("2026-01-08T00:00:00Z"), // 7-day window
      })
    );
    // Jump past the window.
    store._setNow(new Date("2026-02-01T00:00:00Z").getTime());
    expect(await store.consume(USER, "c1", s)).toMatchObject({ ok: true, pool: "free" });
    expect(await store.consume(USER, "c2", s)).toEqual({ ok: false, reason: "exhausted" });
  });

  it("config not name: a custom-named unlimited tier is honored identically", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 0 });
    await store.assignTier(
      assignInput({ tierId: 99, tierName: "Some Custom Trial", isUnlimited: true, scanLimit: null })
    );
    expect(await store.consume(USER, "c1", s)).toMatchObject({ ok: true, pool: "unlimited" });
  });
});

describe("MemoryQuotaStore — limited tier assignment", () => {
  it("creates a drawable grant that expires, then falls back to Free", async () => {
    const store = new MemoryQuotaStore();
    store._setNow(new Date("2026-01-01T00:00:00Z").getTime());
    const s = await settings({ defaultFreeLimit: 1 });
    await store.assignTier(
      assignInput({ scanLimit: 2, expiresAt: new Date("2026-02-01T00:00:00Z") })
    );

    // Draws free (1) then the tier grant (2), for 3 total.
    expect(await store.consume(USER, "c1", s)).toMatchObject({ ok: true, pool: "free" });
    expect(await store.consume(USER, "c2", s)).toMatchObject({ ok: true, pool: "paid" });
    expect(await store.consume(USER, "c3", s)).toMatchObject({ ok: true, pool: "paid" });
    expect(await store.consume(USER, "c4", s)).toEqual({ ok: false, reason: "exhausted" });

    // After the grant expires, only Free would remain (already used) → exhausted.
    store._setNow(new Date("2026-03-01T00:00:00Z").getTime());
    await store.resetUsed(USER, "free"); // fresh period
    expect(await store.consume(USER, "c5", s)).toMatchObject({ ok: true, pool: "free" });
    expect(await store.consume(USER, "c6", s)).toEqual({ ok: false, reason: "exhausted" });
  });

  it("records a snapshot history row with previous → new", async () => {
    const store = new MemoryQuotaStore();
    await store.assignTier(assignInput({ tierId: 1, tierName: "Professional" }));
    await store.assignTier(
      assignInput({ tierId: 2, tierName: "Enterprise", isUnlimited: true, scanLimit: null, previousTierId: 1, previousTierName: "Professional" })
    );
    const history = await store.tierHistory(USER);
    expect(history.entries[0]).toMatchObject({
      tierName: "Enterprise",
      action: "changed",
      previousTierName: "Professional",
    });
    expect(history.entries[1]).toMatchObject({ tierName: "Professional", action: "assigned" });
    // Current tier is the latest.
    expect((await store.currentTier(USER))?.tierName).toBe("Enterprise");
  });

  it("removeTier writes a 'removed' row and clears the current tier", async () => {
    const store = new MemoryQuotaStore();
    await store.assignTier(assignInput());
    await store.removeTier(USER, "root");
    expect(await store.currentTier(USER)).toBeNull();
    const history = await store.tierHistory(USER);
    expect(history.entries[0].action).toBe("removed");
  });
});

describe("MemoryQuotaStore.stats — lowRemaining reflects true remaining allowance", () => {
  it("counts a user as low-remaining by free+paid remaining, not free_used alone", async () => {
    const store = new MemoryQuotaStore();
    // defaultFreeLimit 10, LOW_REMAINING_THRESHOLD 3: 8 used leaves 2 free remaining (<=3) → low.
    const s = await settings({ defaultFreeLimit: 10 });
    for (let i = 0; i < 8; i++) await store.consume(USER, `c${i}`, s);
    expect((await store.stats(s)).lowRemaining).toBe(1);
  });

  it("a large free_limit_override keeps a heavy free_used user out of lowRemaining", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 5 });
    await store.setFreeOverride(USER, 1000);
    for (let i = 0; i < 8; i++) await store.consume(USER, `c${i}`, s); // 992 free remaining
    expect((await store.stats(s)).lowRemaining).toBe(0);
  });

  it("paid remaining offsets an exhausted free pool", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 1 });
    await store.grantPaid(USER, { amount: 20, expiresAt: null, grantedBy: "admin" });
    await store.consume(USER, "c1", s); // free exhausted, 20 paid remaining
    expect((await store.stats(s)).lowRemaining).toBe(0);
  });

  it("an unlimited user is never counted as low-remaining", async () => {
    const store = new MemoryQuotaStore();
    const s = await settings({ defaultFreeLimit: 0 });
    await store.assignTier(
      assignInput({ isUnlimited: true, scanLimit: null, expiresAt: new Date(Date.now() + YEAR_MS) })
    );
    for (let i = 0; i < 50; i++) await store.consume(USER, `c${i}`, s);
    expect((await store.stats(s)).lowRemaining).toBe(0);
  });

  it("a revoked or expired grant does not count toward paid remaining", async () => {
    const store = new MemoryQuotaStore();
    store._setNow(new Date("2026-01-01T00:00:00Z").getTime());
    const s = await settings({ defaultFreeLimit: 1 });
    await store.grantPaid(USER, {
      amount: 20,
      expiresAt: new Date("2025-12-01T00:00:00Z"), // already expired
      grantedBy: "admin",
    });
    await store.consume(USER, "c1", s); // free exhausted, expired grant doesn't help
    expect((await store.stats(s)).lowRemaining).toBe(1);
  });
});
