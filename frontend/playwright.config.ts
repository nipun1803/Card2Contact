import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. Tests run against the FULL Docker stack through nginx
 * (http://localhost:8080) — the real production topology — so they exercise the
 * actual nginx → backend → postgres → Google/Mistral path, not a mock.
 *
 * BASE_URL can override the target (e.g. to hit Vite directly on :5173).
 *
 * Cross-browser: chromium (Chrome), firefox, and webkit (Safari engine). Edge
 * is Chromium-based; the `chromium` project covers its engine. To run the
 * branded MS Edge channel specifically, add `channel: "msedge"` to a project.
 *
 * Auth: the pipeline's authenticated screens need a real Google login, which
 * can't be automated headlessly for a real OAuth client. `tests/e2e/auth.setup.ts`
 * captures a signed-in storageState ONCE (interactively) into
 * tests/e2e/.auth/user.json; authed specs reuse it. Specs tagged for auth are
 * skipped automatically when that file is absent, so the unauthenticated suite
 * always runs green in CI.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // Interactive auth capture (run explicitly with --headed). Declared as its
    // own project so Playwright recognizes *.setup.ts as runnable; it is NOT a
    // dependency of the browser projects, so the default suite never blocks on
    // a human login.
    { name: "setup", testMatch: /.*\.setup\.ts/ },

    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    // Mobile viewport (responsiveness check).
    { name: "mobile-chrome", use: { ...devices["Pixel 5"] } },
  ],
});
