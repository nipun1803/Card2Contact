import type { Contact } from "@/shared/types/contact";
import type { AuthStatus } from "@/shared/types/api";

/** Fresh, override-able fixtures for frontend tests. */

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

export function makeAuthStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    authenticated: true,
    email: "ada@analyticalengines.com",
    needsReconnect: false,
    spreadsheetTitle: "Card2Contact Contacts",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
    savedContactsCount: 3,
    ...overrides,
  };
}

/** Build a File for upload/downscale tests. */
export function makeImageFile(name = "card.png", type = "image/png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });
}
