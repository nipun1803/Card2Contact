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
│                          #   + admin-auth (operator login, Phase 0.1)
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

```mermaid
flowchart LR
  M1[M1 Image Acquisition] --> M2[M2 Text Recognition]
  M2 --> M3[M3 Contact Extraction]
  M3 --> M4[M4 Contact Review]
  M4 --> M5[M5 Google Sheets]
  GA[google-auth Login] -. provisions sheet via .-> SP[SheetsProvisioner]
  M5 -. uses .-> SP
  M5 -. uses .-> US[UserStore]
  GA -. uses .-> US
  SP -. implemented in .-> AppTs[app.ts composition root]
  ADM[admin-auth Operator login] -. guards .-> ADMR["/api/admin/* (future routes)"]
  ADM -. uses .-> ASS[AdminSessionStore in-memory]
```

admin-auth shares nothing with the pipeline or google-auth: no store, no cookie,
no request property. That isolation is a security guarantee (#13), not a
coincidence of layout.

Pipeline modules (M1–M5) depend only on the previous stage's output via
`CardSessionStore`; M5 and google-auth additionally depend on the shared
`UserStore` and `SheetsProvisioner` — never on each other directly.

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

```mermaid
stateDiagram-v2
  [*] --> Created: POST /api/cards (M1)
  Created --> Recognized: POST /recognize (M2, sets rawText)
  Recognized --> Extracted: POST /extract (M3, sets contact)
  Extracted --> Confirmed: POST /confirm (M4, sets confirmed=true)
  Confirmed --> Saved: POST /contacts/save (M5, sets saved=true)
  Saved --> [*]
```

`PATCH /api/cards/{cardId}/contact` (M4) edits `contact` without advancing
state — see [M4's Implementation Notes](./modules/M4-Contact-Review.md) for
exactly when it stays legal.

**Durable state (multi-user).** User identity, OAuth tokens, and each user's
spreadsheet id ARE persisted, in Postgres (`users` table), so login and the
per-user sheet survive restarts. See
[docs/modules/Users-Persistence.md](./modules/Users-Persistence.md) for the
`UserStore`, the `TokenCodec` seam (token encryption postponed), and the signed
httpOnly session cookie that identifies the current user.

**License Management / Scan Quota (durable).** Scan metering, per-user quotas,
and configurable **Tiers** are persisted in eight Postgres tables
(`license_settings`, `scan_quotas`, `paid_grants`, `quota_consumptions`,
`quota_ledger`, `tiers`, `tier_assignments`, `tier_requests`) via the
`QuotaStore`, `LicenseSettingsStore`, `TierStore`, and `TierRequestStore` shared
interfaces. Enforcement is a
composed middleware (`createQuotaGuard`) on the M2 (OCR) route; as a consequence
the **whole scan pipeline now requires sign-in** (M1 applies `requireAuth`). A
scan is metered exactly-once by `cardId`, drawing free-first-then-paid; an
exhausted user gets `402 QUOTA_EXCEEDED`, a Scan-Blocked user `403 SCAN_BLOCKED`.
A **Tier** is admin-editable data — enforcement reads its config
(`is_unlimited`/`scan_limit`/`validity_days`), never its name, so custom tiers
need no code; an unlimited tier grants a per-user allow-always window that never
decrements. **Tier Upgrade Requests** add a user-initiated workflow on top: a
signed-in user files a request (via the `licensing` module at `/api/me/*`, behind
`requireAuth`); an admin approves or rejects it, and approval flows through the
existing `assignTier`/`grantPaid` seam — the same seam a future payment webhook
calls, so there is one grant path. See
[docs/modules/admin/LICENSE_MANAGEMENT.md](./modules/admin/LICENSE_MANAGEMENT.md).

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
  `{ code: "REAUTH_REQUIRED" }`, so the frontend prompts a Reconnect rather than
  failing silently.
- A request presenting a session that was **revoked** → `SessionRevokedError` →
  **401** with `{ code: "SESSION_REVOKED" }`, so the frontend can say *why* the
  user was signed out instead of bouncing to `/login` silently. The message
  itself depends on `revoked_reason`: "you signed in on another device" for a
  real Session Replacement, but "your session was ended by an administrator"
  for an admin's Revoke Access / Force Logout (`reason: "user_revoked"`) —
  reusing the "another device" wording for an admin action would be false and
  misleading. `SessionStore.getRevokedReason()` reads `revoked_reason` back
  from Postgres for exactly this; the reason itself is never sent to the
  client (see `RevokeReason`'s doc comment) — only the two derived, honest
  messages are.

All are caught once by `backend/src/shared/http/error-handler.ts`,
registered as Express error-handling middleware in `app.ts`. The two 401s are
matched **specific-first** — `SessionRevokedError` before `NotAuthenticatedError`.

`SessionRevokedError` is raised by the **session middleware**, not by
`requireAuth`. This is deliberate and load-bearing: `requireAuth` guards only
`POST /api/contacts/save`, but the endpoint that actually notices a Session
Replacement is the public `GET /api/auth/google/status` (which React Query
refetches on window focus). Had the 401 come from `requireAuth`, a revoked
device would sit on a stale dashboard until it happened to try a save.

Note **expiry is not revocation**: an expired session degrades to anonymous
(normal `/login`), while a revoked one gets the explicit message.

**Body-parser rejections** are handled centrally too, and apply to every route
that accepts a JSON body: an oversized body is **413** (`Request body is too
large`) and malformed JSON is **400** (`Request body is not valid JSON`).
`express.json()` already computes the right status — the handler honours it
rather than letting these fall through to the generic 500, which used to report a
client's own oversized request as "Internal server error" and send them hunting
for a server bug that was never there. The messages are deliberately generic:
body-parser's own text echoes the configured limit and parse offsets, which a
client neither needs nor should be handed.

**Admin authentication** adds three, in `shared/http/admin-errors.ts` rather than
`pipeline-errors.ts` (which is documented as shared by all module routers — these
serve one module):

- `AdminInvalidCredentialsError` -> **401** `{code:"ADMIN_INVALID_CREDENTIALS"}`. Deliberately generic and byte-identical for a wrong username, a wrong password, or both — a distinguishable response is a user-enumeration oracle.
- `AdminNotAuthenticatedError` -> **401** `{code:"ADMIN_NOT_AUTHENTICATED"}`. Covers absent/unknown/expired/revoked alike; admin has no Session Replacement story to explain, so there is no equivalent of `SESSION_REVOKED`.
- `AdminNotConfiguredError` -> **503** `{code:"ADMIN_NOT_CONFIGURED"}`. The app's only non-4xx/500 domain error, and correct: with `ADMIN_*` unset no credential *could* succeed, so this is server state, not client fault. A 401 would invite the operator to retype a correct password forever.

All three codes are distinct from `REAUTH_REQUIRED`/`SESSION_REVOKED`, so the
frontend can never mistake an admin 401 for a Google Session Revocation and
bounce an operator to the user login page.

## Terminology

Use these terms and no synonyms — in identifiers, audit events, comments, and UI
copy. Consistency here is what makes the audit log greppable and the code
searchable.

| Term | Means | Never say |
|---|---|---|
| **Session Revocation** | Ending a session server-side by setting `revoked_at`. The umbrella term. | "kick", "kill", "invalidate" |
| **Session Replacement** | Revocation caused by a new sign-in winning a Session Conflict. Audit `session_replaced`, reason `replaced_by_new_login`. | "takeover", "bump" |
| **Session Termination** | Revocation caused by the user's own logout. Audit `session_terminated`, reason `logout`. | "sign-off", "destroy" |
| **Session Conflict** | A sign-in attempted while an Active Session exists. | "duplicate login", "collision" |
| **Pending Session** | A staged, not-yet-active session awaiting the user's Session Conflict decision. | "provisional", "temp session" |
| **Active Session** | Not revoked, and within both the Idle Timeout and the Absolute Lifetime. | "live", "valid" |
| **Idle Timeout** | Expiry measured from `last_activity_at` (30 days). | "rolling expiry" |
| **Absolute Lifetime** | Expiry measured from `created_at` (7 days). The binding constraint. | "hard expiry", "TTL" |
| **Recreate Sheet** | Abandon an unusable spreadsheet and provision a fresh one, persisting id/url/title. | "restore", "regenerate" |
| **Reconnect** | The user re-granting Google access via OAuth after tokens were nulled. Always about *tokens*. | "re-auth", "relink" |
| **Token Cutover** | The one-time migration from plaintext to AES-encrypted tokens at rest. | "the wipe" |
| **Admin** | The single operator identified by `ADMIN_USERNAME`. Never a product user; has no Google account in this role. | "superuser", "root", "staff", "moderator" |
| **Admin Session** | An operator's authenticated session: in-memory, 8h Absolute Lifetime, `admin_session` cookie. Distinct from an Active Session in every respect. | "admin token", "admin login token" |

**M5 vs google-sheets:** "M5" is the *requirement* id (used in `docs/`);
`google-sheets` is the *module* id (used in code paths). Both are correct in
their own context — don't rename either, and don't invent a third.

## Sessions & single active session

One Active Session per user. Signing in on a second device presents a Session
Conflict; continuing revokes the first.

- **The cookie is an opaque capability, not an identity claim.** `c2c_session`
  holds 256 bits from `randomBytes` — never the `google_user_id` (which is what
  it held before server-side sessions existed, and which could not be revoked).
- **Two tables, not one with a status column.** `sessions` and
  `pending_sessions` are separate so a Pending Session is *structurally*
  incapable of authenticating: `findActive` reads `sessions`, and a pending row
  is not there. With a status column that guarantee would rest on every future
  query remembering `AND status='active'` — one omission is a privilege
  escalation.
- **Both lifetime bounds are enforced in SQL**, so an expired session stops
  working whether or not the hourly purge runs. The purge only reclaims space.
  Absolute (7d) is the binding constraint; Idle (30d) still ends an abandoned
  session early on, say, a shared computer.
- **Revoked rows are retained 7 days.** This is what makes `SESSION_REVOKED`
  possible at all — hard-deleting on revoke would give the revoked device a
  silent anonymous downgrade instead of an explanation.
- **The Session Conflict flow** (`google-auth.router.ts`): the OAuth callback
  persists tokens (the authorization code is single-use and cannot be
  re-exchanged after the user clicks Continue — safe, because possessing tokens
  is not being signed in), stages a Pending Session in a short-lived
  `c2c_pending` cookie, and redirects to the frontend `/session-conflict` page.
  Continue → `revokeAllForUser` **then** `create` (that order matters: the
  reverse could leave two Active Sessions if it crashed between them).
  `consumePending` is an atomic `DELETE … RETURNING`, so a double-clicked
  Continue cannot mint two sessions.
- **The revoked device finds out** via React Query's `refetchOnWindowFocus` on
  the auth query — no polling, no websockets.

## Back-forward cache (bfcache) forces a reload

`frontend/src/main.tsx` registers a `pageshow` listener at module scope,
before React mounts, that calls `location.reload()` whenever
`event.persisted` is true:

```ts
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
```

Without this, a browser can restore a **frozen** React tree from the
back-forward cache on Back/Forward navigation instead of re-fetching the
page — no route guard runs, because the page was never re-requested. The
concrete failure this caused: a user who visited `/admin/login` (or any
other route) in a tab, then navigated elsewhere and signed in with Google,
could hit Back after the post-OAuth redirect and have the browser restore
the stale `/admin/login` render straight from bfcache — landing them on a
page that has nothing to do with their actual, current auth state, because
`PublicOnly`/`ProtectedRoute`/`AdminProtectedRoute` never got a chance to
re-evaluate against the browser's current cookies. Forcing a reload on
`persisted: true` makes every back/forward navigation re-run the full route
tree and its guards against fresh state, at the cost of losing bfcache's
instant-restore performance benefit for this app — an acceptable trade,
since every route here is guard-gated and auth-sensitive rather than static
content.

## Admin authentication

A second, entirely independent identity system (Phase 0.1). Full design in
[docs/modules/admin/Admin-Authentication.md](modules/admin/Admin-Authentication.md),
including the threat model; the cross-cutting decisions are here.

- **Env, not a table.** One operator, so `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH`
  in `.env` beats a single-row identity table with a migration and a store. The
  password exists at rest only as a bcrypt hash — a database disclosure has
  nothing admin-shaped to leak.
- **Opt-in, and loud when half-done.** Both vars absent = the panel is off and
  its routes answer 503; every deployment predating this feature boots unchanged
  and the whole test suite runs on that path. Exactly one var set, or a hash that
  isn't bcrypt-shaped, is a **boot error**. Absent is quiet and safe; present is
  strictly validated. (`SESSION_SECRET` cannot have an off-switch; this can.)
- **In-memory sessions, and a deploy signs the admin out.** Accepted, and
  load-bearing: with no revoke endpoint in 0.1, **the restart IS the revocation
  mechanism.** The `AdminSessionStore` interface keeps this reversible — a
  Postgres implementation is a new class plus one wiring line in `index.ts`.
- **8h Absolute Lifetime, no idle bound, no sliding renewal.** Deliberately
  unlike the user session (7d/30d). An operator session is bounded by a work
  session; a sliding window would keep a stolen cookie alive as long as the thief
  kept using it. The cookie's `maxAge` derives from the same constant so the two
  cannot drift.
- **`sameSite:"strict"`, not `"lax"`.** The user cookie's `lax` is required
  *only* because it is set during the cross-site redirect back from
  accounts.google.com. Admin login is a same-site fetch POST, so `strict` is free
  and strictly stronger — it closes CSRF for admin routes outright, rather than
  relying on the app's documented lax-only posture. **Do not unify the two
  policies**: widening `lax` to admin weakens it; narrowing the user cookie to
  `strict` breaks the OAuth landing.
- **`req.adminAuth`, never `req.auth`.** `requireAuth` gates on `req.auth` being
  truthy and `createSaveLimiter`'s keyGenerator reads `req.auth?.googleUserId` —
  an admin populating it would authenticate `POST /api/contacts/save` as a user.
  This is a privilege escalation, and the distinct property is what prevents it.
- **One `cookieParser`, one secret.** A second secret would need
  `cookieParser(["a","b"])`, which makes both secrets valid for both cookies —
  actively removing the distinction it appears to add. Isolation lives in the
  cookie name and the store lookup: a signature only proves *we* minted the
  value; the value still has to name a live session in the right store.
- **`createSessionMiddleware` skips `/api/admin` entirely.** This one is easy to
  read as tidiness and is not. The middleware is global and rejects any request
  whose cookie names a revoked session, whatever the path — so without the guard,
  an operator whose *Google* session was replaced on another device is locked out
  of the *admin* panel and told "you signed in on another device", which is true
  and completely irrelevant to the route they asked for. (Confirmed by
  reproduction before the fix.) The invariant that `SessionRevokedError` is
  raised by the middleware rather than `requireAuth` is untouched: every
  non-admin path behaves exactly as before, which is what the `/status`
  revocation flow depends on. Both directions are pinned in
  `tests/unit/session-middleware.test.ts` — deleting the guard fails it, and so
  does widening it to all of `/api`.

## Admin — User Management

Phase 1, built on top of Admin Authentication above. Full design, threat
model, lifecycle, API reference, schema, and what's deferred all live in
[docs/modules/admin/USER_MANAGEMENT.md](modules/admin/USER_MANAGEMENT.md).

- **A disabled user cannot create a new session or use the pipeline's
  authenticated save.** `UserDisabledError` (403) is thrown at the Google
  OAuth callback (before the Session Conflict branch) and at the M5 save
  route — enforced before any token/session work completes. The M5 check is
  free: `req.auth.user.disabledAt` is already populated, since the session
  middleware loads the full `UserRecord` on every request.
- **Revoking a user's access takes effect immediately, not just for future
  logins.** `AdminUserService.disable()` and `forceLogout()` force-revoke all
  live sessions via the same `SessionStore.revokeAllForUser` primitive
  Session Replacement already uses, with reason `"user_revoked"` — a value
  the `RevokeReason` union had reserved since before this phase existed. The
  user then sees an honest message for it, not "another device" — see the
  `SessionRevokedError` entry in "Error conventions" above.
- **The response envelope is scoped to `/api/admin/users*`, not app-wide.**
  Every other route (including `/api/admin/auth/*`) keeps the existing raw
  JSON convention. Retrofitting `{data, meta}` everywhere would touch every
  existing frontend error-handling branch for zero benefit — see
  [USER_MANAGEMENT.md](modules/admin/USER_MANAGEMENT.md#7-endpoints)'s
  Conventions section.
- **"Scans," in the admin UI, is `savedContactsCount` relabeled — not a
  second, separately tracked count.** M1 image uploads are transient,
  in-memory pipeline state with no Postgres trace (see "Card session state"
  above), so there is no reliable way to count attempts that never reached a
  successful M5 save. The admin surface reuses the one number that already
  has a durable history rather than building a parallel, less-trustworthy
  metric. `UserStats.totalScans` (`GET /api/admin/users`) is
  `SUM(saved_contacts_count)` across every user, computed at query time —
  not a stored aggregate column.
- **The admin surface never returns `spreadsheetUrl`, only
  `spreadsheetTitle`.** Visibility into a user's *activity* (scan count,
  session status) does not require a live credential to their private
  spreadsheet data — the two are deliberately kept separate, unlike the
  user's own `/api/auth/google/status`, which does return the link so the
  user can open their own sheet.

## Sheet recovery

A **trashed** spreadsheet reads and writes normally through the Sheets API and
never 404s. Without an explicit check, contacts would land silently in a bin the
user cannot see. The only way to detect it is the Drive API (`files.get`,
`fields=trashed`), which is why the `drive.file` scope exists.

Order is load-bearing in `M5Service.save()`: **the trash check precedes the
header check**, because `readHeader` *succeeds* on a trashed sheet — so the
existing `header === null` branch would never fire for this case and the
recovery would be dead code. A trashed sheet is never reused, even if the user
could restore it: abandon it and Recreate Sheet.

## Audit logging & metrics

Both emit newline-delimited JSON to **stdout** (`docker logs`), behind
interfaces (`AuditLogger`, `Metrics`) so tests inject memory doubles and a
future sink is a wiring change in `index.ts`. Grep by `"kind":"audit"` or
`"kind":"metrics"`.

**Architecture decision change (Admin User Management, Phase 1): audit
logging is no longer stdout-only.** This doc previously said audit was
deliberately not a table, because an append-only table needs retention,
indexing, and migration for a payload the container platform already
captures. That reasoning held until the admin User Details page needed
queryable per-user history (login, revoke/restore, reconnect, sheet
recreation, contact saves) — a need stdout genuinely cannot serve; `docker
logs | grep` has no per-user index and no pagination. `index.ts` now wires
`PgAuditLogger`, which **dual-writes**: every `log()` call still writes to
stdout (the existing `docker logs` ops workflow, unchanged) *and* inserts
into a new `audit_log` Postgres table (queryable via `AuditLogger.query()`,
an optional interface method only the Postgres-backed sink implements). See
[USER_MANAGEMENT.md](modules/admin/USER_MANAGEMENT.md#6-entities-data-model)
for the table's DDL and the business rules this enables. The field policy
below is unchanged and applies
identically to both the stdout line and the Postgres row for a given event —
enforced once, at the sink, not duplicated per call site.

Metrics stay separate from audit because audit is per-event and bound by a
strict field policy, while metrics are aggregate and carry no identifiers —
merging them would force one to inherit the other's constraints.

**Field policy — an audit log answers "who did what, when, from where"; it is
not a debugging dump.**

| Logged | Why |
|---|---|
| `googleUserId` | Opaque Google `sub`; the join key for any investigation |
| `sessionId`, **truncated to 8 chars** | Keeps all the correlation value, destroys the credential value. Truncation happens at the *sink*, so no call site can leak a full id by mistake |
| `device` / `browser` | Coarse strings from our own parser — not the raw UA |
| `ip` | The core signal for "was this sign-in from somewhere unexpected?" |
| `adminUsername` | The operator's configured (or attempted) login name. Logged despite the `email` ban because that ban's two reasons both fail here: it is **operator-chosen**, set by whoever writes `.env` — i.e. the person reading this log — not a data subject's PII; and there is **no opaque alternative** to join on, since no `admins` table exists, so omitting it would leave `admin_auth_failure` with no subject and fail the log's own purpose. A username without a password is not a capability |

| Never logged | Why |
|---|---|
| Tokens (any) | The whole encryption-at-rest effort is pointless if tokens hit stdout |
| `email` | Direct PII; `googleUserId` + one `SELECT` covers any real investigation |
| Contact data | Our users' *customers'* PII. `contact_save` logs `cardId` only |
| Raw User-Agent | Fingerprinting vector, attacker-controlled |
| `spreadsheetId` | Capability-ish; the event plus the user is enough |
| The admin password / `ADMIN_PASSWORD_HASH` | In any form, in any field. The hash is not a password, but it is offline-crackable — and a log that records the *outcome* of a credential check has no business carrying the credential. Enforced by test (`tests/integration/admin/admin-auth.test.ts`) |

## Security Guarantees

What this system can honestly claim — and, just as importantly, what it cannot.

| # | Guarantee | Enforced by |
|---|---|---|
| 1 | OAuth tokens are never at rest in plaintext | `AesGcmTokenCodec` wired in `index.ts`; Token Cutover wipes pre-existing plaintext; boot fails without the key |
| 2 | A session cookie is an opaque capability, not an identity claim | 256-bit `randomBytes` id, signed + httpOnly |
| 3 | Every session can be revoked, immediately, server-side | `sessions.revoked_at`, checked by `findActive` on every request |
| 4 | At most one Active Session per user at any instant | Session Replacement revokes before creating; `consumePending` is atomic |
| 5 | A revoked device *learns* it was revoked | Middleware rejects known-revoked ids with `SESSION_REVOKED`; rows retained 7 days |
| 6 | No session outlives 7 days, however active | Absolute Lifetime enforced in SQL |
| 7 | Client-supplied IPs cannot be forged into our records | `trust proxy: 1` — takes the right-most XFF entry, appended by our own nginx |
| 8 | Security events are auditable without leaking what they protect | The field policy above |
| 9 | Contacts are never written to a trashed or deleted spreadsheet | Drive `trashed` check before every save; Recreate Sheet |
| 10 | Abuse of expensive endpoints is bounded | Per-endpoint rate limits (OAuth 10, session 20, upload 30, save 60 per 15 min) |
| 11 | All production traffic is TLS-terminated with HSTS | `nginx.prod.conf` |
| 12 | The admin password is never at rest in plaintext | bcrypt hash only, in `.env`; the shape is validated at boot, so a plaintext value cannot start the server |
| 13 | Admin and user sessions cannot authenticate each other's routes | Separate cookie name, separate store, separate request property (`req.adminAuth` vs `req.auth`); pinned by `tests/integration/admin/admin-isolation.test.ts` |
| 14 | Admin login reveals nothing about which credential was wrong | Byte-identical generic 401 for every credential failure, plus a constant-work bcrypt compare against a dummy hash on a username miss |
| 15 | Admin login brute force is bounded | 5 attempts / 15 min / IP, plus bcrypt cost 12 (~100ms per attempt) |
| 16 | No Admin Session outlives 8h, however active | Absolute Lifetime enforced in `findActive` on every lookup; no idle bound, no sliding renewal |
| 17 | A disabled user cannot create a new session or use the pipeline's authenticated save | `UserDisabledError` at the OAuth callback and M5 save gate; enforced before any token/session work completes |
| 18 | Revoking a user's access takes effect immediately, not just for future logins | `AdminUserService.disable()` force-revokes all live sessions via `revokeAllForUser("user_revoked")` in the same request, before responding |
| 19 | The admin panel never grants a live link to a user's spreadsheet | `/api/admin/users*` serializes `spreadsheetTitle` only — `spreadsheetUrl` is dropped in `toUserSummaryJson`, never reaching the admin client |

**Explicitly NOT guaranteed** — stated so nobody assumes otherwise:

- **Not protected against a compromised backend host.** `TOKEN_ENCRYPTION_KEY`
  lives in the process environment; root or a debugger reads both key and
  plaintext. This defends against *database* disclosure — a leaked backup, SQL
  injection, a decommissioned disk — not host compromise.
- **No CSRF tokens.** We rely on `sameSite:"lax"` alone. Adequate here (no
  cross-site POST reaches a state-changing endpoint with cookies attached), but
  it is one mechanism, not defence in depth.
- **Audit logs are not tamper-evident.** Anyone who can write the log stream can
  forge entries. Fine for operational forensics; not legal evidence.
- **Admin Sessions do not survive a restart.** By design (in-memory) — and it is
  the revocation mechanism, not merely a limitation.
- **A stolen admin cookie is valid until it expires.** There is no admin
  revoke endpoint in Phase 0.1; the 8h Absolute Lifetime bounds the window, and a
  redeploy ends every Admin Session immediately.
- **There is exactly one admin, and no MFA.** The audit log records the
  configured username, which says nothing about *which human* used the
  credential.
- **No admin account lockout.** Rate limiting only: locking the single shared
  admin credential would be a self-inflicted denial of service.
- **Rate limits are per-container and in-memory.** They reset on restart and do
  not hold across replicas. Bounds accidental abuse and casual attacks, not a
  determined distributed one.
- **Not a defence against a malicious account owner.** A user can always read,
  edit, or trash their own sheet; we recover, we don't prevent.

## Rollback & recovery

The Token Cutover is the only irreversible step. Everything else is additive DDL
(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) — rolling back the
image leaves unused tables behind, which is harmless.

**Before deploying** (prevents most of the below):

```bash
openssl rand -hex 32                                     # the key
# put it in prod .env as TOKEN_ENCRYPTION_KEY, THEN deploy
pg_dump -t users "$DATABASE_URL" > users-pre-cutover.sql # only copy of the plaintext
```

| Failure | Symptom | Blast radius | Fix |
|---|---|---|---|
| Key missing | Backend exits at boot | **None** — never listened, never touched the DB | Set it, redeploy. The loud crash is deliberate |
| Key malformed | Boot fails in `decodeEncryptionKey` | None, same reason | Regenerate; watch for shell quoting and trailing newlines |
| **Key wrong but well-formed** | Boots fine; *every* user sees "Reconnect Google"; `token_refresh_failure` spikes across the whole user base | **No data loss** — `dec()` degrades to null rather than throwing | Restore the correct key and redeploy; tokens decode again with no further action |
| Key lost | As above, permanently | No contact data lost (it lives in Sheets); `users` rows survive | Unrecoverable by design. Every user Reconnects once |

`decodeEncryptionKey` validates *length*, not correctness — it cannot tell that
a key is the wrong 32 bytes. That is precisely why `PgUserStore.dec()` returns
null instead of throwing: with a throw, a wrong key would 500 every request and
leave no way in. It turns an outage into a recoverable mass-Reconnect.

**Rolling back to a pre-cutover image** has a trap: the old image constructs
`IdentityTokenCodec`, reads ciphertext as if it were a token, and sends
`iv:tag:ciphertext` to Google — users see broken saves, not a clean Reconnect.
Rolling back therefore requires also nulling the tokens:

```sql
UPDATE users SET access_token = NULL, refresh_token = NULL, token_expiry = NULL;
```

Do **not** restore `users-pre-cutover.sql` wholesale — it would revert
`saved_contacts_count` and `spreadsheet_id` too, orphaning sheets.

**Any move across this change — forward or back — signs everyone out once**
(the cookie's meaning changed from a user id to a session id). Expected, not a bug.

**Admin authentication is fully reversible and touches no data.** There is no
DDL, no table, and no migration — nothing to roll back. To disable the panel,
unset both `ADMIN_*` vars and redeploy: the routes answer 503 and no user-facing
behaviour changes. To rotate the password, generate a new hash, replace the var,
and redeploy.

Note the redeploy is not incidental: **restarting the backend ends every Admin
Session** (they are in-memory), which is precisely how you evict a
suspected-stolen admin cookie — there is no admin revoke endpoint in Phase 0.1.
Rolling back to a pre-admin image is safe: the `ADMIN_*` vars are simply ignored.

**If a Session Replacement bug locks users out**, clear recent revocations
without a redeploy:

```sql
UPDATE sessions SET revoked_at = NULL, revoked_reason = NULL
 WHERE revoked_reason = 'replaced_by_new_login' AND revoked_at > now() - interval '1 hour';
```

This restores multi-session behaviour temporarily — a deliberate, reversible
trade of Guarantee #4 for availability while you diagnose.

## Credentials

All external service credentials are read from environment variables, never
hardcoded or committed:

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | persistence | Postgres connection string (multi-user `users` table) |
| `SESSION_SECRET` | session | Signs the httpOnly session cookie. **≥32 chars or the backend refuses to start** — it is the only thing between a user and a forged session id |
| `TOKEN_ENCRYPTION_KEY` | persistence | **Required.** AES-256-GCM key for OAuth tokens at rest; 32 bytes as 64 hex chars or base64 (`openssl rand -hex 32`). The backend exits at boot without it |
| `MISTRAL_API_KEY` | M2 | Mistral OCR API key |
| `GOOGLE_OAUTH_CLIENT_ID` | M5 | OAuth Web Client ID (Google Cloud Console → Credentials) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | M5 | OAuth Web Client secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | M5 | Must exactly match a redirect URI registered on the OAuth client |
| `ADMIN_USERNAME` | admin-auth | The single operator's login name. **Both or neither** with the hash — setting only one is a boot error naming the other |
| `ADMIN_PASSWORD_HASH` | admin-auth | bcrypt hash, **never plaintext** — the shape is validated at boot and a non-hash refuses to start (bcrypt would compare it to `false` forever, locking the admin out silently). Both blank = the admin panel is disabled and `/api/admin/*` answers 503. Generate: `node -e "console.log(require('bcrypt').hashSync(process.argv[1],12))" 'your-password'` |
| `PORT` | app entrypoint | Backend HTTP port (defaults to 4000) |

`GOOGLE_SHEETS_SPREADSHEET_ID` is **removed** — each user's spreadsheet is
auto-created on first login and stored per user.

M5 uses **OAuth 2.0** (interactive login) rather than a service account, with
scopes `openid email profile spreadsheets drive.file`. `drive.file` grants
access only to files this app created and exists solely to read the `trashed`
flag — the Sheets API cannot report it (see *Sheet recovery* below). Each user's
token pair is persisted per user in Postgres, AES-256-GCM encrypted through the
`TokenCodec` seam — see M5's own doc and Users-Persistence.md.

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

- **nginx** uses the stock `nginx:1.27-alpine` image for the local dev
  compose stack (no custom Dockerfile) — the root `nginx.conf` is
  bind-mounted read-only into the container. It reverse-proxies `/api/*` to
  the `backend` service and everything else (including Vite's HMR WebSocket)
  to the `frontend` service. Host port defaults to 8080 (`NGINX_PORT` in
  `.env`, since port 80 is commonly already in use on a dev machine); the
  internal proxied port is always 80. (`frontend/Dockerfile`'s own `prod`
  target — used by `docker-compose.prod.yml`, not this dev stack — runs
  `nginx:1.29-alpine`; see *Container hardening* below.)
- **backend** (`backend/Dockerfile`) is a 4-stage build: install deps → `tsc`
  build → a `prod-deps` stage that runs `npm install --omit=dev` while npm is
  still present → a `runtime` stage that copies in only `node_modules`,
  `package.json`, and compiled `dist/`, with npm/npx/corepack deleted before
  anything else runs. No devDependencies (including `typescript`/`tsx`) ship
  in the final image, and neither does the npm CLI itself — see *Container
  hardening* below for why that split exists. Also published directly on
  host port 4000 (`BACKEND_PORT`).
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

### Container hardening

Both production runtime images (`backend/Dockerfile`'s `runtime` stage,
`frontend/Dockerfile`'s `prod` target) are scanned with Trivy
(`docker-build-backend`/`docker-build-frontend` in
`.github/workflows/pr-validation.yml`, `severity: HIGH,CRITICAL`,
`exit-code: "1"` — a HIGH/CRITICAL finding fails the PR check, not just a
warning). As of the last hardening pass both images scan **clean (0
HIGH/CRITICAL)**. Three changes got there from a non-trivial baseline (15
Alpine OS CVEs + 19 Node-tooling CVEs on backend; 35 Alpine OS CVEs on
frontend):

1. **`apk upgrade --no-cache` in the final stage of both Dockerfiles.**
   Docker Hub's published `node:20-alpine`/`nginx:1.29-alpine` layers lag
   Alpine's own package repo by days to weeks — `apk upgrade` at build time
   pulls whatever Alpine has already patched (openssl, expat, libxml2, etc.)
   without waiting for the upstream image to be rebuilt. Re-run this as part
   of every image rebuild, not just once — it's a moving target.
2. **npm is deleted from the backend's runtime image.** `node:20-alpine`
   bundles the full npm CLI — including its own vendored `glob`, `tar`,
   `sigstore`, `cross-spawn`, `minimatch` — at
   `/usr/local/lib/node_modules/npm`, purely so `npm install` can run inside
   the image. The runtime never invokes `npm` (`CMD ["node", "dist/index.js"]`
   only), so those packages' CVEs were pure unused attack surface. The fix
   splits `npm install --omit=dev` into its own `prod-deps` stage (which
   still has npm) and copies only the resulting `node_modules` +
   `package.json` into a `runtime` stage that deletes
   `npm`/`npx`/`corepack` before anything else runs.
3. **`curl` is removed from the frontend's `prod` nginx image.** Nothing in
   this repo's Dockerfiles, docker-compose files, or CI healthchecks
   (`docker-compose.yml`'s backend healthcheck uses `wget`; postgres uses
   `pg_isready`) shells out to `curl` inside the frontend container — it
   shipped only because the base nginx image includes it.

**Remaining accepted risk:** `CVE-2026-45447` (OpenSSL heap use-after-free in
`PKCS7_verify()`) may still surface on a fresh `node:20-alpine` pull between
scheduled rebuilds if Alpine's repo snapshot at build time predates the fix —
`apk upgrade` closes it as soon as the fix lands in Alpine's repo, which
happened before this pass completed, but the window is real and worth
re-checking on the next scheduled Trivy run rather than assuming it stays
closed. A Node major bump (20 → 22/24, tracked separately since it's a bigger
decision than a base-image patch — see CI's pinned `NODE_VERSION: "20"`)
would land on a base image built against a newer Alpine snapshot by default.

`multer` was upgraded `1.4.5-lts.2` → `2.2.0` (closes eight HIGH CVEs:
CVE-2025-47935, -47944, -48997, -7338; CVE-2026-2359, -3304, -3520, -5079).
The M1 upload route (`memoryStorage`, `.fields()`, `limits.fileSize`,
`MulterError` code check) needed zero code changes — multer 2.x kept that
API surface — but it does **not** bundle its own TypeScript types the way
some 2.x-line packages do; `@types/multer` stays a devDependency, bumped to
`^2.2.0` to match.

A known, separate, NOT-yet-addressed finding: `googleapis@140.0.1`'s
dependency chain (`gaxios` → `googleapis-common` → `uuid <11.1.1`) carries a
moderate `npm audit` finding (CWE-787, buffer bounds check in `uuid`
v3/v5/v6). It doesn't trip `--audit-level=high` (moderate, not high) and
requires a major `googleapis` bump (140 → 173) to fix — that's Google OAuth/
Sheets integration code, out of scope for this hardening pass; tracked here
so it isn't lost.

### TLS and `trust proxy`

Production TLS is terminated at nginx (`nginx.prod.conf`: Let's Encrypt,
`:80 → :443` redirect, HSTS `max-age=63072000`, `X-Forwarded-Proto https`). The
backend always speaks plain HTTP on 4000 behind it.

`app.ts` sets **`app.set("trust proxy", 1)` first, before any middleware** — the
rate limiters and the session middleware both read `req.ip`.

The value is exactly `1`, and this matters: `true` would be a *vulnerability*.
It makes Express trust the entire `X-Forwarded-For` chain and take the left-most
value, which is wholly client-controlled — any client could send
`X-Forwarded-For: 1.2.3.4` and forge the IP we write into sessions, audit logs,
and rate-limit keys, poisoning the exact records we built for security. `1`
means "exactly one trusted proxy, take the right-most entry" — the value our own
nginx appended via `$proxy_add_x_forwarded_for`, which a client cannot forge.
Our topology is exactly one hop: nginx is the sole ingress, with no CDN or load
balancer in front.

Usage: `cp .env.example .env`, fill in `SESSION_SECRET` (≥32 chars),
`TOKEN_ENCRYPTION_KEY` (`openssl rand -hex 32` — **the backend will not start
without it**), `MISTRAL_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, then `docker compose up --build`. Open the app and
click **Sign in with Google** — the user's spreadsheet is created automatically
on first login; no spreadsheet id to configure.
- Full app (through nginx): `http://localhost:8080`
- Backend API directly: `http://localhost:4000`
- Frontend dev server directly: `http://localhost:5173`

(Port numbers above are the defaults; override via `NGINX_PORT`,
`BACKEND_PORT`, `FRONTEND_PORT` in `.env` if any collide with something
already running on your machine.)
