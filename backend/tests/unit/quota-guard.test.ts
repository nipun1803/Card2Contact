import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createQuotaGuard } from "../../src/shared/http/quota-guard";
import { QuotaExceededError, ScanBlockedError } from "../../src/shared/http/pipeline-errors";
import { MemoryAuditLogger } from "../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../src/shared/observability/metrics";
import { makeLicenseSettingsStore, makeQuotaStore } from "../mocks/stores";

/**
 * The quota guard's branching, in isolation from Express routing. We drive it
 * with a minimal fake req/res and assert what it passes to next(): nothing on
 * success, a QuotaExceededError (402) when exhausted under enforcement, a
 * ScanBlockedError (403) when Scan-Blocked, and nothing (allow overage) when
 * enforcement is off.
 */

const USER = "u1";

function fakeReq(cardId = "card-1"): Request {
  return {
    auth: { googleUserId: USER },
    params: { cardId },
    get: () => undefined,
    ip: "203.0.113.1",
  } as unknown as Request;
}

const res = {} as Response;

async function run(guard: ReturnType<typeof createQuotaGuard>, req = fakeReq()) {
  const next = vi.fn();
  await guard(req, res, next);
  return next;
}

function ctx(settingsOverride = {}) {
  const quotas = makeQuotaStore();
  const settings = makeLicenseSettingsStore({ defaultFreeLimit: 1, ...settingsOverride });
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const guard = createQuotaGuard(quotas, settings, audit, metrics);
  return { quotas, settings, audit, metrics, guard };
}

describe("createQuotaGuard", () => {
  it("calls next() with no error and records a consume on success", async () => {
    const { guard, audit, metrics } = ctx();
    const next = await run(guard);
    expect(next).toHaveBeenCalledWith();
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(audit.ofType("quota_consumed")).toHaveLength(1);
    expect(metrics.get("quota_consumed", { pool: "free" })).toBe(1);
  });

  it("throws QuotaExceededError (402) when exhausted under enforcement", async () => {
    const { guard } = ctx({ defaultFreeLimit: 1 });
    await run(guard, fakeReq("card-1")); // uses the one free scan
    const next = await run(guard, fakeReq("card-2")); // exhausted
    expect(next.mock.calls[0][0]).toBeInstanceOf(QuotaExceededError);
  });

  it("throws ScanBlockedError (403) for a Scan-Blocked user, even with quota", async () => {
    const { guard, quotas } = ctx({ defaultFreeLimit: 100 });
    await quotas.setScanBlocked(USER, true, "admin");
    const next = await run(guard);
    expect(next.mock.calls[0][0]).toBeInstanceOf(ScanBlockedError);
  });

  it("allows the scan (no error) when enforcement is OFF, even if exhausted", async () => {
    const { guard } = ctx({ defaultFreeLimit: 0, enforcementEnabled: false });
    const next = await run(guard);
    expect(next).toHaveBeenCalledWith();
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  it("does not double-count a retried cardId (idempotent replay)", async () => {
    const { guard, metrics } = ctx({ defaultFreeLimit: 5 });
    await run(guard, fakeReq("same-card"));
    await run(guard, fakeReq("same-card")); // retry
    // The consume metric fires once; the replay is silent.
    expect(metrics.get("quota_consumed", { pool: "free" })).toBe(1);
  });
});
