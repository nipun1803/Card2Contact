import { Pool } from "pg";
import { LicenseSettings } from "./license-settings-store";

/**
 * Per-user scan quota. The FREE pool is a single counter with a NULLable
 * per-user override (COALESCE to the global default). The PAID pool is the set
 * of the user's non-expired, unrevoked grants (see PaidGrant) — modelled as
 * rows, not a scalar, so each grant can expire independently.
 *
 * This is the inter-module contract the quota guard and the admin-licenses
 * service depend on — not Postgres. Tests inject MemoryQuotaStore.
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

/** One paid grant. `status` is computed from expires_at/revoked_at at read time. */
export interface PaidGrant {
  id: number;
  amount: number;
  used: number;
  expiresAt: Date | null;
  grantedAt: Date;
  grantedBy: string;
  revokedAt: Date | null;
  reason: string | null;
  /** Active = drawable now; Expired = past expires_at; Revoked = admin-removed. */
  status: "active" | "expired" | "revoked";
}

/** Whether a user is currently Scan-Blocked (scanning refused, login unaffected). */
export interface ScanBlockState {
  blocked: boolean;
  blockedAt: Date | null;
  blockedBy: string | null;
}

/**
 * The user's current tier (the latest non-removed assignment), resolved for the
 * admin UI. `unlimited` mirrors the tier's config — enforcement keys off THIS,
 * never the name. `unlimitedUntil` is the window end when unlimited; null
 * otherwise. Null `activeTier` means the user is on the default (Free) fallback.
 */
export interface ActiveTier {
  tierId: number | null;
  name: string;
  unlimited: boolean;
  unlimitedUntil: Date | null;
  expiresAt: Date | null;
}

/**
 * The full quota picture for the admin UI: the free counter, every paid grant
 * with its status, and the derived totals. `totalRemaining` counts only
 * *drawable* allowance (free remaining + active-grant remaining). When
 * `activeTier.unlimited` is true, remaining is not meaningful (the UI shows
 * "Unlimited").
 */
export interface EffectiveQuota {
  googleUserId: string;
  /** The user's email, for admin display. Enriched by the service (joins users);
   *  absent when the store returns raw quota math. Clients fall back to the id. */
  email?: string;
  freeLimit: number; // COALESCE(override, default)
  freeUsed: number;
  freeRemaining: number;
  hasFreeOverride: boolean;
  paidGrants: PaidGrant[];
  paidRemaining: number; // sum over active grants of (amount - used)
  totalRemaining: number;
  scanBlock: ScanBlockState;
  /** The resolved current tier (null = on the default/Free fallback). */
  activeTier: ActiveTier | null;
  /** True when an unlimited tier window is active now. */
  unlimited: boolean;
}

/**
 * The result of a consume attempt. On refusal, `reason` tells the guard which
 * HTTP status to raise: "blocked" -> 403 SCAN_BLOCKED, "exhausted" -> 402
 * QUOTA_EXCEEDED. `idempotentReplay` is true when this cardId was already billed
 * (a retry) — the guard treats it as success without emitting a fresh consume
 * event. `pool: "unlimited"` means an active unlimited tier allowed the scan
 * without drawing down any counter.
 */
export type ConsumeResult =
  | {
      ok: true;
      pool: "free" | "paid" | "unlimited";
      grantId: number | null;
      idempotentReplay: boolean;
    }
  | { ok: false; reason: "blocked" | "exhausted" };

/** One tier-assignment history row (snapshot of the tier as of assign time). */
export interface TierAssignmentEntry {
  id: number;
  googleUserId: string;
  tierId: number | null;
  tierName: string | null;
  isUnlimited: boolean | null;
  scanLimit: number | null;
  validityDays: number | null;
  expiresAt: Date | null;
  previousTierId: number | null;
  previousTierName: string | null;
  action: "assigned" | "changed" | "removed";
  assignedBy: string | null;
  assignedAt: Date;
}

export interface TierAssignmentHistoryResult {
  entries: TierAssignmentEntry[];
  nextCursor: string | null;
  total: number;
}

export type QuotaStatusFilter =
  | "all"
  | "low"
  | "over"
  | "custom"
  | "scan_blocked"
  | "expiring_paid";
export type QuotaSortField = "freeUsed" | "totalRemaining" | "googleUserId";
export type SortDirection = "asc" | "desc";

export interface ListQuotasParams {
  cursor?: string;
  limit: number;
  search?: string;
  status?: QuotaStatusFilter;
  sortField?: QuotaSortField;
  sortDirection?: SortDirection;
}

export interface ListQuotasResult {
  quotas: EffectiveQuota[];
  nextCursor: string | null;
  total: number;
  totalPages: number;
}

export interface QuotaStats {
  /** Users with a materialized quota row or any grant. */
  usersWithQuota: number;
  /** Users currently Scan-Blocked. */
  scanBlocked: number;
  /** App-wide free scans consumed. */
  totalFreeUsed: number;
  /** App-wide paid scans consumed (across all grants). */
  totalPaidUsed: number;
  /** Non-unlimited users whose free+paid remaining is at/under the low-remaining threshold. */
  lowRemaining: number;
}

/** One append-only history entry. */
export interface QuotaLedgerEntry {
  googleUserId: string;
  kind: string; // consume|grant|adjust|reset|recalculate|override_set|override_cleared|grant_expired|scan_blocked|scan_unblocked|tier_assigned|tier_removed
  pool?: "free" | "paid" | "unlimited" | null;
  grantId?: number | null;
  delta?: number | null;
  reason?: string | null;
  adminUsername?: string | null;
}

export interface QuotaLedgerResult {
  entries: (QuotaLedgerEntry & { id: number; ts: string })[];
  nextCursor: string | null;
  total: number;
}

/** A grant to create. */
export interface GrantPaidInput {
  amount: number;
  expiresAt: Date | null;
  grantedBy: string;
  reason?: string | null;
}

export interface QuotaStore {
  /**
   * Meter one scan for a card. Exactly-once by cardId (a retry returns the prior
   * decision without re-drawing). Draws free first, then the soonest-to-expire
   * active grant. See the implementation for the full ordering — it encodes the
   * business policy.
   */
  consume(googleUserId: string, cardId: string, settings: LicenseSettings): Promise<ConsumeResult>;

  /** The admin view of one user's quota, resolved against the global settings. */
  getEffective(googleUserId: string, settings: LicenseSettings): Promise<EffectiveQuota>;

  /** Search/filter/sort/paginate the quota directory. */
  list(params: ListQuotasParams, settings: LicenseSettings): Promise<ListQuotasResult>;

  /** Dashboard summary counts. */
  stats(settings: LicenseSettings): Promise<QuotaStats>;

  /** Set (value) or remove (null) the per-user free limit override. */
  setFreeOverride(googleUserId: string, value: number | null): Promise<void>;

  /** Create a new paid grant (assign / increase paid). Returns the new grant id. */
  grantPaid(googleUserId: string, input: GrantPaidInput): Promise<number>;

  /** Soft-revoke one grant (decrease). Returns false if the grant doesn't exist. */
  revokeGrant(googleUserId: string, grantId: number): Promise<boolean>;

  /** Soft-revoke every active grant for the user (reset paid). Returns count revoked. */
  revokeAllGrants(googleUserId: string): Promise<number>;

  /** Reset used counters to zero for the given pool(s). */
  resetUsed(googleUserId: string, pool: "free" | "paid" | "both"): Promise<void>;

  /**
   * Reconcile free_used / grant.used against the quota_consumptions ledger, in
   * case a fire-and-forget write or manual edit ever drifts the counters.
   */
  recalculate(googleUserId: string): Promise<void>;

  /** Scan-Block (true) or Unblock (false) the user's scanning. */
  setScanBlocked(googleUserId: string, blocked: boolean, adminUsername: string): Promise<void>;

  /** Read one user's quota history (cursor paginated, newest first). */
  ledger(googleUserId: string, cursor?: string, limit?: number): Promise<QuotaLedgerResult>;

  /** Append a ledger row. Fire-and-forget: never throws into the caller. */
  appendLedger(entry: QuotaLedgerEntry): void;

  // ── Tier layer (Phase 4) ───────────────────────────────────────────────────

  /**
   * Assign a tier to a user. The caller (service) resolves the Tier from the
   * catalog and passes its config here, so the store never depends on TierStore.
   * If `unlimited`, sets an `unlimited_until` window; else inserts a tier-stamped
   * paid grant of `scanLimit` scans. Writes a `tier_assignments` snapshot row
   * (previous → new, actor, action). Returns the new EffectiveQuota inputs are
   * read by getEffective afterwards.
   */
  assignTier(input: AssignTierInput): Promise<void>;

  /** Remove the user's tier (fall back to the default). Writes a 'removed' row. */
  removeTier(googleUserId: string, adminUsername: string): Promise<void>;

  /** The current tier assignment (latest non-removed), or null if on default. */
  currentTier(googleUserId: string): Promise<TierAssignmentEntry | null>;

  /** One user's tier-assignment history (cursor paginated, newest first). */
  tierHistory(
    googleUserId: string,
    cursor?: string,
    limit?: number
  ): Promise<TierAssignmentHistoryResult>;
}

/**
 * Everything the store needs to record a tier assignment — resolved by the
 * service from the tier catalog so the store stays catalog-agnostic. `expiresAt`
 * and `unlimitedUntil` are pre-computed from `validityDays` by the service.
 */
export interface AssignTierInput {
  googleUserId: string;
  tierId: number;
  tierName: string;
  isUnlimited: boolean;
  scanLimit: number | null;
  validityDays: number | null;
  /** now + validityDays (or null for no expiry) — used for the grant/window. */
  expiresAt: Date | null;
  adminUsername: string;
  previousTierId: number | null;
  previousTierName: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Postgres implementation
// ─────────────────────────────────────────────────────────────────────────────

const LOW_REMAINING_THRESHOLD = 3;

export class PgQuotaStore implements QuotaStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Meter one scan. Multi-step by necessity (the codebase uses no transactions;
   * correctness rests on ORDER + the quota_consumptions UNIQUE row):
   *
   *   1. Idempotency gate: INSERT the (user, card_id) dedup row FIRST. If it
   *      conflicts, this cardId was already billed — return the prior decision,
   *      no second draw.
   *   2. Scan-Block check: a blocked user is refused regardless of quota.
   *   3. Free draw, then 4. soonest-to-expire paid grant draw.
   *   5. Finalize the dedup row with the pool drawn, or roll it back on refusal
   *      so a later scan (after a grant) can still bill this card.
   *
   * The draw ORDERING in steps 2–5 is the business policy — see consumeDraw().
   */
  async consume(
    googleUserId: string,
    cardId: string,
    settings: LicenseSettings
  ): Promise<ConsumeResult> {
    // Step 1 — idempotency gate. 'pending' is finalized (or the row deleted) below.
    const claim = await this.pool.query<{ pool: string; grant_id: string | null }>(
      `INSERT INTO quota_consumptions (google_user_id, card_id, pool)
         VALUES ($1, $2, 'pending')
       ON CONFLICT (google_user_id, card_id) DO NOTHING
       RETURNING pool, grant_id`,
      [googleUserId, cardId]
    );
    if (claim.rowCount === 0) {
      // Retry of an already-billed card — replay the recorded decision.
      const prior = await this.pool.query<{ pool: string; grant_id: string | null }>(
        `SELECT pool, grant_id FROM quota_consumptions
          WHERE google_user_id = $1 AND card_id = $2`,
        [googleUserId, cardId]
      );
      const row = prior.rows[0];
      // A row still 'pending' means the original attempt was refused and rolled
      // back concurrently, or is mid-flight; treat a non-final pool as exhausted.
      if (!row || row.pool === "pending") return { ok: false, reason: "exhausted" };
      return {
        ok: true,
        pool: row.pool as "free" | "paid" | "unlimited",
        grantId: row.grant_id === null ? null : Number(row.grant_id),
        idempotentReplay: true,
      };
    }

    // We hold the claim. Run the draw; finalize or roll back the pending row.
    const result = await this.consumeDraw(googleUserId, settings);
    if (!result.ok) {
      await this.pool.query(
        `DELETE FROM quota_consumptions WHERE google_user_id = $1 AND card_id = $2`,
        [googleUserId, cardId]
      );
      return result;
    }
    await this.pool.query(
      `UPDATE quota_consumptions SET pool = $3, grant_id = $4
        WHERE google_user_id = $1 AND card_id = $2`,
      [googleUserId, cardId, result.pool, result.grantId]
    );
    return result;
  }

  /**
   * The core draw policy: decide whether this user may scan right now and, if so,
   * which pool it draws from — AFTER the idempotency claim is held (so this runs
   * at most once per card). Does NOT touch quota_consumptions; the caller
   * finalizes/rolls back that row based on this result.
   *
   * Steps to implement (see the plan, Phase 3 "highest-risk logic"):
   *   a. Scan-Block: if the user's scan_quotas row has scan_blocked_at set,
   *      return { ok:false, reason:"blocked" }. (No row = not blocked.)
   *   b. Free draw: materialize the scan_quotas row (INSERT ... ON CONFLICT DO
   *      NOTHING) then one atomic
   *        UPDATE scan_quotas SET free_used = free_used + 1
   *          WHERE google_user_id=$1
   *            AND $freeEnabled
   *            AND free_used < COALESCE(free_limit_override, $defaultFree)
   *          RETURNING free_used
   *      One row back => drew free => return { ok:true, pool:"free", grantId:null }.
   *   c. Paid draw (only if free returned nothing AND settings.paidEnabled): draw
   *      the soonest-to-expire eligible grant in ONE statement (see the plan's
   *      SQL: ORDER BY expires_at NULLS LAST, LIMIT 1 FOR UPDATE SKIP LOCKED).
   *      One row => return { ok:true, pool:"paid", grantId:<id> }.
   *   d. Nothing drawable => return { ok:false, reason:"exhausted" }.
   *
   * Tier layer: between (a) and (b), an active unlimited-tier window
   * (scan_quotas.unlimited_until in the future) short-circuits to allow-always
   * WITHOUT decrementing any counter — usage is still recorded (the caller
   * finalizes a 'unlimited' consumption row + ledger) for analytics.
   */
  private async consumeDraw(
    googleUserId: string,
    settings: LicenseSettings
  ): Promise<ConsumeResult> {
    // (a) Scan-Block wins over any remaining quota. A missing row = not blocked.
    // Read the unlimited window in the same round-trip.
    const q = await this.pool.query<{ scan_blocked_at: Date | null; unlimited_until: Date | null }>(
      `SELECT scan_blocked_at, unlimited_until FROM scan_quotas WHERE google_user_id = $1`,
      [googleUserId]
    );
    if (q.rows[0]?.scan_blocked_at != null) return { ok: false, reason: "blocked" };

    // (a2) Unlimited tier window active → allow always, no draw. Enforcement keys
    // off this time window (set from the tier's config), never a tier name.
    const unlimitedUntil = q.rows[0]?.unlimited_until ?? null;
    if (unlimitedUntil != null && unlimitedUntil.getTime() > Date.now()) {
      return { ok: true, pool: "unlimited", grantId: null, idempotentReplay: false };
    }

    // (b) Free draw. Materialize the row first so a first-ever scanner has one to
    // UPDATE, then decrement only if under the effective limit. The disabled flag
    // is a JS guard rather than a SQL clause: if free is off, we simply don't try
    // it and fall through to paid.
    if (settings.freeEnabled) {
      await this.pool.query(
        `INSERT INTO scan_quotas (google_user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [googleUserId]
      );
      const free = await this.pool.query(
        `UPDATE scan_quotas SET free_used = free_used + 1, updated_at = now()
          WHERE google_user_id = $1
            AND free_used < COALESCE(free_limit_override, $2)
          RETURNING free_used`,
        [googleUserId, settings.defaultFreeLimit]
      );
      if ((free.rowCount ?? 0) > 0) {
        return { ok: true, pool: "free", grantId: null, idempotentReplay: false };
      }
    }

    // (c) Paid draw — soonest-to-expire non-expired, unrevoked, non-full grant.
    // NULLS LAST so never-expiring grants are spent only after dated ones
    // (use-it-or-lose-it). SKIP LOCKED lets concurrent scans pick different rows
    // instead of serializing on the same grant.
    if (settings.paidEnabled) {
      const paid = await this.pool.query<{ id: string }>(
        `UPDATE paid_grants SET used = used + 1
          WHERE id = (
            SELECT id FROM paid_grants
             WHERE google_user_id = $1 AND revoked_at IS NULL
               AND used < amount AND (expires_at IS NULL OR now() < expires_at)
             ORDER BY expires_at ASC NULLS LAST
             LIMIT 1 FOR UPDATE SKIP LOCKED
          )
          RETURNING id`,
        [googleUserId]
      );
      if ((paid.rowCount ?? 0) > 0) {
        return { ok: true, pool: "paid", grantId: Number(paid.rows[0].id), idempotentReplay: false };
      }
    }

    // (d) Nothing drawable.
    return { ok: false, reason: "exhausted" };
  }

  async getEffective(googleUserId: string, settings: LicenseSettings): Promise<EffectiveQuota> {
    const quotaRow = await this.pool.query<{
      free_limit_override: number | null;
      free_used: number;
      scan_blocked_at: Date | null;
      scan_blocked_by: string | null;
      unlimited_until: Date | null;
    }>(
      `SELECT free_limit_override, free_used, scan_blocked_at, scan_blocked_by, unlimited_until
         FROM scan_quotas WHERE google_user_id = $1`,
      [googleUserId]
    );
    const q = quotaRow.rows[0];
    const freeUsed = q?.free_used ?? 0;
    const hasFreeOverride = q?.free_limit_override != null;
    const freeLimit = q?.free_limit_override ?? settings.defaultFreeLimit;

    const grants = await this.loadGrants(googleUserId);
    const paidRemaining = grants
      .filter((g) => g.status === "active")
      .reduce((sum, g) => sum + (g.amount - g.used), 0);
    const freeRemaining = Math.max(0, freeLimit - freeUsed);

    const current = await this.currentTier(googleUserId);
    const unlimitedUntil = q?.unlimited_until ?? null;
    const unlimited = unlimitedUntil != null && unlimitedUntil.getTime() > Date.now();
    const activeTier: ActiveTier | null = current
      ? {
          tierId: current.tierId,
          name: current.tierName ?? "",
          unlimited: current.isUnlimited ?? false,
          unlimitedUntil,
          expiresAt: current.expiresAt,
        }
      : null;

    return {
      googleUserId,
      freeLimit,
      freeUsed,
      freeRemaining,
      hasFreeOverride,
      paidGrants: grants,
      paidRemaining,
      totalRemaining: freeRemaining + paidRemaining,
      scanBlock: {
        blocked: q?.scan_blocked_at != null,
        blockedAt: q?.scan_blocked_at ?? null,
        blockedBy: q?.scan_blocked_by ?? null,
      },
      activeTier,
      unlimited,
    };
  }

  /** All grants for a user, newest first, with computed status. */
  private async loadGrants(googleUserId: string): Promise<PaidGrant[]> {
    const { rows } = await this.pool.query<{
      id: string;
      amount: number;
      used: number;
      expires_at: Date | null;
      granted_at: Date;
      granted_by: string;
      revoked_at: Date | null;
      reason: string | null;
    }>(
      `SELECT id, amount, used, expires_at, granted_at, granted_by, revoked_at, reason
         FROM paid_grants WHERE google_user_id = $1
        ORDER BY granted_at DESC, id DESC`,
      [googleUserId]
    );
    const now = Date.now();
    return rows.map((r) => ({
      id: Number(r.id),
      amount: r.amount,
      used: r.used,
      expiresAt: r.expires_at,
      grantedAt: r.granted_at,
      grantedBy: r.granted_by,
      revokedAt: r.revoked_at,
      reason: r.reason,
      status: r.revoked_at
        ? "revoked"
        : r.expires_at && r.expires_at.getTime() <= now
          ? "expired"
          : "active",
    }));
  }

  async list(params: ListQuotasParams, settings: LicenseSettings): Promise<ListQuotasResult> {
    const limit = Math.min(100, Math.max(1, params.limit));
    // The quota directory is driven by the users table left-joined to scan_quotas
    // (so users who have never scanned still appear with default remaining).
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.search) {
      values.push(`%${params.search}%`, params.search);
      conditions.push(
        `(u.email ILIKE $${values.length - 1} OR u.google_user_id = $${values.length})`
      );
    }
    if (params.status === "scan_blocked") conditions.push("q.scan_blocked_at IS NOT NULL");
    if (params.status === "custom") conditions.push("q.free_limit_override IS NOT NULL");

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM users u LEFT JOIN scan_quotas q ON q.google_user_id = u.google_user_id ${where}`,
      values
    );
    const total = Number(countResult.rows[0].count);

    const direction = params.sortDirection === "asc" ? "ASC" : "DESC";
    values.push(limit + 1);
    const { rows } = await this.pool.query<{ google_user_id: string }>(
      `SELECT u.google_user_id
         FROM users u LEFT JOIN scan_quotas q ON q.google_user_id = u.google_user_id
         ${where}
        ORDER BY COALESCE(q.free_used, 0) ${direction}, u.google_user_id ${direction}
        LIMIT $${values.length}`,
      values
    );
    const hasMore = rows.length > limit;
    const pageIds = rows.slice(0, limit).map((r) => r.google_user_id);
    const quotas = await Promise.all(pageIds.map((id) => this.getEffective(id, settings)));
    const last = pageIds[pageIds.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last) : null;

    return { quotas, nextCursor, total, totalPages: Math.ceil(total / limit) };
  }

  async stats(settings: LicenseSettings): Promise<QuotaStats> {
    const { rows } = await this.pool.query<{
      users_with_quota: string;
      scan_blocked: string;
      total_free_used: string;
      total_paid_used: string;
      low_remaining: string;
    }>(
      `SELECT
         COUNT(*)                                             AS users_with_quota,
         COUNT(*) FILTER (WHERE scan_blocked_at IS NOT NULL)  AS scan_blocked,
         COALESCE(SUM(free_used), 0)                          AS total_free_used,
         (SELECT COALESCE(SUM(used), 0) FROM paid_grants)     AS total_paid_used,
         COUNT(*) FILTER (
           WHERE (unlimited_until IS NULL OR unlimited_until <= now())
             AND GREATEST(0, COALESCE(free_limit_override, $1) - free_used)
               + COALESCE((
                   SELECT SUM(amount - used) FROM paid_grants pg
                    WHERE pg.google_user_id = scan_quotas.google_user_id
                      AND pg.revoked_at IS NULL
                      AND (pg.expires_at IS NULL OR pg.expires_at > now())
                 ), 0) <= $2
         ) AS low_remaining
       FROM scan_quotas`,
      [settings.defaultFreeLimit, LOW_REMAINING_THRESHOLD]
    );
    const r = rows[0];
    return {
      usersWithQuota: Number(r.users_with_quota),
      scanBlocked: Number(r.scan_blocked),
      totalFreeUsed: Number(r.total_free_used),
      totalPaidUsed: Number(r.total_paid_used),
      lowRemaining: Number(r.low_remaining),
    };
  }

  async setFreeOverride(googleUserId: string, value: number | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO scan_quotas (google_user_id, free_limit_override)
         VALUES ($1, $2)
       ON CONFLICT (google_user_id) DO UPDATE
         SET free_limit_override = EXCLUDED.free_limit_override, updated_at = now()`,
      [googleUserId, value]
    );
  }

  async grantPaid(googleUserId: string, input: GrantPaidInput): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO paid_grants (google_user_id, amount, expires_at, granted_by, reason)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [googleUserId, input.amount, input.expiresAt, input.grantedBy, input.reason ?? null]
    );
    return Number(rows[0].id);
  }

  async revokeGrant(googleUserId: string, grantId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE paid_grants SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 AND google_user_id = $2`,
      [grantId, googleUserId]
    );
    return (rowCount ?? 0) > 0;
  }

  async revokeAllGrants(googleUserId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE paid_grants SET revoked_at = now()
        WHERE google_user_id = $1 AND revoked_at IS NULL`,
      [googleUserId]
    );
    return rowCount ?? 0;
  }

  async resetUsed(googleUserId: string, pool: "free" | "paid" | "both"): Promise<void> {
    if (pool === "free" || pool === "both") {
      await this.pool.query(
        `UPDATE scan_quotas SET free_used = 0, updated_at = now() WHERE google_user_id = $1`,
        [googleUserId]
      );
    }
    if (pool === "paid" || pool === "both") {
      await this.pool.query(
        `UPDATE paid_grants SET used = 0 WHERE google_user_id = $1 AND revoked_at IS NULL`,
        [googleUserId]
      );
    }
  }

  /**
   * Reconcile counters from the exactly-once quota_consumptions ledger — the
   * authoritative record of what was actually billed. free_used becomes the
   * count of free consumptions; each grant's used becomes the count of paid
   * consumptions attributed to it.
   */
  async recalculate(googleUserId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scan_quotas SET free_used = (
         SELECT COUNT(*) FROM quota_consumptions
          WHERE google_user_id = $1 AND pool = 'free'
       ), updated_at = now()
       WHERE google_user_id = $1`,
      [googleUserId]
    );
    await this.pool.query(
      `UPDATE paid_grants g SET used = (
         SELECT COUNT(*) FROM quota_consumptions c
          WHERE c.google_user_id = $1 AND c.pool = 'paid' AND c.grant_id = g.id
       )
       WHERE g.google_user_id = $1`,
      [googleUserId]
    );
  }

  async setScanBlocked(
    googleUserId: string,
    blocked: boolean,
    adminUsername: string
  ): Promise<void> {
    if (blocked) {
      await this.pool.query(
        `INSERT INTO scan_quotas (google_user_id, scan_blocked_at, scan_blocked_by)
           VALUES ($1, now(), $2)
         ON CONFLICT (google_user_id) DO UPDATE
           SET scan_blocked_at = COALESCE(scan_quotas.scan_blocked_at, now()),
               scan_blocked_by = COALESCE(scan_quotas.scan_blocked_by, $2),
               updated_at = now()`,
        [googleUserId, adminUsername]
      );
    } else {
      await this.pool.query(
        `UPDATE scan_quotas
            SET scan_blocked_at = NULL, scan_blocked_by = NULL,
                scan_unblocked_at = now(), scan_unblocked_by = $2, updated_at = now()
          WHERE google_user_id = $1`,
        [googleUserId, adminUsername]
      );
    }
  }

  async ledger(googleUserId: string, cursor?: string, limit = 20): Promise<QuotaLedgerResult> {
    const pageSize = Math.min(100, Math.max(1, limit));
    const values: unknown[] = [googleUserId];
    let cursorCond = "";
    if (cursor) {
      values.push(Number(Buffer.from(cursor, "base64url").toString("utf8")));
      cursorCond = `AND id < $${values.length}`;
    }
    values.push(pageSize + 1);
    const { rows } = await this.pool.query<{
      id: string;
      ts: Date;
      kind: string;
      pool: string | null;
      grant_id: string | null;
      delta: number | null;
      reason: string | null;
      admin_username: string | null;
    }>(
      `SELECT id, ts, kind, pool, grant_id, delta, reason, admin_username
         FROM quota_ledger
        WHERE google_user_id = $1 ${cursorCond}
        ORDER BY id DESC
        LIMIT $${values.length}`,
      values
    );
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM quota_ledger WHERE google_user_id = $1`,
      [googleUserId]
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? Buffer.from(String(last.id)).toString("base64url") : null;
    return {
      total: Number(countResult.rows[0].count),
      nextCursor,
      entries: page.map((r) => ({
        id: Number(r.id),
        ts: r.ts.toISOString(),
        googleUserId,
        kind: r.kind,
        pool: (r.pool as "free" | "paid" | "unlimited" | null) ?? null,
        grantId: r.grant_id === null ? null : Number(r.grant_id),
        delta: r.delta,
        reason: r.reason,
        adminUsername: r.admin_username,
      })),
    };
  }

  /** Fire-and-forget, like AuditLogger.log — a ledger hiccup never fails a scan. */
  appendLedger(entry: QuotaLedgerEntry): void {
    this.pool
      .query(
        `INSERT INTO quota_ledger (google_user_id, kind, pool, grant_id, delta, reason, admin_username)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.googleUserId,
          entry.kind,
          entry.pool ?? null,
          entry.grantId ?? null,
          entry.delta ?? null,
          entry.reason ?? null,
          entry.adminUsername ?? null,
        ]
      )
      .catch((err) => console.warn("[quota-store] ledger append failed", err));
  }

  // ── Tier layer ───────────────────────────────────────────────────────────

  async assignTier(input: AssignTierInput): Promise<void> {
    if (input.isUnlimited) {
      // Unlimited: set the per-user allow-always window. No grant to draw down.
      await this.pool.query(
        `INSERT INTO scan_quotas (google_user_id, unlimited_until)
           VALUES ($1, $2)
         ON CONFLICT (google_user_id) DO UPDATE
           SET unlimited_until = EXCLUDED.unlimited_until, updated_at = now()`,
        [input.googleUserId, input.expiresAt]
      );
    } else {
      // Limited: a tier-stamped paid grant. Clearing any prior unlimited window
      // so switching from unlimited → limited takes effect immediately.
      await this.pool.query(
        `INSERT INTO scan_quotas (google_user_id, unlimited_until)
           VALUES ($1, NULL)
         ON CONFLICT (google_user_id) DO UPDATE
           SET unlimited_until = NULL, updated_at = now()`,
        [input.googleUserId]
      );
      await this.pool.query(
        `INSERT INTO paid_grants (google_user_id, amount, expires_at, granted_by, tier_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.googleUserId,
          input.scanLimit,
          input.expiresAt,
          input.adminUsername,
          input.tierId,
          `tier:${input.tierName}`,
        ]
      );
    }
    await this.writeAssignment(input, input.previousTierId ? "changed" : "assigned");
  }

  async removeTier(googleUserId: string, adminUsername: string): Promise<void> {
    const current = await this.currentTier(googleUserId);
    // Clear the unlimited window; any tier-stamped grants simply run out / are
    // left to expire — removal means "fall back to Free", not "claw back".
    await this.pool.query(
      `UPDATE scan_quotas SET unlimited_until = NULL, updated_at = now()
        WHERE google_user_id = $1`,
      [googleUserId]
    );
    await this.pool.query(
      `INSERT INTO tier_assignments
         (google_user_id, tier_id, tier_name, previous_tier_id, previous_tier_name,
          action, assigned_by)
       VALUES ($1, NULL, NULL, $2, $3, 'removed', $4)`,
      [googleUserId, current?.tierId ?? null, current?.tierName ?? null, adminUsername]
    );
  }

  private async writeAssignment(
    input: AssignTierInput,
    action: "assigned" | "changed"
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO tier_assignments
         (google_user_id, tier_id, tier_name, is_unlimited, scan_limit, validity_days,
          expires_at, previous_tier_id, previous_tier_name, action, assigned_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.googleUserId,
        input.tierId,
        input.tierName,
        input.isUnlimited,
        input.scanLimit,
        input.validityDays,
        input.expiresAt,
        input.previousTierId,
        input.previousTierName,
        action,
        input.adminUsername,
      ]
    );
  }

  async currentTier(googleUserId: string): Promise<TierAssignmentEntry | null> {
    const { rows } = await this.pool.query<TierAssignmentRow>(
      `SELECT ${TIER_ASSIGNMENT_COLUMNS} FROM tier_assignments
        WHERE google_user_id = $1
        ORDER BY assigned_at DESC, id DESC
        LIMIT 1`,
      [googleUserId]
    );
    const row = rows[0];
    if (!row || row.action === "removed") return null;
    return toTierAssignment(row);
  }

  async tierHistory(
    googleUserId: string,
    cursor?: string,
    limit = 20
  ): Promise<TierAssignmentHistoryResult> {
    const pageSize = Math.min(100, Math.max(1, limit));
    const values: unknown[] = [googleUserId];
    let cursorCond = "";
    if (cursor) {
      values.push(Number(Buffer.from(cursor, "base64url").toString("utf8")));
      cursorCond = `AND id < $${values.length}`;
    }
    values.push(pageSize + 1);
    const { rows } = await this.pool.query<TierAssignmentRow>(
      `SELECT ${TIER_ASSIGNMENT_COLUMNS} FROM tier_assignments
        WHERE google_user_id = $1 ${cursorCond}
        ORDER BY id DESC
        LIMIT $${values.length}`,
      values
    );
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM tier_assignments WHERE google_user_id = $1`,
      [googleUserId]
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? Buffer.from(String(last.id)).toString("base64url") : null;
    return {
      total: Number(countResult.rows[0].count),
      nextCursor,
      entries: page.map(toTierAssignment),
    };
  }
}

interface TierAssignmentRow {
  id: string;
  google_user_id: string;
  tier_id: string | null;
  tier_name: string | null;
  is_unlimited: boolean | null;
  scan_limit: number | null;
  validity_days: number | null;
  expires_at: Date | null;
  previous_tier_id: string | null;
  previous_tier_name: string | null;
  action: string;
  assigned_by: string | null;
  assigned_at: Date;
}

const TIER_ASSIGNMENT_COLUMNS = `id, google_user_id, tier_id, tier_name, is_unlimited,
  scan_limit, validity_days, expires_at, previous_tier_id, previous_tier_name,
  action, assigned_by, assigned_at`;

function toTierAssignment(row: TierAssignmentRow): TierAssignmentEntry {
  return {
    id: Number(row.id),
    googleUserId: row.google_user_id,
    tierId: row.tier_id === null ? null : Number(row.tier_id),
    tierName: row.tier_name,
    isUnlimited: row.is_unlimited,
    scanLimit: row.scan_limit,
    validityDays: row.validity_days,
    expiresAt: row.expires_at,
    previousTierId: row.previous_tier_id === null ? null : Number(row.previous_tier_id),
    previousTierName: row.previous_tier_name,
    action: row.action as "assigned" | "changed" | "removed",
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
  };
}

interface QuotaCursor {
  googleUserId: string;
}

function encodeCursor(googleUserId: string): string {
  const cursor: QuotaCursor = { googleUserId };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory test double — real behavior (mirrors the Pg draw/idempotency logic)
// ─────────────────────────────────────────────────────────────────────────────

interface MemQuota {
  freeLimitOverride: number | null;
  freeUsed: number;
  scanBlockedAt: Date | null;
  scanBlockedBy: string | null;
  unlimitedUntil: Date | null;
}
interface MemGrant {
  id: number;
  amount: number;
  used: number;
  expiresAt: Date | null;
  grantedAt: Date;
  grantedBy: string;
  revokedAt: Date | null;
  reason: string | null;
}
interface MemLedger extends QuotaLedgerEntry {
  id: number;
  ts: string;
}

/**
 * Faithful in-memory QuotaStore for unit/integration tests — reimplements the
 * free-first-then-paid draw, per-grant expiry, exactly-once idempotency, and
 * Scan-Block exactly as PgQuotaStore does, so a test can drive multi-step
 * consume/grant/expire flows without a database. `_now`/`_setNow` inject time so
 * expiry can be tested without sleeping.
 */
export class MemoryQuotaStore implements QuotaStore {
  private quotas = new Map<string, MemQuota>();
  private grants: MemGrant[] = [];
  private consumptions = new Map<string, { pool: string; grantId: number | null }>();
  private ledgerRows: MemLedger[] = [];
  private assignments: TierAssignmentEntry[] = [];
  private nextGrantId = 1;
  private nextLedgerId = 1;
  private nextAssignmentId = 1;
  private _now: () => number = () => Date.now();

  /** Inject time (ms epoch) so grant expiry is testable without sleeping. */
  _setNow(nowMs: number): void {
    this._now = () => nowMs;
  }

  private key(userId: string, cardId: string): string {
    return `${userId} ${cardId}`;
  }

  private ensureQuota(userId: string): MemQuota {
    let q = this.quotas.get(userId);
    if (!q) {
      q = {
        freeLimitOverride: null,
        freeUsed: 0,
        scanBlockedAt: null,
        scanBlockedBy: null,
        unlimitedUntil: null,
      };
      this.quotas.set(userId, q);
    }
    return q;
  }

  async consume(
    googleUserId: string,
    cardId: string,
    settings: LicenseSettings
  ): Promise<ConsumeResult> {
    const k = this.key(googleUserId, cardId);
    const prior = this.consumptions.get(k);
    if (prior) {
      if (prior.pool === "pending") return { ok: false, reason: "exhausted" };
      return {
        ok: true,
        pool: prior.pool as "free" | "paid" | "unlimited",
        grantId: prior.grantId,
        idempotentReplay: true,
      };
    }
    this.consumptions.set(k, { pool: "pending", grantId: null });
    const result = this.draw(googleUserId, settings);
    if (!result.ok) {
      this.consumptions.delete(k);
      return result;
    }
    this.consumptions.set(k, { pool: result.pool, grantId: result.grantId });
    return result;
  }

  private draw(userId: string, settings: LicenseSettings): ConsumeResult {
    const q = this.quotas.get(userId);
    if (q?.scanBlockedAt != null) return { ok: false, reason: "blocked" };

    // Unlimited tier window active → allow always, no draw (mirrors PgQuotaStore).
    if (q?.unlimitedUntil != null && q.unlimitedUntil.getTime() > this._now()) {
      return { ok: true, pool: "unlimited", grantId: null, idempotentReplay: false };
    }

    if (settings.freeEnabled) {
      const quota = this.ensureQuota(userId);
      const limit = quota.freeLimitOverride ?? settings.defaultFreeLimit;
      if (quota.freeUsed < limit) {
        quota.freeUsed += 1;
        return { ok: true, pool: "free", grantId: null, idempotentReplay: false };
      }
    }

    if (settings.paidEnabled) {
      const now = this._now();
      const eligible = this.userGrants(userId)
        .filter(
          (g) =>
            g.revokedAt === null &&
            g.used < g.amount &&
            (g.expiresAt === null || g.expiresAt.getTime() > now)
        )
        .sort((a, b) => {
          // Dated grants first (soonest expiry), never-expires last.
          if (a.expiresAt === null && b.expiresAt === null) return 0;
          if (a.expiresAt === null) return 1;
          if (b.expiresAt === null) return -1;
          return a.expiresAt.getTime() - b.expiresAt.getTime();
        });
      const grant = eligible[0];
      if (grant) {
        grant.used += 1;
        return { ok: true, pool: "paid", grantId: grant.id, idempotentReplay: false };
      }
    }

    return { ok: false, reason: "exhausted" };
  }

  private userGrants(userId: string): MemGrant[] {
    return this.grants.filter((g) => this.grantUsers.get(g.id) === userId);
  }

  // Track grant ownership out-of-band so MemGrant stays a pure value.
  private grantUsers = new Map<number, string>();

  private statusOf(g: MemGrant): "active" | "expired" | "revoked" {
    if (g.revokedAt) return "revoked";
    if (g.expiresAt && g.expiresAt.getTime() <= this._now()) return "expired";
    return "active";
  }

  async getEffective(googleUserId: string, settings: LicenseSettings): Promise<EffectiveQuota> {
    const q = this.quotas.get(googleUserId);
    const freeUsed = q?.freeUsed ?? 0;
    const hasFreeOverride = q?.freeLimitOverride != null;
    const freeLimit = q?.freeLimitOverride ?? settings.defaultFreeLimit;
    const grants: PaidGrant[] = this.userGrants(googleUserId)
      .slice()
      .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime() || b.id - a.id)
      .map((g) => ({
        id: g.id,
        amount: g.amount,
        used: g.used,
        expiresAt: g.expiresAt,
        grantedAt: g.grantedAt,
        grantedBy: g.grantedBy,
        revokedAt: g.revokedAt,
        reason: g.reason,
        status: this.statusOf(g),
      }));
    const paidRemaining = grants
      .filter((g) => g.status === "active")
      .reduce((sum, g) => sum + (g.amount - g.used), 0);
    const freeRemaining = Math.max(0, freeLimit - freeUsed);
    const unlimitedUntil = q?.unlimitedUntil ?? null;
    const unlimited = unlimitedUntil != null && unlimitedUntil.getTime() > this._now();
    const current = this.currentTierSync(googleUserId);
    const activeTier: ActiveTier | null = current
      ? {
          tierId: current.tierId,
          name: current.tierName ?? "",
          unlimited: current.isUnlimited ?? false,
          unlimitedUntil,
          expiresAt: current.expiresAt,
        }
      : null;
    return {
      googleUserId,
      freeLimit,
      freeUsed,
      freeRemaining,
      hasFreeOverride,
      paidGrants: grants,
      paidRemaining,
      totalRemaining: freeRemaining + paidRemaining,
      scanBlock: {
        blocked: q?.scanBlockedAt != null,
        blockedAt: q?.scanBlockedAt ?? null,
        blockedBy: q?.scanBlockedBy ?? null,
      },
      activeTier,
      unlimited,
    };
  }

  async list(params: ListQuotasParams, settings: LicenseSettings): Promise<ListQuotasResult> {
    const limit = Math.min(100, Math.max(1, params.limit));
    let userIds = [...new Set([...this.quotas.keys(), ...this.grantUsers.values()])];
    if (params.status === "scan_blocked") {
      userIds = userIds.filter((id) => this.quotas.get(id)?.scanBlockedAt != null);
    }
    if (params.status === "custom") {
      userIds = userIds.filter((id) => this.quotas.get(id)?.freeLimitOverride != null);
    }
    const total = userIds.length;
    const page = userIds.slice(0, limit);
    const quotas = await Promise.all(page.map((id) => this.getEffective(id, settings)));
    return {
      quotas,
      nextCursor: userIds.length > limit ? encodeCursor(page[page.length - 1]) : null,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async stats(settings: LicenseSettings): Promise<QuotaStats> {
    const now = this._now();
    let scanBlocked = 0;
    let totalFreeUsed = 0;
    let lowRemaining = 0;
    for (const [googleUserId, q] of this.quotas.entries()) {
      if (q.scanBlockedAt != null) scanBlocked += 1;
      totalFreeUsed += q.freeUsed;

      const unlimited = q.unlimitedUntil != null && q.unlimitedUntil.getTime() > now;
      if (unlimited) continue;
      const freeLimit = q.freeLimitOverride ?? settings.defaultFreeLimit;
      const freeRemaining = Math.max(0, freeLimit - q.freeUsed);
      const paidRemaining = this.grants.reduce((sum, g) => {
        if (this.grantUsers.get(g.id) !== googleUserId) return sum;
        if (g.revokedAt != null) return sum;
        if (g.expiresAt != null && g.expiresAt.getTime() <= now) return sum;
        return sum + (g.amount - g.used);
      }, 0);
      if (freeRemaining + paidRemaining <= LOW_REMAINING_THRESHOLD) lowRemaining += 1;
    }
    const totalPaidUsed = this.grants.reduce((sum, g) => sum + g.used, 0);
    return {
      usersWithQuota: this.quotas.size,
      scanBlocked,
      totalFreeUsed,
      totalPaidUsed,
      lowRemaining,
    };
  }

  async setFreeOverride(googleUserId: string, value: number | null): Promise<void> {
    this.ensureQuota(googleUserId).freeLimitOverride = value;
  }

  async grantPaid(googleUserId: string, input: GrantPaidInput): Promise<number> {
    const id = this.nextGrantId++;
    this.grants.push({
      id,
      amount: input.amount,
      used: 0,
      expiresAt: input.expiresAt,
      grantedAt: new Date(this._now()),
      grantedBy: input.grantedBy,
      revokedAt: null,
      reason: input.reason ?? null,
    });
    this.grantUsers.set(id, googleUserId);
    return id;
  }

  async revokeGrant(googleUserId: string, grantId: number): Promise<boolean> {
    const g = this.grants.find((x) => x.id === grantId && this.grantUsers.get(x.id) === googleUserId);
    if (!g) return false;
    g.revokedAt ??= new Date(this._now());
    return true;
  }

  async revokeAllGrants(googleUserId: string): Promise<number> {
    let count = 0;
    for (const g of this.userGrants(googleUserId)) {
      if (g.revokedAt === null) {
        g.revokedAt = new Date(this._now());
        count += 1;
      }
    }
    return count;
  }

  async resetUsed(googleUserId: string, pool: "free" | "paid" | "both"): Promise<void> {
    if (pool === "free" || pool === "both") {
      const q = this.quotas.get(googleUserId);
      if (q) q.freeUsed = 0;
    }
    if (pool === "paid" || pool === "both") {
      for (const g of this.userGrants(googleUserId)) if (g.revokedAt === null) g.used = 0;
    }
  }

  async recalculate(googleUserId: string): Promise<void> {
    let freeCount = 0;
    const paidByGrant = new Map<number, number>();
    for (const [k, v] of this.consumptions) {
      if (!k.startsWith(`${googleUserId} `)) continue;
      if (v.pool === "free") freeCount += 1;
      else if (v.pool === "paid" && v.grantId != null) {
        paidByGrant.set(v.grantId, (paidByGrant.get(v.grantId) ?? 0) + 1);
      }
    }
    const q = this.quotas.get(googleUserId);
    if (q) q.freeUsed = freeCount;
    for (const g of this.userGrants(googleUserId)) g.used = paidByGrant.get(g.id) ?? 0;
  }

  async setScanBlocked(
    googleUserId: string,
    blocked: boolean,
    adminUsername: string
  ): Promise<void> {
    const q = this.ensureQuota(googleUserId);
    if (blocked) {
      q.scanBlockedAt ??= new Date(this._now());
      q.scanBlockedBy ??= adminUsername;
    } else {
      q.scanBlockedAt = null;
      q.scanBlockedBy = null;
    }
  }

  async ledger(googleUserId: string, cursor?: string, limit = 20): Promise<QuotaLedgerResult> {
    const pageSize = Math.min(100, Math.max(1, limit));
    const all = this.ledgerRows
      .filter((r) => r.googleUserId === googleUserId)
      .sort((a, b) => b.id - a.id);
    let rows = all;
    if (cursor) {
      const cid = Number(Buffer.from(cursor, "base64url").toString("utf8"));
      rows = rows.filter((r) => r.id < cid);
    }
    const page = rows.slice(0, pageSize + 1);
    const hasMore = page.length > pageSize;
    const entries = page.slice(0, pageSize);
    const last = entries[entries.length - 1];
    return {
      total: all.length,
      nextCursor: hasMore && last ? Buffer.from(String(last.id)).toString("base64url") : null,
      entries: entries.map((e) => ({ ...e })),
    };
  }

  appendLedger(entry: QuotaLedgerEntry): void {
    this.ledgerRows.push({ ...entry, id: this.nextLedgerId++, ts: new Date(this._now()).toISOString() });
  }

  // ── Tier layer ───────────────────────────────────────────────────────────

  /** Non-async current-tier lookup used by getEffective (which is sync inside). */
  private currentTierSync(googleUserId: string): TierAssignmentEntry | null {
    const rows = this.assignments
      .filter((a) => a.googleUserId === googleUserId)
      .sort((a, b) => b.id - a.id);
    const latest = rows[0];
    if (!latest || latest.action === "removed") return null;
    return latest;
  }

  async assignTier(input: AssignTierInput): Promise<void> {
    const q = this.ensureQuota(input.googleUserId);
    if (input.isUnlimited) {
      q.unlimitedUntil = input.expiresAt;
    } else {
      q.unlimitedUntil = null;
      const id = this.nextGrantId++;
      // Mirror the Pg CHECK (amount > 0): a limited tier MUST carry a positive
      // scanLimit. Without this the double would silently make a 0-amount,
      // un-drawable grant while production's INSERT would reject — masking a
      // malformed assign in unit tests.
      if (input.scanLimit == null || input.scanLimit <= 0) {
        throw new Error("assignTier: a limited tier requires a positive scanLimit");
      }
      this.grants.push({
        id,
        amount: input.scanLimit,
        used: 0,
        expiresAt: input.expiresAt,
        grantedAt: new Date(this._now()),
        grantedBy: input.adminUsername,
        revokedAt: null,
        reason: `tier:${input.tierName}`,
      });
      this.grantUsers.set(id, input.googleUserId);
    }
    this.assignments.push({
      id: this.nextAssignmentId++,
      googleUserId: input.googleUserId,
      tierId: input.tierId,
      tierName: input.tierName,
      isUnlimited: input.isUnlimited,
      scanLimit: input.scanLimit,
      validityDays: input.validityDays,
      expiresAt: input.expiresAt,
      previousTierId: input.previousTierId,
      previousTierName: input.previousTierName,
      action: input.previousTierId ? "changed" : "assigned",
      assignedBy: input.adminUsername,
      assignedAt: new Date(this._now()),
    });
  }

  async removeTier(googleUserId: string, adminUsername: string): Promise<void> {
    const current = this.currentTierSync(googleUserId);
    const q = this.quotas.get(googleUserId);
    if (q) q.unlimitedUntil = null;
    this.assignments.push({
      id: this.nextAssignmentId++,
      googleUserId,
      tierId: null,
      tierName: null,
      isUnlimited: null,
      scanLimit: null,
      validityDays: null,
      expiresAt: null,
      previousTierId: current?.tierId ?? null,
      previousTierName: current?.tierName ?? null,
      action: "removed",
      assignedBy: adminUsername,
      assignedAt: new Date(this._now()),
    });
  }

  async currentTier(googleUserId: string): Promise<TierAssignmentEntry | null> {
    return this.currentTierSync(googleUserId);
  }

  async tierHistory(
    googleUserId: string,
    cursor?: string,
    limit = 20
  ): Promise<TierAssignmentHistoryResult> {
    const pageSize = Math.min(100, Math.max(1, limit));
    const all = this.assignments
      .filter((a) => a.googleUserId === googleUserId)
      .sort((a, b) => b.id - a.id);
    let rows = all;
    if (cursor) {
      const cid = Number(Buffer.from(cursor, "base64url").toString("utf8"));
      rows = rows.filter((r) => r.id < cid);
    }
    const page = rows.slice(0, pageSize + 1);
    const hasMore = page.length > pageSize;
    const entries = page.slice(0, pageSize);
    const last = entries[entries.length - 1];
    return {
      total: all.length,
      nextCursor: hasMore && last ? Buffer.from(String(last.id)).toString("base64url") : null,
      entries: entries.map((e) => ({ ...e })),
    };
  }

  /** Current-tier assigned counts, so a MemoryTierStore can show "N users hold this". */
  tierAssignedCounts(): Map<number, number> {
    const counts = new Map<number, number>();
    const seen = new Set<string>();
    for (const a of [...this.assignments].sort((x, y) => y.id - x.id)) {
      if (seen.has(a.googleUserId)) continue;
      seen.add(a.googleUserId);
      if (a.action !== "removed" && a.tierId != null) {
        counts.set(a.tierId, (counts.get(a.tierId) ?? 0) + 1);
      }
    }
    return counts;
  }
}
