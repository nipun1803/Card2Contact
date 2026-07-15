import { describe, expect, it, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { M5Service, SHEET_HEADER } from "./google-sheets.service";
import { SheetNotFoundError, SheetsClient } from "./google-sheets.client";
import { ReauthRequiredError } from "../../shared/http/pipeline-errors";
import { CardSession } from "../../shared/types/card-session";
import { CardSessionStore } from "../../shared/store/card-session-store";
import { UserRecord, UserStore } from "../../shared/store/user-store";
import { SheetsProvisioner } from "../../shared/sheets/sheets-provisioner";
import { createEmptyContact } from "../../shared/types/contact";

const authClient = {} as OAuth2Client;

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

const user: UserRecord = {
  googleUserId: "u1",
  email: "ada@example.com",
  spreadsheetId: "sheet-1",
  accessToken: "at",
  refreshToken: "rt",
  tokenExpiry: null,
  savedContactsCount: 0,
};

function fakeUserStore(): UserStore {
  return {
    findById: vi.fn(),
    upsertOnLogin: vi.fn(),
    updateTokens: vi.fn(),
    setSpreadsheetId: vi.fn(),
    clearTokens: vi.fn(),
    incrementSavedContactsCount: vi.fn(async () => 1),
  } as unknown as UserStore;
}

describe("M5Service.save recovery", () => {
  it("recreates the sheet and retries once when append hits a deleted sheet", async () => {
    const session = confirmedSession();
    const append = vi
      .fn()
      .mockRejectedValueOnce(new SheetNotFoundError("sheet-1"))
      .mockResolvedValueOnce(undefined);
    const sheets: SheetsClient = {
      appendRow: append,
      createSpreadsheetWithHeader: vi.fn(),
      readHeader: vi.fn(async () => [...SHEET_HEADER]),
      writeHeader: vi.fn(),
    };
    const provisioner: SheetsProvisioner = {
      ensureSpreadsheet: vi.fn(async () => "sheet-2"),
    };

    const service = new M5Service(fakeStore(session), sheets, provisioner, fakeUserStore());
    const result = await service.save("card-1", user, authClient);

    expect(provisioner.ensureSpreadsheet).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenLastCalledWith("sheet-2", expect.any(Array));
    expect(result.saved).toBe(true);
  });

  it("propagates ReauthRequiredError without retrying", async () => {
    const session = confirmedSession();
    const sheets: SheetsClient = {
      appendRow: vi.fn().mockRejectedValue(new ReauthRequiredError()),
      createSpreadsheetWithHeader: vi.fn(),
      readHeader: vi.fn(async () => [...SHEET_HEADER]),
      writeHeader: vi.fn(),
    };
    const provisioner: SheetsProvisioner = { ensureSpreadsheet: vi.fn() };
    const userStore = fakeUserStore();

    const service = new M5Service(fakeStore(session), sheets, provisioner, userStore);
    await expect(service.save("card-1", user, authClient)).rejects.toBeInstanceOf(
      ReauthRequiredError
    );
    expect(provisioner.ensureSpreadsheet).not.toHaveBeenCalled();
    // A failed append must never bump the saved-contacts counter.
    expect(userStore.incrementSavedContactsCount).not.toHaveBeenCalled();
  });

  it("increments the user's saved-contacts count exactly once on a successful save", async () => {
    const session = confirmedSession();
    const sheets: SheetsClient = {
      appendRow: vi.fn(),
      createSpreadsheetWithHeader: vi.fn(),
      readHeader: vi.fn(async () => [...SHEET_HEADER]),
      writeHeader: vi.fn(),
    };
    const provisioner: SheetsProvisioner = { ensureSpreadsheet: vi.fn() };
    const userStore = fakeUserStore();

    const service = new M5Service(fakeStore(session), sheets, provisioner, userStore);
    await service.save("card-1", user, authClient);

    expect(userStore.incrementSavedContactsCount).toHaveBeenCalledTimes(1);
    expect(userStore.incrementSavedContactsCount).toHaveBeenCalledWith(user.googleUserId);
  });

  it("repairs a drifted header before appending", async () => {
    const session = confirmedSession();
    const sheets: SheetsClient = {
      appendRow: vi.fn(),
      createSpreadsheetWithHeader: vi.fn(),
      readHeader: vi.fn(async () => ["Wrong", "Header"]),
      writeHeader: vi.fn(),
    };
    const provisioner: SheetsProvisioner = { ensureSpreadsheet: vi.fn() };

    const service = new M5Service(fakeStore(session), sheets, provisioner, fakeUserStore());
    await service.save("card-1", user, authClient);

    expect(sheets.writeHeader).toHaveBeenCalledWith("sheet-1", [...SHEET_HEADER]);
  });

  it("recreates the sheet when the header read finds it missing", async () => {
    const session = confirmedSession();
    const sheets: SheetsClient = {
      appendRow: vi.fn(),
      createSpreadsheetWithHeader: vi.fn(),
      readHeader: vi.fn(async () => null), // 404 → sheet gone
      writeHeader: vi.fn(),
    };
    const provisioner: SheetsProvisioner = {
      ensureSpreadsheet: vi.fn(async () => "sheet-3"),
    };

    const service = new M5Service(fakeStore(session), sheets, provisioner, fakeUserStore());
    await service.save("card-1", user, authClient);

    expect(provisioner.ensureSpreadsheet).toHaveBeenCalledTimes(1);
    expect(sheets.appendRow).toHaveBeenCalledWith("sheet-3", expect.any(Array));
  });
});
