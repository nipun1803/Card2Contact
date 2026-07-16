import { expect, test } from "@playwright/test";
import { mockBackend } from "./mockApi";

/**
 * License Management (Phase 5), in a real browser through nginx. The backend is
 * mocked at the network boundary (see mockApi.ts's license routes); the React
 * app is unchanged and unaware. Requires the stack running:
 *   docker compose up -d --build frontend
 */

test.describe("Tier catalog", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true });
  });

  test("lists the seeded tiers with type and assigned count", async ({ page }) => {
    await page.goto("/admin/tiers");
    await expect(page.getByRole("heading", { name: "Tiers" })).toBeVisible();
    await expect(page.getByText("Free")).toBeVisible();
    await expect(page.getByText("Professional")).toBeVisible();
    await expect(page.getByText("Enterprise")).toBeVisible();
    // The unlimited tier's type badge.
    await expect(page.getByText("Unlimited").first()).toBeVisible();
  });

  test("editing a tier shows the future-assignments impact note", async ({ page }) => {
    await page.goto("/admin/tiers");
    await page.getByRole("button", { name: /edit/i }).first().click();
    await expect(page.getByText(/future assignments only/i)).toBeVisible();
  });

  test("the editor hides the scan-limit field when Unlimited is chosen", async ({ page }) => {
    await page.goto("/admin/tiers");
    await page.getByRole("button", { name: /edit/i }).first().click();
    await expect(page.getByLabel(/scan limit/i)).toBeVisible();
    await page.getByLabel(/type/i).selectOption("unlimited");
    await expect(page.getByLabel(/scan limit/i)).toBeHidden();
  });
});

test.describe("Quota directory + assignment", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true });
  });

  test("assigning an unlimited tier flips the user to Unlimited", async ({ page }) => {
    await page.goto("/admin/licenses/u1");
    // Assign the Enterprise (unlimited) tier via the tier select + assign action.
    await page.getByLabel(/tier/i).selectOption({ label: "Enterprise" });
    await page.getByRole("button", { name: /assign tier/i }).click();
    // Confirm dialog, then the allowance shows Unlimited.
    await page.getByRole("button", { name: /confirm|assign/i }).last().click();
    await expect(page.getByText(/unlimited/i).first()).toBeVisible();
  });
});
