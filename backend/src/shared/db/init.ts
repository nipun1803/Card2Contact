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
 * shared/store/token-codec.ts); they are plaintext today, encryptable later
 * with no schema change.
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
