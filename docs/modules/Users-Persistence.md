# Users & Persistence — Design

Shared infrastructure (not a pipeline module) that makes the app multi-user and durable. Used by google-auth (login) and google-sheets (save).

## Data model — `users` (Postgres)

| Column | Type / constraint | Notes |
|---|---|---|
| `google_user_id` | `TEXT PRIMARY KEY` | the OAuth id_token `sub` |
| `email` | `TEXT NOT NULL` | from the id_token |
| `spreadsheet_id` | `TEXT` (nullable) | the user's auto-created sheet (null until first login provisions it) |
| `spreadsheet_url`, `spreadsheet_title` | `TEXT` (nullable) | stored, not derived — Recreate Sheet must update all three together, or a stale url would point at the sheet we just abandoned. Null for rows predating these columns; `PgUserStore` falls back to deriving the url from the id |
| `access_token`, `refresh_token` | `TEXT` (nullable) | AES-256-GCM ciphertext via the `TokenCodec` seam, stored as `iv:tag:ciphertext` |
| `token_expiry` | `BIGINT` (nullable) | epoch ms |
| `saved_contacts_count` | `INTEGER NOT NULL DEFAULT 0` | incremented on each successful M5 save; surfaced via `/api/auth/google/status` |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | audit timestamps (debugging only, not read by app logic) |
| `last_login_at` | `TIMESTAMPTZ` (nullable) | audit timestamp (debugging only) |

Schema is created idempotently at startup by `initSchemaWithRetry` (`shared/db/init.ts`) — up to 10 attempts, 1s apart, so the backend survives Postgres not being ready yet under `docker compose up`; the pool lives in `shared/db/pool.ts`. New columns arrive via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — additive guards, not destructive ones. There is deliberately **no header schema-version column** — header integrity is read-and-repair (see M5).

## Data model — `sessions` / `pending_sessions`

See ARCHITECTURE.md → *Sessions & single active session* for the reasoning. In
short: `sessions` holds one row per browser session (opaque 256-bit id, device /
browser / ip, `created_at` for the Absolute Lifetime, `last_activity_at` for the
Idle Timeout, `revoked_at` + `revoked_reason` as a soft delete);
`pending_sessions` stages a sign-in that hit a Session Conflict.

They are two tables rather than one with a status column so a Pending Session is
*structurally* incapable of authenticating a request — `findActive` reads
`sessions`, and a pending row simply is not there.

## UserStore (`shared/store/user-store.ts`)

The only inter-module contract for identity + tokens; routers depend on the interface, not on Postgres (tests inject a fake). Key methods: `findById`, `upsertOnLogin`, `updateTokens`, `setSpreadsheet` (id + url + title together), `incrementSavedContactsCount` (called by M5 on each successful save, atomic `UPDATE ... SET saved_contacts_count = saved_contacts_count + 1 ... RETURNING saved_contacts_count`), `clearTokens`. `PgUserStore` runs tokens through the codec on write/read.

`clearTokens` is called by the **M5 router** when Google rejects a refresh token (`invalid_grant`): it nulls the stored pair so `/status` reports `needsReconnect` and the dashboard shows the Reconnect prompt proactively, rather than the user only discovering the problem on their next save. The session deliberately survives — losing Google access is not losing your card2contact session. (Until this policy existed, nothing ever nulled tokens, so `needsReconnect` was permanently false and the prompt was unreachable.)

`upsertOnLogin` sets `last_login_at = now()` and `COALESCE`s the refresh token (`refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token)`), so a re-login that doesn't return a fresh refresh token (Google only issues one on first consent) never wipes the existing one. `updateTokens` uses the same `COALESCE` pattern.

`PgUserStore.dec()` catches decode failures and returns null rather than throwing. Post-cutover a decode failure means the key rotated or the row was tampered with — but throwing would escape into the session middleware and 500 *every* request, locking the user out with no way back in. Degrading to "no token" routes them to the existing Reconnect flow instead, which is what makes a wrong `TOKEN_ENCRYPTION_KEY` a recoverable mass-Reconnect rather than an outage (see ARCHITECTURE.md → *Rollback & recovery*).

## TokenCodec seam (`shared/store/token-codec.ts`)

`encode`/`decode` around every token boundary. **`AesGcmTokenCodec` is wired and mandatory** — `index.ts` refuses to start without `TOKEN_ENCRYPTION_KEY`. `IdentityTokenCodec` (pass-through) remains for tests. Which codec is used is a wiring decision in `index.ts`; no schema or store change is involved.

`AesGcmTokenCodec`: AES-256-GCM, a fresh random 12-byte IV per `encode` call, stored as `iv:tag:ciphertext` (each part base64). `decode` verifies the GCM auth tag before returning — a tampered or wrong-key payload throws rather than silently decrypting. `decodeEncryptionKey` accepts `TOKEN_ENCRYPTION_KEY` as 64 hex chars or base64, requiring exactly 32 decoded bytes. Note it validates *length*, not correctness: a wrong-but-well-formed key boots fine.

**Token Cutover** (`wipePlaintextTokens`, run at the end of `initSchema`): the one-time migration to encrypted-at-rest tokens. Since `initSchema` runs on every boot, it must be self-limiting — it wipes only rows whose tokens do *not* have the `iv:tag:ciphertext` shape (Google tokens never contain a colon), so after the first run it matches zero rows. A predicate rather than a marker column, because the predicate reads the actual data instead of a claim about it: a restored plaintext backup is re-wiped correctly, where a marker would say "already migrated" and let plaintext flow into `decode()`.

## Session (`shared/http/session.ts`, `require-auth.ts`)

Cookie `c2c_session`: signed, httpOnly, `sameSite:"lax"`, `secure` in production, `maxAge` = the 7-day Absolute Lifetime (so the browser drops the cookie exactly when the server stops honouring it). It holds an **opaque 256-bit session id** — never tokens, and never the `google_user_id` (which is what it held before server-side sessions, and which could not be revoked).

A second cookie `c2c_pending` (5-min) carries a Pending Session id through the Session Conflict prompt — that page has no Active Session by construction, so Continue/Cancel cannot authenticate the normal way.

`createSessionMiddleware` resolves `req.auth` (now including `sessionId`) and stays permissive for anonymous requests — no cookie, unknown id, expired session, and orphaned session all fall through with `req.auth` unset, so M1–M4 stay public. It rejects **exactly one** case: a signed cookie naming a *known-revoked* session → `SessionRevokedError`. That check cannot live in `requireAuth`; see ARCHITECTURE.md → *Cross-cutting error conventions*.

`requireAuth` (now `createRequireAuth(audit, metrics)`) gates M5 only. Logout revokes the session server-side — previously it only cleared the cookie, leaving the id valid forever — but still keeps the refresh token so signing in again is frictionless.

## Wiring

`index.ts` builds the pool, runs `initSchemaWithRetry` (which includes the Token Cutover, so plaintext is gone before any store can read it), constructs `PgUserStore(pool, new AesGcmTokenCodec(...))` and `PgSessionStore(pool)`, and injects both into `createApp` along with the stdout audit/metrics sinks. It also starts an hourly `purgeExpired` timer (`.unref()`d) — space reclamation only; `findActive` enforces expiry in SQL regardless.

`createApp` sets `trust proxy` **first**, then adds credentialed CORS, `cookieParser(SESSION_SECRET)` (validated ≥32 chars), the session middleware, the rate limiters, and builds the `SheetsProvisioner` (closing over both modules) so google-auth can provision a sheet through a shared interface without importing google-sheets.
