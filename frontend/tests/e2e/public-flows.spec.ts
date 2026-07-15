import { test, expect } from "@playwright/test";

/**
 * Unauthenticated E2E flows against the real Docker stack (nginx :8080). These
 * need no Google login, so they run in every CI/local invocation across all
 * browser projects (chromium/firefox/webkit/mobile).
 */

test.describe("Landing", () => {
  test("renders the hero and a Get started CTA", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /turn business cards into contacts/i }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /get started/i })).toBeVisible();
  });

  test("Get started navigates to the login page", async ({ page }) => {
    await page.goto("/");
    const cta = page.getByRole("link", { name: /get started/i });
    // Wait for the lazy landing chunk to settle before clicking (Firefox can
    // otherwise race the client-side nav on a cold chunk load).
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: /sign in to card2contact/i })).toBeVisible();
  });
});

test.describe("Login", () => {
  test("shows the Google sign-in link pointing at the backend OAuth entry", async ({ page }) => {
    await page.goto("/login");
    const signIn = page.getByRole("link", { name: /continue with google/i });
    await expect(signIn).toBeVisible();
    // Assert the destination without navigating to Google (keeps the test hermetic).
    await expect(signIn).toHaveAttribute("href", "/api/auth/google");
  });
});

test.describe("Route guards", () => {
  test("unauthenticated access to a protected route redirects to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated access to the scan app redirects to /login", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login/);
  });

  test("an unknown route lands on the 404 page", async ({ page }) => {
    await page.goto("/this-does-not-exist");
    await expect(page).toHaveURL(/\/404/);
  });
});

test.describe("Accessibility & responsiveness", () => {
  test("landing has exactly one h1 and a page title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/card2contact/i);
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("login renders within a narrow mobile viewport without horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/login");
    await expect(page.getByRole("link", { name: /continue with google/i })).toBeVisible();
    // Body must not overflow horizontally.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(overflow).toBe(true);
  });
});
