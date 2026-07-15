import { describe, expect, it, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { M5Service, SHEET_HEADER } from "../../src/modules/google-sheets/google-sheets.service";
import { SheetNotFoundError } from "../../src/modules/google-sheets/google-sheets.client";
import { ReauthRequiredError } from "../../src/shared/http/pipeline-errors";
import { CardSession } from "../../src/shared/types/card-session";
import { CardSessionStore } from "../../src/shared/store/card-session-store";
import { UserRecord, UserStore } from "../../src/shared/store/user-store";
import { SheetsProvisioner } from "../../src/shared/sheets/sheets-provisioner";
import { createEmptyContact } from "../../src/shared/types/contact";
import { MemoryAuditLogger } from "../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../src/shared/observability/metrics";
import { makeSheetsClient, makeUserStore } from "../mocks/stores";
import { makeUser } from "../fixtures/contacts";

const authClient = {} as OAuth2Client;
const TRASHED_SHEET = "sheet-1";
const NEW_SHEET = "recreated-sheet";

function confirmedSession(): CardSession {
  return {
    cardId: "card-1",
    mode: "single",
    frontImage: Buffer.from(""),
    backImage: null,
    rawText: "raw",
    contact: { ...createEmptyContact(), name: "Ada" },
    confirmed: true,
    saved: false,
  };
}

function fakeStore(session: CardSession): CardSessionStore {
  return {
    create: vi.fn(),
    get: vi.fn(() => session),
    update: vi.fn((_id, patch) => ({ ...session, ...patch })),
  } as unknown as CardSessionStore;
}

const user: UserRecord = makeUser({ googleUserId: "u1", spreadsheetId: TRASHED_SHEET });

interface Harness {
  service: M5Service;
  sheets: ReturnType<typeof makeSheetsClient>;
  provisioner: SheetsProvisioner;
  userStore: UserStore;
  audit: MemoryAuditLogger;
  metrics: MemoryMetrics;
}

function harness(
  sheetsOverrides: Parameters<typeof makeSheetsClient>[0] = {},
  session = confirmedSession()
): Harness {
  const sheets = makeSheetsClient(sheetsOverrides);
  const provisioner: SheetsProvisioner = { ensureSpreadsheet: vi.fn(async () => NEW_SHEET) };
  const userStore = makeUserStore();
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  return {
    service: new M5Service(fakeStore(session), sheets, provisioner, userStore, audit, metrics),
    sheets,
    provisioner,
    userStore,
    audit,
    metrics,
  };
}

/**
 * The core of the trash requirement. A trashed spreadsheet reads and writes
 * normally through the Sheets API and never 404s, so without an explicit Drive
 * check contacts land silently in a bin the user cannot see.
 */
describe("M5Service.save — trashed sheet (Recreate Sheet)", () => {
  it("recreates the sheet when the stored one is trashed", async () => {
    const h = harness({ isTrashed: vi.fn(async () => true) });

    await h.service.save("card-1", user, authClient);

    expect(h.provisioner.ensureSpreadsheet).toHaveBeenCalledWith(user, authClient);
  });

  // The requirement in one assertion: never write to a trashed sheet.
  it("appends to the NEW sheet, never the trashed one", async () => {
    const h = harness({ isTrashed: vi.fn(async () => true) });

    await h.service.save("card-1", user, authClient);

    expect(h.sheets.appendRow).toHaveBeenCalledTimes(1);
    expect(h.sheets.appendRow).toHaveBeenCalledWith(NEW_SHEET, expect.any(Array));
    expect(h.sheets.appendRow).not.toHaveBeenCalledWith(TRASHED_SHEET, expect.anything());
  });

  /**
   * Ordering regression. readHeader SUCCEEDS on a trashed sheet, so if the
   * trash check ran after it, the header would look fine and we would append
   * straight into the bin — the recovery would be dead code.
   */
  it("checks trashed BEFORE reading the header", async () => {
    const calls: string[] = [];
    const h = harness({
      isTrashed: vi.fn(async () => {
        calls.push("isTrashed");
        return true;
      }),
      readHeader: vi.fn(async () => {
        calls.push("readHeader");
        return [...SHEET_HEADER];
      }),
    });

    await h.service.save("card-1", user, authClient);

    expect(calls[0]).toBe("isTrashed");
  });

  it("reads the header of the new sheet, not the trashed one", async () => {
    const h = harness({ isTrashed: vi.fn(async () => true) });

    await h.service.save("card-1", user, authClient);

    expect(h.sheets.readHeader).toHaveBeenCalledWith(NEW_SHEET);
    expect(h.sheets.readHeader).not.toHaveBeenCalledWith(TRASHED_SHEET);
  });

  it("audits and counts the recreation with reason:trashed", async () => {
    const h = harness({ isTrashed: vi.fn(async () => true) });

    await h.service.save("card-1", user, authClient);

    expect(h.audit.ofType("sheet_recreated")).toEqual([
      expect.objectContaining({ googleUserId: "u1", reason: "trashed" }),
    ]);
    expect(h.metrics.get("sheet_recreated", { reason: "trashed" })).toBe(1);
  });

  // The spreadsheet id is capability-ish; the event plus the user is enough.
  it("does not log the spreadsheet id", async () => {
    const h = harness({ isTrashed: vi.fn(async () => true) });

    await h.service.save("card-1", user, authClient);

    expect(JSON.stringify(h.audit.entries)).not.toContain(TRASHED_SHEET);
    expect(JSON.stringify(h.audit.entries)).not.toContain(NEW_SHEET);
  });

  it("leaves a healthy sheet alone", async () => {
    const h = harness({ isTrashed: vi.fn(async () => false) });

    await h.service.save("card-1", user, authClient);

    expect(h.provisioner.ensureSpreadsheet).not.toHaveBeenCalled();
    expect(h.sheets.appendRow).toHaveBeenCalledWith(TRASHED_SHEET, expect.any(Array));
    expect(h.audit.ofType("sheet_recreated")).toHaveLength(0);
  });
});

describe("M5Service.save — deleted sheet", () => {
  it("recreates when the header read reports the sheet is gone", async () => {
    const h = harness({ readHeader: vi.fn(async () => null) });

    await h.service.save("card-1", user, authClient);

    expect(h.provisioner.ensureSpreadsheet).toHaveBeenCalled();
    expect(h.sheets.appendRow).toHaveBeenCalledWith(NEW_SHEET, expect.any(Array));
    expect(h.metrics.get("sheet_recreated", { reason: "not_found" })).toBe(1);
  });

  it("recreates and retries once when append hits a deleted sheet", async () => {
    // The last-resort race: deleted between our checks and the append.
    const append = vi
      .fn()
      .mockRejectedValueOnce(new SheetNotFoundError(TRASHED_SHEET))
      .mockResolvedValueOnce(undefined);
    const h = harness({ appendRow: append });

    const result = await h.service.save("card-1", user, authClient);

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1][0]).toBe(NEW_SHEET);
    expect(result.saved).toBe(true);
  });

  it("does not retry more than once", async () => {
    const append = vi.fn().mockRejectedValue(new SheetNotFoundError(TRASHED_SHEET));
    const h = harness({ appendRow: append });

    await expect(h.service.save("card-1", user, authClient)).rejects.toBeInstanceOf(
      SheetNotFoundError
    );
    expect(append).toHaveBeenCalledTimes(2);
  });
});

describe("M5Service.save — header integrity", () => {
  it("repairs a drifted header without recreating the sheet", async () => {
    const h = harness({ readHeader: vi.fn(async () => ["Wrong", "Columns"]) });

    await h.service.save("card-1", user, authClient);

    expect(h.sheets.writeHeader).toHaveBeenCalledWith(TRASHED_SHEET, [...SHEET_HEADER]);
    expect(h.provisioner.ensureSpreadsheet).not.toHaveBeenCalled();
  });

  it("leaves a matching header alone", async () => {
    const h = harness();

    await h.service.save("card-1", user, authClient);

    expect(h.sheets.writeHeader).not.toHaveBeenCalled();
  });
});

describe("M5Service.save — error propagation", () => {
  it("propagates ReauthRequiredError for the router to handle", async () => {
    // The router nulls the tokens and surfaces the Reconnect prompt; the
    // service must not swallow this.
    const h = harness({
      appendRow: vi.fn(async () => {
        throw new ReauthRequiredError();
      }),
    });

    await expect(h.service.save("card-1", user, authClient)).rejects.toBeInstanceOf(
      ReauthRequiredError
    );
    expect(h.provisioner.ensureSpreadsheet).not.toHaveBeenCalled();
  });
});

describe("M5Service.save — provisioning when no sheet exists", () => {
  it("provisions before doing anything else", async () => {
    const h = harness();
    const userWithoutSheet = makeUser({ googleUserId: "u1", spreadsheetId: null });

    await h.service.save("card-1", userWithoutSheet, authClient);

    expect(h.provisioner.ensureSpreadsheet).toHaveBeenCalledWith(userWithoutSheet, authClient);
    expect(h.sheets.appendRow).toHaveBeenCalledWith(NEW_SHEET, expect.any(Array));
    // A sheet we just created cannot be trashed, so no recovery should fire.
    expect(h.audit.ofType("sheet_recreated")).toHaveLength(0);
  });
});
