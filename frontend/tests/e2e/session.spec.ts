import { expect, test } from "@playwright/test";
import { mockBackend } from "./mockApi";

/**
 * Single-active-session, end to end through the real Docker stack (nginx →
 * frontend), with the backend API mocked at the network boundary.
 *
 * Real Google OAuth cannot run in an automation-controlled browser, so the
 * OAuth round-trip itself is out of scope here (see docs/TESTING.md — the
 * manual auth.setup.ts covers it). What IS in scope is everything the user
 * actually sees: the Session Conflict prompt the callback redirects to, and the
 * revoked device's discovery that it was signed out.
 */

test.describe("Session Conflict prompt", () => {
  /**
   * Relative to now, not a fixed date: `timeAgo` renders "just now" / "3 hours
   * ago" / "5 days ago" depending on the gap, so a hardcoded timestamp would
   * quietly change what this page says as the calendar moves.
   */
  const conflictUrl = (lastActiveMsAgo = 3 * 60 * 60 * 1000) => {
    const params = new URLSearchParams({
      device: "iPhone",
      browser: "Safari",
      lastActive: new Date(Date.now() - lastActiveMsAgo).toISOString(),
    });
    return `/session-conflict?${params}`;
  };

  const CONFLICT_URL = conflictUrl();

  test("names the other device and explains the consequence", async ({ page }) => {
    await mockBackend(page, { authenticated: false });
    await page.goto(CONFLICT_URL);

    await expect(page.getByRole("heading", { name: /signed in somewhere else/i })).toBeVisible();
    // Enough for the user to recognise which device is theirs.
    await expect(page.getByText("Safari on iPhone")).toBeVisible();
    await expect(page.getByText(/last active 3 hours ago/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign out the other device/i }),
    ).toBeVisible();
  });

  test("shows 'just now' for a device that was active seconds ago", async ({ page }) => {
    await mockBackend(page, { authenticated: false });
    await page.goto(conflictUrl(5_000));

    await expect(page.getByText(/last active just now/i)).toBeVisible();
  });

  test("Continue signs this device in and lands on the dashboard", async ({ page }) => {
    // authenticated:true models the state after the backend activates the
    // session — the guard re-reads /status once the page invalidates it.
    await mockBackend(page, { authenticated: true });
    await page.goto(CONFLICT_URL);

    await page.getByRole("button", { name: /sign out the other device/i }).click();

    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("Cancel abandons the sign-in and returns to login", async ({ page }) => {
    await mockBackend(page, { authenticated: false });
    await page.goto(CONFLICT_URL);

    await page.getByRole("button", { name: /^cancel$/i }).click();

    await expect(page).toHaveURL(/\/login/);
  });

  test("an expired pending session sends the user back to sign in", async ({ page }) => {
    await mockBackend(page, { authenticated: false, continueFails: true });
    await page.goto(CONFLICT_URL);

    await page.getByRole("button", { name: /sign out the other device/i }).click();

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/expired/i)).toBeVisible();
  });

  test("renders on a mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBackend(page, { authenticated: false });
    await page.goto(CONFLICT_URL);

    await expect(page.getByRole("heading", { name: /signed in somewhere else/i })).toBeVisible();
    // The primary action must be reachable without horizontal scrolling.
    const button = page.getByRole("button", { name: /sign out the other device/i });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});

test.describe("a device whose session was revoked elsewhere", () => {
  test("is sent to /login and told why", async ({ page }) => {
    await mockBackend(page, { sessionRevoked: true });

    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/login/);
    // The whole point of SESSION_REVOKED over a bare 401: the user learns why.
    await expect(page.getByText(/signed in on another device/i)).toBeVisible();
  });

  test("does not show the retryable 'couldn’t verify' error", async ({ page }) => {
    // A revoked session is a definitive answer, not a failure to reach the
    // server — offering Retry would promise something that can never work.
    await mockBackend(page, { sessionRevoked: true });

    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/couldn’t verify your session/i)).toHaveCount(0);
  });

  test("cannot reach any protected route", async ({ page }) => {
    await mockBackend(page, { sessionRevoked: true });

    for (const route of ["/dashboard", "/app", "/profile"]) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login/);
    }
  });
});
