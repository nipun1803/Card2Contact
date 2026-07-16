import type { Page, Route } from "@playwright/test";

/**
 * Network-level API mocking for authenticated E2E — the Playwright analogue of
 * MSW. Real Google OAuth can't run in an automation-controlled browser (Google
 * blocks it with "this browser may not be secure"), so instead of driving a
 * real login we intercept the backend API at the network boundary and serve a
 * deterministic authenticated session. The React app is unchanged and unaware.
 *
 * Every handler matches the real backend's response shape (see
 * src/shared/types/api.ts) so the contract stays honest.
 */

export interface MockOptions {
  authenticated?: boolean;
  needsReconnect?: boolean;
  savedContactsCount?: number;
  /** Force the save step to fail with REAUTH_REQUIRED (reconnect flow). */
  saveReauthRequired?: boolean;
  /**
   * Make every request 401 with SESSION_REVOKED — the state of a device whose
   * session was ended by a sign-in elsewhere (Session Replacement).
   */
  sessionRevoked?: boolean;
  /** Make POST /session/continue fail, as an expired Pending Session would. */
  continueFails?: boolean;

  /**
   * Admin authentication — a SEPARATE identity from `authenticated` above.
   *
   * Defaults to false so every existing spec is unaffected: a Google-signed-in
   * user is not an admin, which is exactly the isolation the app guarantees.
   */
  adminAuthenticated?: boolean;
  /** Reject POST /admin/auth/login with the generic 401. */
  adminLoginFails?: boolean;
  /** Answer every admin route 503, as an unconfigured server does. */
  adminNotConfigured?: boolean;
  /** Seed the User Directory / User Details with these users. */
  adminUsers?: MockAdminUser[];
  /** Make POST /admin/users/:id/force-logout 500, to test the dialog's error UI. */
  adminForceLogoutFails?: boolean;

  /**
   * License Management (Phase 5). When set, the M2 recognize call is refused
   * with the matching code — drives the scan-gating panels.
   *  - "quota"   → 402 QUOTA_EXCEEDED
   *  - "blocked" → 403 SCAN_BLOCKED
   */
  scanRefusal?: "quota" | "blocked";
}

/** Mirrors AdminUserSummary/AdminUserDetail (src/shared/types/api.ts). */
export interface MockAdminUser {
  googleUserId: string;
  email: string;
  spreadsheetTitle?: string | null;
  savedContactsCount?: number;
  createdAt?: string;
  lastLoginAt?: string | null;
  disabled?: boolean;
  disabledAt?: string | null;
  disabledBy?: string | null;
  restoredAt?: string | null;
  restoredBy?: string | null;
  activeSession?: { device: string | null; browser: string | null; ip: string | null; lastActivityAt: string } | null;
}

function toSummary(u: MockAdminUser) {
  return {
    googleUserId: u.googleUserId,
    email: u.email,
    spreadsheetTitle: u.spreadsheetTitle ?? null,
    savedContactsCount: u.savedContactsCount ?? 0,
    createdAt: u.createdAt ?? "2026-01-01T00:00:00.000Z",
    lastLoginAt: u.lastLoginAt ?? null,
    disabled: u.disabled ?? false,
    disabledAt: u.disabledAt ?? null,
    disabledBy: u.disabledBy ?? null,
    restoredAt: u.restoredAt ?? null,
    restoredBy: u.restoredBy ?? null,
  };
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

export async function mockBackend(page: Page, opts: MockOptions = {}): Promise<void> {
  const {
    authenticated = true,
    needsReconnect = false,
    savedContactsCount = 7,
    saveReauthRequired = false,
    sessionRevoked = false,
    continueFails = false,
    adminAuthenticated = false,
    adminLoginFails = false,
    adminNotConfigured = false,
    adminUsers = [],
    adminForceLogoutFails = false,
    scanRefusal,
  } = opts;

  // Mutable so a spec can disable/restore a user across the journey.
  const users = adminUsers.map((u) => ({ ...u }));
  // Per-user audit log, appended to by disable/restore/force-logout below —
  // stateful so a spec can prove an action shows up in Audit History, not
  // just that the action's own endpoint returned 200.
  const auditLog = new Map<string, Array<{ id: number; ts: string; event: string }>>();
  let nextAuditId = 1;
  function appendAudit(googleUserId: string, event: string) {
    const entries = auditLog.get(googleUserId) ?? [];
    entries.unshift({ id: nextAuditId++, ts: "2026-07-16T09:00:00.000Z", event });
    auditLog.set(googleUserId, entries);
  }

  /**
   * Admin routes, mounted first so the /api/admin/* patterns win over any
   * broader match below. Session state lives in this closure: a login flips it,
   * so a spec can drive login → dashboard → logout as one journey.
   *
   * Shapes mirror the real backend exactly (see modules/admin-auth/) — a mock
   * that drifts from the contract tests nothing.
   */
  let adminSignedIn = adminAuthenticated;

  const notConfigured = (route: Route) =>
    json(route, 503, {
      error: "Admin access is not configured",
      code: "ADMIN_NOT_CONFIGURED",
    });

  await page.route("**/api/admin/auth/me", (route) => {
    if (adminNotConfigured) return notConfigured(route);
    if (!adminSignedIn) {
      return json(route, 401, {
        error: "Admin login required",
        code: "ADMIN_NOT_AUTHENTICATED",
      });
    }
    return json(route, 200, { username: "admin" });
  });

  await page.route("**/api/admin/auth/login", (route) => {
    if (adminNotConfigured) return notConfigured(route);
    if (adminLoginFails) {
      // Generic by design: the real backend never reveals WHICH credential was
      // wrong.
      return json(route, 401, {
        error: "Invalid credentials",
        code: "ADMIN_INVALID_CREDENTIALS",
      });
    }
    adminSignedIn = true;
    return json(route, 200, { username: "admin" });
  });

  await page.route("**/api/admin/auth/logout", (route) => {
    if (adminNotConfigured) return notConfigured(route);
    adminSignedIn = false;
    return json(route, 200, { ok: true });
  });

  const adminUnauthenticated = (route: Route) =>
    json(route, 401, { error: "Admin login required", code: "ADMIN_NOT_AUTHENTICATED" });

  // Admin User Management (Phase 1). GET /users must be registered before the
  // GET /users/:id pattern below — Playwright matches route handlers in
  // registration order, most-specific-first would be equally correct here,
  // but the query-string form is unambiguous either way.
  await page.route("**/api/admin/users?*", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    const summaries = users.map(toSummary);
    const url = new URL(route.request().url());
    const search = url.searchParams.get("search")?.toLowerCase();
    const status = url.searchParams.get("status");
    const filtered = summaries.filter((u) => {
      if (search && !u.email.toLowerCase().includes(search)) return false;
      if (status === "active" && u.disabled) return false;
      if (status === "disabled" && !u.disabled) return false;
      return true;
    });
    return json(route, 200, {
      data: {
        users: filtered,
        stats: {
          total: summaries.length,
          active: summaries.filter((u) => !u.disabled).length,
          disabled: summaries.filter((u) => u.disabled).length,
          recentLogins: 0,
          totalScans: summaries.reduce((sum, u) => sum + u.savedContactsCount, 0),
        },
      },
      meta: { page: { total: filtered.length, totalPages: 1, nextCursor: null, limit: 20 } },
    });
  });
  await page.route("**/api/admin/users", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    const summaries = users.map(toSummary);
    return json(route, 200, {
      data: {
        users: summaries,
        stats: {
          total: summaries.length,
          active: summaries.filter((u) => !u.disabled).length,
          disabled: summaries.filter((u) => u.disabled).length,
          recentLogins: 0,
          totalScans: summaries.reduce((sum, u) => sum + u.savedContactsCount, 0),
        },
      },
      meta: { page: { total: summaries.length, totalPages: 1, nextCursor: null, limit: 20 } },
    });
  });

  await page.route("**/api/admin/users/*/audit*", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const entries = auditLog.get(id ?? "") ?? [];
    return json(route, 200, {
      data: {
        entries: entries.map((e) => ({
          ...e,
          googleUserId: id,
          adminUsername: "admin",
          sessionId: null,
          device: null,
          browser: null,
          ip: null,
          outcome: "success",
          reason: null,
          cardId: null,
          revokedCount: null,
        })),
      },
      meta: { page: { total: entries.length, totalPages: entries.length ? 1 : 0, nextCursor: null, limit: 20 } },
    });
  });

  await page.route("**/api/admin/users/*/disable", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const u = users.find((x) => x.googleUserId === id);
    if (!u) return json(route, 404, { error: "User not found", code: "USER_NOT_FOUND" });
    u.disabled = true;
    u.disabledAt = "2026-07-16T09:00:00.000Z";
    u.disabledBy = "admin";
    appendAudit(u.googleUserId, "admin_user_disabled");
    return json(route, 200, { data: { ...toSummary(u), activeSession: u.activeSession ?? null } });
  });

  await page.route("**/api/admin/users/*/restore", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const u = users.find((x) => x.googleUserId === id);
    if (!u) return json(route, 404, { error: "User not found", code: "USER_NOT_FOUND" });
    u.disabled = false;
    u.disabledAt = null;
    u.disabledBy = null;
    u.restoredAt = "2026-07-16T09:00:00.000Z";
    u.restoredBy = "admin";
    appendAudit(u.googleUserId, "admin_user_restored");
    return json(route, 200, { data: { ...toSummary(u), activeSession: u.activeSession ?? null } });
  });

  await page.route("**/api/admin/users/*/force-logout", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    if (adminForceLogoutFails) return json(route, 500, { error: "Internal server error" });
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const u = users.find((x) => x.googleUserId === id);
    const hadSession = Boolean(u?.activeSession);
    if (u) u.activeSession = null;
    if (u && hadSession) appendAudit(u.googleUserId, "admin_user_sessions_revoked");
    return json(route, 200, { data: { revokedCount: hadSession ? 1 : 0 } });
  });

  // GET /api/admin/users/:googleUserId — must be registered AFTER the more
  // specific /audit, /disable, /restore, /force-logout patterns above, since
  // Playwright matches in registration order and this pattern would otherwise
  // swallow all of them.
  await page.route("**/api/admin/users/*", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (!adminSignedIn) return adminUnauthenticated(route);
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const u = users.find((x) => x.googleUserId === id);
    if (!u) return json(route, 404, { error: "User not found", code: "USER_NOT_FOUND" });
    return json(route, 200, { data: { ...toSummary(u), activeSession: u.activeSession ?? null } });
  });

  /* ---- License Management (Phase 5) --------------------------------------
   * A small stateful tier catalog + a single quota, enough to drive the admin
   * license pages end-to-end. Mirrors the {data, meta?} envelope exactly.
   */
  const tiers = [
    { id: 1, name: "Free", isUnlimited: false, scanLimit: 30, validityDays: null, isDefault: true, sortOrder: 0, archivedAt: null, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null, assignedCount: 0 },
    { id: 2, name: "Professional", isUnlimited: false, scanLimit: 1000, validityDays: 365, isDefault: false, sortOrder: 1, archivedAt: null, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null, assignedCount: 0 },
    { id: 3, name: "Enterprise", isUnlimited: true, scanLimit: null, validityDays: 365, isDefault: false, sortOrder: 2, archivedAt: null, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null, assignedCount: 0 },
  ];
  let nextTierId = 4;
  const licenseUser = "u1";
  const quota = {
    googleUserId: licenseUser,
    freeLimit: 30,
    freeUsed: 0,
    freeRemaining: 30,
    hasFreeOverride: false,
    paidRemaining: 0,
    totalRemaining: 30,
    scanBlocked: false,
    scanBlockedAt: null as string | null,
    scanBlockedBy: null as string | null,
    unlimited: false,
    activeTier: null as { tierId: number; name: string; unlimited: boolean; unlimitedUntil: string | null; expiresAt: string | null } | null,
    paidGrants: [] as unknown[],
  };

  await page.route("**/api/admin/licenses/settings", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    return json(route, 200, {
      data: {
        defaultFreeLimit: 30,
        defaultPaidLimit: 0,
        freeEnabled: true,
        paidEnabled: true,
        enforcementEnabled: true,
        updatedAt: "2026-01-01T00:00:00Z",
        updatedBy: null,
      },
    });
  });

  await page.route("**/api/admin/licenses/tiers", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const tier = { id: nextTierId++, name: body.name, isUnlimited: !!body.isUnlimited, scanLimit: body.isUnlimited ? null : body.scanLimit, validityDays: body.validityDays ?? null, isDefault: false, sortOrder: 99, archivedAt: null, updatedAt: "2026-01-01T00:00:00Z", updatedBy: "admin", assignedCount: 0 };
      tiers.push(tier);
      return json(route, 201, { data: tier });
    }
    return json(route, 200, { data: { tiers } });
  });

  await page.route("**/api/admin/licenses/tiers/*/clone", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    const body = JSON.parse(route.request().postData() ?? "{}");
    const src = tiers.find((t) => t.id === Number(route.request().url().split("/").at(-2)));
    const tier = { ...(src ?? tiers[0]), id: nextTierId++, name: body.name, isDefault: false, assignedCount: 0 };
    tiers.push(tier);
    return json(route, 201, { data: tier });
  });

  await page.route("**/api/admin/licenses/tiers/*", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    const id = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    const tier = tiers.find((t) => t.id === id);
    if (route.request().method() === "DELETE") {
      if (tier?.isDefault) {
        return json(route, 400, { error: "cannot archive the default tier", code: "LICENSE_INVALID" });
      }
      return route.fulfill({ status: 204, body: "" });
    }
    if (route.request().method() === "PATCH" && tier) {
      Object.assign(tier, JSON.parse(route.request().postData() ?? "{}"));
      return json(route, 200, { data: tier });
    }
    return json(route, 404, { error: "Tier not found", code: "TIER_NOT_FOUND" });
  });

  await page.route("**/api/admin/licenses/quotas?*", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    return json(route, 200, {
      data: {
        quotas: [quota],
        stats: { usersWithQuota: 1, scanBlocked: quota.scanBlocked ? 1 : 0, totalFreeUsed: quota.freeUsed, totalPaidUsed: 0, lowRemaining: 0 },
      },
      meta: { page: { total: 1, totalPages: 1, nextCursor: null, limit: 20 } },
    });
  });

  await page.route("**/api/admin/licenses/quotas/*/tier", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    if (route.request().method() === "POST") {
      const { tierId } = JSON.parse(route.request().postData() ?? "{}");
      const tier = tiers.find((t) => t.id === tierId)!;
      quota.activeTier = { tierId: tier.id, name: tier.name, unlimited: tier.isUnlimited, unlimitedUntil: null, expiresAt: null };
      quota.unlimited = tier.isUnlimited;
    } else {
      quota.activeTier = null;
      quota.unlimited = false;
    }
    return json(route, 200, { data: quota });
  });

  await page.route("**/api/admin/licenses/quotas/*/tier-history", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    return json(route, 200, { data: { entries: [] }, meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } } });
  });

  await page.route("**/api/admin/licenses/quotas/*/history", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    return json(route, 200, { data: { entries: [] }, meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } } });
  });

  await page.route("**/api/admin/licenses/quotas/*", (route) => {
    if (!adminSignedIn) return adminUnauthenticated(route);
    return json(route, 200, { data: quota });
  });

  const revoked = (route: Route) =>
    json(route, 401, {
      error: "Your session was ended because you signed in on another device",
      code: "SESSION_REVOKED",
    });

  // Auth status — the single query that gates the whole authenticated shell,
  // and (thanks to refetchOnWindowFocus) the one that surfaces a revoked
  // session on an otherwise idle tab.
  await page.route("**/api/auth/google/status", (route) => {
    if (sessionRevoked) return revoked(route);
    return json(route, 200, {
      authenticated,
      email: "ada@analyticalengines.com",
      needsReconnect,
      spreadsheetTitle: "Card2Contact Contacts",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/mock-sheet",
      savedContactsCount,
    });
  });

  await page.route("**/api/auth/logout", (route) => json(route, 200, { ok: true }));

  // Session Conflict resolution. Both authenticate via the short-lived pending
  // cookie the backend set during the OAuth callback.
  await page.route("**/api/auth/session/continue", (route) => {
    if (continueFails) {
      // What an expired Pending Session (5 min TTL) looks like.
      return json(route, 401, { error: "This sign-in request expired — please sign in again" });
    }
    return json(route, 200, { ok: true });
  });
  await page.route("**/api/auth/session/cancel", (route) => json(route, 200, { ok: true }));

  // M1 submit
  await page.route("**/api/cards", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return json(route, 201, { cardId: "e2e-card-1", mode: "single" });
  });

  // M2 recognize — refused when scanRefusal is set (License Management gating).
  await page.route("**/api/cards/*/recognize", (route) => {
    if (scanRefusal === "quota") {
      return json(route, 402, {
        error: "Scan quota exhausted — contact your administrator",
        code: "QUOTA_EXCEEDED",
      });
    }
    if (scanRefusal === "blocked") {
      return json(route, 403, {
        error: "Scanning is blocked for your account — contact your administrator",
        code: "SCAN_BLOCKED",
      });
    }
    return json(route, 200, { cardId: "e2e-card-1", rawText: "Ada Lovelace\nAnalytical Engines Inc" });
  });

  // M3 extract
  await page.route("**/api/cards/*/extract", (route) =>
    json(route, 200, {
      cardId: "e2e-card-1",
      contact: {
        name: "Ada Lovelace",
        designation: "Chief Analyst",
        phones: ["+15550101842"],
        email: "ada@analyticalengines.com",
        company: "Analytical Engines Inc",
        addresses: [],
        note: "",
        category: "",
      },
    }),
  );

  // M4 patch + confirm
  await page.route("**/api/cards/*/contact", (route) =>
    json(route, 200, { cardId: "e2e-card-1", contact: route.request().postDataJSON?.() ?? {} }),
  );
  await page.route("**/api/cards/*/confirm", (route) =>
    json(route, 200, { cardId: "e2e-card-1", confirmed: true, contact: {} }),
  );

  // M5 save
  await page.route("**/api/contacts/save", (route) => {
    if (saveReauthRequired) {
      return json(route, 401, {
        error: "Google access was revoked or expired — please reconnect",
        code: "REAUTH_REQUIRED",
      });
    }
    return json(route, 200, { cardId: "e2e-card-1", saved: true });
  });
}
