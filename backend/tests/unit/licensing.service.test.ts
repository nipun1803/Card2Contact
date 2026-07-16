import { describe, expect, it } from "vitest";
import {
  LicensingService,
  RequestValidationError,
} from "../../src/modules/licensing/licensing.service";
import { DuplicatePendingRequestError } from "../../src/shared/store/tier-request-store";
import { MemoryAuditLogger } from "../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../src/shared/observability/metrics";
import {
  makeLicenseSettingsStore,
  makeQuotaStore,
  makeTierStore,
  makeTierRequestStore,
} from "../mocks/stores";

/**
 * The user-facing licensing service. Filing a request must never change a quota
 * (only an admin decision does), the one-pending rule must hold, and a 'custom'
 * request must carry a reason. myPlan bundles quota + catalog + pending + history.
 */

const USER = "u1";

function ctx() {
  const quotas = makeQuotaStore();
  const settings = makeLicenseSettingsStore({ defaultFreeLimit: 30, defaultPaidLimit: 0 });
  const tiers = makeTierStore(quotas);
  const requests = makeTierRequestStore();
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const service = new LicensingService(quotas, settings, tiers, requests, audit, metrics);
  return { quotas, settings, tiers, requests, audit, metrics, service };
}

describe("LicensingService — myPlan", () => {
  it("bundles quota, the tier catalog, and (empty) request state", async () => {
    const { service } = ctx();
    const plan = await service.myPlan(USER);
    expect(plan.quota.freeLimit).toBe(30);
    expect(plan.availableTiers.map((t) => t.name)).toContain("Professional");
    expect(plan.pendingRequest).toBeNull();
    expect(plan.recentRequests).toEqual([]);
  });

  it("surfaces a pending request once filed", async () => {
    const { service, tiers } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    await service.createRequest(USER, { kind: "tier", tierId: pro.id });
    const plan = await service.myPlan(USER);
    expect(plan.pendingRequest?.requestedTierName).toBe("Professional");
  });
});

describe("LicensingService — createRequest", () => {
  it("files a tier request and snapshots the tier name + current tier", async () => {
    const { service, tiers, quotas } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    const r = await service.createRequest(USER, { kind: "tier", tierId: pro.id, note: "please" });
    expect(r).toMatchObject({
      kind: "tier",
      requestedTierId: pro.id,
      requestedTierName: "Professional",
      userNote: "please",
      status: "pending",
    });
    // Filing changed NOTHING about the quota.
    const q = await quotas.getEffective(USER, await ctx().settings.get());
    expect(q.activeTier).toBeNull();
  });

  it("rejects a tier request with no tier", async () => {
    const { service } = ctx();
    await expect(service.createRequest(USER, { kind: "tier" })).rejects.toBeInstanceOf(
      RequestValidationError
    );
  });

  it("rejects a tier request for an unknown/archived tier", async () => {
    const { service } = ctx();
    await expect(
      service.createRequest(USER, { kind: "tier", tierId: 9999 })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("requires a reason for a custom request", async () => {
    const { service } = ctx();
    await expect(
      service.createRequest(USER, { kind: "custom", amount: 100 })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("rejects a non-positive custom amount", async () => {
    const { service } = ctx();
    await expect(
      service.createRequest(USER, { kind: "custom", amount: 0, note: "x" })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("accepts a valid custom request", async () => {
    const { service } = ctx();
    const r = await service.createRequest(USER, {
      kind: "custom",
      amount: 500,
      days: 30,
      note: "big event",
    });
    expect(r).toMatchObject({ kind: "custom", requestedAmount: 500, requestedDays: 30 });
  });

  it("enforces one pending request per user", async () => {
    const { service, tiers } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    await service.createRequest(USER, { kind: "tier", tierId: pro.id });
    await expect(
      service.createRequest(USER, { kind: "tier", tierId: pro.id })
    ).rejects.toBeInstanceOf(DuplicatePendingRequestError);
  });
});
