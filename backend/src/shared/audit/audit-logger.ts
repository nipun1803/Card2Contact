/**
 * Security audit logging.
 *
 * An audit log answers "who did what, when, from where" — it is not a debugging
 * dump. Every field must earn inclusion by serving an investigation, so tokens,
 * emails, contact data, and raw User-Agents are deliberately excluded (see the
 * field policy in docs/ARCHITECTURE.md). Session ids are truncated at the sink
 * rather than by callers: a full session id in `docker logs` is a hijack
 * primitive, and making truncation structural means a call site cannot leak one
 * even by mistake.
 */

/**
 * The closed set of auditable events. A union rather than `string` so a typo is
 * a compile error and the taxonomy can't silently sprawl. Names match the
 * Terminology table (Session Replacement -> session_replaced, etc.).
 */
export type AuditEvent =
  | "login"
  | "logout"
  | "oauth_reconnect"
  | "contact_save"
  | "auth_failure"
  | "session_created"
  | "session_terminated"
  | "session_replaced"
  | "session_conflict"
  | "session_conflict_cancelled"
  | "sheet_recreated"
  | "token_refresh_failed"
  /**
   * Admin authentication (see docs/modules/admin/Admin-Authentication.md).
   * Deliberately distinct from `login`/`logout`/`auth_failure`: those carry a
   * googleUserId and mean "an end user's Google session", a different subject
   * entirely. Separate names keep `docker logs | grep admin_auth_failure`
   * honest — the most likely operational query for the admin panel.
   *
   * Exception, deliberate: a rate-limited admin login emits
   * `auth_failure{reason:"rate_limited"}` from the shared limiter handler
   * (shared/http/rate-limit.ts), not `admin_auth_failure`. The
   * `rate_limit_exceeded{endpoint:"admin_login"}` metric is what identifies it.
   */
  | "admin_login"
  | "admin_logout"
  | "admin_auth_failure"
  /**
   * Admin User Management (Phase 1). `admin_user_sessions_revoked` is
   * separate from `session_terminated`/`session_replaced` because the
   * *reason* class differs (admin action vs. self-service logout vs.
   * login-elsewhere) and the admin surface needs to filter specifically for
   * "an admin forced this."
   */
  | "admin_user_disabled"
  | "admin_user_restored"
  | "admin_user_sessions_revoked"
  /**
   * License Management / Scan Quota (Phase 1). `quota_consumed` is the automatic
   * per-scan event (no adminUsername); the rest are admin actions. Scan-Block is
   * kept distinct from `admin_user_disabled` because it blocks only scanning, not
   * login — a different subject the admin surface must be able to filter on its
   * own. `quota_scan_blocked_hit`/`quota_exceeded` record an END USER being
   * refused at OCR, not an admin action.
   */
  | "quota_consumed"
  | "quota_exceeded"
  | "quota_scan_blocked_hit"
  | "quota_granted"
  | "quota_grant_revoked"
  | "quota_grant_expired"
  | "quota_adjusted"
  | "quota_reset"
  | "quota_recalculated"
  | "quota_override_set"
  | "quota_override_cleared"
  | "license_default_updated"
  | "global_scanning_toggled"
  | "scan_blocked"
  | "scan_unblocked"
  /**
   * Tier layer (Phase 4). Catalog edits (`tier_created`/`updated`/`archived`/
   * `cloned`) are app-wide config changes; the assignment events
   * (`tier_assigned`/`changed`/`removed`/`bulk_assigned`) are per-user. Assign
   * and change are distinct so the admin surface can filter "first assignment"
   * from "moved between tiers".
   */
  | "tier_created"
  | "tier_updated"
  | "tier_archived"
  | "tier_cloned"
  | "tier_assigned"
  | "tier_changed"
  | "tier_removed"
  | "tier_bulk_assigned"
  /**
   * Tier Upgrade Requests. `tier_request_created` is user-initiated (the only
   * license event a non-admin causes); approve/reject are admin decisions. The
   * grant itself still emits its own `tier_assigned`/`quota_granted`, so these
   * three record the *workflow*, not the allowance change.
   */
  | "tier_request_created"
  | "tier_request_approved"
  | "tier_request_rejected";

export interface AuditEntry {
  event: AuditEvent;
  /** Google's opaque `sub`. Null when the request was never identified. */
  googleUserId?: string | null;
  /**
   * The admin's configured username (ADMIN_USERNAME), or the *attempted* one on
   * a failure. Null when not an admin event.
   *
   * Logged despite the field policy forbidding `email`, because the policy's
   * two reasons for that ban both fail here: (1) `email` is an end user's PII —
   * this is an operator-chosen role credential, set by whoever writes `.env`,
   * i.e. the same person reading this log; (2) `email` is redundant given
   * googleUserId — here there is no opaque alternative, since no `admins` table
   * exists to join on, so omitting it would leave admin_auth_failure with no
   * subject at all and fail the log's stated purpose ("who did what").
   *
   * A username is not a capability — unlike tokens and session ids, which is
   * why those are excluded/truncated. The admin *password* is never logged in
   * any form, in any field.
   */
  adminUsername?: string | null;
  /**
   * The session this request authenticated with — user (`c2c_session`) or admin
   * (`admin_session`). Truncated to 8 chars by the sink — pass the full id.
   */
  sessionId?: string | null;
  device?: string | null;
  browser?: string | null;
  ip?: string | null;
  outcome?: "success" | "failure";
  /** Machine-readable cause, e.g. "session_revoked", "replaced_by_new_login". */
  reason?: string;
  /** Opaque pipeline id on contact_save. Never the contact's contents. */
  cardId?: string;
  revokedCount?: number;
}

/** Query params for reading back audit history — Admin User Management (Phase 1). */
export interface AuditQuery {
  googleUserId?: string;
  event?: AuditEvent;
  /** Opaque, encodes (ts, id) — cursor pagination, stable under concurrent inserts. */
  cursor?: string;
  limit?: number;
}

export interface AuditQueryResult {
  entries: (AuditEntry & { id: number; ts: string })[];
  nextCursor: string | null;
  total: number;
}

/**
 * Audit sink. An interface rather than a bare console.log so call sites depend
 * on the contract, tests assert on structured entries instead of scraping
 * stdout, and a future sink (file, SIEM, table) is a wiring change in index.ts.
 */
export interface AuditLogger {
  log(entry: AuditEntry): void;
  /** Optional: only a Postgres-backed sink implements real querying. */
  query?(params: AuditQuery): Promise<AuditQueryResult>;
}

/** Enough to correlate events within a session; useless as a credential. */
const SESSION_ID_LOG_LENGTH = 8;

/**
 * Emits one JSON object per line to stdout, for `docker logs`.
 *
 * Historically this was the ONLY sink — deliberately not an audit table, since
 * retention/indexing/migration cost wasn't justified. Admin User Management
 * (Phase 1) supersedes that: the admin surface needs queryable per-user
 * history, which stdout cannot serve. See PgAuditLogger, which dual-writes
 * here AND to the new `audit_log` table — this class still exists standalone
 * for tests and for any composition root that doesn't want Postgres-backed
 * audit querying.
 */
export class StdoutAuditLogger implements AuditLogger {
  log(entry: AuditEntry): void {
    try {
      const { sessionId, ...rest } = entry;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          // Greppable discriminator: audit lines share stdout with app logs.
          kind: "audit",
          ...rest,
          ...(sessionId
            ? { sessionId: sessionId.slice(0, SESSION_ID_LOG_LENGTH) }
            : {}),
        })
      );
    } catch {
      // An audit failure must never fail the request that triggered it.
    }
  }
}

/** Test double — captures entries for assertions. */
export class MemoryAuditLogger implements AuditLogger {
  readonly entries: AuditEntry[] = [];
  private nextId = 1;
  private readonly ids = new WeakMap<AuditEntry, number>();
  private readonly timestamps = new WeakMap<AuditEntry, string>();

  log(entry: AuditEntry): void {
    this.ids.set(entry, this.nextId++);
    this.timestamps.set(entry, new Date().toISOString());
    this.entries.push(entry);
  }

  /** All entries for one event type, for concise assertions. */
  ofType(event: AuditEvent): AuditEntry[] {
    return this.entries.filter((e) => e.event === event);
  }

  /** In-memory equivalent of PgAuditLogger.query(), so AdminUserService unit
   * tests can inject this without a real Postgres. Cursor is the entry's id,
   * newest first, matching the Postgres sink's ORDER BY ts DESC, id DESC. */
  async query(params: AuditQuery): Promise<AuditQueryResult> {
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    let matches = this.entries
      .map((e) => ({ entry: e, id: this.ids.get(e)!, ts: this.timestamps.get(e)! }))
      .filter((m) => (params.googleUserId ? m.entry.googleUserId === params.googleUserId : true))
      .filter((m) => (params.event ? m.entry.event === params.event : true))
      .sort((a, b) => b.id - a.id);

    const total = matches.length;
    if (params.cursor) {
      const cursorId = Number(Buffer.from(params.cursor, "base64url").toString("utf8"));
      matches = matches.filter((m) => m.id < cursorId);
    }
    const page = matches.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const pageEntries = page.slice(0, limit);
    const last = pageEntries[pageEntries.length - 1];
    const nextCursor = hasMore && last ? Buffer.from(String(last.id)).toString("base64url") : null;

    return {
      total,
      nextCursor,
      entries: pageEntries.map((m) => ({ ...m.entry, id: m.id, ts: m.ts })),
    };
  }
}
