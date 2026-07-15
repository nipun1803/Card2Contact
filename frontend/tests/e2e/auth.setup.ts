import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { AUTH_STATE } from "./helpers";

/**
 * ONE-TIME interactive auth capture. Real Google OAuth can't be automated for a
 * production client, so this opens a headed browser, lets a human complete the
 * Google consent, waits until the app shows the authenticated dashboard, then
 * saves the signed-in cookies to tests/e2e/.auth/user.json for the authed specs
 * to reuse.
 *
 * Run explicitly (headed, no timeout pressure):
 *   npx playwright test auth.setup.ts --project=chromium --headed
 *
 * It is NOT part of the default run (the projects don't declare it as a
 * dependency) so the automated suite never blocks waiting for a human.
 */
setup("capture google login", async ({ page }) => {
  setup.setTimeout(180_000); // up to 3 min for the human to log in

  await page.goto("/login");
  // The sign-in control is a link (<a href="/api/auth/google">) labelled
  // "Continue with Google" — clicking it starts the OAuth redirect chain.
  await page.getByRole("link", { name: /continue with google/i }).click();

  // Human completes Google consent here. We wait until we're back on an
  // authenticated app route (dashboard) as the success signal.
  await page.waitForURL(/\/dashboard/, { timeout: 180_000 });
  await expect(page).toHaveURL(/\/dashboard/);

  fs.mkdirSync(path.dirname(AUTH_STATE), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE });
});
