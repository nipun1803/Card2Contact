# card2contact

Scan a business card → OCR → extract contact → review → save to the user's
Google Sheet. Pipeline: **M1 (image) → M2 (OCR) → M3 (extraction) → M4 (review) → M5 (Sheets)**.

`docs/` is the single source of truth for requirements — each module doc under
`docs/modules/` and `docs/ARCHITECTURE.md` (cross-cutting decisions) should be
read before changing that area. Do not duplicate their content here; this file
only covers what a coding agent needs before touching the repo.

## Stack

- Backend: Node.js + TypeScript + Express, modular monolith (`backend/src/modules/` = M1–M5 + google-auth; `backend/src/shared/` = cross-module contracts only).
- Frontend: React + TypeScript (Vite), API-driven, no business logic — calls backend via `fetch` with `credentials: "include"`.
- Persistence: Postgres `users` table (identity, OAuth tokens, per-user spreadsheet id). Pipeline state (M1→M4) is in-memory only, keyed by `cardId`, and does not survive a restart — that's intentional.
- Infra: Docker Compose (nginx, backend, frontend, postgres).

## Module boundary rule

A module never imports another module's service/router directly. Cross-module
communication goes through shared interfaces in `backend/src/shared/`
(`CardSessionStore`, `UserStore`, `SheetsProvisioner`). `app.ts` is the
composition root that wires implementations in.

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

## Known-confirmed bugs (2026-07 audit) — do not silently "fix" without asking

These were deliberately left unfixed (a tests-only phase pinned current
behavior with regression markers). If work touches these areas, flag it but
don't fix opportunistically unless asked:

- **nginx 413 on real photos** — `nginx.conf` has no `client_max_body_size`; default 1MB rejects camera uploads through `:8080` (works fine hitting backend `:4000` directly). Multer also has no `fileSize` limit.
- **"Prod" frontend Docker runs the Vite dev server**, not a build — `frontend/Dockerfile` runs `npm run dev --host`. `frontend/dist` (`vite build`) works but is unused.
- **No TLS + forced `Secure` cookie** — `backend/Dockerfile` sets `NODE_ENV=production` → `session.ts` sets `secure:true`, but nothing terminates TLS. Fine on `localhost` (browser-exempt), breaks login on any real hostname.
- **M3 phone regex bleeds across lines** — `[\d\s().-]{6,}` includes `\s`, so it can swallow a leading digit from the next line (e.g. address) into the phone number. M3 extraction is a known placeholder heuristic, not the final implementation.
- `ScanApp.tsx` passes `saving={false}` hardcoded to `ContactReviewForm` — submit loading/disable state never engages.
- OAuth token encryption is scaffolded (`AesGcmTokenCodec`) but not wired — tokens are stored plaintext. Must be enabled before handling real user data.

Full list with file/line detail: ask for the audit notes rather than re-deriving from scratch.

## Working in this repo

- Not currently a git repository (`git init` if version control is wanted).
- Camera capture requires a secure context (`localhost` or HTTPS).
- Credentials: `SESSION_SECRET`, `MISTRAL_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `DATABASE_URL` — all via env vars, see `.env.example`. Never hardcode or commit real values.
- Error convention (backend): `CardNotFoundError`→404, `PipelineOrderError`→409, `ValidationError`→400, `NotAuthenticatedError`→401, `ReauthRequiredError`→401 with `{code:"REAUTH_REQUIRED"}` (triggers frontend reconnect prompt). All handled once in `backend/src/shared/http/error-handler.ts`.
