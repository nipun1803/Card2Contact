import { test, expect } from "@playwright/test";
import { mockBackend } from "./mockApi";

/**
 * Authenticated UI journey: dashboard → scan (upload) → review → save → success,
 * plus the reconnect branch and logout. Real Google OAuth can't run in an
 * automation-controlled browser (Google blocks it), so the backend API is
 * mocked at the network layer (see mockApi.ts) to serve a deterministic
 * authenticated session. The React app runs unmodified against these stubs.
 */

const smallPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("authenticated dashboard", () => {
  test("loads the dashboard for a signed-in user (no bounce to /login)", async ({ page }) => {
    await mockBackend(page, { savedContactsCount: 7 });
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page).not.toHaveURL(/\/login/);
    // Server-tracked saved count is surfaced.
    await expect(page.getByText("7")).toBeVisible();
  });

  test("visiting /login while authenticated bounces to the dashboard", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/login");
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

test.describe("scan → review → save", () => {
  test("uploads a card, reviews the extracted contact, and saves it", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/app?source=upload");

    // M1 — pick a file, then submit.
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "card.png",
      mimeType: "image/png",
      buffer: smallPng,
    });
    await page.getByRole("button", { name: /scan card/i }).click();

    // M2/M3 run (mocked) → review form with the extracted contact.
    await expect(page.getByLabel(/^name/i)).toHaveValue("Ada Lovelace", { timeout: 15_000 });

    // M4/M5 — save.
    await page.getByRole("button", { name: /save to google sheets/i }).click();

    // Success screen.
    await expect(page.getByRole("heading", { name: /contact saved/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("routes to the reconnect screen when save returns REAUTH_REQUIRED", async ({ page }) => {
    await mockBackend(page, { saveReauthRequired: true });
    await page.goto("/app?source=upload");

    await page.locator('input[type="file"]').first().setInputFiles({
      name: "card.png",
      mimeType: "image/png",
      buffer: smallPng,
    });
    await page.getByRole("button", { name: /scan card/i }).click();
    await expect(page.getByLabel(/^name/i)).toHaveValue("Ada Lovelace", { timeout: 15_000 });
    await page.getByRole("button", { name: /save to google sheets/i }).click();

    // The reconnect panel is shown instead of the success screen.
    await expect(page.getByRole("heading", { name: /reconnect google/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
