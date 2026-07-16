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
      admin/              # admin config / service / session store / guard / admin-users service + PgAuditLogger
    integration/          # supertest specs driving the real Express app
      admin/              # admin auth over HTTP + admin-vs-user isolation + admin-users router
      google-auth/         # disabled-user OAuth callback gate
      google-sheets/        # disabled-user M5 save gate
    fixtures/             # override-able factories (contacts, users, sessions, OCR samples)
    mocks/                # fake CardSessionStore / UserStore / SheetsClient / OcrClient
    helpers/              # env defaults (setupFile) + buildTestApp()
  vitest.config.ts        # includes both src/**/*.test.ts and tests/**
  tsconfig.test.json      # typechecks tests without touching the prod build

frontend/
  tests/
    unit/                 # utils, hooks, reducer, form-mapping, component (Vitest + RTL)
      admin/              # admin login page, admin guard, useAdminAuth, useAdminUsers,
                           # AdminUsers/AdminUserDetail pages, DataTable/Pagination/StatusBadge
    integration/          # (reserved)
    e2e/                  # Playwright specs against the running stack
      admin-users.spec.ts  # User Directory + User Details, account management actions
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
`contactToRow` + the save-recovery state machine (trashed → Recreate Sheet, and
the ordering that keeps it live), `classifyGoogleError` mapping, `isTrashed`'s
Drive call, `GoogleAuthService` (id_token verify, token mapping), `PgUserStore`
(row mapping, COALESCE refresh-token preservation, AES round-trip, decode
resilience), token codec, `PgSessionStore` + the in-memory session fake (both
lifetime bounds; expiry ≠ revocation), the Token Cutover wipe's idempotency, the
session middleware's single rejection path, the User-Agent parser, the audit
logger's session-id truncation, the metrics registry, and the rate limiters.

Admin (`tests/unit/admin/`): `resolveAdminConfig`'s boot gate (both-or-neither,
and a plaintext `ADMIN_PASSWORD_HASH` refusing to start), `AdminAuthService`
(exact-match username, the constant-work bcrypt compare, session issue/revoke),
`InMemoryAdminSessionStore` (the 8h Absolute Lifetime, no sliding renewal, and
that correctness never depends on the purge timer), and the `adminAuth` guard
(every failure generic, `req.auth` never populated).

Admin User Management (`tests/unit/admin/`, `tests/unit/user-store.test.ts`):
`PgUserStore.list/stats/disable/restore` (search/filter/sort/cursor-pagination
SQL, idempotent disable via `COALESCE`, stats counts including `totalScans`
as `SUM(saved_contacts_count)` — and that it comes back `0`, not `NaN`/`null`,
when the `users` table is empty), `AdminUserService` (disable→revokeAllForUser
call order, no noisy `admin_user_sessions_revoked` log when there was no
active session, force-logout leaves `disabledAt` untouched, `getDetail`'s
`activeSession: null` case), and `PgAuditLogger` (the `audit_log` INSERT,
session-id truncation, a rejected insert never throwing synchronously, cursor
pagination on `query()`).

**Backend integration** (supertest, real Express app; Mistral/Google SDKs
mocked): the M1→M4 pipeline over HTTP, status codes and JSON shapes, the
cross-cutting error conventions (404/409/400/401), the auth router (consent
redirect, callback + first-login provisioning, status, Session Termination), the
Session Conflict flow (conflict → pending, Continue → Session Replacement,
Cancel, double-Continue atomicity), a revoked session 401ing on public *and*
guarded routes while anonymous requests still pass, and the refresh-token
failure policy (tokens nulled, session survives, `needsReconnect` flips).

Admin (`tests/integration/admin/`): the login/me/logout flow with real signed
cookies (flags asserted: HttpOnly, SameSite=Strict, Path=/, Max-Age=28800,
Secure only in production), every credential failure proven byte-identical,
table-driven input validation, logout idempotency, the unconfigured→503 surface,
the audit/metrics contract, and — most importantly — `admin-isolation.test.ts`.

Admin User Management (`tests/integration/admin/admin-users.test.ts`): every
`/api/admin/users*` route unauthenticated → 401, the `{data, meta}` envelope
shape on an empty and a populated list, search params passed through to the
store, disable/restore/force-logout end to end (session revocation, audit
entries, 404 on an unknown user), and that no response ever serializes
`accessToken`/`refreshToken`. Force Logout has its own effect-level proof
(not just "was `revokeAllForUser` called"): a real seeded session's
`findActive`/`findActiveForUser` genuinely flips from present to `null` after
the request — the same contract the session middleware relies on — and a
second user's session is provably untouched by another user's force-logout,
guarding against a `WHERE` clause that scoped too broadly. The disabled-user
enforcement gate is covered separately end to end:
`tests/integration/google-auth/disabled-user.test.ts`
(a disabled user's OAuth callback gets 403 `USER_DISABLED`, no session
cookie, `auth_failure{reason:"user_disabled"}` logged; an active user's
callback is unaffected) and
`tests/integration/google-sheets/disabled-user-save.test.ts` (a user disabled
mid-session gets 403 `USER_DISABLED` on `POST /api/contacts/save`).

**Frontend unit** (Vitest + RTL, jsdom): `format`, `files` (graceful
downscale fallback), `recentScans` (localStorage read/write/parse-guard),
`featureFlags`, the `useCardPipeline` state machine (submit/confirm flows,
session-lost reset, reauth branch), `ContactReviewForm` (the string[]↔
{value}[] mapping, name-required rule, field-array add/remove, a11y labels),
the API client's 401 classification (REAUTH_REQUIRED vs SESSION_REVOKED vs
bare — plus the admin codes, which must classify as a plain ApiError and never
as a Session Revocation), the route guards' revoked-session redirect + toast, and
the Session Conflict page. Admin (`tests/unit/admin/`): the login form
(show/hide toggle, loading, and a distinct message for each of 401/429/network/
503), the admin guard's four states, and `useAdminAuth`'s query-key isolation.
Admin User Management: `useAdminUsers`'s query-key composition and mutation
invalidation (disable/restore/force-logout each invalidate the users list,
the affected user's detail, AND their audit history — a dedicated test
verifies this on a real `QueryClient`, not just a spied call: a mounted
`useAdminUserAudit` genuinely refetches and picks up the new entry after
`forceLogout()` resolves, which is the exact regression that made Force
Logout look like a dead button when the audit invalidation was missing),
the `AdminUsers` page (stat cards
including the app-wide "Total Scans" tile, table rows labeled "Total Scans"
rather than the legacy "Saved Contacts" wording, search debounce, status
filter, empty/error states), the `AdminUserDetail` page (profile/session/
spreadsheet sections — the spreadsheet card shows only the title, never a
link to the sheet — Revoke/Restore/Force-Logout confirm dialogs with **no**
reason/note input, asserted explicitly since the decision was deliberate, and
that a failed mutation surfaces its error inline and keeps the dialog open
rather than closing silently), and the `DataTable`/`Pagination`/`StatusBadge`
components in isolation (sort-callback firing, page-boundary button
disabling, badge variant mapping).

**E2E** (Playwright, real Docker stack via nginx :8080): landing → login,
route guards (protected → /login, unknown → /404), the Google sign-in link
target, mobile viewport / no-horizontal-scroll, the API contract through nginx
(pipeline, auth status, 401 gate, upload size limits), the Session Conflict
page, and the revoked device. Admin (`admin.spec.ts`): the login page renders for
an anonymous visitor AND for a signed-in Google user (the `PublicOnly` trap), the
show/hide toggle in a real browser, the login→dashboard→logout journey, and the
dashboard bouncing both anonymous visitors and non-admin Google users.
`api-contract.spec.ts` additionally proves nginx proxies `/api/admin/*` to the
app as JSON rather than an HTML error page. Cross-browser: Chrome, Firefox,
WebKit/Safari, and a mobile viewport.

Admin User Management (`admin-users.spec.ts`): the User Directory renders
seeded users and summary stats — including the app-wide "Total Scans" tile
(a real sum across the seeded users, not a hardcoded value) — search and the
status filter narrow the list, a row click navigates to User Details, and
the page stays free of horizontal scroll on a 375px viewport. The directory
never renders the legacy "Saved Contacts" wording. User Details:
profile/session/audit sections render (profile shows "Total scans," never a
link to the user's spreadsheet), Revoke Access flips the status badge to
Revoked and back via Restore Access, Force Logout succeeds without touching
the status badge, Force Logout's effect shows up in Audit History in the
same page load with no manual refresh (the real bug this test exists for —
without invalidating the audit query on success, the panel kept showing "No
audit history" after a successful action, making the button look dead), and
a failing Force Logout request keeps the confirm dialog open and shows the
error inline instead of the dialog silently sitting there with no feedback.
`mockApi.ts`'s admin audit route is stateful (tracks a real per-user log
appended to by disable/restore/force-logout) precisely so this round-trip is
provable rather than asserted against a route that always returns empty. All
mocked at the network layer via `mockApi.ts`'s `adminUsers`/
`adminForceLogoutFails` options — same technique as the authenticated
pipeline E2E below.

> **Before running E2E after a frontend change:** the dev frontend container has
> no bind mount — it bakes `src/` in at build time. Run
> `docker compose up -d --build frontend` first, or you will test stale code
> (symptom: your new route 404s).

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

- **M3 phone cross-line bleed** (`backend/tests/unit/contact-extraction.service.test.ts`)
  — the phone regex includes `\s`, so a phone above an address bleeds the
  address's leading digit into the number. Pinned as current (wrong) behavior
  with a `.todo` describing the correct expectation to flip once fixed.

The nginx 413 marker is **retired** — the bug is fixed (`client_max_body_size 10m`
in both nginx configs, plus multer's own `fileSize` limit), and
`api-contract.spec.ts` now asserts the correct behavior in both directions: a
~1.5 MB photo passes, an over-10 MB upload is rejected at the edge.

## Security & session testing

The security work (encryption at rest, single active session, audit, rate
limiting, trash recovery) is covered at every layer. A few conventions worth
knowing before adding to it:

- **Rate limiters are disabled when `NODE_ENV=test`** (`shared/http/rate-limit.ts`),
  since integration specs fire dozens of requests from one fake IP.
  `tests/unit/rate-limit.test.ts` re-enables them explicitly — it is the only
  suite that should.
- **`makeSessionStore()`** (`tests/mocks/stores.ts`) is a *working* in-memory
  fake, not `vi.fn()` stubs — session tests drive multi-step flows (sign in →
  conflict → continue → old device revoked) where stubs would force every test
  to re-specify the state machine. It reimplements the Active predicate that
  `PgSessionStore` expresses in SQL, so `tests/unit/session-store-fake.test.ts`
  tests the fake itself: a bug there would silently invalidate every
  integration suite. Its `_setNow()` ages sessions without sleeping.
- **Where the lifetime bounds are actually proven:** `PgSessionStore`'s own
  tests can only assert that the right bounds are *bound as parameters* — the
  time logic runs inside Postgres. The behavioural proof (a 6-day session lives,
  a 7-day one dies even with fresh activity) lives in the fake's tests.
- **Integration specs sign in through the real callback** rather than
  hand-crafting a cookie. A forged cookie would be rejected by the signature
  check, not by revocation, and the `SESSION_REVOKED` assertions would pass for
  the wrong reason.
- **`tests/unit/init-schema.test.ts`** is the highest-value suite here: it pins
  that running `initSchema` twice leaves already-encrypted tokens untouched. A
  regression there would sign every user out on every restart, forever. It
  evaluates the real predicate against real `AesGcmTokenCodec` output rather
  than asserting on SQL strings, so a wrong regex actually fails it.
- **The audit field policy is enforced by test**, not just convention —
  `tests/integration/auth.test.ts` asserts no entry ever contains a token, an
  email, or a full session id.
- **E2E** (`frontend/tests/e2e/session.spec.ts`) covers the Session Conflict
  page and the revoked device via `mockApi.ts`'s `sessionRevoked` /
  `continueFails` options. As with all authenticated E2E, the OAuth round-trip
  itself is out of scope (Google blocks automation-controlled browsers).
- **The revoked-session message depends on WHY it was revoked, and this is
  tested, not just implemented.** `tests/integration/session-revoked.test.ts`
  asserts a `"user_revoked"` reason gets "ended by an administrator" — never
  "another device" — and that `"logout"`/`"replaced_by_new_login"` are
  unaffected. `tests/unit/session-store.test.ts`'s
  `PgSessionStore.getRevokedReason` tests pin the SQL shape (only
  `revoked_at IS NOT NULL`, never the lifetime bounds — same discipline as
  `isRevoked`) separately from the message-selection logic, which lives
  entirely in `SessionRevokedError`'s constructor.
- **bfcache-restore reload** (`frontend/tests/unit/bfcache-reload.test.ts`):
  imports `main.tsx` in isolation (mocking `react-dom/client` and `App` so it
  doesn't need a real DOM tree) and fires a synthetic `pageshow` event with
  `persisted: true`, asserting `location.reload()` fires — and does NOT fire
  for a normal `persisted: false` load. This is the regression test for a
  real reported bug: a user who'd visited `/admin/login` in a tab, then
  signed in via Google OAuth in the same tab, could hit the browser Back
  button and have a frozen `/admin/login` render restored from bfcache with
  no route guard re-evaluating against their actual (now-authenticated)
  state.

### Admin authentication

- **`tests/integration/admin/admin-isolation.test.ts` is the highest-value admin
  suite.** Admin and Google auth are two identity systems sharing one app, one
  cookie parser, and one signing secret; a regression that lets either
  authenticate the other's routes is a **privilege escalation**, not a bug. It is
  prevented by three independent choices (distinct cookie name, distinct store,
  distinct request property), any of which a refactor could quietly undo. Both
  sessions are minted through the REAL routes — a forged cookie would fail on its
  signature rather than the check under test, and pass for the wrong reason.
- **X9 is a regression test for a confirmed bug**, not a hypothetical: because
  `createSessionMiddleware` is global and rejects revoked sessions on every path,
  a revoked *Google* session used to 401 the *admin* panel. The `/api/admin`
  early-return fixes it, and `tests/unit/session-middleware.test.ts` pins both
  directions — deleting the guard fails, and so does widening it to all of `/api`.
- **The no-timing-oracle property is asserted STRUCTURALLY**, by spying on
  `bcrypt.compare`'s call count, never by wall-clock. A timing assertion is flaky
  under CI load, and a flaky security test gets skipped — which is worse than no
  test. The refactor it guards against (`if (!usernameOk) return false` before the
  compare) is functionally identical, faster, and silently reopens user
  enumeration; the call-count assertion is what makes it loud.
- **The admin login limiter is 5/15min** (tighter than OAuth's 10 — a password
  endpoint with a guessable username) and, like every limiter, is disabled under
  `NODE_ENV=test`; `tests/unit/rate-limit.test.ts` enables it explicitly. That
  suite also pins the deliberate asymmetry that a 429 audits as
  `auth_failure{rate_limited}` rather than `admin_auth_failure`, so it reads as a
  decision rather than a bug.
- **`tests/helpers/env.ts` deliberately does NOT set `ADMIN_*`.** Admin config is
  opt-in, so the unconfigured→503 path is what the rest of the suite exercises by
  default — and a global default would invent a live admin credential across
  specs that have nothing to do with admin. The admin integration specs set the
  vars per-file and generate the bcrypt hash at runtime (cost 4, for speed): a
  committed `$2b$` literal would trip the gitleaks CI job.
- **A third fake-vs-real convention.** `InMemoryAdminSessionStore` is the
  PRODUCTION store and is already in-memory with a `_setNow()` seam, so tests
  inject the real thing rather than a fake. Where `makeSessionStore()` exists
  because the real predicate runs inside Postgres, there is nothing here worth
  faking — a fake would only be a second implementation to keep in sync.

### Admin — User Management

- **`tests/integration/admin/admin-users.test.ts` follows the same
  authenticate-through-the-real-route convention** as `admin-isolation.test.ts`
  — an admin session is minted via the real `POST /api/admin/auth/login`, not
  hand-crafted, so a signature failure can't masquerade as the check under
  test.
- **The disabled-user gate is proven at both enforcement points, end to end,
  in separate integration suites**: `tests/integration/google-auth/
  disabled-user.test.ts` (the OAuth callback) and `tests/integration/
  google-sheets/disabled-user-save.test.ts` (the M5 save route). Kept
  separate from `admin-users.test.ts` because they exercise a *different*
  router's behavior (the consequence of being disabled, not the admin action
  that disables) — folding them in would blur which router a failure
  actually points at.
- **`AdminUserService`'s unit tests assert call *order*, not just call
  presence** — `users.disable()` must run before
  `sessions.revokeAllForUser()`, so a concurrent OAuth callback that reads the
  user row after the disable call sees `disabledAt` set even if the session
  revoke hasn't completed yet. A reordering that broke this invariant would
  still pass a test that only checked "both were called."
- **No reason/note field is asserted as an explicit absence**, not just an
  unremarked omission — `AdminUserDetail.test.tsx` asserts
  `queryByRole("textbox")` is null inside the confirm dialog, since the
  decision not to add free-text capture (see USER_MANAGEMENT.md) is easy to
  accidentally reverse in a future edit without a test catching it.
- **The admin nav header's mobile-viewport wrap was caught by E2E, not unit
  tests** — `admin-users.spec.ts`'s "no horizontal scroll" check on a 375px
  viewport found a real overflow bug in the first draft of the nav (a
  non-wrapping flex row), which no component-level test would have caught
  since RTL/jsdom doesn't lay out CSS.

## CI: what the audit gate checks

`backend-audit` and `frontend-audit` run `npm audit --omit=dev --audit-level=high`
— **production dependencies only**, deliberately.

The gate exists to protect the deployed artifact, and the Docker image installs
exactly that set (`npm ci --omit=dev`). Auditing devDependencies made the job fail
on advisories that cannot reach production — the vitest UI server (we never run
`--ui`), vite's dev-server, Windows-only path handling — while telling us nothing
about what ships.

This is a scoping decision, not a suppression: those advisories are real for a
developer running a dev server on a hostile network. The only fix is vitest
2 → 4, and a sandboxed dry-run (documented in full, with the exact failure
mode, in `docs/VITEST-UPGRADE-PLAN.md`) confirms it currently breaks 68
existing tests — every `admin-isolation.test.ts` case that signs in through
the real Google callback, via `vi.mock("google-auth-library")`'s
mocking/spy-restore semantics changing under vitest 4. That upgrade is worth
doing on its own — see the linked plan for the target versions, the full
breaking-change audit against this repo's actual `vitest.config.ts` files,
and the recommended sequencing — and `npm audit` (unscoped) locally is how to
see what it would address today.

## Docker image scanning (Trivy)

`docker-build-backend`/`docker-build-frontend` in
`.github/workflows/pr-validation.yml` build the production runtime image for
each service and scan it with Trivy (`severity: HIGH,CRITICAL`,
`exit-code: "1"`) — a HIGH/CRITICAL finding fails the PR, it doesn't just
warn. As of the last hardening pass both images scan clean. See
`docs/ARCHITECTURE.md` → *Container hardening* for what changed (base image
patch strategy, npm/curl removed from runtime images, the `multer` upgrade)
and the one documented remaining accepted-risk CVE.

## Coverage snapshot

- **Backend: 509 tests / 37 files.** Uncovered: the DB layer (`db/pool.ts` —
  exercised only by the live/Docker path). `db/init.ts` is covered by
  `init-schema.test.ts`, including the new `disabled_at`/`disabled_by`/
  `restored_at`/`restored_by` columns and the `audit_log` table.
- **Frontend: 130 unit tests / 19 files; 201 E2E across chromium/firefox/
  webkit/mobile-chrome + the one manual `auth.setup.ts` project** (Admin User
  Management adds 44 of the E2E total: 11 specs × 4 browsers, in
  `admin-users.spec.ts`).
  Overall line coverage reads low only because the ~50 pure presentational
  components carry no branching logic and are covered structurally by the E2E
  run rather than unit tests.
