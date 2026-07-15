import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";

/**
 * Frontend test runner. jsdom environment for component/hook tests; the `@/*`
 * path alias is resolved by vite-tsconfig-paths so tests import exactly like
 * app code. Playwright E2E specs live under tests/e2e and are run by Playwright
 * (playwright.config.ts), NOT vitest — excluded here so vitest doesn't try to
 * load them.
 */
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    // Explicit alias mirrors tsconfig `paths` — belt-and-suspenders so `@/*`
    // resolves under vitest regardless of tsconfigPaths' include scanning.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["tests/utils/setup.ts"],
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "text-summary", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/vite-env.d.ts",
        // Pure presentational shells with no logic — excluded to keep the
        // coverage signal focused on logic we actually assert.
        "src/shared/components/ui/**",
      ],
    },
  },
});
