import { CardSessionStore } from "../../shared/store/card-session-store";
import { CardSession } from "../../shared/types/card-session";
import { Contact } from "../../shared/types/contact";
import { PipelineOrderError } from "../../shared/http/pipeline-errors";
import { UserRecord, UserStore } from "../../shared/store/user-store";
import { SheetsProvisioner } from "../../shared/sheets/sheets-provisioner";
import { OAuth2Client } from "google-auth-library";
import { SheetNotFoundError, SheetsClient } from "./google-sheets.client";

/**
 * Separator used to collapse multi-value contact fields (phones, addresses)
 * into the single Phone / Address cells of the fixed-schema sheet.
 */
export const MULTI_VALUE_SEPARATOR = "; ";

/**
 * The fixed column order of every user's sheet. Single source of truth for both
 * the header row written at provisioning time and the per-row mapping below, so
 * the two can never drift.
 */
export const SHEET_HEADER = [
  "Name",
  "Designation",
  "Phone",
  "Email",
  "Company",
  "Address",
  "Note",
  "Category",
] as const;

/** Title given to each user's auto-created spreadsheet. */
export const SPREADSHEET_TITLE = "Card2Contact Contacts";

/**
 * Pure mapping from a confirmed Contact to a single spreadsheet row, in the
 * fixed column order (SHEET_HEADER). Multi-value fields join with "; ".
 */
export function contactToRow(contact: Contact): string[] {
  return [
    contact.name,
    contact.designation,
    contact.phones.join(MULTI_VALUE_SEPARATOR),
    contact.email,
    contact.company,
    contact.addresses.join(MULTI_VALUE_SEPARATOR),
    contact.note,
    contact.category,
  ];
}

function headerMatches(actual: string[] | null): boolean {
  if (actual === null) return false;
  if (actual.length < SHEET_HEADER.length) return false;
  return SHEET_HEADER.every((h, i) => actual[i] === h);
}

/**
 * M5 — Google Sheets Integration (docs/modules/M5-Google-Sheets-Integration.md).
 * Appends the confirmed contact to the CURRENT user's own spreadsheet, with
 * resilience baked in:
 *  - Header integrity: read row 1 and repair it if it drifted (no versioning).
 *  - Deleted sheet: if the sheet 404s, recreate it, persist the new id, retry once.
 *  - Revoked access: ReauthRequiredError propagates so the client can reconnect.
 * Depends on M4 having confirmed the contact first.
 */
export class M5Service {
  constructor(
    private readonly store: CardSessionStore,
    private readonly sheets: SheetsClient,
    private readonly provisioner: SheetsProvisioner,
    private readonly userStore: UserStore
  ) {}

  /**
   * @param user       the authenticated user (owns the target spreadsheet)
   * @param authClient the user's authorized OAuth2Client, for re-provisioning on 404.
   * `provisioner.ensureSpreadsheet` persists any newly-created spreadsheet id,
   * so this service never writes to the user store directly.
   */
  async save(cardId: string, user: UserRecord, authClient: OAuth2Client): Promise<CardSession> {
    const session = this.store.get(cardId);

    if (session.confirmed !== true || session.contact === null) {
      throw new PipelineOrderError("contact confirmation (M4 /confirm)");
    }

    const row = contactToRow(session.contact);
    // Login provisions the sheet, so spreadsheetId is normally set — recover if not.
    let spreadsheetId = user.spreadsheetId
      ? user.spreadsheetId
      : await this.provisioner.ensureSpreadsheet(user, authClient);

    // Header integrity: repair row 1 if it drifted from SHEET_HEADER.
    const header = await this.sheets.readHeader(spreadsheetId);
    if (header === null) {
      // Sheet is gone — recreate before we even append.
      spreadsheetId = await this.provisioner.ensureSpreadsheet(user, authClient);
    } else if (!headerMatches(header)) {
      await this.sheets.writeHeader(spreadsheetId, [...SHEET_HEADER]);
    }

    try {
      await this.sheets.appendRow(spreadsheetId, row);
    } catch (err) {
      if (err instanceof SheetNotFoundError) {
        // User deleted the sheet between the header check and append: recreate,
        // persist the new id, and retry the append exactly once.
        spreadsheetId = await this.provisioner.ensureSpreadsheet(user, authClient);
        await this.sheets.appendRow(spreadsheetId, row);
      } else {
        // ReauthRequiredError and anything else propagate to the router.
        throw err;
      }
    }

    // Postgres is the source of truth for "how many contacts has this user
    // saved" — cheaper to read on the dashboard than re-counting sheet rows,
    // and it can never drift since it only increments right here, once per
    // successful append.
    await this.userStore.incrementSavedContactsCount(user.googleUserId);

    return this.store.update(cardId, { saved: true });
  }
}
