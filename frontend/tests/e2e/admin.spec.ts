import { expect, test } from "@playwright/test";
import { mockBackend } from "./mockApi";

/**
 * Admin authentication in a real browser, through nginx.
 *
 * Note the deliberate locators: getByLabel("Password") is AMBIGUOUS here — it
 * matches both the input and the toggle button's "Show password" aria-label, and
 * Playwright's strict mode rejects it. The password field is addressed by role
 * instead. (An <input type=password> is still exposed as role=textbox; ARIA has
 * no password role.)
 *
 * The highest-value case here is E2: /admin/login must render for someone who is
 * ALREADY signed in with Google. That is the exact bug putting the route under
 * PublicOnly would cause — that guard bounces authenticated users to /dashboard,
 * so an operator who also uses the product could never reach the admin login.
 * It cannot be caught by a unit test of either guard in isolation; it only shows
 * up once the real router is assembled.
 */

test.describe("admin login page", () => {
  test("E1: renders for an anonymous visitor", async ({ page }) => {
    await mockBackend(page, { authenticated: false });

    await page.goto("/admin/login");

    await expect(page.getByRole("heading", { name: /admin sign in/i })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Username" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Password" })).toBeVisible();
  });

  test("E2: renders even when signed in as a Google user (not bounced to /dashboard)", async ({
    page,
  }) => {
    await mockBackend(page, { authenticated: true });

    await page.goto("/admin/login");

    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByRole("heading", { name: /admin sign in/i })).toBeVisible();
  });

  test("E4: the show/hide toggle flips the input type", async ({ page }) => {
    await mockBackend(page, { authenticated: false });
    await page.goto("/admin/login");

    const password = page.getByRole("textbox", { name: "Password" });
    await expect(password).toHaveAttribute("type", "password");

    await page.getByRole("button", { name: /show password/i }).click();
    await expect(password).toHaveAttribute("type", "text");

    await page.getByRole("button", { name: /hide password/i }).click();
    await expect(password).toHaveAttribute("type", "password");
  });

  test("E5: invalid credentials show the generic error and stay on the page", async ({ page }) => {
    await mockBackend(page, { authenticated: false, adminLoginFails: true });
    await page.goto("/admin/login");

    await page.getByRole("textbox", { name: "Username" }).fill("admin");
    await page.getByRole("textbox", { name: "Password" }).fill("wrong");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByRole("alert")).toHaveText(/invalid credentials/i);
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test("E9: is usable on a mobile viewport with no horizontal scroll", async ({ page }) => {
    await mockBackend(page, { authenticated: false });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/admin/login");

    await expect(page.getByRole("textbox", { name: "Username" })).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});

test.describe("admin session journey", () => {
  test("E6: valid credentials land on the dashboard", async ({ page }) => {
    await mockBackend(page, { authenticated: false });
    await page.goto("/admin/login");

    await page.getByRole("textbox", { name: "Username" }).fill("admin");
    await page.getByRole("textbox", { name: "Password" }).fill("correct-horse");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
    // Proves GET /me resolved and the session cookie round-tripped. Scoped to
    // the "Signed in as" line — a bare getByText("admin") also matches the
    // heading and the URL-derived text.
    await expect(page.getByText(/signed in as/i)).toContainText("admin");
  });

  test("E7: logging out returns to the login page and re-guards the dashboard", async ({
    page,
  }) => {
    await mockBackend(page, { authenticated: false, adminAuthenticated: true });
    await page.goto("/admin/dashboard");

    await page.getByRole("button", { name: /log out/i }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);

    // The session is really gone: the guard bounces a direct revisit.
    await page.goto("/admin/dashboard");
    await expect(page).toHaveURL(/\/admin\/login$/);
  });
});

test.describe("admin dashboard is guarded", () => {
  test("E3: an anonymous visitor is redirected to /admin/login", async ({ page }) => {
    await mockBackend(page, { authenticated: false });

    await page.goto("/admin/dashboard");

    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  /**
   * E8 — the cross-contamination check at the UI layer. A Google session is not
   * an admin session; being signed into the product must not open the operator
   * surface.
   */
  test("E8: a signed-in Google user who is not an admin is redirected to /admin/login", async ({
    page,
  }) => {
    await mockBackend(page, { authenticated: true, adminAuthenticated: false });

    await page.goto("/admin/dashboard");

    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test("the admin area does not render the product navigation", async ({ page }) => {
    // Admin gets no AppLayout: that shell assumes a Google session an operator
    // may not have.
    await mockBackend(page, { authenticated: false, adminAuthenticated: true });

    await page.goto("/admin/dashboard");

    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
    await expect(page.getByRole("link", { name: /scan/i })).toHaveCount(0);
  });
});
