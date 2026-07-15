import { describe, expect, it, beforeEach } from "vitest";
import {
  addRecentScan,
  getRecentScans,
  clearRecentScans,
} from "@/shared/services/recentScans";
import { RECENT_SCANS_LIMIT } from "@/shared/lib/constants";
import { makeContact } from "../fixtures/contacts";

/**
 * recentScans is the only client-persisted state (localStorage). jsdom provides
 * a real localStorage, so these tests exercise the actual read/write/parse path
 * including the malformed-data guard.
 */
describe("recentScans", () => {
  beforeEach(() => localStorage.clear());

  it("returns an empty array when nothing is stored", () => {
    expect(getRecentScans()).toEqual([]);
  });

  it("prepends a newly added scan (most recent first)", () => {
    addRecentScan("card-1", makeContact({ name: "First" }));
    addRecentScan("card-2", makeContact({ name: "Second" }));
    const scans = getRecentScans();
    expect(scans[0].name).toBe("Second");
    expect(scans[1].name).toBe("First");
  });

  it("stores id, name, company, email and an ISO timestamp", () => {
    addRecentScan("card-1", makeContact({ name: "Ada", company: "AE Inc", email: "a@x.com" }));
    const [scan] = getRecentScans();
    expect(scan).toMatchObject({ id: "card-1", name: "Ada", company: "AE Inc", email: "a@x.com" });
    expect(() => new Date(scan.savedAt).toISOString()).not.toThrow();
  });

  it("caps the history at RECENT_SCANS_LIMIT entries", () => {
    for (let i = 0; i < RECENT_SCANS_LIMIT + 5; i++) {
      addRecentScan(`card-${i}`, makeContact({ name: `N${i}` }));
    }
    expect(getRecentScans()).toHaveLength(RECENT_SCANS_LIMIT);
  });

  it("clears the history", () => {
    addRecentScan("card-1", makeContact());
    clearRecentScans();
    expect(getRecentScans()).toEqual([]);
  });

  it("returns [] (not a crash) when the stored value is malformed JSON", () => {
    localStorage.setItem("c2c.recentScans", "{not json");
    expect(getRecentScans()).toEqual([]);
  });

  it("returns [] when the stored value is a non-array", () => {
    localStorage.setItem("c2c.recentScans", JSON.stringify({ foo: "bar" }));
    expect(getRecentScans()).toEqual([]);
  });
});
