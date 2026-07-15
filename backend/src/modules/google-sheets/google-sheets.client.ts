import { drive_v3, google, sheets_v4 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { ReauthRequiredError } from "../../shared/http/pipeline-errors";

/**
 * Isolated Google Sheets integration for M5. This is the ONLY place the
 * `googleapis` SDK is referenced — the service depends on the `SheetsClient`
 * interface below, so Google specifics never leak into business logic.
 *
 * The client is now PER-USER: it's constructed per request from a specific
 * user's authorized OAuth2Client, and every method takes the target
 * `spreadsheetId` (each user has their own auto-provisioned sheet).
 */
export interface SheetsClient {
  /**
   * Append one already-mapped row to the given spreadsheet. One API call, no
   * retry loop (recovery is orchestrated in the service). Throws
   * SheetNotFoundError (deleted sheet) or ReauthRequiredError (revoked access)
   * for the recoverable cases, via `classifyGoogleError`.
   */
  appendRow(spreadsheetId: string, row: string[]): Promise<void>;
  /** Create a new spreadsheet, seed its header row, return the new id. */
  createSpreadsheetWithHeader(title: string, header: string[]): Promise<string>;
  /** Read row 1 of the sheet; null if the sheet is missing (404). */
  readHeader(spreadsheetId: string): Promise<string[] | null>;
  /** Overwrite row 1 with the given header (repair drift). */
  writeHeader(spreadsheetId: string, header: string[]): Promise<void>;
  /**
   * Whether the spreadsheet is in the owner's Trash or gone entirely.
   *
   * This needs the Drive API, not Sheets: a trashed spreadsheet reads and
   * writes perfectly well through the Sheets API and never 404s, so Sheets
   * simply cannot tell us. Without this check contacts land silently in a bin
   * the user cannot see.
   */
  isTrashed(spreadsheetId: string): Promise<boolean>;
}

/** Deleted-sheet signal used by the M5 save-with-recovery flow (not an HTTP error). */
export class SheetNotFoundError extends Error {
  constructor(spreadsheetId: string) {
    super(`Spreadsheet ${spreadsheetId} not found`);
    this.name = "SheetNotFoundError";
  }
}

const HEADER_RANGE = "A1"; // create/repair the header in the first row/tab

/**
 * Normalize a googleapis/gaxios error into our domain errors so the service
 * layer never inspects Google-specific error shapes:
 * - 404 -> SheetNotFoundError (recover by recreating the sheet)
 * - 401 / invalid_grant -> ReauthRequiredError (prompt the user to reconnect)
 * - anything else -> rethrown unchanged (client-driven retry / 500)
 */
export function classifyGoogleError(err: unknown): never {
  const anyErr = err as {
    code?: number | string;
    response?: { status?: number; data?: { error?: string } };
    errors?: Array<{ reason?: string }>;
  };
  const status =
    typeof anyErr?.code === "number"
      ? anyErr.code
      : anyErr?.response?.status ?? Number(anyErr?.code);
  const oauthError = anyErr?.response?.data?.error;

  if (status === 404) {
    throw new SheetNotFoundError("(target spreadsheet)");
  }
  if (status === 401 || oauthError === "invalid_grant") {
    throw new ReauthRequiredError();
  }
  throw err;
}

export class GoogleSheetsClient implements SheetsClient {
  private readonly sheets: sheets_v4.Sheets;
  private readonly drive: drive_v3.Drive;

  constructor(auth: OAuth2Client) {
    this.sheets = google.sheets({ version: "v4", auth });
    // Drive is needed solely for the `trashed` flag — see isTrashed. Scoped to
    // drive.file (files this app created), the narrowest scope that works.
    this.drive = google.drive({ version: "v3", auth });
  }

  async isTrashed(spreadsheetId: string): Promise<boolean> {
    try {
      const { data } = await this.drive.files.get({
        fileId: spreadsheetId,
        fields: "trashed",
      });
      return data.trashed === true;
    } catch (err) {
      try {
        classifyGoogleError(err);
      } catch (classified) {
        // Hard-deleted (or beyond our drive.file grant): unusable either way,
        // and the recovery is identical to the trashed case.
        if (classified instanceof SheetNotFoundError) return true;
        throw classified;
      }
      return false;
    }
  }

  async appendRow(spreadsheetId: string, row: string[]): Promise<void> {
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: HEADER_RANGE,
        // RAW so a leading "+" (phone) or "=" (note) is never read as a formula.
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      });
    } catch (err) {
      classifyGoogleError(err);
    }
  }

  async createSpreadsheetWithHeader(title: string, header: string[]): Promise<string> {
    // `create` cannot seed rows, so create then write the header separately.
    const { data } = await this.sheets.spreadsheets.create({
      requestBody: { properties: { title } },
    });
    const spreadsheetId = data.spreadsheetId;
    if (!spreadsheetId) {
      throw new Error("Sheets create returned no spreadsheetId");
    }
    await this.writeHeader(spreadsheetId, header);
    return spreadsheetId;
  }

  async readHeader(spreadsheetId: string): Promise<string[] | null> {
    try {
      const { data } = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "1:1", // entire first row
      });
      const firstRow = data.values?.[0] ?? [];
      return firstRow.map((cell) => String(cell ?? ""));
    } catch (err) {
      // A missing sheet reads as not-found; report null so the caller recovers.
      try {
        classifyGoogleError(err);
      } catch (classified) {
        if (classified instanceof SheetNotFoundError) return null;
        throw classified;
      }
      return null;
    }
  }

  async writeHeader(spreadsheetId: string, header: string[]): Promise<void> {
    try {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range: HEADER_RANGE,
        valueInputOption: "RAW",
        requestBody: { values: [header] },
      });
    } catch (err) {
      classifyGoogleError(err);
    }
  }
}

/**
 * Per-user factory: builds a Sheets client from an already-authorized
 * OAuth2Client (see GoogleAuthService.authClientForUser). Kept as a factory so
 * the router constructs the real client per request while tests inject a fake.
 */
export function createGoogleSheetsClient(auth: OAuth2Client): SheetsClient {
  return new GoogleSheetsClient(auth);
}
