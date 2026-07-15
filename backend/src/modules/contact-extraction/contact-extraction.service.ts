import { CardSessionStore } from "../../shared/store/card-session-store";
import { CardSession } from "../../shared/types/card-session";
import { Contact, createEmptyContact } from "../../shared/types/contact";
import { PipelineOrderError } from "../../shared/http/pipeline-errors";

/**
 * M3 — Contact Extraction business rules (docs/modules/M3-Contact-Extraction.md §4):
 * - Extracted fields: Name, Phone[], Email, Company, Address[], Note, Category.
 * - A card may have more than one phone and address; both are captured as lists.
 * - A field not found on the card is left blank rather than guessed.
 *
 * Depends on M2 having produced rawText first (§6). If rawText is missing when
 * /extract is called, that is a genuine out-of-order pipeline call.
 */
export class M3Service {
  constructor(private readonly store: CardSessionStore) {}

  extract(cardId: string): CardSession {
    const session = this.store.get(cardId);

    if (session.rawText === null) {
      throw new PipelineOrderError("text recognition (M2 /recognize)");
    }

    const contact = parseContactFromText(session.rawText);
    return this.store.update(cardId, { contact });
  }
}

/**
 * SWAPPABLE PLACEHOLDER IMPLEMENTATION.
 *
 * The M3 doc treats "the specific extraction technique or model used" as a
 * black-box contract that is explicitly Out of Scope (§ Out of Scope, §1). This
 * function is therefore an isolated, replaceable heuristic — a reasonable-effort
 * regex/line-based parser — so the endpoint returns real data today, while the
 * technique itself remains an unlocked decision that can later be swapped for an
 * AI/NLP extractor without touching the service or router.
 *
 * The only actual business rules baked in here are the documented ones: multiple
 * phones/addresses are captured as lists, and any field not found is left blank
 * rather than guessed.
 */
export function parseContactFromText(rawText: string): Contact {
  const contact = createEmptyContact();

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Email — first RFC-ish match wins; a field not found stays blank.
  const emailMatch = rawText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (emailMatch) {
    contact.email = emailMatch[0];
  }

  // Phones — collect every plausible phone-like run; multiple numbers allowed.
  // The inner separator class uses literal space/tab (not \s) so a phone number
  // can never span a line break and swallow the next line's leading digit
  // (e.g. a phone directly above "1 Mayfair Road" must not become ...18421).
  const phoneCandidates =
    rawText.match(/(?:\+?\d[\d \t().-]{6,}\d)/g) ?? [];
  contact.phones = dedupe(
    phoneCandidates
      .map((raw) => raw.replace(/[^\d+]/g, ""))
      .filter((digits) => digits.replace(/\D/g, "").length >= 7)
  );

  // Lines that are "used up" by email/phone detection are poor name/company
  // candidates, so exclude them from the line-based heuristics below.
  const emailLower = contact.email.toLowerCase();
  const textLines = lines.filter((line) => {
    if (emailLower && line.toLowerCase().includes(emailLower)) return false;
    const digits = line.replace(/\D/g, "");
    // Mostly-digit lines are phone/other numeric data, not names/companies.
    return digits.length < line.replace(/\s/g, "").length * 0.5;
  });

  // Name — heuristic: the first non-numeric text line, typically the person's
  // name printed at the top of the card.
  if (textLines.length > 0) {
    contact.name = textLines[0];
  }

  // Company — heuristic: a subsequent line containing a common company suffix,
  // else the second text line if present.
  const companyLine = textLines
    .slice(1)
    .find((line) => /\b(inc|inc\.|llc|ltd|ltd\.|co\.|corp|corp\.|company|gmbh|plc|group|solutions|technologies|labs)\b/i.test(line));
  if (companyLine) {
    contact.company = companyLine;
  } else if (textLines.length > 1) {
    contact.company = textLines[1];
  }

  // Addresses — heuristic: lines that look like a street/postal address
  // (contain a number followed by words, or a postal-code-ish token). Multiple
  // addresses are captured as a list.
  contact.addresses = dedupe(
    lines.filter((line) => isAddressLike(line))
  );

  // Note and Category are not derivable from a plain business card via this
  // placeholder heuristic — left blank rather than guessed (§4).

  return contact;
}

function isAddressLike(line: string): boolean {
  // A leading/embedded street number followed by words, or a postal code token.
  const hasStreetNumber = /\b\d{1,5}\s+[A-Za-z][A-Za-z.]*/.test(line);
  const hasPostalCode = /\b\d{4,6}\b/.test(line) && /[A-Za-z]/.test(line);
  const hasAddressKeyword =
    /\b(street|st\.|avenue|ave\.?|road|rd\.?|blvd\.?|boulevard|suite|ste\.?|floor|fl\.?|drive|dr\.?|lane|ln\.?|way|court|ct\.?)\b/i.test(
      line
    );
  return (hasStreetNumber || hasPostalCode) && (hasAddressKeyword || hasStreetNumber);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
