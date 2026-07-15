import { Contact } from "../../src/shared/types/contact";
import { CardSession } from "../../src/shared/types/card-session";
import { UserRecord } from "../../src/shared/store/user-store";

/**
 * Fixture factories. Each returns a fresh object every call (no shared mutable
 * state between tests) and accepts a partial override so a test can vary just
 * the field it cares about: `makeContact({ name: "" })`.
 */

export function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    name: "Ada Lovelace",
    phones: ["+1 555 010 1842"],
    email: "ada@analyticalengines.com",
    company: "Analytical Engines Inc",
    addresses: ["1 Mayfair Road, London W1"],
    note: "met at conf",
    category: "engineering",
    ...overrides,
  };
}

export function makeCardSession(overrides: Partial<CardSession> = {}): CardSession {
  return {
    cardId: "card-fixture-1",
    mode: "single",
    frontImage: Buffer.from("front"),
    backImage: null,
    rawText: null,
    contact: null,
    confirmed: false,
    saved: false,
    ...overrides,
  };
}

export function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    googleUserId: "user-1",
    email: "ada@analyticalengines.com",
    spreadsheetId: "sheet-1",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiry: null,
    savedContactsCount: 0,
    ...overrides,
  };
}

/**
 * Realistic multi-line OCR blocks, as Mistral returns them (blank lines between
 * fields). Used by M3 parser tests. `withNoise` adds junk lines a real card
 * might carry (taglines, URLs) to exercise the heuristics.
 */
export const OCR_SAMPLES = {
  simple: [
    "Ada Lovelace",
    "",
    "Analytical Engines Inc",
    "",
    "ada@analyticalengines.com",
    "",
    "+1 555 010 1842",
    "",
    "1 Mayfair Road, London W1",
  ].join("\n"),

  multiPhone: [
    "Grace Hopper",
    "Naval Systems LLC",
    "grace@navy.example.com",
    "Tel: +1 202 555 0100",
    "Mobile: +1 202 555 0199",
    "1 Anchor Way, Arlington 22201",
  ].join("\n"),

  nameOnly: "Alan Turing",

  empty: "",
} as const;
