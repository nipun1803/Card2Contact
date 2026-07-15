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

  await wipePlaintextTokens(pool);
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
