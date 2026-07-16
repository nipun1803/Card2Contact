import { Pool } from "pg";
import { TokenCodec } from "./token-codec";

/**
 * One authenticated user. Tokens are always plaintext in this shape — the
 * TokenCodec handles encode/decode at the storage boundary, so the rest of the
 * app never sees ciphertext. `spreadsheetId` is the user's own auto-provisioned
 * sheet (null until first login provisions it).
 */
export interface UserRecord {
  googleUserId: string;
  email: string;
  spreadsheetId: string | null;
  /**
   * The sheet's URL and title are stored rather than derived: Recreate Sheet
   * must persist all three together, and a stale derived URL would point at a
   * trashed spreadsheet. Null for rows created before these columns existed —
   * callers fall back to deriving from spreadsheetId.
   */
  spreadsheetUrl: string | null;
  spreadsheetTitle: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: number | null; // epoch ms (google-auth-library Credentials.expiry_date)
  /** Running total of contacts this user has saved (M5), tracked in Postgres. */
  savedContactsCount: number;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** Null = enabled. Set by an admin Revoke Access action; cleared by Restore. */
  disabledAt: Date | null;
  /** Admin username that disabled this user, if currently disabled. */
  disabledBy: string | null;
  /** Last restore timestamp, if this user was ever restored. */
  restoredAt: Date | null;
  /** Admin username that performed the last restore. */
  restoredBy: string | null;
}

/** Identifying details of a user's provisioned spreadsheet. */
export interface SpreadsheetInfo {
  id: string;
  url: string;
  title: string;
}

/** Canonical URL for a spreadsheet id — the fallback for pre-migration rows. */
export function spreadsheetUrlFor(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

/** Tokens supplied at login / refresh time. */
export interface TokenSet {
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: number | null;
}

export type UserStatusFilter = "all" | "active" | "disabled";
export type UserSortField = "createdAt" | "lastLoginAt" | "savedContactsCount" | "email";
export type SortDirection = "asc" | "desc";

export interface ListUsersParams {
  /** Cursor pagination — omit for the first page. Stable under concurrent
   * writes, unlike OFFSET, which can skip/duplicate rows if a user is
   * disabled/restored between two page loads. */
  cursor?: string;
  limit: number; // capped server-side at 100
  search?: string; // matches email (ILIKE) and googleUserId (exact)
  status?: UserStatusFilter;
  registeredAfter?: string; // ISO date — filters createdAt >=
  registeredBefore?: string; // ISO date — filters createdAt <=
  lastLoginAfter?: string; // ISO date — filters lastLoginAt >=
  sortField?: UserSortField;
  sortDirection?: SortDirection;
}

export interface ListUsersResult {
  users: UserRecord[];
  nextCursor: string | null;
  total: number;
  totalPages: number;
}

export interface UserStats {
  total: number;
  active: number;
  disabled: number;
  /** Users who logged in within the last 24h. */
  recentLogins: number;
  /** App-wide total of successful M5 saves ("scans") across every user. */
  totalScans: number;
}

/**
 * Durable, per-user replacement for the old single-user in-memory token store.
 * This is the only inter-module contract for user identity + Google tokens —
 * routers depend on this interface, not on Postgres, so tests inject a fake.
 */
export interface UserStore {
  findById(googleUserId: string): Promise<UserRecord | null>;
  /** Create or update the user on login; sets last_login_at and preserves an existing refresh token if a new one isn't supplied. */
  upsertOnLogin(input: { googleUserId: string; email: string } & TokenSet): Promise<UserRecord>;
  /** Persist tokens refreshed by the OAuth client mid-session. */
  updateTokens(googleUserId: string, tokens: TokenSet): Promise<void>;
  /** Associate the user's provisioned spreadsheet — id, url, and title together. */
  setSpreadsheet(googleUserId: string, sheet: SpreadsheetInfo): Promise<void>;
  /**
   * Null out tokens (keep the row) when Google rejects them, so /status reports
   * needsReconnect and the user sees the Reconnect prompt proactively rather
   * than only discovering the problem mid-save. Called by the M5 router on
   * ReauthRequiredError — the session deliberately survives, since losing
   * Google access is not losing your card2contact session.
   */
  clearTokens(googleUserId: string): Promise<void>;
  /** Atomically bump the running saved-contacts total by one; returns the new total. */
  incrementSavedContactsCount(googleUserId: string): Promise<number>;
  /** Admin User Management: search/filter/sort/paginate the user directory. */
  list(params: ListUsersParams): Promise<ListUsersResult>;
  /** Global (unfiltered) counts for the admin dashboard summary cards. */
  stats(): Promise<UserStats>;
  /**
   * Batch-resolve emails for a set of googleUserIds in one query — used by the
   * License Management surface to label quota/request rows (keyed by id) with a
   * human email, without an N+1 of findById per row. Missing ids are simply
   * absent from the map (the caller falls back to showing the id).
   */
  emailsByIds(googleUserIds: string[]): Promise<Map<string, string>>;
  /**
   * Revoke Access. Sets disabled_at = now(), disabled_by = adminUsername;
   * idempotent — re-disabling an already-disabled user changes neither the
   * timestamp nor the actor (first disable wins). Returns null if the user
   * doesn't exist.
   */
  disable(googleUserId: string, adminUsername: string): Promise<UserRecord | null>;
  /**
   * Restore Access. Clears disabled_at/disabled_by, sets restored_at/restored_by.
   * Restoring an already-active user is still a no-op on the disabled flag but
   * still stamps restoredAt/restoredBy (last-restore-wins), since "who last
   * restored this row" is meaningful even for a no-op re-restore. Returns null
   * if the user doesn't exist.
   */
  restore(googleUserId: string, adminUsername: string): Promise<UserRecord | null>;
}

interface UserRow {
  google_user_id: string;
  email: string;
  spreadsheet_id: string | null;
  spreadsheet_url: string | null;
  spreadsheet_title: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: string | null; // pg returns BIGINT as string
  saved_contacts_count: number;
  created_at: Date;
  last_login_at: Date | null;
  disabled_at: Date | null;
  disabled_by: string | null;
  restored_at: Date | null;
  restored_by: string | null;
}

const USER_COLUMNS = `google_user_id, email, spreadsheet_id, spreadsheet_url, spreadsheet_title,
                      access_token, refresh_token, token_expiry, saved_contacts_count,
                      created_at, last_login_at, disabled_at, disabled_by, restored_at, restored_by`;

export class PgUserStore implements UserStore {
  constructor(
    private readonly pool: Pool,
    private readonly codec: TokenCodec
  ) {}

  /**
   * Decode a stored token, degrading to null rather than throwing.
   *
   * Post-cutover every stored token is ciphertext, so a decode failure means
   * the key rotated or the row was tampered with — never a routine case. But
   * throwing here would escape through findById into the session middleware and
   * 500 EVERY request, locking the user out with no way to recover. Treating it
   * as "no token" instead routes them to the existing needsReconnect flow: one
   * Reconnect and they're working again, and a wrong TOKEN_ENCRYPTION_KEY
   * becomes a recoverable mass-Reconnect event rather than an outage.
   *
   * Logged loudly because this always indicates an operational problem — see
   * the rollback notes for how a wrong-but-valid key presents.
   */
  private dec(stored: string | null, googleUserId: string, field: string): string | null {
    if (stored === null) return null;
    try {
      return this.codec.decode(stored);
    } catch {
      console.error(
        `[user-store] failed to decode ${field} for user ${googleUserId} — treating as absent (key rotation? tampering?)`
      );
      return null;
    }
  }

  private toRecord(row: UserRow): UserRecord {
    return {
      googleUserId: row.google_user_id,
      email: row.email,
      spreadsheetId: row.spreadsheet_id,
      // Fall back to the derived URL for rows written before these columns.
      spreadsheetUrl:
        row.spreadsheet_url ??
        (row.spreadsheet_id === null ? null : spreadsheetUrlFor(row.spreadsheet_id)),
      spreadsheetTitle: row.spreadsheet_title,
      accessToken: this.dec(row.access_token, row.google_user_id, "access_token"),
      refreshToken: this.dec(row.refresh_token, row.google_user_id, "refresh_token"),
      tokenExpiry: row.token_expiry === null ? null : Number(row.token_expiry),
      savedContactsCount: row.saved_contacts_count,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      disabledAt: row.disabled_at,
      disabledBy: row.disabled_by,
      restoredAt: row.restored_at,
      restoredBy: row.restored_by,
    };
  }

  private enc(token: string | null): string | null {
    return token === null ? null : this.codec.encode(token);
  }

  async findById(googleUserId: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE google_user_id = $1`,
      [googleUserId]
    );
    return rows.length ? this.toRecord(rows[0]) : null;
  }

  async emailsByIds(googleUserIds: string[]): Promise<Map<string, string>> {
    if (googleUserIds.length === 0) return new Map();
    // De-dup the ids (a list may repeat a user) and resolve in one ANY($1) query.
    const unique = [...new Set(googleUserIds)];
    const { rows } = await this.pool.query<{ google_user_id: string; email: string }>(
      `SELECT google_user_id, email FROM users WHERE google_user_id = ANY($1)`,
      [unique]
    );
    return new Map(rows.map((r) => [r.google_user_id, r.email]));
  }

  async upsertOnLogin(
    input: { googleUserId: string; email: string } & TokenSet
  ): Promise<UserRecord> {
    // COALESCE(EXCLUDED.refresh_token, users.refresh_token): Google returns a
    // refresh token only on first consent (and with prompt=consent), so on a
    // later login without one we must keep the stored token, not wipe it.
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (google_user_id, email, access_token, refresh_token, token_expiry, last_login_at)
         VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (google_user_id) DO UPDATE SET
         email         = EXCLUDED.email,
         access_token  = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token),
         token_expiry  = EXCLUDED.token_expiry,
         last_login_at = now(),
         updated_at    = now()
       RETURNING ${USER_COLUMNS}`,
      [
        input.googleUserId,
        input.email,
        this.enc(input.accessToken),
        this.enc(input.refreshToken),
        input.tokenExpiry,
      ]
    );
    return this.toRecord(rows[0]);
  }

  async updateTokens(googleUserId: string, tokens: TokenSet): Promise<void> {
    await this.pool.query(
      `UPDATE users SET
         access_token  = $2,
         refresh_token = COALESCE($3, refresh_token),
         token_expiry  = $4,
         updated_at    = now()
       WHERE google_user_id = $1`,
      [googleUserId, this.enc(tokens.accessToken), this.enc(tokens.refreshToken), tokens.tokenExpiry]
    );
  }

  async setSpreadsheet(googleUserId: string, sheet: SpreadsheetInfo): Promise<void> {
    // All three together: a Recreate Sheet that updated the id but left a stale
    // url would point the user at the spreadsheet we just abandoned.
    await this.pool.query(
      `UPDATE users SET spreadsheet_id = $2, spreadsheet_url = $3, spreadsheet_title = $4,
                        updated_at = now()
        WHERE google_user_id = $1`,
      [googleUserId, sheet.id, sheet.url, sheet.title]
    );
  }

  async incrementSavedContactsCount(googleUserId: string): Promise<number> {
    const { rows } = await this.pool.query<{ saved_contacts_count: number }>(
      `UPDATE users SET saved_contacts_count = saved_contacts_count + 1, updated_at = now()
       WHERE google_user_id = $1
       RETURNING saved_contacts_count`,
      [googleUserId]
    );
    return rows[0].saved_contacts_count;
  }

  async clearTokens(googleUserId: string): Promise<void> {
    await this.pool.query(
      `UPDATE users SET access_token = NULL, refresh_token = NULL, token_expiry = NULL, updated_at = now()
       WHERE google_user_id = $1`,
      [googleUserId]
    );
  }

  async list(params: ListUsersParams): Promise<ListUsersResult> {
    const limit = Math.min(100, Math.max(1, params.limit));
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.status === "active") conditions.push("disabled_at IS NULL");
    if (params.status === "disabled") conditions.push("disabled_at IS NOT NULL");
    if (params.search) {
      values.push(`%${params.search}%`, params.search);
      conditions.push(`(email ILIKE $${values.length - 1} OR google_user_id = $${values.length})`);
    }
    if (params.registeredAfter) {
      values.push(params.registeredAfter);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (params.registeredBefore) {
      values.push(params.registeredBefore);
      conditions.push(`created_at <= $${values.length}`);
    }
    if (params.lastLoginAfter) {
      values.push(params.lastLoginAfter);
      conditions.push(`last_login_at >= $${values.length}`);
    }

    const sortColumn = {
      createdAt: "created_at",
      lastLoginAt: "last_login_at",
      savedContactsCount: "saved_contacts_count",
      email: "email",
    }[params.sortField ?? "createdAt"];
    const direction = params.sortDirection === "asc" ? "ASC" : "DESC";
    const cmp = direction === "ASC" ? ">" : "<";

    // Count uses the filter conditions only — captured before any cursor
    // condition is appended, since "how many total rows match" must not
    // depend on which page we're currently on.
    const countWhere = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM users ${countWhere}`,
      values
    );
    const total = Number(countResult.rows[0].count);

    if (params.cursor) {
      const { sortValue, googleUserId } = decodeUserCursor(params.cursor);
      values.push(sortValue, googleUserId);
      // Keyset pagination: strictly past the cursor row, using google_user_id
      // as a tiebreaker so exact ties in sortColumn don't repeat/skip rows.
      conditions.push(`(${sortColumn}, google_user_id) ${cmp} ($${values.length - 1}, $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    values.push(limit + 1); // fetch one extra row to know if there's a next page
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users ${where}
       ORDER BY ${sortColumn} ${direction}, google_user_id ${direction}
       LIMIT $${values.length}`,
      values
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => this.toRecord(r));
    const last = page[page.length - 1];
    const sortField = params.sortField ?? "createdAt";
    const nextCursor =
      hasMore && last
        ? encodeUserCursor({ sortValue: String(last[sortField]), googleUserId: last.googleUserId })
        : null;

    return { users: page, nextCursor, total, totalPages: Math.ceil(total / limit) };
  }

  async stats(): Promise<UserStats> {
    const { rows } = await this.pool.query<{
      total: string;
      active: string;
      disabled: string;
      recent_logins: string;
      total_scans: string;
    }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE disabled_at IS NULL) AS active,
              COUNT(*) FILTER (WHERE disabled_at IS NOT NULL) AS disabled,
              COUNT(*) FILTER (WHERE last_login_at >= now() - INTERVAL '24 hours') AS recent_logins,
              COALESCE(SUM(saved_contacts_count), 0) AS total_scans
         FROM users`
    );
    const r = rows[0];
    return {
      total: Number(r.total),
      active: Number(r.active),
      disabled: Number(r.disabled),
      recentLogins: Number(r.recent_logins),
      totalScans: Number(r.total_scans),
    };
  }

  async disable(googleUserId: string, adminUsername: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `UPDATE users
          SET disabled_at = COALESCE(disabled_at, now()),
              disabled_by = COALESCE(disabled_by, $2),
              updated_at = now()
        WHERE google_user_id = $1
        RETURNING ${USER_COLUMNS}`,
      [googleUserId, adminUsername]
    );
    return rows.length ? this.toRecord(rows[0]) : null;
  }

  async restore(googleUserId: string, adminUsername: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `UPDATE users
          SET disabled_at = NULL, disabled_by = NULL,
              restored_at = now(), restored_by = $2,
              updated_at = now()
        WHERE google_user_id = $1
        RETURNING ${USER_COLUMNS}`,
      [googleUserId, adminUsername]
    );
    return rows.length ? this.toRecord(rows[0]) : null;
  }
}

interface UserCursor {
  sortValue: string;
  googleUserId: string;
}

function encodeUserCursor(cursor: UserCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeUserCursor(cursor: string): UserCursor {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}
