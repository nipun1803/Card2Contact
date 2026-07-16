# card2contact

Scan a business card → OCR → extract contact → review → save to the user's
Google Sheet. Pipeline: **M1 (image) → M2 (OCR) → M3 (extraction) → M4 (review) → M5 (Sheets)**.

`docs/` is the single source of truth for requirements — each module doc under
`docs/modules/` and `docs/ARCHITECTURE.md` (cross-cutting decisions) should be
read before changing that area. Do not duplicate their content here; this file
only covers what a coding agent needs before touching the repo.

## Stack

- Backend: Node.js + TypeScript + Express, modular monolith (`backend/src/modules/` = M1–M5 + google-auth + admin-auth + admin-users + admin-licenses + licensing; `backend/src/shared/` = cross-module contracts only). `admin-licenses` is the admin surface (behind `adminAuth`); `licensing` is the user's own "my plan" + upgrade-request surface at `/api/me/*` (behind `requireAuth`) — same stores, no shared auth path.
- Frontend: React + TypeScript (Vite), API-driven, no business logic — calls backend via `fetch` with `credentials: "include"`.
- Persistence: Postgres — `users` (identity, AES-encrypted OAuth tokens, per-user spreadsheet id/url/title), `sessions` / `pending_sessions` (single active session), `audit_log`, and the License Management tables `license_settings` / `scan_quotas` / `paid_grants` / `quota_consumptions` / `quota_ledger` / `tiers` / `tier_assignments` / `tier_requests`. Pipeline state (M1→M4) is in-memory only, keyed by `cardId`, and does not survive a restart — that's intentional.
- Infra: Docker Compose (nginx, backend, frontend, postgres).

## Module boundary rule

A module never imports another module's service/router directly. Cross-module
communication goes through shared interfaces in `backend/src/shared/`
(`CardSessionStore`, `UserStore`, `SessionStore`, `QuotaStore`,
`LicenseSettingsStore`, `TierStore`, `SheetsProvisioner`, `AuditLogger`,
`Metrics`). `app.ts` is the composition root that wires implementations in.
Scan-quota enforcement is a composed middleware (`createQuotaGuard`), mounted
onto the M2 route in `app.ts` — the pipeline modules import nothing
quota/tier-related.

## Terminology (use these exact words)

Security/session vocabulary is standardized — see the table in
`docs/ARCHITECTURE.md`. The short version: **Session Revocation** (umbrella),
**Session Replacement** (a new sign-in wins a **Session Conflict**), **Session
Termination** (logout), **Pending Session**, **Active Session**, **Idle
Timeout** (30d) vs **Absolute Lifetime** (7d, the binding one), **Recreate
Sheet**, **Reconnect** (always about *tokens*), **Token Cutover**. Never "kick",
"invalidate", "restore", or "re-auth". Audit event names match these terms.

Admin vocabulary is separate and equally fixed: **Admin** (the single operator
from `ADMIN_USERNAME` — never "superuser"/"root"/"staff") and **Admin Session**
(in-memory, 8h Absolute Lifetime, `admin_session` cookie — never "admin token").
An Admin Session is never an Active Session; they share no code path.

License/quota vocabulary is likewise fixed: **Scan** (one OCR run = one metered
unit), **Free pool** (a counter, no expiry) vs **Paid pool** (the sum of
non-expired **Grants**), **Grant** (one dated paid allowance with Active/Expired
status), **Override** (a per-user *free* limit; removing it resets to the global
default), **Consume** (draw one unit at OCR, free-first-then-paid), **Enforcement**
(the global hard-block toggle), **Scan-Block** (a scanning-only per-user block —
`403 SCAN_BLOCKED`, NOT the same as Revoke Access, which blocks login), **Tier**
(a named, admin-editable allowance preset), **Unlimited** (a per-tier flag →
per-user allow-always window; the `pool:"unlimited"` consume never decrements),
**Tier assignment** (snapshots the tier config as-of-now, so editing a tier only
affects future assignments), **Upgrade Request** (a user-filed *ask* for more
scans — a `tier` pick or a `custom` amount; it changes no quota until an admin
**Approves** or **Rejects** it, and approval flows through the same
`assignTier`/`grantPaid` seam — never a parallel grant path), **one pending
request per user** (a DB rule; a second is `409 REQUEST_ALREADY_PENDING`). Never
"credit", "subscription", or "token" for quota. See
`docs/modules/admin/LICENSE_MANAGEMENT.md`.

**Tier enforcement keys off config, never name.** The consume path and quota
guard read only `is_unlimited`/`scan_limit`/`validity_days` — never a tier's
`name`. This is what lets an admin create Custom tiers with zero code, and it is
a tested invariant (a grep for tier-name literals in the store/guard must stay
empty; `quota-store.test.ts` proves a custom unlimited tier is honored). Do not
introduce a `switch(tierName)` anywhere in enforcement.

"M5" is the requirement id (docs); `google-sheets` is the module id (code
paths). Both are correct in context — don't invent a third.

## Commands

```bash
# backend (needs DATABASE_URL to a running Postgres)
cd backend && npm run dev            # tsx watch
npm test                             # vitest, unit + integration
npm run test:unit / test:integration
npm run test:coverage
npm run typecheck                    # prod tsconfig
npm run typecheck:test               # separate tsconfig.test.json, doesn't touch prod rootDir:src

# frontend
cd frontend && npm run dev           # vite
npm test                             # vitest + RTL (jsdom)
npm run test:e2e                     # Playwright — needs `docker compose up -d` running against :8080
```

No ESLint in either project — typecheck is the only static gate. Full test
architecture is in `docs/TESTING.md`.

## Known-confirmed bugs — do not silently "fix" without asking

Deliberately left unfixed; regression markers pin current behavior. Flag if you
touch these, but don't fix opportunistically unless asked:

- **M3 phone regex bleeds across lines** — `[\d\s().-]{6,}` includes `\s`, so it can swallow a leading digit from the next line (e.g. address) into the phone number. M3 extraction is a known placeholder heuristic, not the final implementation.
- `ScanApp.tsx:90` passes `saving={false}` hardcoded to `ContactReviewForm` — submit loading/disable state never engages.

Fixed since the 2026-07 audit (do not re-report): nginx 413 (`client_max_body_size 10m`
in both configs) and the missing multer limit (`fileSize` in the M1 router); no
TLS (`nginx.prod.conf` terminates it, `docker-compose.prod.yml` + `frontend/Dockerfile`'s
`prod` target serve a real build); plaintext OAuth tokens (AES-256-GCM is wired
and mandatory). The dev compose file still uses the Vite `dev` target **by
design** — `prod` exists for `docker-compose.prod.yml`.

## Security invariants — don't break these without reading the docs

`docs/ARCHITECTURE.md` has the full Security Guarantees table, the audit field
policy, and the rollback plan. The ones easiest to break by accident:

- **`app.set("trust proxy", 1)` must stay `1` and stay first in `app.ts`.** `true` lets any client forge `X-Forwarded-For`, poisoning session/audit/rate-limit records.
- **`SessionRevokedError` is raised by the session middleware, not `requireAuth`.** `/status` is public and is what notices a revocation; moving the check would silently break the whole flow.
- **The trash check precedes the header check in `M5Service.save()`.** `readHeader` succeeds on a trashed sheet, so reversing the order makes the recovery dead code.
- **The Token Cutover wipe (`init.ts`) must stay self-limiting.** `initSchema` runs on every boot; an unconditional `UPDATE users SET access_token=NULL` would sign everyone out forever. It wipes only non-ciphertext-shaped tokens.
- **Never log tokens, emails, contact data, or full session ids.** Session ids are truncated at the sink (`StdoutAuditLogger`) so no call site can leak one.
- **`sameSite:"lax"` on the session cookie is required**, not incidental: `strict` would withhold it on the redirect back from Google and loop the user at `/login`.
- **The `/api/admin` early-return in `createSessionMiddleware` must stay.** Without it, a revoked *Google* session 401s the *admin* panel — the middleware is global and rejects revoked ids on every path. Confirmed by reproduction; pinned in both directions (deleting it fails, widening it to `/api` fails).
- **`req.adminAuth` must never be merged into `req.auth`.** `requireAuth` gates on `req.auth` and `createSaveLimiter`'s keyGenerator reads `req.auth?.googleUserId` — an admin populating it would authenticate M5 save. This is a privilege escalation.
- **The admin login must keep calling `bcrypt.compare` on a username miss.** The dummy-hash compare exists solely to burn identical time; `if (!usernameOk) return false` is faster, functionally identical, and silently reintroduces a user-enumeration timing oracle.
- **`sameSite:"strict"` on `admin_session` is correct** and must not be "unified" with the user cookie's `lax` — that `lax` is specific to the Google redirect landing, which admin login does not have.

## Working in this repo

- Camera capture requires a secure context (`localhost` or HTTPS).
- Credentials: `SESSION_SECRET` (≥32 chars), `TOKEN_ENCRYPTION_KEY` (**required** — backend exits at boot without it; `openssl rand -hex 32`), `MISTRAL_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `DATABASE_URL` — all via env vars, see `.env.example`. Never hardcode or commit real values.
  `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` (admin panel) are **optional and both-or-neither**: absent = the panel is disabled (routes 503, and every pre-existing deploy/test takes this path); exactly one set, or a non-bcrypt hash, is a deliberate boot error.
- Error convention (backend): `CardNotFoundError`→404, `PipelineOrderError`→409, `ValidationError`→400, `NotAuthenticatedError`→401, `SessionRevokedError`→401 with `{code:"SESSION_REVOKED"}`, `ReauthRequiredError`→401 with `{code:"REAUTH_REQUIRED"}`, `UserDisabledError`→403 with `{code:"USER_DISABLED"}`, `QuotaExceededError`→402 with `{code:"QUOTA_EXCEEDED"}`, `ScanBlockedError`→403 with `{code:"SCAN_BLOCKED"}`, `LicenseUserNotFoundError`→404 with `{code:"LICENSE_USER_NOT_FOUND"}`, `LicenseValidationError`→400 with `{code:"LICENSE_INVALID"}`, `TierNotFoundError`→404 with `{code:"TIER_NOT_FOUND"}`, `RequestValidationError`→400 with `{code:"REQUEST_INVALID"}`, `DuplicatePendingRequestError`→409 with `{code:"REQUEST_ALREADY_PENDING"}`. The 401s are matched specific-first; the two 403s (`USER_DISABLED` vs `SCAN_BLOCKED`) are distinguished by `code`, never by status — clients must branch on `code`. All handled once in `backend/src/shared/http/error-handler.ts`.
- **The scan pipeline now requires sign-in (License Management):** M1 `POST /api/cards` applies `requireAuth`, and M2 `POST /api/cards/:cardId/recognize` additionally passes the quota guard. M1–M4 are no longer anonymous — a cookieless upload is 401. Integration specs that drive the pipeline authenticate via `buildAuthedTestApp` (`tests/helpers/app.ts`), which seeds an active session and signs a `c2c_session` cookie. The quota guard meters exactly-once by `cardId`, so a retried `recognize` bills a scan only once.
- Rate limiters are **disabled when `NODE_ENV=test`** (`shared/http/rate-limit.ts`) — integration specs fire dozens of requests from one IP. `tests/unit/rate-limit.test.ts` enables them explicitly.
- The dev frontend container has **no bind mount** — it bakes `src/` in at build time. After changing frontend code, `docker compose up -d --build frontend` before running E2E, or you'll test stale code.
