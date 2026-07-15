import { describe, expect, it } from "vitest";
import { featureFlags, isFeatureEnabled } from "@/shared/lib/featureFlags";

/**
 * Flags are computed at import time from import.meta.env. With no VITE_FLAG_*
 * set in the test env, every flag defaults to enabled — this test pins that
 * default contract and the full flag set (so a renamed/removed flag is caught).
 */
describe("featureFlags", () => {
  it("defaults every flag to enabled when no env override is set", () => {
    expect(featureFlags).toEqual({
      camera: true,
      upload: true,
      googleOAuth: true,
      darkMode: true,
      animations: true,
      recentScans: true,
    });
  });

  it("isFeatureEnabled reflects the flag map", () => {
    expect(isFeatureEnabled("camera")).toBe(true);
    expect(isFeatureEnabled("recentScans")).toBe(true);
  });
});
