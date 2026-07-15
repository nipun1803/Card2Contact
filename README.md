# card2contact

Scan a business card, review the extracted contact, and save it to your own
Google Sheet. A linear pipeline:

**M1 → M2 → M3 → M4 → M5**
(Image Acquisition → Text Recognition → Contact Extraction → Contact Review → Google Sheets)

The functional specification lives in [`docs/`](docs/); each module doc is the
single source of truth for that module. Cross-cutting decisions are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Stack

- **Backend** — Node.js + TypeScript + Express, a modular monolith
  (`backend/src/modules/` = M1–M5 + google-auth; `backend/src/shared/` = shared
  contracts). OCR via Mistral; Sheets via `googleapis` + `google-auth-library`.
- **Frontend** — React + TypeScript (Vite), API-driven, no business logic.
- **Persistence** — Postgres (`users` table) for multi-user identity, OAuth
  tokens, and each user's spreadsheet id.
- **Infra** — Docker Compose: nginx, backend, frontend, postgres.

## Flow

1. **Sign in with Google** (scopes `openid email profile spreadsheets`). On first
   login a dedicated spreadsheet is auto-created with the header row
   `Name | Phone | Email | Company | Address | Note | Category` and stored for you.
2. **Capture** a card — upload a file or use the camera (single- or double-sided).
3. OCR (Mistral) → contact **extraction** → **review & edit**.
4. **Save** — the confirmed contact is appended as a new row to your sheet; every
   later scan appends another row to the same sheet.

Resilience: if your sheet is deleted it is recreated automatically on the next
save; if Google access is revoked you're prompted to reconnect.

## Run (Docker)

```bash
cp .env.example .env
# fill in SESSION_SECRET, MISTRAL_API_KEY,
#         GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
docker compose up --build
```

- Full app (through nginx): <http://localhost:8080>
- Backend API directly: <http://localhost:4000>

Then open the app and click **Sign in with Google** — no spreadsheet id to
configure. (The camera capture needs a secure context: `localhost` or HTTPS.)

## Develop / test

```bash
# backend
cd backend && npm install && npm run dev     # needs DATABASE_URL to a running Postgres
npm test                                      # vitest (unit + integration)
npm run test:coverage                         # + coverage report
npm run typecheck

# frontend
cd frontend && npm install && npm run dev
npm test                                      # vitest + React Testing Library (jsdom)
npm run test:e2e                              # Playwright E2E (needs the Docker stack up)
```

Full test architecture, layers, and the interactive authenticated-E2E capture
are documented in [`docs/TESTING.md`](docs/TESTING.md).

## Notes

- OAuth token encryption at rest is scaffolded (`AesGcmTokenCodec`) but not yet
  wired — tokens are plaintext for now. Enable it before handling real user data
  (see [`docs/modules/Users-Persistence.md`](docs/modules/Users-Persistence.md)).
- Contact-field extraction (M3) is a heuristic placeholder intended to be
  swapped for an AI/NLP extractor.
- A full-codebase verification audit (2026-07) confirmed several bugs (e.g. an
  nginx `client_max_body_size` gap that 413s real camera photos, an M3 phone
  cross-line regex bleed) — see `docs/TESTING.md` and the audit report. Fixes are
  tracked separately; the test suite pins the current behavior with regression
  markers.
