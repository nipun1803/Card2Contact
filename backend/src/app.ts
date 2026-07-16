import express, { Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { OAuth2Client } from "google-auth-library";
import { cardSessionStore } from "./shared/store/card-session-store";
import { errorHandler } from "./shared/http/error-handler";
import { createSessionMiddleware } from "./shared/http/session";
import { createRequireAuth } from "./shared/http/require-auth";
import {
  createAdminLoginLimiter,
  createOAuthLimiter,
  createSaveLimiter,
  createSessionLimiter,
  createUploadLimiter,
} from "./shared/http/rate-limit";
import { createAdminAuth } from "./shared/http/admin-auth";
import {
  AdminSessionStore,
  InMemoryAdminSessionStore,
} from "./shared/store/admin-session-store";
import { UserRecord, UserStore, spreadsheetUrlFor } from "./shared/store/user-store";
import { SessionStore } from "./shared/store/session-store";
import { AuditLogger, StdoutAuditLogger } from "./shared/audit/audit-logger";
import { Metrics, StdoutMetrics } from "./shared/observability/metrics";
import { SheetsProvisioner } from "./shared/sheets/sheets-provisioner";
import { createM1Router } from "./modules/image-acquisition/image-acquisition.router";
import { createM2Router } from "./modules/text-recognition/text-recognition.router";
import { createM3Router } from "./modules/contact-extraction/contact-extraction.router";
import { createM4Router } from "./modules/contact-review/contact-review.router";
import { createM5Router } from "./modules/google-sheets/google-sheets.router";
import { createGoogleSheetsClient } from "./modules/google-sheets/google-sheets.client";
import { SHEET_HEADER, SPREADSHEET_TITLE } from "./modules/google-sheets/google-sheets.service";
import { GoogleAuthService } from "./modules/google-auth/google-auth.service";
import { createGoogleAuthRouter } from "./modules/google-auth/google-auth.router";
import { resolveAdminConfig } from "./modules/admin-auth/admin-auth.config";
import { AdminAuthService } from "./modules/admin-auth/admin-auth.service";
import { createAdminAuthRouter } from "./modules/admin-auth/admin-auth.router";
import { AdminUserService } from "./modules/admin-users/admin-users.service";
import { createAdminUsersRouter } from "./modules/admin-users/admin-users.router";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

/**
 * The session cookie is signed with this and nothing else — it is the only
 * thing standing between a user and a forged session id, so a short secret is
 * a real vulnerability rather than a style issue.
 */
const MIN_SESSION_SECRET_LENGTH = 32;

function createGoogleAuthService(): GoogleAuthService {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI must all be set"
    );
  }
  return new GoogleAuthService(clientId, clientSecret, redirectUri);
}

/**
 * The SheetsProvisioner implementation lives here in the composition root —
 * the only place allowed to know both the google-sheets and users modules. It
 * closes over the per-user Sheets client factory + the user store so the
 * google-auth module can trigger provisioning through the shared interface
 * without importing google-sheets.
 *
 * Contract: Recreate Sheet — provision a fresh spreadsheet and persist its id,
 * url, and title together.
 */
function createSheetsProvisioner(userStore: UserStore): SheetsProvisioner {
  return {
    async ensureSpreadsheet(user: UserRecord, authClient: OAuth2Client): Promise<string> {
      const sheets = createGoogleSheetsClient(authClient);
      const spreadsheetId = await sheets.createSpreadsheetWithHeader(
        SPREADSHEET_TITLE,
        [...SHEET_HEADER]
      );
      // All three together — a Recreate Sheet that left a stale url would point
      // the user at the spreadsheet we just abandoned.
      await userStore.setSpreadsheet(user.googleUserId, {
        id: spreadsheetId,
        url: spreadsheetUrlFor(spreadsheetId),
        title: SPREADSHEET_TITLE,
      });
      return spreadsheetId;
    },
  };
}

/**
 * Composition root: wires the shared stores (CardSessionStore, UserStore,
 * SessionStore), session cookie handling, audit/metrics sinks, rate limiters,
 * and the GoogleAuthService/SheetsProvisioner into each module's router.
 * Modules never import one another — this is the only file that knows all five
 * pipeline modules plus google-auth exist.
 *
 * Durable stores are injected (built in index.ts from the DB pool) so createApp
 * stays synchronous and DB-free for unit tests.
 */
export function createApp(deps: {
  userStore: UserStore;
  sessionStore: SessionStore;
  audit?: AuditLogger;
  metrics?: Metrics;
  /**
   * Admin Sessions. Defaulted internally because the implementation is
   * in-memory and needs no DB — which is exactly why index.ts has nothing to
   * wire here. Injectable so a test can age sessions via _setNow().
   */
  adminSessionStore?: AdminSessionStore;
}): Express {
  const {
    userStore,
    sessionStore,
    audit = new StdoutAuditLogger(),
    metrics = new StdoutMetrics(),
    adminSessionStore = new InMemoryAdminSessionStore(),
  } = deps;
  const app = express();

  /**
   * TRUST PROXY — exactly 1, and set FIRST, before any middleware that reads
   * req.ip (the rate limiters and the session middleware both do).
   *
   * `true` would be a vulnerability, not a convenience: it makes Express trust
   * the ENTIRE X-Forwarded-For chain and take the left-most value, which is
   * wholly client-controlled. Any client could send `X-Forwarded-For: 1.2.3.4`
   * and forge the IP we write into sessions, audit logs, and rate-limit keys —
   * poisoning the exact records we are building for security.
   *
   * `1` means "there is exactly one trusted proxy in front of me, take the
   * right-most entry" — the value our own nginx appended via
   * $proxy_add_x_forwarded_for, which a client cannot forge. Our topology is
   * exactly one hop (nginx -> backend on the compose network; nginx is the only
   * ingress, with no CDN or load balancer in front).
   */
  app.set("trust proxy", 1);

  const googleAuthService = createGoogleAuthService();
  const provisioner = createSheetsProvisioner(userStore);
  const limiterDeps = { audit, metrics };

  /**
   * Admin authentication is OPT-IN: with ADMIN_USERNAME/ADMIN_PASSWORD_HASH
   * unset this resolves to null, the service is never built, and the admin
   * routes answer 503. That is why this cannot throw the way SESSION_SECRET
   * does — every deployment predating this feature must still boot, and the
   * whole test suite runs on exactly this path.
   *
   * It DOES throw for a half-configured or malformed credential (see
   * resolveAdminConfig): absent is off, present is strictly validated.
   */
  const adminConfig = resolveAdminConfig();
  const adminService = adminConfig
    ? new AdminAuthService(adminConfig, adminSessionStore)
    : null;

  // Credentialed CORS with an explicit origin — a wildcard origin is illegal
  // once cookies (credentials) are sent, so the session cookie can ride along.
  app.use(cors({ origin: FRONTEND_URL, credentials: true }));
  app.use(express.json());

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be set and at least ${MIN_SESSION_SECRET_LENGTH} characters`
    );
  }
  app.use(cookieParser(sessionSecret));
  app.use(createSessionMiddleware(userStore, sessionStore, audit, metrics));

  // Deliberately unlimited: a rate-limited healthcheck fails exactly when you
  // most need it to answer.
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  const requireAuth = createRequireAuth(audit, metrics);

  app.use("/api", createM1Router(cardSessionStore, createUploadLimiter(limiterDeps)));
  app.use("/api", createM2Router(cardSessionStore));
  app.use("/api", createM3Router(cardSessionStore));
  app.use("/api", createM4Router(cardSessionStore));
  app.use(
    "/api",
    createM5Router(
      cardSessionStore,
      googleAuthService,
      userStore,
      provisioner,
      createSaveLimiter(limiterDeps),
      requireAuth,
      audit,
      metrics
    )
  );
  app.use(
    "/api",
    createGoogleAuthRouter({
      service: googleAuthService,
      userStore,
      sessionStore,
      provisioner,
      audit,
      metrics,
      spreadsheetTitle: SPREADSHEET_TITLE,
      oauthLimiter: createOAuthLimiter(limiterDeps),
      sessionLimiter: createSessionLimiter(limiterDeps),
    })
  );

  /**
   * Admin routes, on their own mount path — the one thing that makes "every
   * future /api/admin/* route is guarded" structural rather than conventional:
   * a future admin router mounts here and applies the same `adminAuth`.
   *
   * Note createSessionMiddleware skips /api/admin entirely (see session.ts):
   * admin requests carry no user identity, and a revoked *Google* session must
   * not 401 the *admin* panel.
   *
   * One `adminAuth` instance, reused by every admin router mounted below —
   * not re-instantiated per router.
   */
  const adminAuth = createAdminAuth(adminService, audit, metrics);
  app.use(
    "/api/admin",
    createAdminAuthRouter({
      service: adminService,
      audit,
      metrics,
      loginLimiter: createAdminLoginLimiter(limiterDeps),
      adminAuth,
    })
  );

  /**
   * Admin User Management (Phase 1). Needs no "not configured" null-path the
   * way AdminAuthService does — user management is meaningless without admin
   * auth being configured at all, and this router already sits behind
   * `adminAuth`, which itself throws AdminNotConfiguredError when the admin
   * service is null.
   */
  const adminUserService = new AdminUserService(userStore, sessionStore, audit, metrics);
  app.use(
    "/api/admin",
    createAdminUsersRouter({ service: adminUserService, adminAuth })
  );

  app.use(errorHandler);

  return app;
}
