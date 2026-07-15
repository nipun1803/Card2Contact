# Architecture & Cross-Cutting Decisions

This document records implementation-level decisions that apply across modules,
filling gaps the module docs intentionally left unspecified (tech stack, session
storage, error conventions). Module-specific decisions live in each module's own
"Implementation Notes" section under `docs/modules/`.

## Structure

```
card2contact/
├── docs/                  # Single source of truth for requirements
├── backend/               # Node.js + TypeScript + Express modular monolith
│   └── src/
│       ├── shared/        # Cross-module contracts ONLY:
│       │                  #   types, stores (card-session, user), token-codec,
│       │                  #   db (pool/init), http (session, errors), sheets (provisioner)
│       └── modules/       # One folder per doc module:
│                          #   image-acquisition (M1), text-recognition (M2),
│                          #   contact-extraction (M3), contact-review (M4),
│                          #   google-sheets (M5) + google-auth (login)
├── frontend/              # React + TypeScript, API-driven, no business logic
└── (postgres via docker-compose — multi-user persistence)
```

## Tech stack

- **Backend**: Node.js, TypeScript, Express.
- **Frontend**: React + TypeScript (Vite), calls the backend only via `fetch` (with `credentials: "include"` so the session cookie rides along).
- **OCR provider**: Mistral (`@mistralai/mistralai`), per M2.
- **Sheets/auth**: `googleapis` + `google-auth-library`, per M5.
- **Persistence**: Postgres (`pg`) for the multi-user `users` table; session cookies via `cookie-parser`. Unit tests via `vitest`.

## Module boundary rule

Each module folder under `backend/src/modules/` is named for what it does
(`image-acquisition`, `text-recognition`, `contact-extraction`,
`contact-review`, `google-sheets` — mapping 1:1 to M1–M5) and exposes a
`<name>.service.ts` (business rules) and `<name>.router.ts` (HTTP wiring); a
module with an external provider also gets a `<name>.client.ts` isolating that
SDK (`text-recognition.client.ts` for Mistral, `google-sheets.client.ts` for
Google Sheets). A module never imports another module's service or router
directly — the inter-module contracts are the shared `CardSessionStore`,
`UserStore`, and `SheetsProvisioner` interfaces in `backend/src/shared/`. The
`SheetsProvisioner` interface exists specifically so google-auth can provision a
user's sheet without importing google-sheets; `app.ts` (the composition root)
supplies the implementation.

## Session state (M1 → M4 handoff)

The docs describe card/image/text/contact state as held "in-session," with no
database anywhere except the final Google Sheets write (M5). This is
implemented as a single process-wide in-memory store:

- `backend/src/shared/types/card-session.ts` — the `CardSession` record shape.
  Each field is commented with which module owns it.
- `backend/src/shared/store/card-session-store.ts` — `CardSessionStore`
  interface + `InMemoryCardSessionStore` implementation, keyed by `cardId`.
  This is the only way modules read or write pipeline state.
- Card/OCR/contact state does not survive a server restart — acceptable, as it
  is transient per-scan working state.

**Durable state (multi-user).** User identity, OAuth tokens, and each user's
spreadsheet id ARE persisted, in Postgres (`users` table), so login and the
per-user sheet survive restarts. See
[docs/modules/Users-Persistence.md](./modules/Users-Persistence.md) for the
`UserStore`, the `TokenCodec` seam (token encryption postponed), and the signed
httpOnly session cookie that identifies the current user.

## cardId

Generated as a v4 UUID (`crypto.randomUUID()`) by M1 when a card is submitted.
Not specified by the docs; chosen because it's collision-safe without a
database-backed sequence.

## Cross-cutting error conventions

Defined once in `backend/src/shared/http/` and reused by every module's router:

- Unknown `cardId` → `CardNotFoundError` → **404**.
- Endpoint called before its documented prerequisite step ran (e.g. `/extract`
  before `/recognize`) → `PipelineOrderError` → **409**, naming the missing step.
- Business-rule violation (e.g. confirming with an empty Name) → `ValidationError`
  → **400**.
- Save attempted without an active session → `NotAuthenticatedError` → **401**.
- Google access revoked/expired mid-use → `ReauthRequiredError` → **401** with
  `{ code: "REAUTH_REQUIRED" }`, so the frontend prompts a reconnect rather than
  failing silently.

All are caught once by `backend/src/shared/http/error-handler.ts`,
registered as Express error-handling middleware in `app.ts`.

## Credentials

All external service credentials are read from environment variables, never
hardcoded or committed:

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | persistence | Postgres connection string (multi-user `users` table) |
| `SESSION_SECRET` | session | Signs the httpOnly session cookie |
| `MISTRAL_API_KEY` | M2 | Mistral OCR API key |
| `GOOGLE_OAUTH_CLIENT_ID` | M5 | OAuth Web Client ID (Google Cloud Console → Credentials) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | M5 | OAuth Web Client secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | M5 | Must exactly match a redirect URI registered on the OAuth client |
| `PORT` | app entrypoint | Backend HTTP port (defaults to 4000) |

`GOOGLE_SHEETS_SPREADSHEET_ID` is **removed** — each user's spreadsheet is
auto-created on first login and stored per user. `TOKEN_ENCRYPTION_KEY` is not
used yet (token encryption postponed; see Users-Persistence.md).

M5 uses **OAuth 2.0** (interactive login) rather than a service account. Each
user's token pair is now persisted per user in Postgres (through the
`TokenCodec` seam), not held in memory — see M5's own doc and
Users-Persistence.md for the login flow, the session cookie, and the
auto-created per-user spreadsheet.

## Feature flags (frontend)

The frontend gates a handful of UI capabilities behind build-time feature flags
so a capability can be disabled without code changes. Each flag defaults to
**enabled** and is turned off by setting the corresponding `VITE_FLAG_*` env var
to `false` (or `0`) at build time.

| Flag | Env var | Gates |
|---|---|---|
| `camera` | `VITE_FLAG_CAMERA` | In-browser camera capture |
| `upload` | `VITE_FLAG_UPLOAD` | File-upload dropzone |
| `googleOAuth` | `VITE_FLAG_GOOGLE_OAUTH` | The Google sign-in button (Login page) |
| `darkMode` | `VITE_FLAG_DARK_MODE` | Theme toggle / dark theme |
| `animations` | `VITE_FLAG_ANIMATIONS` | framer-motion transitions |
| `recentScans` | `VITE_FLAG_RECENT_SCANS` | The dashboard "recent scans" history |

Implemented in `frontend/src/shared/lib/featureFlags.ts` and read declaratively
through the `useFeatureFlag` hook. Since the values are read from
`import.meta.env` they are baked in at `vite build` time, not runtime-toggleable.

## Testing

Automated tests span three layers — Vitest unit specs (backend + frontend),
supertest integration specs against the real Express app, and Playwright E2E
against the running Docker stack (cross-browser). Layout, run commands, coverage,
and the interactive authenticated-E2E capture are documented in
[docs/TESTING.md](./TESTING.md). Neither project ships an ESLint config yet;
`typecheck` (and `typecheck:test`) are the current static-analysis gates.

## Images between M1 and M2

Uploaded images are parsed via `multer` memory storage (never written to
disk) and held as raw `Buffer`s on the `CardSession` record, matching the
docs' "in-memory/session" framing literally.

## Docker topology

Four containers, orchestrated by the root `docker-compose.yml`: nginx, backend,
frontend, and **postgres**. The three web services are reachable directly from
the host (useful for debugging) as well as through nginx's reverse proxy;
postgres is internal:

```
  host:8080 ──▶ nginx (reverse proxy) ──┬──▶ /api/*  ──▶ backend  (also host:4000) ──▶ postgres
                                        └──▶ /       ──▶ frontend (also host:5173)
```

- **nginx** uses the stock `nginx:1.27-alpine` image (no custom Dockerfile) —
  the root `nginx.conf` is bind-mounted read-only into the container. It
  reverse-proxies `/api/*` to the `backend` service and everything else
  (including Vite's HMR WebSocket) to the `frontend` service. Host port
  defaults to 8080 (`NGINX_PORT` in `.env`, since port 80 is commonly already
  in use on a dev machine); the internal proxied port is always 80.
- **backend** (`backend/Dockerfile`) is a 3-stage build: install deps → `tsc`
  build → production-only image running compiled `dist/index.js`. No
  devDependencies (including `typescript`/`tsx`) ship in the final image.
  Also published directly on host port 4000 (`BACKEND_PORT`).
- **frontend** (`frontend/Dockerfile`) runs `vite --host` directly (not a
  static build) — matches how the frontend already runs outside Docker, with
  hot reload preserved. `frontend/vite.config.ts`'s own `/api` proxy was
  removed since nginx now owns that routing; the Vite dev server no longer
  needs to know the backend exists. Also published directly on host port 5173
  (`FRONTEND_PORT`).
- **postgres** uses the stock `postgres:16-alpine` image with a named volume
  `pgdata` for durability and a `pg_isready` healthcheck; the backend
  `depends_on` it with `condition: service_healthy`, and `initSchemaWithRetry`
  additionally retries in case the DB isn't ready the instant the backend starts.
  It is not published to the host.
- **Google OAuth credentials** (`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`/`_REDIRECT_URI`)
  are passed as plain environment variables (no file to mount) — see M5's
  module doc for the login flow and where to get these from Google Cloud
  Console. The OAuth redirect URI intentionally points at the backend's own
  published port (`http://localhost:4000/api/auth/google/callback`) rather
  than through nginx, matching what's registered on the OAuth client.

Usage: `cp .env.example .env`, fill in `SESSION_SECRET`, `MISTRAL_API_KEY`,
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, then
`docker compose up --build`. Open the app and click **Sign in with Google** —
the user's spreadsheet is created automatically on first login; no spreadsheet
id to configure.
- Full app (through nginx): `http://localhost:8080`
- Backend API directly: `http://localhost:4000`
- Frontend dev server directly: `http://localhost:5173`

(Port numbers above are the defaults; override via `NGINX_PORT`,
`BACKEND_PORT`, `FRONTEND_PORT` in `.env` if any collide with something
already running on your machine.)
