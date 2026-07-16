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
  } = opts;

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

  // M2 recognize
  await page.route("**/api/cards/*/recognize", (route) =>
    json(route, 200, { cardId: "e2e-card-1", rawText: "Ada Lovelace\nAnalytical Engines Inc" }),
  );

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
