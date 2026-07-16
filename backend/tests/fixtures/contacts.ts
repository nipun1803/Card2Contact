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
    designation: "Chief Analyst",
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
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
    spreadsheetTitle: "Card2Contact Contacts",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiry: null,
    savedContactsCount: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastLoginAt: null,
    disabledAt: null,
    disabledBy: null,
    restoredAt: null,
    restoredBy: null,
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

  /**
   * Models a real reported bug: Mistral OCR markdown embedding the card's
   * logo as an image ref ABOVE the name line, and rendering a stylized
   * company wordmark as bold. Also exercises the designation field and two
   * Indian-format phone numbers with different digit groupings.
   */
  markdownArtifacts: [
    "![img-0.jpeg](img-0.jpeg)",
    "",
    "Sonia Arora",
    "Branch Head",
    "",
    "**Infinity**",
    "Flower Boutique",
    "",
    "+91 91876 54321",
    "+91 22 6718 6718",
    "",
    "sonia.a@mail.web",
  ].join("\n"),

  /**
   * Reported bug: a two-column card (logo/company wordmark on the left,
   * name/designation/contact details on the right). OCR reads left-to-right
   * then top-to-bottom, so the company text comes out BEFORE the person's
   * name in the raw text — unlike `markdownArtifacts`, where the logo is
   * merely a stray image ref above a single-column layout. Same card as
   * `markdownArtifacts` in content, but in the reading order Mistral actually
   * produced for the real (two-column) card image.
   */
  companyColumnBeforeName: [
    "![img-0.jpeg](img-0.jpeg)",
    "",
    "**Infinity**",
    "Flower Boutique",
    "",
    "Sonia Arora",
    "Branch Head",
    "",
    "+91 91876 54321",
    "+91 22 6718 6718",
    "",
    "sonia.a@mail.web",
  ].join("\n"),

  /**
   * Same left-column-company layout, but the company is a single line (no
   * wrapped wordmark) and has a recognizable legal suffix — checks the fix
   * doesn't depend on the company being multi-line or suffix-less.
   */
  companyColumnBeforeNameWithSuffix: [
    "Nimbus Cloud Solutions Inc",
    "",
    "Marcus Chen",
    "Vice President, Engineering",
    "",
    "marcus.chen@nimbuscloud.io",
    "+1 (415) 555-0134",
  ].join("\n"),

  /**
   * Two-column layout where the designation line comes BEFORE the name line
   * (both still adjacent, but in the opposite order from the common case) —
   * checks the "prefer before, fall back to after" adjacency rule.
   */
  designationBeforeNameInColumn: [
    "Bloom & Co",
    "",
    "Founder",
    "Priya Nair",
    "",
    "priya@bloomandco.in",
    "+91 98765 43210",
  ].join("\n"),

  /** A second real-card shape: designation before company-suffix line, US number. */
  designationAndSuffix: [
    "Marcus Chen",
    "Vice President, Engineering",
    "Nimbus Cloud Solutions Inc",
    "marcus.chen@nimbuscloud.io",
    "+1 (415) 555-0134",
    "500 Market Street, Suite 12, San Francisco, CA 94105",
  ].join("\n"),

  /** A third real-card shape: no designation present, company has no legal suffix. */
  noDesignation: [
    "Priya Nair",
    "Bloom & Co",
    "priya@bloomandco.in",
    "+91 98765 43210",
  ].join("\n"),

  /**
   * A real address split across two consecutive OCR lines with no
   * street/road/etc. keyword on either line — only a floor/tower reference
   * and a trailing city+postal-code. Must be joined into ONE address entry,
   * not dropped or truncated to a single line.
   */
  multiLineAddress: [
    "Rahul Mehta",
    "Regional Sales Manager",
    "Zenith Retail Pvt Ltd",
    "rahul.mehta@zenithretail.in",
    "+91 98111 22334",
    "4th Floor, Tower B",
    "Cyber City, Gurugram 122002",
  ].join("\n"),

  /** A card with no address at all — must leave `addresses` as an empty list. */
  noAddress: [
    "Kenji Sato",
    "Product Designer",
    "Studio Nine",
    "kenji@studionine.jp",
    "+81 3 1234 5678",
  ].join("\n"),

  /**
   * Two distinct addresses separated by a blank OCR line (e.g. head office +
   * branch office on one card). Must produce TWO separate address entries,
   * not one merged string.
   */
  twoAddresses: [
    "Lee Park",
    "Harbor Consulting",
    "lee@harborconsulting.com",
    "+1 617 555 0111",
    "10 Harbor St, Boston MA 02110",
    "",
    "42 Wharf Ave, Brooklyn NY 11201",
  ].join("\n"),
} as const;
