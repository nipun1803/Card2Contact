# Users & Persistence — Design

Shared infrastructure (not a pipeline module) that makes the app multi-user and durable. Used by google-auth (login) and google-sheets (save).

## Data model — `users` (Postgres)

| Column | Notes |
|---|---|
| `google_user_id` | PK — the OAuth id_token `sub` |
| `email` | from the id_token |
| `spreadsheet_id` | the user's auto-created sheet (null until first login provisions it) |
| `access_token`, `refresh_token` | via the `TokenCodec` seam (plaintext now, encryptable later) |
| `token_expiry` | epoch ms |
| `saved_contacts_count` | incremented on each successful M5 save; surfaced via `/api/auth/google/status` |
| `created_at`, `updated_at`, `last_login_at` | audit timestamps (debugging only, not read by app logic) |

Schema is created idempotently at startup by `initSchemaWithRetry` (`shared/db/init.ts`); the pool lives in `shared/db/pool.ts`. There is deliberately **no header schema-version column** — header integrity is read-and-repair (see M5).

## UserStore (`shared/store/user-store.ts`)

The only inter-module contract for identity + tokens; routers depend on the interface, not on Postgres (tests inject a fake). Key methods: `findById`, `upsertOnLogin` (sets `last_login_at`, `COALESCE`s the refresh token so re-login never wipes it), `updateTokens`, `setSpreadsheetId`, `incrementSavedContactsCount` (called by M5 on each successful save), `clearTokens` (revoke recovery). `PgUserStore` runs tokens through the codec on write/read.

## TokenCodec seam (`shared/store/token-codec.ts`)

`encode`/`decode` around every token boundary. `IdentityTokenCodec` (pass-through) is wired today; `AesGcmTokenCodec` (AES-256-GCM, written + tested) is unwired. Encryption is a wiring decision in `index.ts` — no schema/store change. **Encryption is postponed; enable it before handling real user data.**

## Session (`shared/http/session.ts`, `require-auth.ts`)

Signed, httpOnly, `sameSite:"lax"` cookie holding `google_user_id` (`secure` only in production; lax so it survives the Google redirect). `createSessionMiddleware` resolves `req.auth` from the cookie (leaves it undefined if absent — M1–M4 stay public). `requireAuth` gates M5 only. Logout clears the cookie but keeps the refresh token.

## Wiring

`index.ts` builds the pool, runs `initSchema`, and constructs `PgUserStore(pool, new IdentityTokenCodec())`, injecting it into `createApp`. `createApp` adds `cookieParser(SESSION_SECRET)`, credentialed CORS, and the session middleware, and builds the `SheetsProvisioner` (closing over both modules) so google-auth can provision a sheet through a shared interface without importing google-sheets.
