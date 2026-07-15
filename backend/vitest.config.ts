import { defineConfig } from "vitest/config";

/**
 * Backend test runner config.
 *
 * Test layout is split intentionally:
 *  - Legacy co-located specs still live next to source (src, *.test.ts)
 *    (they predate this structure and pass; moving them buys nothing).
 *  - New specs live under tests/unit and tests/integration per the layout.
 * Both globs are included below so `npm test` runs everything.
 *
 * Integration specs (supertest against a real Express app) need a handful of
 * env vars present at import time — `tests/helpers/env.ts` sets safe test
 * defaults via `setupFiles`, so no real secrets are required for the mocked
 * integration suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["tests/helpers/env.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "text-summary", "html", "lcov"],
      // Measure only our own source, not test scaffolding or the entrypoint.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/**/*.d.ts"],
    },
  },
});
