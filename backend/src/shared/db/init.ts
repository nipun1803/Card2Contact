import { Pool } from "pg";

/**
 * Idempotent schema setup. An MMVP-scale migration approach: a single
 * `CREATE TABLE IF NOT EXISTS` run once at startup (before `app.listen`),
 * so there is no separate migration tool to operate.
 *
 * The `users` table is the durable, per-user replacement for the old
 * single-user in-memory token store. Each row associates one Google account
 * (`google_user_id` = the OAuth id_token `sub`) with its own spreadsheet and
 * OAuth tokens. Tokens are written through the TokenCodec seam (see
 * shared/store/token-codec.ts) and are AES-256-GCM encrypted at rest; the
 * one-time Token Cutover below clears any plaintext left from before that.
 *
 * `sessions` and `pending_sessions` back the single-active-session model — see
 * their comments below and shared/store/session-store.ts.
 *
 * Audit timestamps (`created_at`, `updated_at`, `last_login_at`) exist purely
 * to make later debugging easier — they are not read by application logic.
 * There is deliberately NO header schema-version column: header integrity is
 * enforced by reading row 1 and repairing it if it drifts (M5 save flow).
 *
 * `saved_contacts_count` is a running per-user total, incremented once per
 * successful M5 save (see UserStore.incrementSavedContactsCount). It exists so
 * the dashboard can show "contacts saved" without re-reading the Google Sheet
 * on every load — Postgres is the source of truth for the count, the sheet for
 * the actual rows.
 */
export async function initSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      google_user_id TEXT PRIMARY KEY,
      email          TEXT NOT NULL,
      spreadsheet_id TEXT,
      access_token   TEXT,
      refresh_token  TEXT,
      token_expiry   BIGINT,
      saved_contacts_count INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at  TIMESTAMPTZ
    );
  `);
  // Additive migration for pre-existing tables from before this column existed.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_contacts_count INTEGER NOT NULL DEFAULT 0;
  `);
  // The spreadsheet's URL and title used to be derived (URL built inline in the
  // auth router, title a constant). Recreate Sheet must persist all three, so
  // they became columns.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS spreadsheet_url TEXT;
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS spreadsheet_title TEXT;
  `);
  // Admin User Management (Phase 1): soft-disable a user's access without
  // deleting their row (contacts/history must survive). NULL = enabled (the
  // default for every pre-existing row — no backfill needed, absence of a
  // value IS "not disabled"). disabled_by/restored_by store the admin
  // username that performed the action — plain text, not a FK (there is only
  // ever one admin operator today) — recorded structurally so "who did this"
  // survives independent of audit_log. restored_at/restored_by are set on
  // every restore call (not just cleared) so "last restored" is queryable
  // without joining audit_log.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by TEXT;
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ;
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS restored_by TEXT;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS users_disabled_idx ON users (disabled_at) WHERE disabled_at IS NOT NULL;
  `);

  /**
   * One row per browser session. The id is an opaque 256-bit random value
   * (never the google_user_id), carried in a signed httpOnly cookie.
   *
   * A session is Active iff it is not revoked AND within both the Idle Timeout
   * (last_activity_at) and the Absolute Lifetime (created_at) — both enforced
   * in SQL by findActive, so an expired session needs no sweeper to stop
   * working. Revocation is a soft delete: the row is retained so the revoked
   * device's next request can be answered with a specific SESSION_REVOKED
   * rather than a silent downgrade to anonymous.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id               TEXT PRIMARY KEY,
      google_user_id   TEXT NOT NULL REFERENCES users(google_user_id) ON DELETE CASCADE,
      device           TEXT,
      browser          TEXT,
      ip               TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at       TIMESTAMPTZ,
      revoked_reason   TEXT
    );
  `);
  // Partial index: findActiveForUser (the Session Conflict check) and
  // revokeAllForUser both only ever look at non-revoked rows.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_user_active_idx
      ON sessions (google_user_id) WHERE revoked_at IS NULL;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_last_activity_idx ON sessions (last_activity_at);
  `);

  /**
   * A sign-in that hit a Session Conflict, staged awaiting the user's decision.
   * Tokens are already persisted to `users` by this point (the OAuth code is
   * single-use and cannot be re-exchanged after the user clicks Continue), so
   * this row holds only the identity of the not-yet-active session plus its
   * device fingerprint.
   *
   * Separate from `sessions` rather than a status column so a Pending Session
   * is structurally incapable of authenticating a request: findActive reads
   * `sessions`, and a pending row simply is not there. With a status column
   * that guarantee would rest on every future query remembering
   * `AND status='active'`.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_sessions (
      id             TEXT PRIMARY KEY,
      google_user_id TEXT NOT NULL REFERENCES users(google_user_id) ON DELETE CASCADE,
      device         TEXT,
      browser        TEXT,
      ip             TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at     TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS pending_sessions_expires_idx ON pending_sessions (expires_at);
  `);

  /**
   * Admin User Management (Phase 1): insert-only audit history, queryable by
   * the admin User Details page.
   *
   * ARCHITECTURE DECISION CHANGE: audit logging used to be stdout-only,
   * deliberately not a table (retention/indexing/migration cost wasn't
   * justified). This supersedes that: the admin surface needs queryable
   * per-user history (login, revoke/restore, reconnect, sheet recreation,
   * contact saves), which stdout cannot serve. AuditLogger now dual-writes:
   * Postgres for querying, stdout unchanged for the existing `docker logs`
   * ops workflow. See docs/ARCHITECTURE.md's "Audit logging & metrics"
   * section for the full rationale.
   *
   * Same field policy as the stdout sink: no tokens, no email, no contact
   * data, no raw UA, sessionId truncated to 8 chars — enforced in the sink
   * (PgAuditLogger), not by callers.
   *
   * No FK from google_user_id to users — deliberate: audit rows must outlive
   * the thing they describe, and some failure events may reference a
   * googleUserId that never resolved to a persisted row.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id             BIGSERIAL PRIMARY KEY,
      ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
      event          TEXT NOT NULL,
      google_user_id TEXT,
      admin_username TEXT,
      session_id     TEXT,
      device         TEXT,
      browser        TEXT,
      ip             TEXT,
      outcome        TEXT,
      reason         TEXT,
      card_id        TEXT,
      revoked_count  INTEGER
    );
  `);
  // Two access patterns the admin surface needs: "history for this user" and
  // "recent events across everyone" (future-proofing, not used by Phase 1 UI).
  await pool.query(`
    CREATE INDEX IF NOT EXISTS audit_log_user_ts_idx ON audit_log (google_user_id, ts DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
  `);

  await initLicenseSchema(pool);

  await wipePlaintextTokens(pool);
}

/**
 * License Management / Scan Quota (Phase 1): meters scans (one OCR run = one
 * unit), enforces per-user quotas, and records every quota change. Split into
 * its own function purely for readability — it is still part of the one
 * idempotent initSchema run, added here as additive CREATE TABLE IF NOT EXISTS.
 *
 * Five tables, each with a distinct job:
 * - license_settings   — app-wide defaults + global on/off flags (singleton row)
 * - scan_quotas        — per-user free counter + Scan-Block state
 * - paid_grants        — per-user paid pool as dated, independently-expiring grants
 * - quota_consumptions — one row per billable card (exactly-once metering key)
 * - quota_ledger       — append-only "why did this quota change" history
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md for the full data model.
 */
export async function initLicenseSchema(pool: Pool): Promise<void> {
  /**
   * Application-wide license configuration. A single row (id is a BOOLEAN pinned
   * to TRUE by the CHECK, so a second INSERT can never create a second config)
   * rather than a stringly-typed key/value table: these are a small, fixed set
   * of typed values that change together, and one typed row is both safer and
   * cheaper to read than parsing strings.
   *
   * Defaults chosen so a fresh deploy meters but does not lock anyone out:
   * 10 free scans, no paid, all pools enabled, enforcement ON (the user chose
   * hard-block). The seed INSERT is idempotent via ON CONFLICT DO NOTHING.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_settings (
      id                  BOOLEAN PRIMARY KEY DEFAULT TRUE,
      default_free_limit  INTEGER NOT NULL DEFAULT 10,
      default_paid_limit  INTEGER NOT NULL DEFAULT 0,
      free_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      paid_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      enforcement_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by          TEXT,
      CONSTRAINT license_settings_singleton CHECK (id = TRUE)
    );
  `);
  await pool.query(`
    INSERT INTO license_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
  `);

  /**
   * Per-user free pool + Scan-Block state. Lazily materialized: a user with no
   * scan history has no row, and admin reads COALESCE a missing row to "0 used,
   * full default remaining". free_limit_override is NULL to inherit the global
   * default — so "remove override → reset to default" is a single SET ... = NULL
   * with no backfill.
   *
   * Scan-Block is deliberately HERE and not the users table: users.disabled_at
   * is login-level Revoke Access (a different door). scan_blocked_at blocks only
   * scanning while the user stays signed in. blocked_by/unblocked_by mirror the
   * users-table disabled_by convention (admin username, plain text, not a FK).
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_quotas (
      google_user_id      TEXT PRIMARY KEY REFERENCES users(google_user_id) ON DELETE CASCADE,
      free_limit_override INTEGER,
      free_used           INTEGER NOT NULL DEFAULT 0,
      scan_blocked_at     TIMESTAMPTZ,
      scan_blocked_by     TEXT,
      scan_unblocked_at   TIMESTAMPTZ,
      scan_unblocked_by   TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS scan_quotas_blocked_idx
      ON scan_quotas (scan_blocked_at) WHERE scan_blocked_at IS NOT NULL;
  `);

  /**
   * Paid pool as a set of dated grants — one row per admin paid grant, each with
   * its own expires_at. Drawable paid = SUM(amount - used) over non-expired,
   * unrevoked grants. A flat "paid_used" integer cannot express independent
   * expiries, so the pool is modelled as rows: "increase" is a new grant,
   * "decrease/reset" soft-revokes grants (revoked_at), and Active/Expired status
   * is computed from expires_at at read time — no cron needed.
   *
   * CHECK (used <= amount) is a last-line guard; the consume statement never
   * over-draws a grant because it only touches rows WHERE used < amount.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paid_grants (
      id             BIGSERIAL PRIMARY KEY,
      google_user_id TEXT NOT NULL REFERENCES users(google_user_id) ON DELETE CASCADE,
      amount         INTEGER NOT NULL CHECK (amount > 0),
      used           INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= amount),
      expires_at     TIMESTAMPTZ,
      granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      granted_by     TEXT NOT NULL,
      revoked_at     TIMESTAMPTZ,
      reason         TEXT
    );
  `);
  // Partial index tuned to the consume query: the drawable set (unrevoked,
  // not-full), ordered by expires_at (soonest-to-expire drawn first).
  await pool.query(`
    CREATE INDEX IF NOT EXISTS paid_grants_draw_idx
      ON paid_grants (google_user_id, expires_at)
      WHERE revoked_at IS NULL AND used < amount;
  `);

  /**
   * Exactly-once metering. One row per billable card, keyed (google_user_id,
   * card_id). The consume path inserts here FIRST with ON CONFLICT DO NOTHING;
   * a retried OCR request (network flake re-sending the same cardId) conflicts,
   * returns zero rows, and short-circuits to the prior decision — so a scan is
   * billed exactly once no matter how many times the client retries.
   *
   * `pool` records which pool the scan drew from (and grant_id which grant), so
   * a retry can return the SAME decision, and recalculate can reconcile counters
   * from this table if they ever drift.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quota_consumptions (
      google_user_id TEXT NOT NULL REFERENCES users(google_user_id) ON DELETE CASCADE,
      card_id        TEXT NOT NULL,
      pool           TEXT NOT NULL,
      grant_id       BIGINT,
      consumed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (google_user_id, card_id)
    );
  `);

  /**
   * Append-only history of every quota change: automatic consumes plus admin
   * grants/adjusts/resets/overrides and Scan-Block toggles. No FK to users —
   * like audit_log, a ledger row must outlive the row it describes. This powers
   * the admin "quota history" view; counters/grants remain the atomic source of
   * truth, the ledger is a best-effort (fire-and-forget) record of intent.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quota_ledger (
      id             BIGSERIAL PRIMARY KEY,
      ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
      google_user_id TEXT NOT NULL,
      kind           TEXT NOT NULL,
      pool           TEXT,
      grant_id       BIGINT,
      delta          INTEGER,
      reason         TEXT,
      admin_username TEXT
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS quota_ledger_user_ts_idx ON quota_ledger (google_user_id, ts DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS quota_ledger_ts_idx ON quota_ledger (ts DESC);
  `);

  await initTierSchema(pool);
}

/**
 * Tier layer (Phase 4): named, admin-configurable allowance presets on top of
 * the free-counter + paid-grants primitives. A Tier is DATA the admin edits, not
 * a name the code branches on — enforcement reads only is_unlimited / scan_limit
 * / validity_days, so a future custom tier needs no code change.
 *
 * Two tables plus two additive columns:
 * - tiers            — the catalog (Free / Professional / Enterprise, editable)
 * - tier_assignments — append-only snapshot history + current-tier source
 * - paid_grants.tier_id       — stamps a grant with the tier that created it
 * - scan_quotas.unlimited_until — the per-user "never block" window (unlimited)
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */
export async function initTierSchema(pool: Pool): Promise<void> {
  /**
   * The tier catalog. `is_unlimited` (not the name) is what enforcement keys off
   * — a limited tier MUST carry a scan_limit (CHECK), an unlimited one ignores
   * it. `validity_days` NULL = no expiry (the Free tier). Exactly one row is
   * `is_default` (the fallback when a paid tier lapses); a partial unique index
   * enforces that. Tiers are soft-deleted (archived_at) because assignments and
   * grants reference them and must never dangle.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tiers (
      id            BIGSERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      is_unlimited  BOOLEAN NOT NULL DEFAULT FALSE,
      scan_limit    INTEGER,
      validity_days INTEGER,
      is_default    BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      archived_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by    TEXT,
      CONSTRAINT tiers_limit_or_unlimited CHECK (is_unlimited OR scan_limit IS NOT NULL),
      CONSTRAINT tiers_limit_positive CHECK (scan_limit IS NULL OR scan_limit > 0),
      CONSTRAINT tiers_validity_positive CHECK (validity_days IS NULL OR validity_days > 0)
    );
  `);
  // At most one default tier — enforced in the DB so no code path can create two.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tiers_single_default_idx
      ON tiers ((is_default)) WHERE is_default;
  `);

  /**
   * Seed the three starting tiers. Snapshot-on-assign means editing these later
   * never disturbs already-assigned users, so seeding sane defaults is safe.
   * ON CONFLICT (name) DO NOTHING keeps it idempotent across boots and lets an
   * admin rename/edit without the seed clobbering their changes.
   */
  await pool.query(`
    INSERT INTO tiers (name, is_unlimited, scan_limit, validity_days, is_default, sort_order)
    VALUES ('Free', FALSE, 30, NULL, TRUE, 0)
    ON CONFLICT (name) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO tiers (name, is_unlimited, scan_limit, validity_days, is_default, sort_order)
    VALUES ('Professional', FALSE, 1000, 365, FALSE, 1)
    ON CONFLICT (name) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO tiers (name, is_unlimited, scan_limit, validity_days, is_default, sort_order)
    VALUES ('Enterprise', TRUE, NULL, 365, FALSE, 2)
    ON CONFLICT (name) DO NOTHING;
  `);

  /**
   * Append-only assignment history AND the current-tier source of truth. Each
   * row SNAPSHOTS the tier's values as of assign time (tier_name, is_unlimited,
   * scan_limit, validity_days, expires_at) — so a later catalog edit can't
   * retroactively change what a user was given, and "when did they move from X
   * to Y" is answerable without reconstructing state. The user's CURRENT tier is
   * the latest row whose action <> 'removed'.
   *
   * No FK on tier_id is enforced as RESTRICT — a tier is archived, never deleted,
   * so the reference stays valid; the snapshot columns make the row
   * self-describing even if the catalog row later changes.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tier_assignments (
      id                 BIGSERIAL PRIMARY KEY,
      google_user_id     TEXT NOT NULL REFERENCES users(google_user_id) ON DELETE CASCADE,
      tier_id            BIGINT REFERENCES tiers(id),
      tier_name          TEXT,
      is_unlimited       BOOLEAN,
      scan_limit         INTEGER,
      validity_days      INTEGER,
      expires_at         TIMESTAMPTZ,
      previous_tier_id   BIGINT,
      previous_tier_name TEXT,
      action             TEXT NOT NULL,   -- assigned | changed | removed
      assigned_by        TEXT,
      assigned_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS tier_assignments_user_idx
      ON tier_assignments (google_user_id, assigned_at DESC);
  `);

  // Additive columns on the Phase-1 tables (idempotent).
  await pool.query(`
    ALTER TABLE paid_grants ADD COLUMN IF NOT EXISTS tier_id BIGINT REFERENCES tiers(id);
  `);
  await pool.query(`
    ALTER TABLE scan_quotas ADD COLUMN IF NOT EXISTS unlimited_until TIMESTAMPTZ;
  `);

  await initTierRequestSchema(pool);
}

/**
 * Tier Upgrade Requests: a user-initiated workflow layer on top of the tier
 * catalog. A request is METADATA, not an allowance — nothing about a user's
 * quota changes when they file one. Only an admin decision acts: Approve calls
 * the existing assignTier / grantPaid seam (the same one a future payment
 * webhook would call), so there is one source of truth and no parallel grant
 * mechanism. The enforcement path (quota-guard, consume) never reads this table.
 *
 * Two request shapes, discriminated by `kind`:
 * - 'tier'   — the user picked a catalog tier (requested_tier_id set).
 * - 'custom' — the user asked for an ad-hoc amount/duration with a reason.
 *
 * Lifecycle: pending -> approved | rejected. Exactly one pending row per user is
 * enforced by a partial unique index — the DB guarantees "one open request",
 * so a double-submit races to a single row instead of stacking duplicates. The
 * admin's decision may DIFFER from the ask (approve-with-different-tier /
 * approve-with-custom-quota), so the decision columns are separate from the
 * request columns and record what was actually granted.
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */
export async function initTierRequestSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tier_requests (
      id                  BIGSERIAL PRIMARY KEY,
      google_user_id      TEXT NOT NULL REFERENCES users(google_user_id) ON DELETE CASCADE,
      kind                TEXT NOT NULL,             -- 'tier' | 'custom'
      -- What the user asked for (a snapshot of intent; the tier may be edited later).
      requested_tier_id   BIGINT REFERENCES tiers(id),
      requested_tier_name TEXT,                      -- snapshot at request time
      requested_amount    INTEGER,                   -- custom: desired scan count
      requested_days      INTEGER,                   -- custom: desired validity window
      user_note           TEXT,                      -- optional (tier) / required (custom) justification
      -- The user's tier at request time, for admin context (snapshot, not a live ref).
      current_tier_name   TEXT,
      status              TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
      -- What the admin actually did (may differ from the ask). NULL until decided.
      decided_by          TEXT,
      decided_at          TIMESTAMPTZ,
      decision_note       TEXT,                      -- admin's reason (esp. on reject)
      granted_tier_id     BIGINT REFERENCES tiers(id),   -- the tier assigned on approve, if any
      granted_amount      INTEGER,                   -- the paid grant amount on approve, if any
      granted_days        INTEGER,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT tier_requests_kind CHECK (kind IN ('tier', 'custom')),
      CONSTRAINT tier_requests_status CHECK (status IN ('pending', 'approved', 'rejected')),
      -- A 'tier' request must name a tier; a 'custom' one must carry a reason.
      CONSTRAINT tier_requests_shape CHECK (
        (kind = 'tier'   AND requested_tier_id IS NOT NULL) OR
        (kind = 'custom' AND user_note IS NOT NULL)
      )
    );
  `);
  // At most one PENDING request per user — the DB enforces the "one open
  // request" rule so a double-submit can't stack duplicates.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tier_requests_one_pending_idx
      ON tier_requests (google_user_id) WHERE status = 'pending';
  `);
  // Admin queue: pending-first, newest-first.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS tier_requests_queue_idx
      ON tier_requests (status, created_at DESC);
  `);
  // A user's own request history.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS tier_requests_user_idx
      ON tier_requests (google_user_id, created_at DESC);
  `);
}

/**
 * The shape AesGcmTokenCodec.encode produces: `iv:tag:ciphertext`, three base64
 * parts. Google OAuth tokens ("ya29.a0Af...", "1//0gL...") never contain a
 * colon, so this cleanly separates encrypted rows from plaintext ones.
 */
const CIPHERTEXT_SHAPE = "^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$";

/**
 * Token Cutover: the one-time migration to encrypted-at-rest OAuth tokens.
 *
 * initSchema runs on EVERY boot, so this must be self-limiting — an
 * unconditional `UPDATE users SET access_token = NULL` would sign every user
 * out on every restart, forever. It is made self-limiting by predicate rather
 * than by bookkeeping: only rows whose tokens do NOT already have the
 * ciphertext shape are wiped. After the first run every surviving token matches
 * the pattern, so subsequent runs match zero rows.
 *
 * Chosen over a marker column (`token_encryption_version`) because the
 * predicate reads the actual data instead of a claim about it. A marker can
 * drift from reality: restore a plaintext backup and the marker still says
 * "already migrated", letting plaintext flow into decode() and throw for every
 * user with no obvious cause. This predicate re-wipes that backup correctly.
 *
 * Nulls BOTH token columns when EITHER fails the test — a row with an encrypted
 * access token but a plaintext refresh token is incoherent, and half-wiping it
 * would leave decode() throwing on the survivor.
 *
 * Consequence, accepted: every pre-cutover user must Reconnect once. They are
 * not signed out (sessions are independent of Google tokens) — /status reports
 * needsReconnect and the existing ReconnectPanel handles it.
 */
export async function wipePlaintextTokens(pool: Pool): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE users
        SET access_token = NULL, refresh_token = NULL, token_expiry = NULL, updated_at = now()
      WHERE (access_token  IS NOT NULL AND access_token  !~ $1)
         OR (refresh_token IS NOT NULL AND refresh_token !~ $1)`,
    [CIPHERTEXT_SHAPE]
  );
  if (rowCount && rowCount > 0) {
    console.warn(
      `[schema] Token Cutover: cleared plaintext tokens for ${rowCount} user(s); they must Reconnect Google once`
    );
  }
}

/**
 * Postgres may not accept connections the instant the backend container
 * starts (Docker healthchecks reduce but don't eliminate the race). Retry the
 * one-time schema init a few times before giving up, so `docker compose up`
 * doesn't need perfect ordering.
 */
export async function initSchemaWithRetry(
  pool: Pool,
  attempts = 10,
  delayMs = 1000
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await initSchema(pool);
      return;
    } catch (err) {
      lastError = err;
      console.warn(
        `initSchema attempt ${attempt}/${attempts} failed; retrying in ${delayMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
