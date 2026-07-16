import type { Express } from "express";
import { createApp } from "../../src/app";
import { UserStore } from "../../src/shared/store/user-store";
import { SessionStore } from "../../src/shared/store/session-store";
import { AuditLogger } from "../../src/shared/audit/audit-logger";
import { Metrics } from "../../src/shared/observability/metrics";
import { AdminSessionStore } from "../../src/shared/store/admin-session-store";
import { makeSessionStore, makeUserStore } from "../mocks/stores";

/**
 * Build a real Express app for supertest, with every durable boundary
 * (UserStore, SessionStore) injected as a fake. The env vars `createApp` needs
 * are set by the global setupFile (tests/helpers/env.ts).
 *
 * IMPORTANT — external SDK boundaries:
 * `createApp` constructs the Mistral OCR client (M2) and the Google OAuth
 * client (auth/M5) internally, so integration specs that exercise those routes
 * must `vi.mock("@mistralai/mistralai")` / `vi.mock("googleapis")` /
 * `vi.mock("google-auth-library")` at the top of the file BEFORE importing this
 * helper. Specs that only touch M1/M3/M4 need no such mock.
 *
 * The pipeline (M1–M4) shares a single process-wide in-memory
 * `cardSessionStore` (a module singleton). Tests that submit a card and then
 * act on it work fine within one file; they must not assume isolation between
 * unrelated card ids.
 *
 * Pass a MemoryAuditLogger / MemoryMetrics when a spec needs to assert on
 * security events; both default to no-ops so existing specs stay quiet.
 */
export interface TestAppDeps {
  userStore?: UserStore;
  sessionStore?: SessionStore;
  audit?: AuditLogger;
  metrics?: Metrics;
  /**
   * Admin Sessions. Pass an InMemoryAdminSessionStore (the real one — it is
   * already in-memory, so there is nothing worth faking) when a spec needs to
   * age an admin session via _setNow(). Omit it and createApp builds its own.
   *
   * Note admin routes only exist when ADMIN_USERNAME/ADMIN_PASSWORD_HASH are
   * set; tests/helpers/env.ts deliberately does NOT set them, so by default
   * every spec sees the unconfigured (503) admin surface.
   */
  adminSessionStore?: AdminSessionStore;
}

export function buildTestApp(deps: TestAppDeps = {}): Express {
  return createApp({
    userStore: deps.userStore ?? makeUserStore(),
    sessionStore: deps.sessionStore ?? makeSessionStore(),
    audit: deps.audit ?? { log: () => {} },
    metrics: deps.metrics ?? { inc: () => {} },
    ...(deps.adminSessionStore ? { adminSessionStore: deps.adminSessionStore } : {}),
  });
}
