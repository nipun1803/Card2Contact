import { Pool } from "pg";

/**
 * The tier catalog — named, admin-configurable allowance presets. A Tier is DATA
 * the admin edits, never a name the code branches on: enforcement (in QuotaStore)
 * reads only `isUnlimited` / `scanLimit` / `validityDays`, so a future custom
 * tier needs zero code change. This store is the catalog CRUD + assigned-counts;
 * the assignment write and enforcement resolution live on QuotaStore.
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */
export interface Tier {
  id: number;
  name: string;
  /** When true, an assignment grants a "never block" window; scanLimit is ignored. */
  isUnlimited: boolean;
  /** Scans granted per assignment. Null iff isUnlimited. */
  scanLimit: number | null;
  /** Validity of one assignment in days. Null = no expiry (e.g. the Free tier). */
  validityDays: number | null;
  /** Exactly one tier is the default — the fallback when a paid tier lapses. */
  isDefault: boolean;
  sortOrder: number;
  /** Non-null when soft-deleted; archived tiers stay referenceable by history. */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

/** A tier plus how many users currently hold it (for the "affects N users" note). */
export interface TierWithCount extends Tier {
  assignedCount: number;
}

export interface CreateTierInput {
  name: string;
  isUnlimited: boolean;
  scanLimit: number | null;
  validityDays: number | null;
  sortOrder?: number;
  updatedBy: string;
}

export interface UpdateTierPatch {
  name?: string;
  isUnlimited?: boolean;
  scanLimit?: number | null;
  validityDays?: number | null;
  sortOrder?: number;
}

export interface ListTiersParams {
  /** Free-text match on name (ILIKE). */
  search?: string;
  /** Include archived tiers (default false). */
  includeArchived?: boolean;
}

export interface TierStore {
  /** The catalog, active-first, with per-tier assigned counts. */
  list(params?: ListTiersParams): Promise<TierWithCount[]>;
  get(id: number): Promise<Tier | null>;
  getByName(name: string): Promise<Tier | null>;
  /** The single default tier (the fallback allowance). */
  getDefault(): Promise<Tier | null>;
  create(input: CreateTierInput): Promise<Tier>;
  update(id: number, patch: UpdateTierPatch, updatedBy: string): Promise<Tier | null>;
  /** Soft-delete. Returns false if not found. Callers must block archiving the default. */
  archive(id: number): Promise<boolean>;
  /** Copy a tier's config into a new row with a new name. */
  clone(id: number, newName: string, updatedBy: string): Promise<Tier | null>;
  /** Map of tierId → number of users currently holding it. */
  assignedCounts(): Promise<Map<number, number>>;
}

interface TierRow {
  id: string;
  name: string;
  is_unlimited: boolean;
  scan_limit: number | null;
  validity_days: number | null;
  is_default: boolean;
  sort_order: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
}

const TIER_COLUMNS = `id, name, is_unlimited, scan_limit, validity_days, is_default,
                      sort_order, archived_at, created_at, updated_at, updated_by`;

function toTier(row: TierRow): Tier {
  return {
    id: Number(row.id),
    name: row.name,
    isUnlimited: row.is_unlimited,
    scanLimit: row.scan_limit,
    validityDays: row.validity_days,
    isDefault: row.is_default,
    sortOrder: row.sort_order,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * The current assigned count per tier is derived from tier_assignments: a user's
 * current tier is their latest non-'removed' assignment. This CTE picks that
 * latest row per user (DISTINCT ON), then counts by tier.
 */
const ASSIGNED_COUNTS_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (google_user_id) google_user_id, tier_id, action
      FROM tier_assignments
     ORDER BY google_user_id, assigned_at DESC, id DESC
  )
  SELECT tier_id, COUNT(*)::int AS count
    FROM latest
   WHERE action <> 'removed' AND tier_id IS NOT NULL
   GROUP BY tier_id`;

export class PgTierStore implements TierStore {
  constructor(private readonly pool: Pool) {}

  async list(params: ListTiersParams = {}): Promise<TierWithCount[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (!params.includeArchived) conditions.push("archived_at IS NULL");
    if (params.search) {
      values.push(`%${params.search}%`);
      conditions.push(`name ILIKE $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query<TierRow>(
      `SELECT ${TIER_COLUMNS} FROM tiers ${where} ORDER BY sort_order ASC, id ASC`,
      values
    );
    const counts = await this.assignedCounts();
    return rows.map((r) => {
      const tier = toTier(r);
      return { ...tier, assignedCount: counts.get(tier.id) ?? 0 };
    });
  }

  async get(id: number): Promise<Tier | null> {
    const { rows } = await this.pool.query<TierRow>(
      `SELECT ${TIER_COLUMNS} FROM tiers WHERE id = $1`,
      [id]
    );
    return rows.length ? toTier(rows[0]) : null;
  }

  async getByName(name: string): Promise<Tier | null> {
    const { rows } = await this.pool.query<TierRow>(
      `SELECT ${TIER_COLUMNS} FROM tiers WHERE name = $1`,
      [name]
    );
    return rows.length ? toTier(rows[0]) : null;
  }

  async getDefault(): Promise<Tier | null> {
    const { rows } = await this.pool.query<TierRow>(
      `SELECT ${TIER_COLUMNS} FROM tiers WHERE is_default AND archived_at IS NULL LIMIT 1`
    );
    return rows.length ? toTier(rows[0]) : null;
  }

  async create(input: CreateTierInput): Promise<Tier> {
    const { rows } = await this.pool.query<TierRow>(
      `INSERT INTO tiers (name, is_unlimited, scan_limit, validity_days, sort_order, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${TIER_COLUMNS}`,
      [
        input.name,
        input.isUnlimited,
        input.isUnlimited ? null : input.scanLimit,
        input.validityDays,
        input.sortOrder ?? 0,
        input.updatedBy,
      ]
    );
    return toTier(rows[0]);
  }

  async update(id: number, patch: UpdateTierPatch, updatedBy: string): Promise<Tier | null> {
    // COALESCE each field so only supplied keys change. isUnlimited and scanLimit
    // interact: when a tier becomes unlimited, its scan_limit is nulled so the
    // CHECK stays satisfied and a stale limit can't leak into a later edit.
    const { rows } = await this.pool.query<TierRow>(
      `UPDATE tiers SET
         name          = COALESCE($2, name),
         is_unlimited  = COALESCE($3, is_unlimited),
         scan_limit    = CASE WHEN COALESCE($3, is_unlimited) THEN NULL
                              ELSE COALESCE($4, scan_limit) END,
         validity_days = CASE WHEN $5::boolean THEN $6 ELSE validity_days END,
         sort_order    = COALESCE($7, sort_order),
         updated_at    = now(),
         updated_by    = $8
       WHERE id = $1
       RETURNING ${TIER_COLUMNS}`,
      [
        id,
        patch.name ?? null,
        patch.isUnlimited ?? null,
        patch.scanLimit ?? null,
        // validityDays can be set to null intentionally, so a presence flag drives it.
        patch.validityDays !== undefined,
        patch.validityDays ?? null,
        patch.sortOrder ?? null,
        updatedBy,
      ]
    );
    return rows.length ? toTier(rows[0]) : null;
  }

  async archive(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE tiers SET archived_at = COALESCE(archived_at, now()), updated_at = now()
        WHERE id = $1`,
      [id]
    );
    return (rowCount ?? 0) > 0;
  }

  async clone(id: number, newName: string, updatedBy: string): Promise<Tier | null> {
    const source = await this.get(id);
    if (!source) return null;
    return this.create({
      name: newName,
      isUnlimited: source.isUnlimited,
      scanLimit: source.scanLimit,
      validityDays: source.validityDays,
      sortOrder: source.sortOrder,
      updatedBy,
    });
  }

  async assignedCounts(): Promise<Map<number, number>> {
    const { rows } = await this.pool.query<{ tier_id: string; count: number }>(
      ASSIGNED_COUNTS_SQL
    );
    return new Map(rows.map((r) => [Number(r.tier_id), r.count]));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory test double
// ─────────────────────────────────────────────────────────────────────────────

interface MemTier extends Tier {}

/**
 * Faithful in-memory TierStore. Seeded with the same three tiers as the schema so
 * tests see a realistic catalog; `_assignedCounts` is injected by MemoryQuotaStore
 * (the two stores share assignment state in a test via a setter) or defaults to
 * empty.
 */
export class MemoryTierStore implements TierStore {
  private tiers: MemTier[] = [];
  private nextId = 1;
  private countsProvider: () => Map<number, number> = () => new Map();

  constructor(seed = true) {
    if (seed) {
      this.seed("Free", false, 30, null, true, 0);
      this.seed("Professional", false, 1000, 365, false, 1);
      this.seed("Enterprise", true, null, 365, false, 2);
    }
  }

  private seed(
    name: string,
    isUnlimited: boolean,
    scanLimit: number | null,
    validityDays: number | null,
    isDefault: boolean,
    sortOrder: number
  ): void {
    this.tiers.push({
      id: this.nextId++,
      name,
      isUnlimited,
      scanLimit,
      validityDays,
      isDefault,
      sortOrder,
      archivedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      updatedBy: null,
    });
  }

  /** Wire up the assigned-count source (MemoryQuotaStore provides it in tests). */
  _setCountsProvider(fn: () => Map<number, number>): void {
    this.countsProvider = fn;
  }

  async list(params: ListTiersParams = {}): Promise<TierWithCount[]> {
    const counts = this.countsProvider();
    return this.tiers
      .filter((t) => (params.includeArchived ? true : t.archivedAt === null))
      .filter((t) =>
        params.search ? t.name.toLowerCase().includes(params.search.toLowerCase()) : true
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map((t) => ({ ...t, assignedCount: counts.get(t.id) ?? 0 }));
  }

  async get(id: number): Promise<Tier | null> {
    return this.tiers.find((t) => t.id === id) ?? null;
  }

  async getByName(name: string): Promise<Tier | null> {
    return this.tiers.find((t) => t.name === name) ?? null;
  }

  async getDefault(): Promise<Tier | null> {
    return this.tiers.find((t) => t.isDefault && t.archivedAt === null) ?? null;
  }

  async create(input: CreateTierInput): Promise<Tier> {
    if (this.tiers.some((t) => t.name === input.name)) {
      throw new Error(`duplicate tier name: ${input.name}`);
    }
    const tier: MemTier = {
      id: this.nextId++,
      name: input.name,
      isUnlimited: input.isUnlimited,
      scanLimit: input.isUnlimited ? null : input.scanLimit,
      validityDays: input.validityDays,
      isDefault: false,
      sortOrder: input.sortOrder ?? 0,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: input.updatedBy,
    };
    this.tiers.push(tier);
    return { ...tier };
  }

  async update(id: number, patch: UpdateTierPatch, updatedBy: string): Promise<Tier | null> {
    const tier = this.tiers.find((t) => t.id === id);
    if (!tier) return null;
    if (patch.name !== undefined) tier.name = patch.name;
    if (patch.isUnlimited !== undefined) tier.isUnlimited = patch.isUnlimited;
    if (tier.isUnlimited) tier.scanLimit = null;
    else if (patch.scanLimit !== undefined) tier.scanLimit = patch.scanLimit;
    if (patch.validityDays !== undefined) tier.validityDays = patch.validityDays;
    if (patch.sortOrder !== undefined) tier.sortOrder = patch.sortOrder;
    tier.updatedAt = new Date();
    tier.updatedBy = updatedBy;
    return { ...tier };
  }

  async archive(id: number): Promise<boolean> {
    const tier = this.tiers.find((t) => t.id === id);
    if (!tier) return false;
    tier.archivedAt ??= new Date();
    return true;
  }

  async clone(id: number, newName: string, updatedBy: string): Promise<Tier | null> {
    const source = this.tiers.find((t) => t.id === id);
    if (!source) return null;
    return this.create({
      name: newName,
      isUnlimited: source.isUnlimited,
      scanLimit: source.scanLimit,
      validityDays: source.validityDays,
      sortOrder: source.sortOrder,
      updatedBy,
    });
  }

  async assignedCounts(): Promise<Map<number, number>> {
    return this.countsProvider();
  }
}
