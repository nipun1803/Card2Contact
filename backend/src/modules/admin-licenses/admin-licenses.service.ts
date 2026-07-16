import { UserStore } from "../../shared/store/user-store";
import {
  QuotaStore,
  EffectiveQuota,
  ListQuotasParams,
  ListQuotasResult,
  QuotaStats,
  QuotaLedgerResult,
} from "../../shared/store/quota-store";
import {
  LicenseSettings,
  LicenseSettingsPatch,
  LicenseSettingsStore,
} from "../../shared/store/license-settings-store";
import {
  Tier,
  TierWithCount,
  TierStore,
  CreateTierInput,
  UpdateTierPatch,
} from "../../shared/store/tier-store";
import { TierAssignmentHistoryResult } from "../../shared/store/quota-store";
import {
  TierRequest,
  TierRequestStore,
  ListTierRequestsParams,
  TierRequestPage,
} from "../../shared/store/tier-request-store";
import { AuditLogger } from "../../shared/audit/audit-logger";
import { Metrics } from "../../shared/observability/metrics";

/**
 * License Management business rules. No HTTP here — the router owns status codes
 * and request parsing, this owns "what does grant/adjust/reset/block actually
 * do". Every mutating method follows the same shape as AdminUserService: perform
 * the store op, emit an audit entry and a metric, and append a quota_ledger row
 * (the "why" record). See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

/** A user was named that has no account row. Distinct code from USER_NOT_FOUND
 *  so the admin-users and admin-licenses surfaces stay independently filterable. */
export class LicenseUserNotFoundError extends Error {
  readonly code = "LICENSE_USER_NOT_FOUND";
  constructor(message = "User not found") {
    super(message);
    this.name = "LicenseUserNotFoundError";
  }
}

/** A limit/amount/delta was invalid (negative, zero where positive is required). */
export class LicenseValidationError extends Error {
  readonly code = "LICENSE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "LicenseValidationError";
  }
}

/** Device/browser/ip from the admin's own request, for audit entries. */
export interface RequestFingerprint {
  device: string | null;
  browser: string | null;
  ip: string | null;
}

export interface GrantPaidRequest {
  amount: number;
  /** ISO date, or null for a never-expiring grant. */
  expiresAt: string | null;
  reason?: string;
}

/** A named tier could not be found. */
export class TierNotFoundError extends Error {
  readonly code = "TIER_NOT_FOUND";
  constructor(message = "Tier not found") {
    super(message);
    this.name = "TierNotFoundError";
  }
}

export interface CreateTierRequest {
  name: string;
  isUnlimited: boolean;
  scanLimit: number | null;
  validityDays: number | null;
  sortOrder?: number;
}

export interface UpdateTierRequest {
  name?: string;
  isUnlimited?: boolean;
  scanLimit?: number | null;
  validityDays?: number | null;
  sortOrder?: number;
}

/**
 * How an admin approves a request. Every field is optional: omit them all to
 * approve exactly as the user asked, or set one to override — approve a
 * different tier (`tierId`), convert to (or adjust) a custom grant
 * (`amount`/`days`), and attach a `note`. tierId and amount are mutually
 * exclusive; the service rejects an approval that resolves to both or neither.
 */
export interface ApproveOverride {
  tierId?: number | null;
  amount?: number | null;
  days?: number | null;
  note?: string | null;
}

export class AdminLicenseService {
  constructor(
    private readonly quotas: QuotaStore,
    private readonly settings: LicenseSettingsStore,
    private readonly users: UserStore,
    private readonly tiers: TierStore,
    private readonly requests: TierRequestStore,
    private readonly audit: AuditLogger,
    private readonly metrics: Metrics
  ) {}

  // ── Global settings ────────────────────────────────────────────────────────

  getSettings(): Promise<LicenseSettings> {
    return this.settings.get();
  }

  async updateSettings(
    patch: LicenseSettingsPatch,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<LicenseSettings> {
    this.assertNonNegative(patch.defaultFreeLimit, "defaultFreeLimit");
    this.assertNonNegative(patch.defaultPaidLimit, "defaultPaidLimit");

    const next = await this.settings.update(patch, adminUsername);
    // One audit line for a limit change, one for each pool/enforcement toggle —
    // so `grep global_scanning_toggled` finds every on/off flip.
    if (patch.defaultFreeLimit !== undefined || patch.defaultPaidLimit !== undefined) {
      this.audit.log({ event: "license_default_updated", adminUsername, ...fp });
      this.metrics.inc("license_default_updated");
    }
    if (
      patch.freeEnabled !== undefined ||
      patch.paidEnabled !== undefined ||
      patch.enforcementEnabled !== undefined
    ) {
      this.audit.log({ event: "global_scanning_toggled", adminUsername, ...fp });
      this.metrics.inc("global_scanning_toggled");
    }
    return next;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(params: ListQuotasParams): Promise<ListQuotasResult> {
    const settings = await this.settings.get();
    const result = await this.quotas.list(params, settings);
    // Label each row with the user's email for admin display (batch, no N+1).
    const emails = await this.users.emailsByIds(result.quotas.map((q) => q.googleUserId));
    return {
      ...result,
      quotas: result.quotas.map((q) => ({ ...q, email: emails.get(q.googleUserId) })),
    };
  }

  async stats(): Promise<QuotaStats> {
    const settings = await this.settings.get();
    return this.quotas.stats(settings);
  }

  async getQuota(googleUserId: string): Promise<EffectiveQuota> {
    await this.assertUserExists(googleUserId);
    const settings = await this.settings.get();
    const quota = await this.quotas.getEffective(googleUserId, settings);
    const user = await this.users.findById(googleUserId);
    return { ...quota, email: user?.email };
  }

  async history(
    googleUserId: string,
    cursor: string | undefined,
    limit: number
  ): Promise<QuotaLedgerResult> {
    await this.assertUserExists(googleUserId);
    return this.quotas.ledger(googleUserId, cursor, limit);
  }

  // ── Free override ──────────────────────────────────────────────────────────

  async setFreeLimit(
    googleUserId: string,
    limit: number,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    this.assertNonNegative(limit, "limit");
    await this.assertUserExists(googleUserId);
    await this.quotas.setFreeOverride(googleUserId, limit);
    this.record(googleUserId, "override_set", "quota_override_set", {
      pool: "free",
      delta: limit,
      adminUsername,
      fp,
    });
    return this.getQuota(googleUserId);
  }

  async removeFreeOverride(
    googleUserId: string,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    await this.assertUserExists(googleUserId);
    await this.quotas.setFreeOverride(googleUserId, null);
    this.record(googleUserId, "override_cleared", "quota_override_cleared", {
      pool: "free",
      adminUsername,
      fp,
    });
    return this.getQuota(googleUserId);
  }

  // ── Paid grants ────────────────────────────────────────────────────────────

  async grantPaid(
    googleUserId: string,
    req: GrantPaidRequest,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    if (!Number.isInteger(req.amount) || req.amount <= 0) {
      throw new LicenseValidationError("amount must be a positive integer");
    }
    const expiresAt = this.parseExpiry(req.expiresAt);
    await this.assertUserExists(googleUserId);

    const grantId = await this.quotas.grantPaid(googleUserId, {
      amount: req.amount,
      expiresAt,
      grantedBy: adminUsername,
      reason: req.reason ?? null,
    });
    this.record(googleUserId, "grant", "quota_granted", {
      pool: "paid",
      grantId,
      delta: req.amount,
      reason: req.reason ?? null,
      adminUsername,
      fp,
    });
    return this.getQuota(googleUserId);
  }

  async revokeGrant(
    googleUserId: string,
    grantId: number,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    await this.assertUserExists(googleUserId);
    const revoked = await this.quotas.revokeGrant(googleUserId, grantId);
    if (!revoked) throw new LicenseValidationError("grant not found");
    this.record(googleUserId, "adjust", "quota_grant_revoked", {
      pool: "paid",
      grantId,
      adminUsername,
      fp,
    });
    return this.getQuota(googleUserId);
  }

  async resetPaid(
    googleUserId: string,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    await this.assertUserExists(googleUserId);
    const count = await this.quotas.revokeAllGrants(googleUserId);
    this.record(googleUserId, "reset", "quota_reset", {
      pool: "paid",
      delta: count,
      adminUsername,
      fp,
    });
    return this.getQuota(googleUserId);
  }

  // ── Used counters ──────────────────────────────────────────────────────────

  async resetUsed(
    googleUserId: string,
    pool: "free" | "paid" | "both",
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    await this.assertUserExists(googleUserId);
    await this.quotas.resetUsed(googleUserId, pool);
    this.record(googleUserId, "reset", "quota_reset", {
      pool: pool === "both" ? null : pool,
      adminUsername,
      fp,
    });
    return this.getQuota(googleUserId);
  }

  async recalculate(
    googleUserId: string,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    await this.assertUserExists(googleUserId);
    await this.quotas.recalculate(googleUserId);
    this.record(googleUserId, "recalculate", "quota_recalculated", { adminUsername, fp });
    return this.getQuota(googleUserId);
  }

  // ── Scan-Block ─────────────────────────────────────────────────────────────

  async setScanBlocked(
    googleUserId: string,
    blocked: boolean,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    await this.assertUserExists(googleUserId);
    await this.quotas.setScanBlocked(googleUserId, blocked, adminUsername);
    const event = blocked ? "scan_blocked" : "scan_unblocked";
    this.audit.log({ event, googleUserId, adminUsername, ...fp });
    this.metrics.inc(event);
    this.quotas.appendLedger({
      googleUserId,
      kind: event,
      adminUsername,
    });
    return this.getQuota(googleUserId);
  }

  // ── Tier catalog ─────────────────────────────────────────────────────────

  listTiers(search?: string): Promise<TierWithCount[]> {
    return this.tiers.list({ search });
  }

  async createTier(
    req: CreateTierRequest,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<Tier> {
    this.validateTierShape(req);
    if (await this.tiers.getByName(req.name)) {
      throw new LicenseValidationError(`a tier named "${req.name}" already exists`);
    }
    const input: CreateTierInput = {
      name: req.name,
      isUnlimited: req.isUnlimited,
      scanLimit: req.isUnlimited ? null : req.scanLimit,
      validityDays: req.validityDays,
      sortOrder: req.sortOrder,
      updatedBy: adminUsername,
    };
    const tier = await this.tiers.create(input);
    this.audit.log({ event: "tier_created", adminUsername, reason: tier.name, ...fp });
    this.metrics.inc("tier_created");
    return tier;
  }

  async updateTier(
    id: number,
    req: UpdateTierRequest,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<TierWithCount> {
    const existing = await this.tiers.get(id);
    if (!existing) throw new TierNotFoundError();
    // Validate the RESULTING shape (merge patch over existing) so a limited tier
    // can't be left without a scan_limit.
    this.validateTierShape({
      isUnlimited: req.isUnlimited ?? existing.isUnlimited,
      scanLimit: req.scanLimit ?? existing.scanLimit,
      validityDays: req.validityDays ?? existing.validityDays,
      name: req.name ?? existing.name,
    });
    if (req.name && req.name !== existing.name && (await this.tiers.getByName(req.name))) {
      throw new LicenseValidationError(`a tier named "${req.name}" already exists`);
    }
    const patch: UpdateTierPatch = {
      name: req.name,
      isUnlimited: req.isUnlimited,
      scanLimit: req.scanLimit,
      validityDays: req.validityDays,
      sortOrder: req.sortOrder,
    };
    await this.tiers.update(id, patch, adminUsername);
    this.audit.log({ event: "tier_updated", adminUsername, reason: existing.name, ...fp });
    this.metrics.inc("tier_updated");
    // Return with the assigned count so the UI can show the impact note.
    const counts = await this.tiers.assignedCounts();
    const updated = (await this.tiers.get(id))!;
    return { ...updated, assignedCount: counts.get(id) ?? 0 };
  }

  async archiveTier(id: number, adminUsername: string, fp: RequestFingerprint): Promise<void> {
    const tier = await this.tiers.get(id);
    if (!tier) throw new TierNotFoundError();
    if (tier.isDefault) {
      throw new LicenseValidationError("cannot archive the default tier");
    }
    await this.tiers.archive(id);
    this.audit.log({ event: "tier_archived", adminUsername, reason: tier.name, ...fp });
    this.metrics.inc("tier_archived");
  }

  async cloneTier(
    id: number,
    newName: string,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<Tier> {
    if (!newName || !newName.trim()) throw new LicenseValidationError("clone name is required");
    if (await this.tiers.getByName(newName)) {
      throw new LicenseValidationError(`a tier named "${newName}" already exists`);
    }
    const clone = await this.tiers.clone(id, newName, adminUsername);
    if (!clone) throw new TierNotFoundError();
    this.audit.log({ event: "tier_cloned", adminUsername, reason: newName, ...fp });
    this.metrics.inc("tier_cloned");
    return clone;
  }

  // ── Tier assignment ────────────────────────────────────────────────────────

  async assignTier(
    googleUserId: string,
    tierId: number,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    await this.assertUserExists(googleUserId);
    const tier = await this.tiers.get(tierId);
    if (!tier || tier.archivedAt) throw new TierNotFoundError();
    await this.doAssign(googleUserId, tier, adminUsername);
    this.audit.log({ event: "tier_assigned", googleUserId, adminUsername, reason: tier.name, ...fp });
    this.metrics.inc("tier_assigned");
    return this.getQuota(googleUserId);
  }

  async removeTier(
    googleUserId: string,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<EffectiveQuota> {
    await this.assertUserExists(googleUserId);
    await this.quotas.removeTier(googleUserId, adminUsername);
    this.audit.log({ event: "tier_removed", googleUserId, adminUsername, ...fp });
    this.metrics.inc("tier_removed");
    this.quotas.appendLedger({ googleUserId, kind: "tier_removed", adminUsername });
    return this.getQuota(googleUserId);
  }

  async bulkAssignTier(
    googleUserIds: string[],
    tierId: number,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<{ assigned: number }> {
    const tier = await this.tiers.get(tierId);
    if (!tier || tier.archivedAt) throw new TierNotFoundError();
    let assigned = 0;
    for (const googleUserId of googleUserIds) {
      const user = await this.users.findById(googleUserId);
      if (!user) continue; // skip unknown ids rather than fail the whole batch
      await this.doAssign(googleUserId, tier, adminUsername);
      assigned += 1;
    }
    this.audit.log({ event: "tier_bulk_assigned", adminUsername, reason: tier.name, revokedCount: assigned, ...fp });
    this.metrics.inc("tier_bulk_assigned");
    return { assigned };
  }

  tierHistory(
    googleUserId: string,
    cursor: string | undefined,
    limit: number
  ): Promise<TierAssignmentHistoryResult> {
    return this.quotas.tierHistory(googleUserId, cursor, limit);
  }

  // ── Tier Upgrade Requests (admin side) ───────────────────────────────────────

  /** The admin queue — pending-first when no status filter is passed. */
  async listRequests(params: ListTierRequestsParams): Promise<TierRequestPage> {
    const page = await this.requests.list(params);
    const emails = await this.users.emailsByIds(page.requests.map((r) => r.googleUserId));
    return {
      ...page,
      requests: page.requests.map((r) => ({ ...r, email: emails.get(r.googleUserId) })),
    };
  }

  /** Count of pending requests — the admin nav badge. */
  pendingRequestCount(): Promise<number> {
    return this.requests.pendingCount();
  }

  /** A single user's request history (for the inline view on the detail page). */
  async requestsForUser(googleUserId: string): Promise<TierRequest[]> {
    const requests = await this.requests.listForUser(googleUserId);
    const user = await this.users.findById(googleUserId);
    return requests.map((r) => ({ ...r, email: user?.email }));
  }

  /**
   * Approve a pending request. The admin's decision MAY differ from the ask:
   * `override` lets them approve a different tier or a custom amount/duration.
   * The request is marked decided FIRST (its pending-guard makes a double-approve
   * a no-op — no double grant), THEN the grant flows through the existing
   * assignTier / grantPaid seam. That ordering is deliberate: if the assignment
   * throws, the request is already 'approved' with the granted values recorded,
   * so a retry won't re-grant; the admin sees the decision stuck and can grant
   * manually. Coupling it the other way (grant first) would risk a granted
   * allowance with a still-'pending' request that a second admin approves again.
   */
  async approveRequest(
    requestId: number,
    override: ApproveOverride,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<{ request: TierRequest; quota: EffectiveQuota }> {
    const request = await this.requests.get(requestId);
    if (!request) throw new LicenseValidationError("request not found");
    if (request.status !== "pending") {
      throw new LicenseValidationError("request has already been decided");
    }

    // Resolve what to grant: the admin's override wins, else the user's ask.
    const grantTierId = override.tierId ?? request.requestedTierId ?? null;
    const grantAmount = override.amount ?? request.requestedAmount ?? null;
    const grantDays = override.days ?? request.requestedDays ?? null;

    // A tier grant and a custom grant are mutually exclusive; a valid approval
    // must resolve to exactly one. (Admin can convert a custom ask into a tier
    // and vice-versa via the override.)
    if (grantTierId == null && grantAmount == null) {
      throw new LicenseValidationError(
        "approval must resolve to a tier or a custom scan amount"
      );
    }
    if (grantTierId != null && grantAmount != null) {
      throw new LicenseValidationError(
        "approve with either a tier or a custom amount, not both"
      );
    }
    // A custom grant must be positive, and its validity (if bounded) must be at
    // least a day — grantDays=0 would mint an already-expired, un-drawable grant.
    // (grantPaid re-validates the amount; days has no other guard, so it lives here.)
    if (grantAmount != null && (!Number.isInteger(grantAmount) || grantAmount <= 0)) {
      throw new LicenseValidationError("granted amount must be a positive integer");
    }
    if (grantDays != null && (!Number.isInteger(grantDays) || grantDays <= 0)) {
      throw new LicenseValidationError("granted validity days must be a positive integer");
    }

    // Record the decision first — the pending-guard makes this the idempotency
    // point. A second approve finds status='approved' above and is rejected.
    const decided = await this.requests.decide(requestId, {
      status: "approved",
      decidedBy: adminUsername,
      decisionNote: override.note ?? null,
      grantedTierId: grantTierId,
      grantedAmount: grantAmount,
      grantedDays: grantDays,
    });
    if (!decided) throw new LicenseValidationError("request has already been decided");

    // Now perform the actual grant through the single source of truth.
    let quota: EffectiveQuota;
    if (grantTierId != null) {
      quota = await this.assignTier(request.googleUserId, grantTierId, adminUsername, fp);
    } else {
      const expiresAt =
        grantDays != null
          ? new Date(Date.now() + grantDays * 24 * 60 * 60 * 1000).toISOString()
          : null;
      quota = await this.grantPaid(
        request.googleUserId,
        { amount: grantAmount!, expiresAt, reason: `Upgrade request #${requestId}` },
        adminUsername,
        fp
      );
    }

    this.audit.log({
      event: "tier_request_approved",
      googleUserId: request.googleUserId,
      adminUsername,
      ...fp,
    });
    this.metrics.inc("tier_request_approved");
    return { request: decided, quota };
  }

  /** Reject a pending request, recording the admin's optional reason. */
  async rejectRequest(
    requestId: number,
    note: string | null,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<TierRequest> {
    const request = await this.requests.get(requestId);
    if (!request) throw new LicenseValidationError("request not found");
    if (request.status !== "pending") {
      throw new LicenseValidationError("request has already been decided");
    }
    const decided = await this.requests.decide(requestId, {
      status: "rejected",
      decidedBy: adminUsername,
      decisionNote: note,
    });
    if (!decided) throw new LicenseValidationError("request has already been decided");
    this.audit.log({
      event: "tier_request_rejected",
      googleUserId: request.googleUserId,
      adminUsername,
      ...fp,
    });
    this.metrics.inc("tier_request_rejected");
    return decided;
  }

  /**
   * Resolve a tier's config into the store's AssignTierInput — computing
   * expiresAt from validityDays and capturing the previous tier for the snapshot.
   * This is the ONE place a tier's config becomes an assignment, so it's the
   * single seam a future payment webhook would call.
   */
  private async doAssign(googleUserId: string, tier: Tier, adminUsername: string): Promise<void> {
    const previous = await this.quotas.currentTier(googleUserId);
    const expiresAt =
      tier.validityDays == null
        ? null
        : new Date(Date.now() + tier.validityDays * 24 * 60 * 60 * 1000);
    await this.quotas.assignTier({
      googleUserId,
      tierId: tier.id,
      tierName: tier.name,
      isUnlimited: tier.isUnlimited,
      scanLimit: tier.scanLimit,
      validityDays: tier.validityDays,
      expiresAt,
      adminUsername,
      previousTierId: previous?.tierId ?? null,
      previousTierName: previous?.tierName ?? null,
    });
    this.quotas.appendLedger({
      googleUserId,
      kind: "tier_assigned",
      pool: tier.isUnlimited ? "unlimited" : "paid",
      delta: tier.scanLimit,
      reason: tier.name,
      adminUsername,
    });
  }

  /** A limited tier must carry a positive scan_limit; validity must be positive. */
  private validateTierShape(t: {
    isUnlimited: boolean;
    scanLimit: number | null;
    validityDays: number | null;
    name: string;
  }): void {
    if (!t.name || !t.name.trim()) throw new LicenseValidationError("tier name is required");
    if (!t.isUnlimited) {
      if (t.scanLimit == null || !Number.isInteger(t.scanLimit) || t.scanLimit <= 0) {
        throw new LicenseValidationError("a limited tier needs a positive scan limit");
      }
    }
    if (t.validityDays != null && (!Number.isInteger(t.validityDays) || t.validityDays <= 0)) {
      throw new LicenseValidationError("validity days must be a positive integer");
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async assertUserExists(googleUserId: string): Promise<void> {
    const user = await this.users.findById(googleUserId);
    if (!user) throw new LicenseUserNotFoundError();
  }

  private assertNonNegative(value: number | undefined, field: string): void {
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < 0) {
      throw new LicenseValidationError(`${field} must be a non-negative integer`);
    }
  }

  /** Parse an ISO expiry string; null passes through (never-expires). */
  private parseExpiry(iso: string | null): Date | null {
    if (iso === null) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      throw new LicenseValidationError("expiresAt is not a valid date");
    }
    return date;
  }

  /**
   * One place to emit the audit line, the metric, and the ledger row for an
   * admin quota mutation — so a new action can't forget one of the three.
   */
  private record(
    googleUserId: string,
    ledgerKind: string,
    event:
      | "quota_granted"
      | "quota_grant_revoked"
      | "quota_reset"
      | "quota_recalculated"
      | "quota_override_set"
      | "quota_override_cleared",
    opts: {
      pool?: "free" | "paid" | null;
      grantId?: number;
      delta?: number;
      reason?: string | null;
      adminUsername: string;
      fp: RequestFingerprint;
    }
  ): void {
    this.audit.log({
      event,
      googleUserId,
      adminUsername: opts.adminUsername,
      reason: opts.reason ?? undefined,
      ...opts.fp,
    });
    this.metrics.inc(event);
    this.quotas.appendLedger({
      googleUserId,
      kind: ledgerKind,
      pool: opts.pool ?? null,
      grantId: opts.grantId ?? null,
      delta: opts.delta ?? null,
      reason: opts.reason ?? null,
      adminUsername: opts.adminUsername,
    });
  }
}
