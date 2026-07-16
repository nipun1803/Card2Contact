import { Pool } from "pg";

/**
 * Tier Upgrade Requests — a user-initiated workflow layer on top of the tier
 * catalog. A request is METADATA, not an allowance: creating one changes nothing
 * about a user's quota. The admin decision is the only thing that acts, and it
 * acts through the existing assignTier / grantPaid seam on QuotaStore (see
 * admin-licenses.service) — so there is one source of truth and no parallel
 * grant mechanism. The enforcement path (quota-guard, consume) never reads this.
 *
 * This store is pure persistence: create a pending request, read the queue /
 * a user's history, and record a decision (approve/reject). Turning an approval
 * into an actual assignment is the service's job — keeping that outside the store
 * is what lets a future payment webhook reuse the same assignTier call.
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

export type TierRequestKind = "tier" | "custom";
export type TierRequestStatus = "pending" | "approved" | "rejected";

export interface TierRequest {
  id: number;
  googleUserId: string;
  /** The user's email, for admin display. Enriched by the service (joins users);
   *  absent on the user's own view. Clients fall back to the id. */
  email?: string;
  kind: TierRequestKind;
  /** For a 'tier' request: the catalog tier the user picked (snapshot name too). */
  requestedTierId: number | null;
  requestedTierName: string | null;
  /** For a 'custom' request: the desired scan count / validity window. */
  requestedAmount: number | null;
  requestedDays: number | null;
  /** Optional (tier) / required (custom) user justification. */
  userNote: string | null;
  /** The user's tier at request time, for admin context. */
  currentTierName: string | null;
  status: TierRequestStatus;
  /** Decision fields — null until an admin decides. May differ from the ask. */
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  grantedTierId: number | null;
  grantedAmount: number | null;
  grantedDays: number | null;
  createdAt: Date;
}

export interface CreateTierRequestInput {
  googleUserId: string;
  kind: TierRequestKind;
  requestedTierId?: number | null;
  requestedTierName?: string | null;
  requestedAmount?: number | null;
  requestedDays?: number | null;
  userNote?: string | null;
  currentTierName?: string | null;
}

/** What the admin actually granted (may differ from the ask) + the outcome. */
export interface DecideTierRequestInput {
  status: "approved" | "rejected";
  decidedBy: string;
  decisionNote?: string | null;
  grantedTierId?: number | null;
  grantedAmount?: number | null;
  grantedDays?: number | null;
}

export interface ListTierRequestsParams {
  /** Filter by status; omit for all. */
  status?: TierRequestStatus;
  limit?: number;
  /** Keyset cursor (opaque, from a prior page's nextCursor). */
  cursor?: string;
}

export interface TierRequestPage {
  requests: TierRequest[];
  nextCursor: string | null;
  total: number;
  /** Count of pending requests — drives the admin nav badge. */
  pendingCount: number;
}

/** Thrown by createRequest when the user already has an open (pending) request. */
export class DuplicatePendingRequestError extends Error {
  readonly code = "REQUEST_ALREADY_PENDING";
  constructor() {
    super("You already have a pending upgrade request.");
    this.name = "DuplicatePendingRequestError";
  }
}

export interface TierRequestStore {
  /** File a new request. Throws DuplicatePendingRequestError if one is open. */
  create(input: CreateTierRequestInput): Promise<TierRequest>;
  get(id: number): Promise<TierRequest | null>;
  /** The admin queue (pending-first by default via status filter), keyset-paginated. */
  list(params?: ListTierRequestsParams): Promise<TierRequestPage>;
  /** A single user's requests, newest-first. */
  listForUser(googleUserId: string, limit?: number): Promise<TierRequest[]>;
  /** The user's current open (pending) request, if any. */
  pendingForUser(googleUserId: string): Promise<TierRequest | null>;
  /**
   * Record a decision on a PENDING request. Returns null if the request is
   * missing or already decided (so a double-approve is a safe no-op, not a
   * double-grant). The caller performs the actual assignment before/after.
   */
  decide(id: number, input: DecideTierRequestInput): Promise<TierRequest | null>;
  /** Count of pending requests — the nav badge. */
  pendingCount(): Promise<number>;
}

interface TierRequestRow {
  id: string;
  google_user_id: string;
  kind: TierRequestKind;
  requested_tier_id: string | null;
  requested_tier_name: string | null;
  requested_amount: number | null;
  requested_days: number | null;
  user_note: string | null;
  current_tier_name: string | null;
  status: TierRequestStatus;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  granted_tier_id: string | null;
  granted_amount: number | null;
  granted_days: number | null;
  created_at: Date;
}

const REQUEST_COLUMNS = `id, google_user_id, kind, requested_tier_id, requested_tier_name,
                         requested_amount, requested_days, user_note, current_tier_name,
                         status, decided_by, decided_at, decision_note, granted_tier_id,
                         granted_amount, granted_days, created_at`;

function toRequest(row: TierRequestRow): TierRequest {
  return {
    id: Number(row.id),
    googleUserId: row.google_user_id,
    kind: row.kind,
    requestedTierId: row.requested_tier_id === null ? null : Number(row.requested_tier_id),
    requestedTierName: row.requested_tier_name,
    requestedAmount: row.requested_amount,
    requestedDays: row.requested_days,
    userNote: row.user_note,
    currentTierName: row.current_tier_name,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    grantedTierId: row.granted_tier_id === null ? null : Number(row.granted_tier_id),
    grantedAmount: row.granted_amount,
    grantedDays: row.granted_days,
    createdAt: row.created_at,
  };
}

/**
 * Keyset cursor over (created_at DESC, id DESC). Base64url of "createdAtISO|id",
 * mirroring the user-store / quota-store cursor idiom (stable across inserts,
 * no OFFSET drift).
 */
function encodeCursor(r: TierRequest): string {
  return Buffer.from(`${r.createdAt.toISOString()}|${r.id}`, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(cursor: string): { createdAt: string; id: number } | null {
  try {
    const raw = Buffer.from(cursor.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const [createdAt, id] = raw.split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id: Number(id) };
  } catch {
    return null;
  }
}

export class PgTierRequestStore implements TierRequestStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateTierRequestInput): Promise<TierRequest> {
    try {
      const { rows } = await this.pool.query<TierRequestRow>(
        `INSERT INTO tier_requests
           (google_user_id, kind, requested_tier_id, requested_tier_name,
            requested_amount, requested_days, user_note, current_tier_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${REQUEST_COLUMNS}`,
        [
          input.googleUserId,
          input.kind,
          input.requestedTierId ?? null,
          input.requestedTierName ?? null,
          input.requestedAmount ?? null,
          input.requestedDays ?? null,
          input.userNote ?? null,
          input.currentTierName ?? null,
        ]
      );
      return toRequest(rows[0]);
    } catch (err) {
      // The partial unique index (one pending per user) surfaces as a 23505.
      if (isUniqueViolation(err)) throw new DuplicatePendingRequestError();
      throw err;
    }
  }

  async get(id: number): Promise<TierRequest | null> {
    const { rows } = await this.pool.query<TierRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM tier_requests WHERE id = $1`,
      [id]
    );
    return rows.length ? toRequest(rows[0]) : null;
  }

  async list(params: ListTierRequestsParams = {}): Promise<TierRequestPage> {
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.status) {
      values.push(params.status);
      conditions.push(`status = $${values.length}`);
    }
    if (params.cursor) {
      const c = decodeCursor(params.cursor);
      if (c) {
        values.push(c.createdAt, c.id);
        conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(limit + 1); // fetch one extra to detect a next page
    const { rows } = await this.pool.query<TierRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM tier_requests ${where}
         ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values
    );
    const page = rows.slice(0, limit).map(toRequest);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;

    // Total honors the same status filter; pendingCount is always the queue badge.
    const totalWhere = params.status ? `WHERE status = $1` : "";
    const totalValues = params.status ? [params.status] : [];
    const [{ rows: totalRows }, pendingCount] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tier_requests ${totalWhere}`,
        totalValues
      ),
      this.pendingCount(),
    ]);
    return {
      requests: page,
      nextCursor,
      total: Number(totalRows[0]?.count ?? 0),
      pendingCount,
    };
  }

  async listForUser(googleUserId: string, limit = 20): Promise<TierRequest[]> {
    const { rows } = await this.pool.query<TierRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM tier_requests
         WHERE google_user_id = $1
         ORDER BY created_at DESC, id DESC LIMIT $2`,
      [googleUserId, Math.min(100, Math.max(1, limit))]
    );
    return rows.map(toRequest);
  }

  async pendingForUser(googleUserId: string): Promise<TierRequest | null> {
    const { rows } = await this.pool.query<TierRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM tier_requests
         WHERE google_user_id = $1 AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
      [googleUserId]
    );
    return rows.length ? toRequest(rows[0]) : null;
  }

  async decide(id: number, input: DecideTierRequestInput): Promise<TierRequest | null> {
    // The `status = 'pending'` guard makes this atomic and idempotent: a second
    // approve matches zero rows (already decided) and returns null — never a
    // double-grant.
    const { rows } = await this.pool.query<TierRequestRow>(
      `UPDATE tier_requests SET
         status         = $2,
         decided_by     = $3,
         decided_at     = now(),
         decision_note  = $4,
         granted_tier_id = $5,
         granted_amount  = $6,
         granted_days    = $7
       WHERE id = $1 AND status = 'pending'
       RETURNING ${REQUEST_COLUMNS}`,
      [
        id,
        input.status,
        input.decidedBy,
        input.decisionNote ?? null,
        input.grantedTierId ?? null,
        input.grantedAmount ?? null,
        input.grantedDays ?? null,
      ]
    );
    return rows.length ? toRequest(rows[0]) : null;
  }

  async pendingCount(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tier_requests WHERE status = 'pending'`
    );
    return Number(rows[0]?.count ?? 0);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory test double
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Faithful in-memory TierRequestStore. Mirrors the Pg semantics exactly: the
 * one-pending-per-user rule (throws DuplicatePendingRequestError), the
 * decide() pending-guard (returns null when already decided), and newest-first
 * ordering — so unit tests exercise the same invariants the DB enforces.
 */
export class MemoryTierRequestStore implements TierRequestStore {
  private requests: TierRequest[] = [];
  private nextId = 1;

  async create(input: CreateTierRequestInput): Promise<TierRequest> {
    if (this.requests.some((r) => r.googleUserId === input.googleUserId && r.status === "pending")) {
      throw new DuplicatePendingRequestError();
    }
    const request: TierRequest = {
      id: this.nextId++,
      googleUserId: input.googleUserId,
      kind: input.kind,
      requestedTierId: input.requestedTierId ?? null,
      requestedTierName: input.requestedTierName ?? null,
      requestedAmount: input.requestedAmount ?? null,
      requestedDays: input.requestedDays ?? null,
      userNote: input.userNote ?? null,
      currentTierName: input.currentTierName ?? null,
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      grantedTierId: null,
      grantedAmount: null,
      grantedDays: null,
      createdAt: new Date(),
    };
    this.requests.push(request);
    return { ...request };
  }

  async get(id: number): Promise<TierRequest | null> {
    const r = this.requests.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  async list(params: ListTierRequestsParams = {}): Promise<TierRequestPage> {
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    let filtered = [...this.requests].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id
    );
    if (params.status) filtered = filtered.filter((r) => r.status === params.status);
    const total = filtered.length;

    let start = 0;
    if (params.cursor) {
      const c = decodeCursor(params.cursor);
      if (c) {
        const idx = filtered.findIndex((r) => r.id === c.id);
        if (idx >= 0) start = idx + 1;
      }
    }
    const slice = filtered.slice(start, start + limit);
    const nextCursor = start + limit < filtered.length ? encodeCursor(slice[slice.length - 1]) : null;
    return {
      requests: slice.map((r) => ({ ...r })),
      nextCursor,
      total,
      pendingCount: await this.pendingCount(),
    };
  }

  async listForUser(googleUserId: string, limit = 20): Promise<TierRequest[]> {
    return this.requests
      .filter((r) => r.googleUserId === googleUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
      .slice(0, Math.min(100, Math.max(1, limit)))
      .map((r) => ({ ...r }));
  }

  async pendingForUser(googleUserId: string): Promise<TierRequest | null> {
    const r = this.requests.find((x) => x.googleUserId === googleUserId && x.status === "pending");
    return r ? { ...r } : null;
  }

  async decide(id: number, input: DecideTierRequestInput): Promise<TierRequest | null> {
    const r = this.requests.find((x) => x.id === id);
    if (!r || r.status !== "pending") return null;
    r.status = input.status;
    r.decidedBy = input.decidedBy;
    r.decidedAt = new Date();
    r.decisionNote = input.decisionNote ?? null;
    r.grantedTierId = input.grantedTierId ?? null;
    r.grantedAmount = input.grantedAmount ?? null;
    r.grantedDays = input.grantedDays ?? null;
    return { ...r };
  }

  async pendingCount(): Promise<number> {
    return this.requests.filter((r) => r.status === "pending").length;
  }
}
