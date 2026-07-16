import { newSessionId } from "./session-store";

/**
 * Admin session storage — the operator's session, entirely separate from the
 * end-user session model in session-store.ts.
 *
 * Why not reuse SessionStore/`sessions`: that table declares
 * `google_user_id TEXT NOT NULL REFERENCES users(google_user_id)`, and every
 * SessionStore method is googleUserId-shaped. An admin has no Google identity.
 * Reusing it would mean either a nullable FK — destroying the property that an
 * admin session is *structurally incapable* of being a user session — or a fake
 * id the whole codebase would have to keep lying about. This is the same
 * reasoning that keeps `pending_sessions` a separate table rather than a status
 * column (see docs/ARCHITECTURE.md).
 *
 * Why in-memory rather than Postgres: the durability of `sessions` exists to
 * solve problems admin does not have — cross-device Session Replacement, a
 * /status contract polled on window focus, a 7-day lifetime that must outlive
 * deploys. Admin has one operator, no conflict flow, and an 8h lifetime. The
 * cost is that a deploy logs the admin out, which for a single operator is a
 * non-event — and it is load-bearing rather than merely tolerated: with no
 * revoke endpoint in Phase 0.1, **the restart IS the revocation mechanism**.
 * The interface below is the seam that makes this reversible: a
 * PgAdminSessionStore would be a new implementation plus one wiring line.
 *
 * See docs/modules/admin/Admin-Authentication.md for the full expiry rules.
 */

/**
 * Absolute Lifetime: 8h from creation, regardless of activity.
 *
 * Deliberately shorter than the user session's 7 days. An operator session is
 * naturally bounded by a work session and carries no "keep me signed in"
 * expectation, so a short cap costs one login a day and bounds how long a stolen
 * cookie stays useful.
 *
 * There is deliberately NO admin Idle Timeout. The user session has both bounds
 * and documents that Absolute (7d) always binds first, making its 30d Idle
 * unreachable. With an 8h absolute cap here, any idle bound worth having would
 * be unreachable *by construction* — so rather than ship a constant that can
 * never fire, admin has one rule. `lastActivityAt` is recorded (useful for a
 * future /me and for audit) but is NEVER read for expiry, and the session does
 * NOT slide forward on activity: a sliding window would keep a stolen cookie
 * alive exactly as long as the thief kept using it, which is backwards.
 *
 * The admin cookie's maxAge is set from this same constant, so the browser
 * discards the cookie at the instant the server stops honouring it. The two must
 * not drift — see shared/http/admin-session.ts.
 */
export const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

/** How often the in-memory store reclaims expired records. Space only. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Device fingerprint captured at login. Display/audit only. */
export interface AdminSessionFingerprint {
  device: string | null;
  browser: string | null;
  ip: string | null;
}

export interface AdminSessionRecord {
  /** Opaque 256-bit id — a bearer credential, never an identity claim. */
  id: string;
  /** The configured ADMIN_USERNAME this session authenticated as. */
  username: string;
  createdAt: Date;
  /** Recorded for audit/display. NOT read for expiry — see the note above. */
  lastActivityAt: Date;
  device: string | null;
  browser: string | null;
  ip: string | null;
}

/**
 * The seam. Middleware and the admin service depend on this, never on the
 * implementation — mirroring how UserStore/SessionStore are injected, and what
 * makes the in-memory choice above reversible.
 */
export interface AdminSessionStore {
  create(username: string, fp: AdminSessionFingerprint): Promise<AdminSessionRecord>;
  /**
   * The session for this id if it is still within its Absolute Lifetime and has
   * not been revoked. Null for unknown, expired, OR revoked — the caller cannot
   * tell which, by design: admin has no Session Replacement story to explain, so
   * every failure is one generic 401.
   */
  findActive(id: string): Promise<AdminSessionRecord | null>;
  /** Session Termination (logout). Idempotent. */
  revoke(id: string): Promise<void>;
  /** Housekeeping: drop expired records. Returns how many were removed. */
  purgeExpired(): Promise<number>;
}

/**
 * Map-backed AdminSessionStore.
 *
 * This is the production implementation, not a test double — which is why it
 * lives in src/ alongside MemoryAuditLogger rather than in tests/mocks/. Tests
 * inject it directly rather than faking it: per docs/TESTING.md, a fake exists
 * to stand in for something expensive or non-deterministic, and this is neither.
 *
 * Revocation is a hard delete, unlike the user store's soft delete. `sessions`
 * retains revoked rows for 7 days specifically so a revoked device can be told
 * SESSION_REVOKED instead of being silently downgraded to anonymous. Admin makes
 * no such distinction (see findActive), so retaining the row would buy nothing
 * and only keep a dead credential's record around.
 */
export class InMemoryAdminSessionStore implements AdminSessionStore {
  private readonly sessions = new Map<string, AdminSessionRecord>();
  private readonly timer: ReturnType<typeof setInterval>;
  /** Injectable clock — lets tests age a session without sleeping. */
  private now: () => Date = () => new Date();

  constructor() {
    /**
     * The store owns its own purge, unlike PgSessionStore whose purge is driven
     * by index.ts. Legitimate here precisely because this store owns its own
     * storage: there is no pool to schedule against, and without this nothing
     * would ever call purgeExpired() and expired records would accumulate for
     * the life of the container.
     *
     * unref()'d so it never holds the process open at shutdown (matching the
     * purge interval in index.ts).
     *
     * NOT a correctness mechanism: findActive enforces the Absolute Lifetime on
     * every lookup, so an expired session stops working the instant it expires
     * whether or not this ever runs. Purely space.
     */
    this.timer = setInterval(() => {
      void this.purgeExpired();
    }, PURGE_INTERVAL_MS);
    this.timer.unref();
  }

  /** Test seam: override "now" to age sessions without sleeping. */
  _setNow(fn: () => Date): void {
    this.now = fn;
  }

  /** Test seam: stop the purge timer so a suite can exit deterministically. */
  stop(): void {
    clearInterval(this.timer);
  }

  private isActive(session: AdminSessionRecord): boolean {
    // Absolute Lifetime only — there is deliberately no idle bound.
    return this.now().getTime() - session.createdAt.getTime() < ADMIN_SESSION_ABSOLUTE_MS;
  }

  async create(
    username: string,
    fp: AdminSessionFingerprint
  ): Promise<AdminSessionRecord> {
    const at = this.now();
    const session: AdminSessionRecord = {
      // Reuses the user store's CSPRNG id generator: 256 bits from randomBytes,
      // base64url so it is cookie-safe. Already documented there as a bearer
      // credential; a second id generator would be a second thing to review.
      id: newSessionId(),
      username,
      createdAt: at,
      lastActivityAt: at,
      device: fp.device,
      browser: fp.browser,
      ip: fp.ip,
    };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  async findActive(id: string): Promise<AdminSessionRecord | null> {
    const session = this.sessions.get(id);
    if (!session || !this.isActive(session)) return null;
    // Recorded, never enforced — see the ADMIN_SESSION_ABSOLUTE_MS note. This
    // must NOT extend the session's life.
    session.lastActivityAt = this.now();
    return { ...session };
  }

  async revoke(id: string): Promise<void> {
    // Idempotent: revoking an unknown or already-revoked id is a no-op, so a
    // double-clicked logout cannot fail.
    this.sessions.delete(id);
  }

  async purgeExpired(): Promise<number> {
    let purged = 0;
    for (const [id, session] of this.sessions) {
      if (!this.isActive(session)) {
        this.sessions.delete(id);
        purged++;
      }
    }
    return purged;
  }
}
