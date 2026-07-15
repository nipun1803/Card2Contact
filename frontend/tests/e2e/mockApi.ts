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
  } = opts;

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
