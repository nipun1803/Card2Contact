import { Pool } from "pg";
import {
  AuditEntry,
  AuditLogger,
  AuditQuery,
  AuditQueryResult,
  StdoutAuditLogger,
} from "./audit-logger";

const SESSION_ID_LOG_LENGTH = 8;

interface AuditLogRow {
  id: number;
  ts: Date;
  event: string;
  google_user_id: string | null;
  admin_username: string | null;
  session_id: string | null;
  device: string | null;
  browser: string | null;
  ip: string | null;
  outcome: string | null;
  reason: string | null;
  card_id: string | null;
  revoked_count: number | null;
}

/**
 * Dual-writes: Postgres (queryable, for the admin User Details history) AND
 * stdout (unchanged `docker logs` ops workflow — see StdoutAuditLogger).
 * Field policy identical to StdoutAuditLogger; sessionId is truncated here
 * too so the DB never holds a full bearer credential either.
 *
 * A failed Postgres insert must never fail the request that triggered it —
 * same non-negotiable as StdoutAuditLogger's try/catch.
 */
export class PgAuditLogger implements AuditLogger {
  private readonly stdout = new StdoutAuditLogger();

  constructor(private readonly pool: Pool) {}

  log(entry: AuditEntry): void {
    this.stdout.log(entry);
    const sessionId = entry.sessionId ? entry.sessionId.slice(0, SESSION_ID_LOG_LENGTH) : null;
    this.pool
      .query(
        `INSERT INTO audit_log
           (event, google_user_id, admin_username, session_id, device, browser, ip, outcome, reason, card_id, revoked_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          entry.event,
          entry.googleUserId ?? null,
          entry.adminUsername ?? null,
          sessionId,
          entry.device ?? null,
          entry.browser ?? null,
          entry.ip ?? null,
          entry.outcome ?? null,
          entry.reason ?? null,
          entry.cardId ?? null,
          entry.revokedCount ?? null,
        ]
      )
      .catch((err) => console.error("[audit] Postgres insert failed", err));
  }

  async query(params: AuditQuery): Promise<AuditQueryResult> {
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.googleUserId) {
      values.push(params.googleUserId);
      conditions.push(`google_user_id = $${values.length}`);
    }
    if (params.event) {
      values.push(params.event);
      conditions.push(`event = $${values.length}`);
    }
    const countWhere = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM audit_log ${countWhere}`,
      values
    );

    if (params.cursor) {
      const { ts, id } = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8"));
      values.push(ts, id);
      // ORDER BY ts DESC → strictly OLDER than the cursor row, id as tiebreaker
      // for rows sharing the same timestamp.
      conditions.push(`(ts, id) < ($${values.length - 1}, $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(limit + 1);
    const { rows } = await this.pool.query<AuditLogRow>(
      `SELECT id, ts, event, google_user_id, admin_username, session_id, device, browser, ip, outcome, reason, card_id, revoked_count
         FROM audit_log ${where} ORDER BY ts DESC, id DESC LIMIT $${values.length}`,
      values
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(JSON.stringify({ ts: lastRow.ts, id: lastRow.id })).toString("base64url")
        : null;

    return {
      total: Number(countResult.rows[0].count),
      nextCursor,
      entries: page.map((r) => ({
        id: r.id,
        ts: r.ts.toISOString(),
        event: r.event as AuditEntry["event"],
        googleUserId: r.google_user_id,
        adminUsername: r.admin_username,
        sessionId: r.session_id,
        device: r.device,
        browser: r.browser,
        ip: r.ip,
        outcome: r.outcome as AuditEntry["outcome"],
        reason: r.reason ?? undefined,
        cardId: r.card_id ?? undefined,
        revokedCount: r.revoked_count ?? undefined,
      })),
    };
  }
}
