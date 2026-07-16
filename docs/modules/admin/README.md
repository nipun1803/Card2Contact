# Admin — Design Docs

The operator-facing side of card2contact: everything reachable under
`/admin/*` (frontend) and `/api/admin/*` (backend), gated by an admin login that
is entirely independent of the Google OAuth users sign in with.

This folder is a subdirectory of `docs/modules/` rather than a flat file beside
the pipeline docs, because admin is a *surface* that will grow features (Phase
0.2+) rather than a single module. Each gets its own doc here.

## How to read these

Start with [Admin Authentication](Admin-Authentication.md) — it defines the
threat model, the session rules, and the `adminAuth` seam that every later admin
feature attaches to. Then read
[ARCHITECTURE.md](../../ARCHITECTURE.md) → *Admin authentication* for how it is
wired alongside the user session, and why the two cannot contaminate each other.

## Docs

| Doc | Description |
|---|---|
| [Admin Authentication](Admin-Authentication.md) | Phase 0.1 — operator login at `/admin/login`, the `admin_session` cookie, and the `adminAuth` guard protecting all `/api/admin/*` routes. |

## Adding an admin feature

The contract is one line: mount under `/api/admin` in `app.ts` and call
`router.use(adminAuth)` at the top of your router. `adminAuth` lives in
`backend/src/shared/http/admin-auth.ts` (not in the admin-auth module) precisely
so you can apply it without importing that module — the module boundary rule
holds for admin exactly as it does for M1–M5.

Two invariants worth knowing before you touch anything here:

- **Never populate `req.auth` from an admin route.** `requireAuth` and
  `createSaveLimiter` both read it; an admin session that sets it would
  authenticate M5's save as a user. Use `req.adminAuth`.
- **`createSessionMiddleware` skips `/api/admin`** — without that guard, a
  revoked *Google* session 401s the *admin* panel. Both directions are pinned by
  tests in `backend/tests/unit/session-middleware.test.ts`.
