import { QuotaStore, EffectiveQuota } from "../../shared/store/quota-store";
import { LicenseSettingsStore } from "../../shared/store/license-settings-store";
import { TierStore, Tier } from "../../shared/store/tier-store";
import {
  TierRequest,
  TierRequestStore,
  DuplicatePendingRequestError,
} from "../../shared/store/tier-request-store";
import { AuditLogger } from "../../shared/audit/audit-logger";
import { Metrics } from "../../shared/observability/metrics";

/**
 * The USER-facing side of License Management — the counterpart to
 * AdminLicenseService. A signed-in user reads their own plan (effective quota +
 * active tier + the catalog they could request) and files an upgrade request.
 * They can never grant themselves anything: filing a request changes no quota;
 * only an admin decision (in AdminLicenseService) acts.
 *
 * Kept a separate service (and module) from admin-licenses so the two surfaces
 * don't share an auth path — this one is behind requireAuth (Google session),
 * that one behind adminAuth (Admin Session). It reuses the SAME stores, so
 * "my plan" and the admin's "their quota" are one source of truth.
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

/** The catalog entry a user sees when choosing an upgrade — no internal fields. */
export interface PublicTier {
  id: number;
  name: string;
  isUnlimited: boolean;
  scanLimit: number | null;
  validityDays: number | null;
  isDefault: boolean;
}

/** Everything the Profile "Your Plan" section renders, in one call. */
export interface MyPlan {
  quota: EffectiveQuota;
  /** The non-archived catalog, for the "request an upgrade" picker. */
  availableTiers: PublicTier[];
  /** The user's open request, if any (drives "pending" state + re-request lock). */
  pendingRequest: TierRequest | null;
  /** Recent request history (status + rejection reason for transparency). */
  recentRequests: TierRequest[];
}

export interface CreateMyRequestInput {
  kind: "tier" | "custom";
  /** 'tier': the catalog tier id the user picked. */
  tierId?: number | null;
  /** 'custom': optional desired amount / duration. */
  amount?: number | null;
  days?: number | null;
  /** Optional for 'tier', required for 'custom'. */
  note?: string | null;
}

/** A user tried to request something invalid (unknown tier, missing custom reason). */
export class RequestValidationError extends Error {
  readonly code = "REQUEST_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function toPublicTier(t: Tier): PublicTier {
  return {
    id: t.id,
    name: t.name,
    isUnlimited: t.isUnlimited,
    scanLimit: t.scanLimit,
    validityDays: t.validityDays,
    isDefault: t.isDefault,
  };
}

export class LicensingService {
  constructor(
    private readonly quotas: QuotaStore,
    private readonly settings: LicenseSettingsStore,
    private readonly tiers: TierStore,
    private readonly requests: TierRequestStore,
    private readonly audit: AuditLogger,
    private readonly metrics: Metrics
  ) {}

  /** The full "Your Plan" payload — quota, catalog, pending request, history. */
  async myPlan(googleUserId: string): Promise<MyPlan> {
    const settings = await this.settings.get();
    const [quota, tiers, pendingRequest, recentRequests] = await Promise.all([
      this.quotas.getEffective(googleUserId, settings),
      this.tiers.list(),
      this.requests.pendingForUser(googleUserId),
      this.requests.listForUser(googleUserId, 10),
    ]);
    return {
      quota,
      availableTiers: tiers.map(toPublicTier),
      pendingRequest,
      recentRequests,
    };
  }

  /**
   * File an upgrade request. Validates the shape, snapshots the requested tier
   * name and the user's current tier (for admin context), then persists. The
   * one-pending-per-user rule is enforced by the store (a DB unique index) and
   * surfaces here as DuplicatePendingRequestError — we let it propagate so the
   * router maps it to a 409.
   */
  async createRequest(googleUserId: string, input: CreateMyRequestInput): Promise<TierRequest> {
    let requestedTierName: string | null = null;

    if (input.kind === "tier") {
      if (input.tierId == null) {
        throw new RequestValidationError("a tier request must name a tier");
      }
      const tier = await this.tiers.get(input.tierId);
      if (!tier || tier.archivedAt) throw new RequestValidationError("that tier is not available");
      requestedTierName = tier.name;
    } else {
      // 'custom' — a business justification is required; amount/days optional.
      if (!input.note || !input.note.trim()) {
        throw new RequestValidationError("a custom request needs a reason");
      }
      if (input.amount != null && (!Number.isInteger(input.amount) || input.amount <= 0)) {
        throw new RequestValidationError("requested amount must be a positive integer");
      }
      if (input.days != null && (!Number.isInteger(input.days) || input.days <= 0)) {
        throw new RequestValidationError("requested duration must be a positive integer");
      }
    }

    // Snapshot the user's current tier name for the admin's context.
    const current = await this.quotas.currentTier(googleUserId);

    const request = await this.requests.create({
      googleUserId,
      kind: input.kind,
      requestedTierId: input.kind === "tier" ? input.tierId : null,
      requestedTierName,
      requestedAmount: input.kind === "custom" ? input.amount ?? null : null,
      requestedDays: input.kind === "custom" ? input.days ?? null : null,
      userNote: input.note ?? null,
      currentTierName: current?.tierName ?? null,
    });

    this.audit.log({ event: "tier_request_created", googleUserId });
    this.metrics.inc("tier_request_created");
    return request;
  }

  /** The user's own request history (Profile page). */
  myRequests(googleUserId: string): Promise<TierRequest[]> {
    return this.requests.listForUser(googleUserId);
  }
}

export { DuplicatePendingRequestError };
