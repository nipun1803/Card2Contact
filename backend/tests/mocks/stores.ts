import { vi } from "vitest";
import { CardSession } from "../../src/shared/types/card-session";
import {
  CardNotFoundError,
  CardSessionStore,
} from "../../src/shared/store/card-session-store";
import { UserRecord, UserStore, TokenSet } from "../../src/shared/store/user-store";
import { SheetsClient } from "../../src/modules/google-sheets/google-sheets.client";
import { SheetsProvisioner } from "../../src/shared/sheets/sheets-provisioner";
import { OcrClient } from "../../src/modules/text-recognition/text-recognition.client";
import { SHEET_HEADER } from "../../src/modules/google-sheets/google-sheets.service";

/**
 * A working in-memory CardSessionStore backed by a Map — behaves like the real
 * InMemoryCardSessionStore but lets a test seed sessions directly and spy on
 * calls. Prefer this over hand-rolling `vi.fn()` stubs when a test drives more
 * than one pipeline step.
 */
export function makeCardStore(seed: CardSession[] = []): CardSessionStore & {
  _map: Map<string, CardSession>;
} {
  const map = new Map<string, CardSession>(seed.map((s) => [s.cardId, s]));
  return {
    _map: map,
    create: vi.fn((mode, frontImage, backImage) => {
      const session: CardSession = {
        cardId: `card-${map.size + 1}`,
        mode,
        frontImage,
        backImage,
        rawText: null,
        contact: null,
        confirmed: false,
        saved: false,
      };
      map.set(session.cardId, session);
      return session;
    }),
    get: vi.fn((id: string) => {
      const s = map.get(id);
      if (!s) throw new CardNotFoundError(id);
      return s;
    }),
    update: vi.fn((id: string, patch: Partial<CardSession>) => {
      const s = map.get(id);
      if (!s) throw new CardNotFoundError(id);
      const next = { ...s, ...patch };
      map.set(id, next);
      return next;
    }),
  };
}

/** Fully-stubbed UserStore; override any method per test. */
export function makeUserStore(overrides: Partial<UserStore> = {}): UserStore {
  return {
    findById: vi.fn(async () => null),
    upsertOnLogin: vi.fn(async (input) => ({
      googleUserId: input.googleUserId,
      email: input.email,
      spreadsheetId: null,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      tokenExpiry: input.tokenExpiry,
      savedContactsCount: 0,
    })),
    updateTokens: vi.fn(async () => {}),
    setSpreadsheetId: vi.fn(async () => {}),
    clearTokens: vi.fn(async () => {}),
    incrementSavedContactsCount: vi.fn(async () => 1),
    ...overrides,
  };
}

/** Sheets client whose header read matches the canonical header by default. */
export function makeSheetsClient(overrides: Partial<SheetsClient> = {}): SheetsClient {
  return {
    appendRow: vi.fn(async () => {}),
    createSpreadsheetWithHeader: vi.fn(async () => "new-sheet-id"),
    readHeader: vi.fn(async () => [...SHEET_HEADER]),
    writeHeader: vi.fn(async () => {}),
    ...overrides,
  };
}

export function makeProvisioner(spreadsheetId = "provisioned-sheet"): SheetsProvisioner {
  return { ensureSpreadsheet: vi.fn(async () => spreadsheetId) };
}

/** OCR client that returns canned text per image, or a fixed string. */
export function makeOcrClient(text: string | ((image: Buffer) => string) = "OCR TEXT"): OcrClient {
  return {
    recognize: vi.fn(async (image: Buffer) =>
      typeof text === "function" ? text(image) : text,
    ),
  };
}

export type { UserRecord, TokenSet };
