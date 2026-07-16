# card2contact

Scan a business card → OCR → extract contact → review → save to the user's
Google Sheet. Pipeline: **M1 (image) → M2 (OCR) → M3 (extraction) → M4 (review) → M5 (Sheets)**.

`docs/` is the single source of truth for requirements — each module doc under
`docs/modules/` and `docs/ARCHITECTURE.md` (cross-cutting decisions) should be
read before changing that area. Do not duplicate their content here; this file
only covers what a coding agent needs before touching the repo.

## Stack

- Backend: Node.js + TypeScript + Express, modular monolith (`backend/src/modules/` = M1–M5 + google-auth + admin-auth; `backend/src/shared/` = cross-module contracts only).
- Frontend: React + TypeScript (Vite), API-driven, no business logic — calls backend via `fetch` with `credentials: "include"`.
- Persistence: Postgres — `users` (identity, AES-encrypted OAuth tokens, per-user spreadsheet id/url/title) and `sessions` / `pending_sessions` (single active session). Pipeline state (M1→M4) is in-memory only, keyed by `cardId`, and does not survive a restart — that's intentional.
- Infra: Docker Compose (nginx, backend, frontend, postgres).

## Module boundary rule

A module never imports another module's service/router directly. Cross-module
communication goes through shared interfaces in `backend/src/shared/`
(`CardSessionStore`, `UserStore`, `SessionStore`, `SheetsProvisioner`,
`AuditLogger`, `Metrics`). `app.ts` is the composition root that wires
implementations in.

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
- Error convention (backend): `CardNotFoundError`→404, `PipelineOrderError`→409, `ValidationError`→400, `NotAuthenticatedError`→401, `SessionRevokedError`→401 with `{code:"SESSION_REVOKED"}`, `ReauthRequiredError`→401 with `{code:"REAUTH_REQUIRED"}`. The two 401s are matched specific-first. All handled once in `backend/src/shared/http/error-handler.ts`.
- Rate limiters are **disabled when `NODE_ENV=test`** (`shared/http/rate-limit.ts`) — integration specs fire dozens of requests from one IP. `tests/unit/rate-limit.test.ts` enables them explicitly.
- The dev frontend container has **no bind mount** — it bakes `src/` in at build time. After changing frontend code, `docker compose up -d --build frontend` before running E2E, or you'll test stale code.
