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
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: number | null; // epoch ms (google-auth-library Credentials.expiry_date)
  /** Running total of contacts this user has saved (M5), tracked in Postgres. */
  savedContactsCount: number;
}

/** Tokens supplied at login / refresh time. */
export interface TokenSet {
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: number | null;
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
  /** Associate the user's auto-provisioned spreadsheet. */
  setSpreadsheetId(googleUserId: string, spreadsheetId: string): Promise<void>;
  /** Null out tokens (keep the row) when access is revoked/expired, so status can report needsReconnect. */
  clearTokens(googleUserId: string): Promise<void>;
  /** Atomically bump the running saved-contacts total by one; returns the new total. */
  incrementSavedContactsCount(googleUserId: string): Promise<number>;
}

interface UserRow {
  google_user_id: string;
  email: string;
  spreadsheet_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: string | null; // pg returns BIGINT as string
  saved_contacts_count: number;
}

export class PgUserStore implements UserStore {
  constructor(
    private readonly pool: Pool,
    private readonly codec: TokenCodec
  ) {}

  private toRecord(row: UserRow): UserRecord {
    return {
      googleUserId: row.google_user_id,
      email: row.email,
      spreadsheetId: row.spreadsheet_id,
      // Decode through the codec (pass-through today, decrypt once AES is wired).
      accessToken: row.access_token === null ? null : this.codec.decode(row.access_token),
      refreshToken: row.refresh_token === null ? null : this.codec.decode(row.refresh_token),
      tokenExpiry: row.token_expiry === null ? null : Number(row.token_expiry),
      savedContactsCount: row.saved_contacts_count,
    };
  }

  private enc(token: string | null): string | null {
    return token === null ? null : this.codec.encode(token);
  }

  async findById(googleUserId: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT google_user_id, email, spreadsheet_id, access_token, refresh_token, token_expiry, saved_contacts_count
         FROM users WHERE google_user_id = $1`,
      [googleUserId]
    );
    return rows.length ? this.toRecord(rows[0]) : null;
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
       RETURNING google_user_id, email, spreadsheet_id, access_token, refresh_token, token_expiry, saved_contacts_count`,
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

  async setSpreadsheetId(googleUserId: string, spreadsheetId: string): Promise<void> {
    await this.pool.query(
      `UPDATE users SET spreadsheet_id = $2, updated_at = now() WHERE google_user_id = $1`,
      [googleUserId, spreadsheetId]
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
}
