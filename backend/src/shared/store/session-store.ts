import { Pool } from "pg";
import { randomBytes } from "crypto";

/**
 * Server-side session storage — the single-active-session model.
 *
 * This is the only inter-module contract for session identity: middleware and
 * routers depend on the SessionStore interface, not Postgres, so tests inject
 * an in-memory fake (mirroring the UserStore pattern).
 *
 * The cookie carries `id` and nothing else. It is an opaque capability, never
 * an identity claim — the server resolves who you are, so a stolen cookie can
 * be revoked and a forged one is meaningless.
 */

/**
 * Opaque 256-bit session id. base64url so it is cookie-safe without escaping.
 * randomBytes (CSPRNG) rather than a uuid: this value is a bearer credential.
 */
export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** Idle Timeout: no activity for 30 days ends the session. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Absolute Lifetime: 7 days from creation, regardless of activity. This is the
 * BINDING constraint — no session can reach the 30-day Idle Timeout because it
 * dies at 7 days first.
 *
 * Both exist deliberately: Absolute bounds how long a stolen cookie is useful,
 * Idle ends an abandoned session early (a shared computer, say) without waiting
 * for the absolute cap. The session cookie's maxAge is set to this value too,
 * so the browser discards the cookie at the same moment the server stops
 * honouring it — they must not drift.
 */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a Pending Session survives. A Session Conflict prompt is on-screen
 * while it lives: 5 minutes is generous for reading and clicking, and short
 * enough that an abandoned prompt cannot be resumed later from a stale tab.
 */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * How long revoked rows are retained before purging. This retention is what
 * makes SESSION_REVOKED work at all — hard-deleting on revoke would leave the
 * revoked device with a silent anonymous downgrade instead of an explanation.
 * After this window a very stale tab just sees a normal signed-out state.
 */
export const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionRecord {
  id: string;
  googleUserId: string;
  device: string | null;
  browser: string | null;
  ip: string | null;
  createdAt: Date;
  lastActivityAt: Date;
}

export interface PendingSessionRecord {
  id: string;
  googleUserId: string;
  device: string | null;
  browser: string | null;
  ip: string | null;
}

/** Device fingerprint captured at session creation. Display-only. */
export interface SessionFingerprint {
  device: string | null;
  browser: string | null;
  ip: string | null;
}

/**
 * Why a session was revoked. Surfaced in audit logs and metrics, never to the
 * client. Terminology: "logout" is Session Termination,
 * "replaced_by_new_login" is Session Replacement.
 */
export type RevokeReason = "logout" | "replaced_by_new_login" | "user_revoked";

export interface SessionStore {
  create(googleUserId: string, fp: SessionFingerprint): Promise<SessionRecord>;
  /**
   * The session for this id if it is Active. Null for unknown, revoked, OR
   * expired ids — the caller cannot tell which, by design...
   */
  findActive(id: string): Promise<SessionRecord | null>;
  /**
   * ...so this answers the one question that needs distinguishing: was this id
   * explicitly revoked (tell the user) rather than merely expired/unknown
   * (treat as anonymous)? Expiry is not revocation.
   */
  isRevoked(id: string): Promise<boolean>;
  /** Bump last_activity_at. Throttled by the caller; never awaited on the hot path. */
  touch(id: string): Promise<void>;
  revoke(id: string, reason: RevokeReason): Promise<void>;
  /** Revoke every Active Session for a user; returns how many were revoked. */
  revokeAllForUser(googleUserId: string, reason: RevokeReason): Promise<number>;
  /** The user's current Active Session, if any — drives the Session Conflict check. */
  findActiveForUser(googleUserId: string): Promise<SessionRecord | null>;
  createPending(googleUserId: string, fp: SessionFingerprint): Promise<PendingSessionRecord>;
  /** Atomically fetch-and-delete a Pending Session. Null if unknown or expired. */
  consumePending(id: string): Promise<PendingSessionRecord | null>;
  /** Housekeeping: drop long-revoked/expired sessions and expired pendings. */
  purgeExpired(): Promise<{ sessions: number; pending: number }>;
}

interface SessionRow {
  id: string;
  google_user_id: string;
  device: string | null;
  browser: string | null;
  ip: string | null;
  created_at: Date;
  last_activity_at: Date;
}

interface PendingRow {
  id: string;
  google_user_id: string;
  device: string | null;
  browser: string | null;
  ip: string | null;
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    googleUserId: row.google_user_id,
    device: row.device,
    browser: row.browser,
    ip: row.ip,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

function toPendingRecord(row: PendingRow): PendingSessionRecord {
  return {
    id: row.id,
    googleUserId: row.google_user_id,
    device: row.device,
    browser: row.browser,
    ip: row.ip,
  };
}

const SESSION_COLUMNS =
  "id, google_user_id, device, browser, ip, created_at, last_activity_at";

/**
 * Both lifetime bounds are enforced here in SQL rather than by a background
 * sweeper, so an expired session stops working the instant it expires even if
 * the purge job never runs. purgeExpired only reclaims space.
 */
const ACTIVE_PREDICATE = `
  revoked_at IS NULL
  AND last_activity_at > now() - ($2::bigint * interval '1 millisecond')
  AND created_at       > now() - ($3::bigint * interval '1 millisecond')`;

export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async create(googleUserId: string, fp: SessionFingerprint): Promise<SessionRecord> {
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (id, google_user_id, device, browser, ip)
         VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SESSION_COLUMNS}`,
      [newSessionId(), googleUserId, fp.device, fp.browser, fp.ip]
    );
    return toSessionRecord(rows[0]);
  }

  async findActive(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE id = $1 AND ${ACTIVE_PREDICATE}`,
      [id, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS]
    );
    return rows.length ? toSessionRecord(rows[0]) : null;
  }

  async findActiveForUser(googleUserId: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE google_user_id = $1 AND ${ACTIVE_PREDICATE}
        ORDER BY last_activity_at DESC
        LIMIT 1`,
      [googleUserId, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS]
    );
    return rows.length ? toSessionRecord(rows[0]) : null;
  }

  async isRevoked(id: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NOT NULL`,
      [id]
    );
    return rows.length > 0;
  }

  async touch(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET last_activity_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [id]
    );
  }

  async revoke(id: string, reason: RevokeReason): Promise<void> {
    // `revoked_at IS NULL` keeps the original revocation's timestamp and reason
    // if this is called twice — the first revocation is the true one.
    await this.pool.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, reason]
    );
  }

  async revokeAllForUser(googleUserId: string, reason: RevokeReason): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
        WHERE google_user_id = $1 AND revoked_at IS NULL`,
      [googleUserId, reason]
    );
    return rowCount ?? 0;
  }

  async createPending(
    googleUserId: string,
    fp: SessionFingerprint
  ): Promise<PendingSessionRecord> {
    const { rows } = await this.pool.query<PendingRow>(
      `INSERT INTO pending_sessions (id, google_user_id, device, browser, ip, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6::bigint * interval '1 millisecond'))
       RETURNING id, google_user_id, device, browser, ip`,
      [newSessionId(), googleUserId, fp.device, fp.browser, fp.ip, PENDING_TTL_MS]
    );
    return toPendingRecord(rows[0]);
  }

  async consumePending(id: string): Promise<PendingSessionRecord | null> {
    // DELETE ... RETURNING is atomic: two concurrent Continue clicks cannot
    // both consume the same row, so one Session Conflict cannot mint two
    // sessions. The expiry check rides in the same statement, so there is no
    // TOCTOU window between "is it fresh?" and "consume it".
    const { rows } = await this.pool.query<PendingRow>(
      `DELETE FROM pending_sessions
        WHERE id = $1 AND expires_at > now()
        RETURNING id, google_user_id, device, browser, ip`,
      [id]
    );
    return rows.length ? toPendingRecord(rows[0]) : null;
  }

  async purgeExpired(): Promise<{ sessions: number; pending: number }> {
    // Revoked rows outlive their revocation by REVOKED_RETENTION_MS so the
    // revoked device still gets a specific SESSION_REVOKED when it wakes up.
    const sessions = await this.pool.query(
      `DELETE FROM sessions
        WHERE (revoked_at IS NOT NULL AND revoked_at < now() - ($1::bigint * interval '1 millisecond'))
           OR (revoked_at IS NULL AND last_activity_at < now() - ($2::bigint * interval '1 millisecond'))
           OR (revoked_at IS NULL AND created_at       < now() - ($3::bigint * interval '1 millisecond'))`,
      [REVOKED_RETENTION_MS, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS]
    );
    const pending = await this.pool.query(
      `DELETE FROM pending_sessions WHERE expires_at < now()`
    );
    return { sessions: sessions.rowCount ?? 0, pending: pending.rowCount ?? 0 };
  }
}
