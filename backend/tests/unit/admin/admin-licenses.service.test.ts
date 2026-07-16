import { describe, expect, it, vi } from "vitest";
import {
  AdminLicenseService,
  LicenseUserNotFoundError,
  LicenseValidationError,
  TierNotFoundError,
} from "../../../src/modules/admin-licenses/admin-licenses.service";
import { MemoryAuditLogger } from "../../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../../src/shared/observability/metrics";
import {
  makeLicenseSettingsStore,
  makeQuotaStore,
  makeTierStore,
  makeTierRequestStore,
  makeUserStore,
} from "../../mocks/stores";
import { makeUser } from "../../fixtures/contacts";

/**
 * AdminLicenseService business rules. Uses the real in-memory quota/settings
 * stores (so effects are observable) plus a MemoryAuditLogger/Metrics to assert
 * that every mutation audits, counts, AND appends a ledger row — the three-write
 * discipline the service centralizes.
 */

const ADMIN = "root";
const FP = { device: "macOS", browser: "Chrome", ip: "203.0.113.1" };
const USER = "u1";

function ctx(userExists = true) {
  const quotas = makeQuotaStore();
  const settings = makeLicenseSettingsStore({ defaultFreeLimit: 10, defaultPaidLimit: 0 });
  const tiers = makeTierStore(quotas);
  const requests = makeTierRequestStore();
  const users = makeUserStore({
    findById: vi.fn(async () => (userExists ? makeUser({ googleUserId: USER }) : null)),
  });
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const service = new AdminLicenseService(quotas, settings, users, tiers, requests, audit, metrics);
  return { quotas, settings, tiers, requests, users, audit, metrics, service };
}

describe("AdminLicenseService — email enrichment (admin display)", () => {
  it("getQuota attaches the user's email", async () => {
    const { service } = ctx();
    const quota = await service.getQuota(USER);
    expect(quota.email).toBe("ada@analyticalengines.com");
  });

  it("list labels every quota row with an email (batch)", async () => {
    const { service, quotas, settings } = ctx();
    // Materialize a quota row so list() returns it.
    await quotas.consume(USER, "card-1", await settings.get());
    const result = await service.list({ limit: 20, status: "all" });
    expect(result.quotas.length).toBeGreaterThan(0);
    expect(result.quotas[0].email).toBe("ada@analyticalengines.com");
  });

  it("requestsForUser labels each request with the user's email", async () => {
    const { service, tiers, requests } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    await requests.create({
      googleUserId: USER,
      kind: "tier",
      requestedTierId: pro.id,
      requestedTierName: "Professional",
    });
    const list = await service.requestsForUser(USER);
    expect(list[0].email).toBe("ada@analyticalengines.com");
  });

  it("leaves email undefined when the user has no row (falls back to id in the UI)", async () => {
    // A user store that resolves no emails (e.g. a deleted user still referenced).
    const quotas = makeQuotaStore();
    const settings = makeLicenseSettingsStore({ defaultFreeLimit: 10 });
    const users = makeUserStore({ emailsByIds: async () => new Map() });
    const service = new AdminLicenseService(
      quotas,
      settings,
      users,
      makeTierStore(quotas),
      makeTierRequestStore(),
      new MemoryAuditLogger(),
      new MemoryMetrics()
    );
    await quotas.consume(USER, "card-1", await settings.get());
    const result = await service.list({ limit: 20, status: "all" });
    expect(result.quotas[0].email).toBeUndefined();
  });
});

describe("AdminLicenseService — user existence gate", () => {
  it("throws LicenseUserNotFoundError for an unknown user on every quota op", async () => {
    const { service } = ctx(false);
    await expect(service.getQuota(USER)).rejects.toBeInstanceOf(LicenseUserNotFoundError);
    await expect(service.setFreeLimit(USER, 5, ADMIN, FP)).rejects.toBeInstanceOf(
      LicenseUserNotFoundError
    );
    await expect(
      service.grantPaid(USER, { amount: 5, expiresAt: null }, ADMIN, FP)
    ).rejects.toBeInstanceOf(LicenseUserNotFoundError);
  });
});

describe("AdminLicenseService — validation", () => {
  it("rejects a non-positive grant amount", async () => {
    const { service } = ctx();
    await expect(
      service.grantPaid(USER, { amount: 0, expiresAt: null }, ADMIN, FP)
    ).rejects.toBeInstanceOf(LicenseValidationError);
  });

  it("rejects a negative free limit", async () => {
    const { service } = ctx();
    await expect(service.setFreeLimit(USER, -1, ADMIN, FP)).rejects.toBeInstanceOf(
      LicenseValidationError
    );
  });

  it("rejects an invalid expiry date", async () => {
    const { service } = ctx();
    await expect(
      service.grantPaid(USER, { amount: 5, expiresAt: "not-a-date" }, ADMIN, FP)
    ).rejects.toBeInstanceOf(LicenseValidationError);
  });
});

describe("AdminLicenseService — grantPaid emits audit + metric + ledger", () => {
  it("grants and records all three", async () => {
    const { service, audit, metrics, quotas } = ctx();
    const quota = await service.grantPaid(USER, { amount: 5, expiresAt: null, reason: "trial" }, ADMIN, FP);

    expect(quota.paidRemaining).toBe(5);
    expect(audit.ofType("quota_granted")).toHaveLength(1);
    expect(audit.ofType("quota_granted")[0]).toMatchObject({ googleUserId: USER, adminUsername: ADMIN });
    expect(metrics.get("quota_granted")).toBe(1);
    const ledger = await quotas.ledger(USER);
    expect(ledger.entries[0]).toMatchObject({ kind: "grant", pool: "paid", delta: 5 });
  });
});

describe("AdminLicenseService — free override lifecycle", () => {
  it("set then remove override reflects in effective limit and ledger", async () => {
    const { service, quotas } = ctx();
    let quota = await service.setFreeLimit(USER, 2, ADMIN, FP);
    expect(quota.freeLimit).toBe(2);
    expect(quota.hasFreeOverride).toBe(true);

    quota = await service.removeFreeOverride(USER, ADMIN, FP);
    expect(quota.freeLimit).toBe(10); // back to default
    expect(quota.hasFreeOverride).toBe(false);

    const kinds = (await quotas.ledger(USER)).entries.map((e) => e.kind);
    expect(kinds).toContain("override_set");
    expect(kinds).toContain("override_cleared");
  });
});

describe("AdminLicenseService — scan block", () => {
  it("blocks then unblocks, auditing each with the right event", async () => {
    const { service, audit } = ctx();
    let quota = await service.setScanBlocked(USER, true, ADMIN, FP);
    expect(quota.scanBlock.blocked).toBe(true);
    expect(audit.ofType("scan_blocked")).toHaveLength(1);

    quota = await service.setScanBlocked(USER, false, ADMIN, FP);
    expect(quota.scanBlock.blocked).toBe(false);
    expect(audit.ofType("scan_unblocked")).toHaveLength(1);
  });
});

describe("AdminLicenseService — settings", () => {
  it("audits a default-limit change and a toggle separately", async () => {
    const { service, audit, metrics } = ctx();
    await service.updateSettings({ defaultFreeLimit: 25 }, ADMIN, FP);
    expect(audit.ofType("license_default_updated")).toHaveLength(1);
    expect(audit.ofType("global_scanning_toggled")).toHaveLength(0);

    await service.updateSettings({ enforcementEnabled: false }, ADMIN, FP);
    expect(audit.ofType("global_scanning_toggled")).toHaveLength(1);
    expect(metrics.get("global_scanning_toggled")).toBe(1);
  });

  it("rejects a negative default limit", async () => {
    const { service } = ctx();
    await expect(
      service.updateSettings({ defaultFreeLimit: -5 }, ADMIN, FP)
    ).rejects.toBeInstanceOf(LicenseValidationError);
  });
});

describe("AdminLicenseService — revoke grant", () => {
  it("revokes an existing grant; errors on an unknown grant id", async () => {
    const { service } = ctx();
    const quota = await service.grantPaid(USER, { amount: 3, expiresAt: null }, ADMIN, FP);
    const grantId = quota.paidGrants[0].id;

    const after = await service.revokeGrant(USER, grantId, ADMIN, FP);
    expect(after.paidRemaining).toBe(0);

    await expect(service.revokeGrant(USER, 99999, ADMIN, FP)).rejects.toBeInstanceOf(
      LicenseValidationError
    );
  });
});

describe("AdminLicenseService — tier catalog", () => {
  it("creates a tier, auditing it", async () => {
    const { service, audit } = ctx();
    const tier = await service.createTier(
      { name: "Starter", isUnlimited: false, scanLimit: 100, validityDays: 30 },
      ADMIN,
      FP
    );
    expect(tier).toMatchObject({ name: "Starter", scanLimit: 100 });
    expect(audit.ofType("tier_created")).toHaveLength(1);
  });

  it("rejects a limited tier with no scan limit", async () => {
    const { service } = ctx();
    await expect(
      service.createTier({ name: "Bad", isUnlimited: false, scanLimit: null, validityDays: null }, ADMIN, FP)
    ).rejects.toBeInstanceOf(LicenseValidationError);
  });

  it("rejects a duplicate tier name", async () => {
    const { service } = ctx();
    await expect(
      service.createTier({ name: "Free", isUnlimited: false, scanLimit: 5, validityDays: null }, ADMIN, FP)
    ).rejects.toBeInstanceOf(LicenseValidationError);
  });

  it("cannot archive the default tier", async () => {
    const { service, tiers } = ctx();
    const free = (await tiers.list()).find((t) => t.name === "Free")!;
    await expect(service.archiveTier(free.id, ADMIN, FP)).rejects.toBeInstanceOf(
      LicenseValidationError
    );
  });

  it("clones a tier with a new name", async () => {
    const { service, tiers } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    const clone = await service.cloneTier(pro.id, "Professional 2026", ADMIN, FP);
    expect(clone.name).toBe("Professional 2026");
    expect(clone.scanLimit).toBe(pro.scanLimit);
  });

  it("update returns the assigned-count for the impact note", async () => {
    const { service, tiers } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    const updated = await service.updateTier(pro.id, { scanLimit: 1500 }, ADMIN, FP);
    expect(updated.scanLimit).toBe(1500);
    expect(updated.assignedCount).toBe(0);
  });
});

describe("AdminLicenseService — tier assignment", () => {
  it("assigns a tier and reflects it in the active tier", async () => {
    const { service, tiers, audit } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    const quota = await service.assignTier(USER, pro.id, ADMIN, FP);
    expect(quota.activeTier?.name).toBe("Professional");
    expect(audit.ofType("tier_assigned")).toHaveLength(1);
  });

  it("assigning an unlimited tier makes the quota unlimited", async () => {
    const { service, tiers } = ctx();
    const ent = (await tiers.list()).find((t) => t.name === "Enterprise")!;
    const quota = await service.assignTier(USER, ent.id, ADMIN, FP);
    expect(quota.unlimited).toBe(true);
  });

  it("rejects an unknown tier", async () => {
    const { service } = ctx();
    await expect(service.assignTier(USER, 99999, ADMIN, FP)).rejects.toBeInstanceOf(
      TierNotFoundError
    );
  });

  it("bulk-assign counts only known users", async () => {
    const { service, tiers, users } = ctx();
    (users.findById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === "known" ? makeUser({ googleUserId: id }) : null
    );
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    const result = await service.bulkAssignTier(["known", "ghost"], pro.id, ADMIN, FP);
    expect(result.assigned).toBe(1);
  });

  it("tier history records assignment then removal", async () => {
    const { service, tiers } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    await service.assignTier(USER, pro.id, ADMIN, FP);
    await service.removeTier(USER, ADMIN, FP);
    const history = await service.tierHistory(USER, undefined, 20);
    expect(history.entries[0].action).toBe("removed");
    expect(history.entries[1].action).toBe("assigned");
  });
});

describe("AdminLicenseService — upgrade requests (approve/reject)", () => {
  async function seedTierRequest(requests: ReturnType<typeof makeTierRequestStore>, tierId: number) {
    return requests.create({
      googleUserId: USER,
      kind: "tier",
      requestedTierId: tierId,
      requestedTierName: "Professional",
      currentTierName: "Free",
    });
  }

  it("approve as-asked assigns the requested tier through the standard seam", async () => {
    const { service, tiers, requests, quotas } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    const req = await seedTierRequest(requests, pro.id);

    const { request, quota } = await service.approveRequest(req.id, {}, ADMIN, FP);

    expect(request.status).toBe("approved");
    expect(request.grantedTierId).toBe(pro.id);
    // The grant actually landed: the user now has a Professional tier active.
    expect(quota.activeTier?.name).toBe("Professional");
    // And a tier_assignments row exists (the standard assignTier path ran).
    const current = await quotas.currentTier(USER);
    expect(current?.tierName).toBe("Professional");
  });

  it("approve with a different tier overrides the ask", async () => {
    const { service, tiers, requests } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    const ent = (await tiers.list()).find((t) => t.name === "Enterprise")!;
    const req = await seedTierRequest(requests, pro.id);

    const { quota } = await service.approveRequest(req.id, { tierId: ent.id }, ADMIN, FP);
    expect(quota.unlimited).toBe(true); // Enterprise is unlimited
  });

  it("approve with a custom amount grants paid instead of a tier", async () => {
    const { service, requests } = ctx();
    // A custom request (no tier).
    const req = await requests.create({
      googleUserId: USER,
      kind: "custom",
      requestedAmount: 500,
      userNote: "event",
      currentTierName: "Free",
    });
    const { quota } = await service.approveRequest(req.id, {}, ADMIN, FP);
    expect(quota.paidRemaining).toBe(500);
  });

  it("rejects a custom approval resolving to grantDays=0 (would expire instantly)", async () => {
    const { service, requests } = ctx();
    const req = await requests.create({
      googleUserId: USER,
      kind: "custom",
      requestedAmount: 100,
      userNote: "x",
      currentTierName: "Free",
    });
    await expect(
      service.approveRequest(req.id, { days: 0 }, ADMIN, FP)
    ).rejects.toBeInstanceOf(LicenseValidationError);
  });

  it("a second approve of the same request is rejected (no double-grant)", async () => {
    const { service, tiers, requests } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    const req = await seedTierRequest(requests, pro.id);
    await service.approveRequest(req.id, {}, ADMIN, FP);
    await expect(service.approveRequest(req.id, {}, ADMIN, FP)).rejects.toBeInstanceOf(
      LicenseValidationError
    );
  });

  it("reject records the reason and grants nothing", async () => {
    const { service, tiers, requests, quotas } = ctx();
    const pro = (await tiers.list()).find((t) => t.name === "Professional")!;
    const req = await seedTierRequest(requests, pro.id);
    const decided = await service.rejectRequest(req.id, "contact sales", ADMIN, FP);
    expect(decided).toMatchObject({ status: "rejected", decisionNote: "contact sales" });
    expect(await quotas.currentTier(USER)).toBeNull();
  });
});
