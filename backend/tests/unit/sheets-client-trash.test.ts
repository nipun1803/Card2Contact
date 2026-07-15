import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuth2Client } from "google-auth-library";

/**
 * GoogleSheetsClient.isTrashed — the Drive call behind Recreate Sheet.
 *
 * Drive is required because the Sheets API cannot answer this: a trashed
 * spreadsheet reads and writes normally and never 404s, so without this check
 * contacts would land silently in a bin the user cannot see.
 */

const filesGet = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({ spreadsheets: {} })),
    drive: vi.fn(() => ({ files: { get: filesGet } })),
  },
}));

import { createGoogleSheetsClient } from "../../src/modules/google-sheets/google-sheets.client";
import { ReauthRequiredError } from "../../src/shared/http/pipeline-errors";

const client = () => createGoogleSheetsClient({} as OAuth2Client);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isTrashed", () => {
  it("asks Drive only for the trashed field", async () => {
    filesGet.mockResolvedValue({ data: { trashed: false } });

    await client().isTrashed("sheet-1");

    // Narrow `fields` keeps the response small and the intent obvious.
    expect(filesGet).toHaveBeenCalledWith({ fileId: "sheet-1", fields: "trashed" });
  });

  it("is true for a trashed sheet", async () => {
    filesGet.mockResolvedValue({ data: { trashed: true } });
    expect(await client().isTrashed("sheet-1")).toBe(true);
  });

  it("is false for a healthy sheet", async () => {
    filesGet.mockResolvedValue({ data: { trashed: false } });
    expect(await client().isTrashed("sheet-1")).toBe(false);
  });

  it("is false when Drive omits the field", async () => {
    // Absent is not trashed — only an explicit `true` should trigger recovery.
    filesGet.mockResolvedValue({ data: {} });
    expect(await client().isTrashed("sheet-1")).toBe(false);
  });

  // Hard-deleted (or outside our drive.file grant): unusable either way, and
  // the recovery is identical to the trashed case.
  it("is true when the file is gone (404)", async () => {
    filesGet.mockRejectedValue({ code: 404 });
    expect(await client().isTrashed("sheet-1")).toBe(true);
  });

  it("propagates ReauthRequiredError on a 401 rather than reporting trashed", async () => {
    // Revoked access is not a missing sheet: recreating would be wrong, and
    // would burn a Sheets create on every save.
    filesGet.mockRejectedValue({ code: 401 });

    await expect(client().isTrashed("sheet-1")).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("propagates an unclassified error rather than silently recreating", async () => {
    const boom = Object.assign(new Error("Drive is down"), { code: 500 });
    filesGet.mockRejectedValue(boom);

    await expect(client().isTrashed("sheet-1")).rejects.toThrow("Drive is down");
  });
});
