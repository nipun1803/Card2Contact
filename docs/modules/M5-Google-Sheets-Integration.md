# M5 — Google Sheets Integration — Design

## 1. Purpose & scope

Saves the confirmed contact as a row in the user's own Google Sheet — the only durable Sheets write in the pipeline.
Does NOT: let the user pick/connect a different spreadsheet, or apply spreadsheet formatting/styling.

## 2. Audience & permissions

Multi-user. Each user signs in with Google (OAuth 2.0, scopes `openid email profile spreadsheets`) and is identified by their Google account id (`sub` from the verified id_token). A signed, httpOnly session cookie keeps them logged in. Every user gets their own auto-created spreadsheet; a user can only write to their own.

## 3. Entities (data model)

Persisted in Postgres (`users` table — see [Users-Persistence.md](./Users-Persistence.md)): `google_user_id`, `email`, `spreadsheet_id`, the OAuth token pair (through the `TokenCodec` seam; plaintext for now), `token_expiry`, and audit timestamps. The contact itself is still never stored server-side — it is passed from M4 straight into the append call.

## 4. Business rules

- Each user's contacts are written to that user's own fixed-schema spreadsheet (columns: Name, Phone, Email, Company, Address, Note, Category — `SHEET_HEADER`).
- The spreadsheet is auto-created with its header row on first login and reused for all future scans.
- Multi-value fields (Phone[], Address[]) join with `"; "`.
- **Header integrity**: before appending, row 1 is read and repaired if it no longer matches `SHEET_HEADER` (read-and-repair, no schema versioning).
- **Deleted-sheet recovery**: if the sheet is gone (404), a new one is auto-created, `spreadsheet_id` is updated, and the append is retried once.
- **Revoked access**: a revoked/expired refresh token surfaces as `401 { code: "REAUTH_REQUIRED" }` and the user's tokens are cleared, so the frontend prompts a reconnect instead of failing silently.

## 5. Endpoints

`GET /api/auth/google` — start (or re-)consent; 302 to Google. Reused for "reconnect".

`GET /api/auth/google/callback` — exchange code, verify id_token, upsert the user, auto-create their sheet on first login, set the session cookie, redirect to the frontend.

`GET /api/auth/google/status` — `{ authenticated, email?, needsReconnect? }`. `needsReconnect` is true when the row exists but tokens were cleared.

`POST /api/auth/logout` — clears the session cookie only; the Google refresh token is retained (not revoked) for frictionless re-login. `{ ok: true }`.

`POST /api/contacts/save` — requires an authenticated session; appends the confirmed contact to the current user's spreadsheet with the recovery behavior above. `{ cardId, saved: true }`, or `401 REAUTH_REQUIRED`, or a retryable error.

## 6. Inter-module contracts

- Depends on: confirmed contact for `cardId` from M4; the `UserStore` (identity + tokens + spreadsheet id); a `SheetsProvisioner` (shared interface) for sheet creation, supplied by the composition root so google-auth never imports google-sheets.
- Provides: nothing back into the pipeline — terminal step.

## Out of Scope

- User-selectable spreadsheets.
- Spreadsheet formatting or styling.

## Implementation Notes

- Row append uses `spreadsheets.values.append` with `valueInputOption: "RAW"`. Sheet creation uses `spreadsheets.create` (which cannot seed rows) followed by a `values.update` to write the header. `spreadsheets.values.get` reads row 1 for the integrity check.
- **Per-user auth**: `GoogleAuthService` is stateless — `handleCallback` verifies the id_token and returns identity + tokens; `authClientForUser` builds a fresh `OAuth2Client` from one user's stored tokens, persisting silent refreshes via `UserStore.updateTokens`.
- **Error classification**: `classifyGoogleError` (in `google-sheets.client.ts`) maps Google API failures to domain errors — 404 → `SheetNotFoundError` (recover), 401/`invalid_grant` → `ReauthRequiredError` (reconnect), else rethrow.
- Env vars: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `SESSION_SECRET`, `DATABASE_URL`. `GOOGLE_SHEETS_SPREADSHEET_ID` is no longer used (sheets are auto-created per user).
- Token encryption is postponed: tokens go through a pass-through `IdentityTokenCodec` today; enabling `AesGcmTokenCodec` (already written) is a one-line change in `index.ts` plus a `TOKEN_ENCRYPTION_KEY` env var.
- Implemented in `backend/src/modules/google-sheets/` (Sheets logic) and `backend/src/modules/google-auth/` (OAuth login flow), with shared persistence/session under `backend/src/shared/`.
