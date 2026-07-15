import { describe, expect, it, vi } from "vitest";
import { downscaleImage, previewUrl } from "@/shared/utils/files";
import { makeImageFile } from "../fixtures/contacts";

/**
 * downscaleImage is best-effort: it must NEVER block a scan, so every failure
 * path returns the original file unchanged. jsdom has no real canvas/
 * createImageBitmap, which lets us verify the graceful-fallback contract
 * (the happy downscale path is covered by the E2E run against a real browser).
 */
describe("downscaleImage", () => {
  it("returns non-image files untouched", async () => {
    const pdf = new File(["x"], "notes.pdf", { type: "application/pdf" });
    expect(await downscaleImage(pdf)).toBe(pdf);
  });

  it("falls back to the original file when bitmap decoding is unavailable/throws", async () => {
    // jsdom: createImageBitmap is undefined → the try/catch returns the original.
    const img = makeImageFile();
    const result = await downscaleImage(img);
    expect(result).toBe(img);
  });

  it("falls back to the original when createImageBitmap rejects", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode fail")));
    const img = makeImageFile();
    expect(await downscaleImage(img)).toBe(img);
    vi.unstubAllGlobals();
  });
});

describe("previewUrl", () => {
  it("creates an object URL for a file", () => {
    const url = previewUrl(makeImageFile());
    expect(url).toMatch(/^blob:/);
  });
});
