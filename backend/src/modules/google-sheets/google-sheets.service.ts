import { CardSessionStore } from "../../shared/store/card-session-store";
import { CardSession } from "../../shared/types/card-session";
import { Contact } from "../../shared/types/contact";
import { PipelineOrderError } from "../../shared/http/pipeline-errors";
import { UserRecord, UserStore } from "../../shared/store/user-store";
import { SheetsProvisioner } from "../../shared/sheets/sheets-provisioner";
import { AuditLogger } from "../../shared/audit/audit-logger";
import { Metrics } from "../../shared/observability/metrics";
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
 *  - Trashed/deleted sheet: abandon it and Recreate Sheet (see save()).
 *  - Header integrity: read row 1 and repair it if it drifted (no versioning).
 *  - Revoked access: ReauthRequiredError propagates so the router can null the
 *    tokens and the client can Reconnect.
 * Depends on M4 having confirmed the contact first.
 */
export class M5Service {
  constructor(
    private readonly store: CardSessionStore,
    private readonly sheets: SheetsClient,
    private readonly provisioner: SheetsProvisioner,
    private readonly userStore: UserStore,
    private readonly audit: AuditLogger,
    private readonly metrics: Metrics
  ) {}

  /** Recreate Sheet: abandon the unusable spreadsheet and provision a fresh one. */
  private async recreateSheet(
    user: UserRecord,
    authClient: OAuth2Client,
    reason: "trashed" | "not_found"
  ): Promise<string> {
    const spreadsheetId = await this.provisioner.ensureSpreadsheet(user, authClient);
    // No spreadsheetId in the audit entry: the event plus the user is enough,
    // and the id is a capability-ish identifier.
    this.audit.log({ event: "sheet_recreated", googleUserId: user.googleUserId, reason });
    this.metrics.inc("sheet_recreated", { reason });
    return spreadsheetId;
  }

  /**
   * @param user       the authenticated user (owns the target spreadsheet)
   * @param authClient the user's authorized OAuth2Client, for re-provisioning.
   * `provisioner.ensureSpreadsheet` persists the new spreadsheet's id, url, and
   * title, so this service never writes to the user store directly.
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

    /**
     * Trash check FIRST, before the header check.
     *
     * A trashed spreadsheet reads and writes normally through the Sheets API —
     * it does not 404 — so without this the contact would land silently in a
     * bin the user cannot see. It must precede readHeader for the same reason:
     * readHeader SUCCEEDS on a trashed sheet, returning the real header, so the
     * `header === null` branch below would never fire for this case and the
     * recovery would be dead code.
     *
     * We never reconnect to a trashed sheet — even one the user could restore.
     * Abandon it and Recreate Sheet.
     */
    if (await this.sheets.isTrashed(spreadsheetId)) {
      spreadsheetId = await this.recreateSheet(user, authClient, "trashed");
    }

    // Header integrity: repair row 1 if it drifted from SHEET_HEADER.
    const header = await this.sheets.readHeader(spreadsheetId);
    if (header === null) {
      // Sheet is gone — recreate before we even append.
      spreadsheetId = await this.recreateSheet(user, authClient, "not_found");
    } else if (!headerMatches(header)) {
      await this.sheets.writeHeader(spreadsheetId, [...SHEET_HEADER]);
    }

    try {
      await this.sheets.appendRow(spreadsheetId, row);
    } catch (err) {
      if (err instanceof SheetNotFoundError) {
        // Last-resort race handler: the sheet was deleted between our checks
        // and this append. Recreate, persist the new id, retry exactly once.
        spreadsheetId = await this.recreateSheet(user, authClient, "not_found");
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
