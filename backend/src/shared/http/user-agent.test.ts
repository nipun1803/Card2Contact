import { describe, expect, it } from "vitest";
import { parseUserAgent } from "./user-agent";

// Real UA strings — synthetic ones hide the substring overlaps that make
// match ordering load-bearing.
const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  operaWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
};

describe("parseUserAgent", () => {
  describe("browser detection order", () => {
    // Each of these would resolve to the wrong browser if the match table
    // were reordered — they exist to pin the ordering, not just the output.
    it("reports Edge, not Chrome, for an Edge UA containing 'Chrome/'", () => {
      expect(parseUserAgent(UA.edgeWindows).browser).toBe("Edge");
    });

    it("reports Opera, not Chrome, for an Opera UA containing 'Chrome/'", () => {
      expect(parseUserAgent(UA.operaWindows).browser).toBe("Opera");
    });

    it("reports Chrome, not Safari, for a Chrome UA containing 'Safari/'", () => {
      expect(parseUserAgent(UA.chromeMac).browser).toBe("Chrome");
    });

    it("reports Safari for a genuine Safari UA", () => {
      expect(parseUserAgent(UA.safariMac).browser).toBe("Safari");
    });

    it("reports Firefox", () => {
      expect(parseUserAgent(UA.firefoxLinux).browser).toBe("Firefox");
    });
  });

  describe("device detection order", () => {
    it("reports iPhone, not macOS, for an iOS UA containing 'like Mac OS X'", () => {
      expect(parseUserAgent(UA.safariIphone).device).toBe("iPhone");
    });

    it("reports Android, not Linux, for an Android UA containing 'Linux'", () => {
      expect(parseUserAgent(UA.chromeAndroid).device).toBe("Android");
    });

    it("reports macOS for a desktop Mac UA", () => {
      expect(parseUserAgent(UA.chromeMac).device).toBe("macOS");
    });

    it("reports Windows", () => {
      expect(parseUserAgent(UA.edgeWindows).device).toBe("Windows");
    });

    it("reports Linux for a desktop Linux UA", () => {
      expect(parseUserAgent(UA.firefoxLinux).device).toBe("Linux");
    });
  });

  describe("degradation", () => {
    it("returns Unknown for an absent UA", () => {
      expect(parseUserAgent(undefined)).toEqual({
        device: "Unknown device",
        browser: "Unknown browser",
      });
    });

    it("returns Unknown for an empty UA", () => {
      expect(parseUserAgent("")).toEqual({
        device: "Unknown device",
        browser: "Unknown browser",
      });
    });

    it("returns Unknown for an unrecognised UA rather than throwing", () => {
      expect(parseUserAgent("curl/8.4.0")).toEqual({
        device: "Unknown device",
        browser: "Unknown browser",
      });
    });

    it("handles a hostile multi-KB UA without hanging", () => {
      const hostile = "A".repeat(100_000);
      const start = Date.now();
      expect(parseUserAgent(hostile)).toEqual({
        device: "Unknown device",
        browser: "Unknown browser",
      });
      expect(Date.now() - start).toBeLessThan(50);
    });

    it("still classifies when the marker is within the 256-char cap", () => {
      expect(parseUserAgent(UA.chromeMac).browser).toBe("Chrome");
    });
  });
});
