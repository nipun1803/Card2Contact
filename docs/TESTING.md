# Testing

This document describes the automated test architecture added to Card2Contact,
how to run each layer, and what each layer covers. Tests are **additive** — no
business logic was modified to make them pass.

## Layers & layout

```
backend/
  src/**/*.test.ts        # legacy co-located unit specs (pre-existing, kept)
  tests/
    unit/                 # service/util/store unit specs (Vitest)
    integration/          # supertest specs driving the real Express app
    fixtures/             # override-able factories (contacts, users, sessions, OCR samples)
    mocks/                # fake CardSessionStore / UserStore / SheetsClient / OcrClient
    helpers/              # env defaults (setupFile) + buildTestApp()
  vitest.config.ts        # includes both src/**/*.test.ts and tests/**
  tsconfig.test.json      # typechecks tests without touching the prod build

frontend/
  tests/
    unit/                 # utils, hooks, reducer, form-mapping, component (Vitest + RTL)
    integration/          # (reserved)
    e2e/                  # Playwright specs against the running stack
      .auth/user.json     # captured Google login (gitignored; created on demand)
    fixtures/             # contact / auth-status / file factories
    mocks/                # (reserved — api mocked inline per spec)
    utils/setup.ts        # jsdom polyfills (matchMedia, storage, object URL) + jest-dom
  vitest.config.ts        # jsdom env, @/* alias, coverage config
  playwright.config.ts    # chromium/firefox/webkit/mobile projects, baseURL :8080
  tsconfig.test.json
```

## Running

```bash
# Backend
cd backend
npm test                 # all unit + integration (Vitest)
npm run test:coverage    # + coverage report (text/html/lcov)
npm run typecheck:test   # typecheck the test tree

# Frontend
cd frontend
npm test                 # unit + component tests (Vitest + RTL, jsdom)
npm run test:coverage
npm run typecheck:test

# End-to-end (requires the Docker stack up: `docker compose up -d`)
npm run test:e2e                 # all browsers (chromium/firefox/webkit/mobile)
npm run test:e2e -- --project=chromium   # one browser
```

## What each layer covers

**Backend unit** — pure business rules with injected fakes:
M1 image-acquisition validation, M2 OCR merge (single/double, no-back), M3
`parseContactFromText` heuristics, M4 edit-merge + confirm rules, M5
`contactToRow` + save-recovery state machine, `classifyGoogleError` mapping,
`GoogleAuthService` (id_token verify, token mapping), `PgUserStore` (row mapping,
COALESCE refresh-token preservation), token codec, session middleware.

**Backend integration** (supertest, real Express app; Mistral/Google SDKs
mocked): the M1→M4 pipeline over HTTP, status codes and JSON shapes, the
cross-cutting error conventions (404/409/400/401), and the auth router
(consent redirect, callback + first-login provisioning, status, logout).

**Frontend unit** (Vitest + RTL, jsdom): `format`, `files` (graceful
downscale fallback), `recentScans` (localStorage read/write/parse-guard),
`featureFlags`, the `useCardPipeline` state machine (submit/confirm flows,
session-lost reset, reauth branch), and `ContactReviewForm` (the string[]↔
{value}[] mapping, name-required rule, field-array add/remove, a11y labels).

**E2E** (Playwright, real Docker stack via nginx :8080): landing → login,
route guards (protected → /login, unknown → /404), the Google sign-in link
target, mobile viewport / no-horizontal-scroll, and the API contract through
nginx (pipeline, auth status, 401 gate). Cross-browser: Chrome, Firefox,
WebKit/Safari, and a mobile viewport.

## Authenticated E2E (network-mocked, fully automated)

Google **blocks OAuth logins from automation-controlled browsers** ("this
browser or app may not be secure"), so a real Playwright-driven Google login is
not possible. Instead, the authenticated journey (dashboard → scan → review →
save → reconnect) mocks the backend API at the **network layer** —
`tests/e2e/mockApi.ts` intercepts `/api/auth/google/status`, the M1–M5 pipeline
endpoints, and `/api/contacts/save` with responses matching the real contract
(`src/shared/types/api.ts`). This is the Playwright equivalent of MSW and runs
with no human step:

```bash
cd frontend
npx playwright test authenticated-pipeline.spec.ts
```

`authenticated-pipeline.spec.ts` covers: dashboard loads for a signed-in user,
`/login`→dashboard bounce, the full upload→review→save→success flow, and the
REAUTH_REQUIRED → reconnect branch. To fake different states, pass options to
`mockBackend(page, { needsReconnect, saveReauthRequired, savedContactsCount })`.

An interactive `auth.setup.ts` (captures a real signed-in `storageState` via a
headed browser) is kept for manual local verification against a real Google
session, but is **not** part of the automated suite — see its header for the
one-off command. Because of Google's automation block it only works when a human
drives the login.

## Known-bug regression markers

Two confirmed defects are pinned by tests that assert the *current* (wrong)
behavior, each paired with a `.todo`/`.fixme` describing the correct expectation
to flip once fixed:

- **nginx 413** (`frontend/tests/e2e/api-contract.spec.ts`) — a ~1.5 MB upload
  is rejected with 413 through nginx (no `client_max_body_size`). Live-confirmed
  across all four browsers.
- **M3 phone cross-line bleed** (`backend/tests/unit/contact-extraction.service.test.ts`)
  — the phone regex includes `\s`, so a phone above an address bleeds the
  address's leading digit into the number.

See the audit report / project memory for the full confirmed-bug list; fixes are
deferred to a dedicated fix-pass (tests here are additive only).

## Coverage snapshot (at introduction)

- **Backend: ~86% statements, ~90% branch, ~94% funcs.** Uncovered: the DB
  layer (`db/init.ts`, `db/pool.ts` — exercised only by the live/Docker path)
  and the composition-root provisioner closure.
- **Frontend logic files: 80–100%** (`ContactReviewForm` 100%, `useCardPipeline`
  ~80%, `format`/`recentScans`/`featureFlags` ~92–94%). Overall line coverage
  reads low (~19%) only because the ~50 pure presentational components carry no
  branching logic and are covered structurally by the E2E run rather than unit
  tests.
