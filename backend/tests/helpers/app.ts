import type { Express } from "express";
import { createHmac } from "crypto";
import { createApp } from "../../src/app";
import { UserStore } from "../../src/shared/store/user-store";
import { SessionStore } from "../../src/shared/store/session-store";
import { AuditLogger } from "../../src/shared/audit/audit-logger";
import { Metrics } from "../../src/shared/observability/metrics";
import { AdminSessionStore } from "../../src/shared/store/admin-session-store";
import { QuotaStore } from "../../src/shared/store/quota-store";
import { LicenseSettingsStore } from "../../src/shared/store/license-settings-store";
import { COOKIE_NAME } from "../../src/shared/http/session";
import { makeSessionStore, makeUserStore } from "../mocks/stores";
import { makeUser } from "../fixtures/contacts";

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
  quotaStore?: QuotaStore;
  licenseSettingsStore?: LicenseSettingsStore;
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
    ...(deps.quotaStore ? { quotaStore: deps.quotaStore } : {}),
    ...(deps.licenseSettingsStore ? { licenseSettingsStore: deps.licenseSettingsStore } : {}),
    audit: deps.audit ?? { log: () => {} },
    metrics: deps.metrics ?? { inc: () => {} },
    ...(deps.adminSessionStore ? { adminSessionStore: deps.adminSessionStore } : {}),
  });
}

/**
 * Build an app plus a genuinely-signed session cookie for an active user — the
 * pipeline (M1–M2) requires a signed-in user now that scans are metered. Seeds a
 * matching user + active session in the fakes and signs the cookie with the test
 * SESSION_SECRET the same way `res.cookie(..., {signed:true})` does, so the
 * session middleware accepts it. Returns the app, the `Cookie` header value, and
 * the stores (so a spec can seed quota or revoke the session).
 */
export function buildAuthedTestApp(
  deps: TestAppDeps & { googleUserId?: string } = {}
): {
  app: Express;
  cookie: string;
  googleUserId: string;
  sessionStore: ReturnType<typeof makeSessionStore>;
  userStore: UserStore;
} {
  const googleUserId = deps.googleUserId ?? "u1";
  const sessionStore = (deps.sessionStore as ReturnType<typeof makeSessionStore>) ?? makeSessionStore();
  const userStore =
    deps.userStore ??
    makeUserStore({
      findById: async () => makeUser({ googleUserId }),
    });
  const app = buildTestApp({ ...deps, sessionStore, userStore });

  const session = sessionStore._seed({ googleUserId });
  const secret = process.env.SESSION_SECRET!;
  // cookie-parser reads a signed cookie as `s:<value>.<sig>` (URL-encoded whole),
  // where sig is base64 HMAC-SHA256 with trailing '=' padding stripped — exactly
  // what cookie-signature.sign produces and what the server verifies on read.
  const signed = `s:${session.id}.${signCookie(session.id, secret)}`;
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(signed)}`;

  return { app, cookie, googleUserId, sessionStore, userStore };
}

/** Replicates cookie-signature.sign: base64 HMAC-SHA256, '=' padding trimmed. */
function signCookie(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64").replace(/=+$/, "");
}
