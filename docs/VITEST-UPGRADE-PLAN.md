# Vitest / Vite upgrade plan (deferred)

Both `backend` and `frontend` are pinned to **vitest 2.1.9** / **vite 5.x**
(backend: vite 5.4.21 as vitest's transitive dep; frontend: vite 5.3.4
direct). This is **not yet upgraded** — this document is the plan for when it
is, not a changelog for work already done. It exists because the gap is not
free: `backend-audit`/`frontend-audit` in CI scope `npm audit` to
`--omit=dev` specifically to route around advisories in this dev-only
toolchain (see `docs/TESTING.md` → *CI: what the audit gate checks*). That
scoping is a real, understood decision — not a blind spot — but it is a
standing exception that this upgrade would retire.

## Why it's deferred, not just outdated

A sandboxed dry-run (`vitest@4.1.10` + `vite@7.3.6` installed into a scratch
copy of `backend/`, none of it touching the real repo) reproduces the
regression exactly as already documented in `docs/TESTING.md`:

```
Test Files  9 failed | 22 passed (31)
     Tests  68 failed | 381 passed (449)
```

Every failure is the same shape — `admin-isolation.test.ts`'s `googleLogin()`
helper throws `no user session cookie issued: []`. That test signs in through
the real `/api/auth/google/callback` route with `google-auth-library` mocked
via `vi.mock("google-auth-library")`; under vitest 4 the mock no longer
produces a session cookie, which is consistent with vitest 4's narrowed mock/
spy-restore semantics (see **Mocking** below). This is a real behavioral
regression to fix, not a config toggle — hence its own PR rather than riding
along with unrelated work.

## Target versions

| Package | Current | Target | Constraint |
|---|---|---|---|
| `vitest` | 2.1.9 | **4.1.10** (latest stable; 5.0 is beta-only as of this writing — do not target a beta) | needs Vite ≥6, Node ≥20.19/22.12 |
| `@vitest/coverage-v8` | 2.1.9 | **4.1.10 — exact match to `vitest`, always** | its `peerDependencies.vitest` is a literal version string, not a range, in every release sampled (2.x/3.x/4.x). Bump both in the same commit. |
| `vite` (frontend, direct) | 5.3.4 | **7.x** (see *Why not 8.x* below) | Vitest 4.1.10 accepts `^6.0.0 \|\| ^7.0.0 \|\| ^8.0.0` |
| `vite` (backend, transitive via vitest) | 5.4.21 | follows `vitest`'s resolution automatically | no direct action in `backend/package.json` |
| `@vitejs/plugin-react` | 4.3.1 | **4.7.0** (last of the 4.x line; supports Vite 5/6/7) or **5.x** if going to Vite 7/8 | `@vitejs/plugin-react@6.x` requires Vite ≥8 and drops Babel — bigger jump, see below |
| `vite-tsconfig-paths` | 5.1.4 | 6.1.1 | peer is `"vite": "*"` — never blocks, upgrade opportunistically |
| `jsdom` | 29.1.1 | unchanged (already latest) | already satisfies vitest 4's floor |

**Why not Vite 8 / `@vitejs/plugin-react` 6 yet:** plugin-react 6.x removes
Babel entirely in favor of Oxc and requires Vite ≥8 — a second compounding
change on top of the vitest 2→4 jump, with its own Fast-Refresh-pipeline risk.
Land vitest 4 + Vite 7 + plugin-react 4.7.0/5.x first, let it sit, then
evaluate the Vite 8 / plugin-react 6 jump as a separate, later PR.

## Breaking changes that apply to this codebase

Checked against `backend/vitest.config.ts` and `frontend/vitest.config.ts`
directly — neither file uses `coverage.all`, `coverage.extensions`,
`poolOptions`, `singleThread`/`singleFork`, or a `vitest.workspace.ts` file,
so several 4.0 hard-breaks that are common elsewhere **do not apply here**:

| Area | Change | Applies here? |
|---|---|---|
| Config | `vitest.workspace.ts` removed, must be `test.projects` in the main config | No — neither project has a workspace file |
| Coverage | `coverage.all`, `coverage.extensions`, `coverage.ignoreEmptyLines` removed; AST-aware remapping is now the only mode (was opt-in via `experimentalAstAwareRemapping` in 3.2) | Config-wise no (neither option is set) — but **coverage numbers will shift** since the remapper changed; treat this as a re-baseline, not a config edit. Re-run `npm run test:coverage` after upgrading and compare against the snapshot in `docs/TESTING.md` before assuming thresholds still hold (neither config currently sets `coverage.thresholds`, so nothing will fail — but the numbers reported will move) |
| Pool config | `maxThreads`/`maxForks`/`poolOptions`/`singleThread`/`singleFork` renamed to `maxWorkers` | No — neither config sets pool options, defaults apply |
| Default excludes | 4.0 only excludes `node_modules`/`.git` by default (previously also `dist`, `cypress`, hidden folders) | No — both configs already set explicit `include` globs (`src/**/*.test.ts`, `tests/**/*.test.ts` / `tests/unit/**`, `tests/integration/**`), so there's no implicit-exclude to lose |
| Mocking | `vi.fn().getMockName()` default changed `"spy"` → `"vi.fn()"` (breaks snapshots asserting the old name); `vi.restoreAllMocks()` now only restores manual `vi.spyOn()` spies, not automocks; automocked getters return `undefined` instead of calling through; `mock.invocationCallOrder` now starts at 1, not 0 | **Yes — this is the confirmed cause of the 68 failing tests.** Every `vi.mock("google-auth-library")` / `vi.mock("googleapis")` / `vi.mock("@mistralai/mistralai")` call site needs re-verification, not just the one test file that happens to fail loudly |
| Snapshots | Custom-element shadow-root contents now print by default | No shadow-DOM/custom-element snapshots in this codebase (plain RTL component tests) |
| Node floor | Vitest 4.0 requires Node ≥20.0 (effectively ≥20.19/22.12 via Vite 7's own floor) | Already satisfied — `node:20-alpine` resolves to 20.20.2, CI pins `NODE_VERSION: "20"` which resolves to a current 20.x on GitHub-hosted runners |
| jsdom auto-install | Vitest 4 no longer auto-installs jsdom/happy-dom on demand — must be an explicit devDependency | Already true here — `jsdom` is pinned directly in `frontend/package.json` |
| Sass legacy API | Removed in Vite 7 | Not applicable — this project has no Sass/SCSS preprocessing |
| CJS `require('vite')` | Removed in Vite 6 | Not applicable — `vite.config.ts`/`vitest.config.ts` use ESM `export default defineConfig(...)`, loaded by Vite's own config loader, not a plain `require()` |
| `resolve.conditions` defaults | Vite 6 made previously-implicit resolve conditions explicit | Unverified against this repo's specific dependency graph — low risk (no custom `resolve.conditions` override exists today) but worth a diff-the-bundle check after upgrading |

## Recommended sequencing

1. **Fix the mock regression first, in isolation**, before touching any
   `package.json`. Reproduce it in a scratch branch (as done for this plan:
   copy `backend/`, install `vitest@4.1.10`/`@vitest/coverage-v8@4.1.10` only,
   run `npx vitest run`, without upgrading `vite` explicitly — vitest pulls a
   compatible vite transitively). Isolating the mock fix from the vite bump
   makes it possible to tell which change caused what if something else also
   breaks.
2. **Backend**: bump `vitest` + `@vitest/coverage-v8` to `4.1.10` together.
   Backend's `vite` is transitive-only (no direct build step uses it — the
   backend builds with `tsc`), so nothing else needs a version bump here.
   Fix the `vi.mock("google-auth-library")` call sites until
   `admin-isolation.test.ts` and the rest of the suite pass, then run the
   **full** suite (`npm test`), not just the previously-failing file — the
   same mock semantics change could affect `vi.mock("googleapis")` and
   `vi.mock("@mistralai/mistralai")` call sites that happen not to have
   dedicated regression coverage yet.
3. **Frontend**: bump `vite` to `7.x`, `@vitejs/plugin-react` to `4.7.0` (or
   `5.x`), `vitest`/`@vitest/coverage-v8` to `4.1.10`, `vite-tsconfig-paths`
   to `6.1.1`. Run `npm run typecheck`, `npm test`, and a full
   `npm run build` (confirms the Vite 7 default browser-target change —
   `'modules'` → `'baseline-widely-available'`, Chrome 107+/Firefox 104+/
   Safari 16+ — doesn't regress anything this app relies on; card2contact has
   no stated legacy-browser support requirement, so this is expected to be a
   no-op).
4. **Re-baseline coverage** on both projects (`npm run test:coverage`), diff
   against the snapshot in `docs/TESTING.md` → *Coverage snapshot*, and update
   that section with the new numbers — don't assume the old percentages still
   apply after the AST-aware remapper change.
5. **Re-run full CI locally** (typecheck, unit, integration, build, E2E) on
   both projects before opening the PR. This upgrade touches the test
   *runner*, so the E2E suite (Playwright, unaffected by vitest/vite version)
   is the cross-check that nothing about the actual app broke — only the
   in-process test tooling did.
6. **Land as its own PR**, not bundled with feature work — a regression here
   is easy to misattribute to unrelated changes if they ship together.
7. **Retire the `--omit=dev` audit scoping** in
   `.github/workflows/pr-validation.yml` (`backend-audit`/`frontend-audit`)
   once `npm audit` (unscoped) is clean, and remove the explanatory comment
   that documents why it was scoped — that comment's reason will no longer be
   true.

## What NOT to do in this pass

- Don't jump straight to Vite 8 / `@vitejs/plugin-react` 6.x — that's a
  second, independent breaking change (Babel removal, Oxc-based refresh) best
  evaluated after 4.x/7.x is stable in CI.
- Don't target vitest 5.0 — it's beta-only as of this writing.
- Don't change `coverage.thresholds` speculatively — neither config sets
  them today, so there's nothing to pre-adjust; just re-baseline the
  snapshot numbers in `docs/TESTING.md` after the real upgrade lands.
