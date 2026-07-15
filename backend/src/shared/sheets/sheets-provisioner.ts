import { OAuth2Client } from "google-auth-library";
import { UserRecord } from "../store/user-store";

/**
 * Narrow, module-agnostic contract for "make sure this user has a usable
 * spreadsheet, and return its id". The google-auth module and the M5 recovery
 * path both need to provision a sheet, but neither may import the google-sheets
 * module (module-boundary rule). They depend on this shared interface instead;
 * `app.ts` (the composition root, allowed to know both modules) supplies the
 * implementation, closing over the google-sheets client factory + auth service.
 */
export interface SheetsProvisioner {
  /**
   * Create a fresh spreadsheet (with the standard header) for `user`, persist
   * its id on the user row, and return the new id. Called on first login and
   * when a previously-created sheet is found deleted during save.
   */
  ensureSpreadsheet(user: UserRecord, authClient: OAuth2Client): Promise<string>;
}
