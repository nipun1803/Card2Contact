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
  | "token_refresh_failed";

export interface AuditEntry {
  event: AuditEvent;
  /** Google's opaque `sub`. Null when the request was never identified. */
  googleUserId?: string | null;
  /** Truncated to 8 chars by the sink — pass the full id. */
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

/**
 * Audit sink. An interface rather than a bare console.log so call sites depend
 * on the contract, tests assert on structured entries instead of scraping
 * stdout, and a future sink (file, SIEM, table) is a wiring change in index.ts.
 */
export interface AuditLogger {
  log(entry: AuditEntry): void;
}

/** Enough to correlate events within a session; useless as a credential. */
const SESSION_ID_LOG_LENGTH = 8;

/**
 * Emits one JSON object per line to stdout, for `docker logs`. Deliberately not
 * an audit table: an append-only table needs retention, indexing, and migration
 * for a payload the container platform already captures and rotates.
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

  log(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  /** All entries for one event type, for concise assertions. */
  ofType(event: AuditEvent): AuditEntry[] {
    return this.entries.filter((e) => e.event === event);
  }
}
