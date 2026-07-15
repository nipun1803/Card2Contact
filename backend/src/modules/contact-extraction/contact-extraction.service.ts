import { parsePhoneNumberFromString } from "libphonenumber-js";
import { CardSessionStore } from "../../shared/store/card-session-store";
import { CardSession } from "../../shared/types/card-session";
import { Contact, createEmptyContact } from "../../shared/types/contact";
import { PipelineOrderError } from "../../shared/http/pipeline-errors";

/**
 * M3 — Contact Extraction business rules (docs/modules/M3-Contact-Extraction.md §4):
 * - Extracted fields: Name, Designation, Phone[], Email, Company, Address[], Note, Category.
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

  // M2 already strips Markdown from OCR output, but M3 doesn't assume that:
  // any Markdown artifact (image refs, bold/italic/heading syntax) that
  // reaches this parser is scrubbed here too, so it never leaks into a field.
  const cleanedText = stripMarkdown(rawText);

  const lines = cleanedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isNoiseLine(line));

  // Email — first RFC-ish match wins; a field not found stays blank.
  const emailMatch = cleanedText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (emailMatch) {
    contact.email = emailMatch[0];
  }

  // Phones — collect every plausible phone-like run; multiple numbers allowed.
  // The inner separator class uses literal space/tab (not \s) so a phone number
  // can never span a line break and swallow the next line's leading digit
  // (e.g. a phone directly above "1 Mayfair Road" must not become ...18421).
  const phoneCandidates = cleanedText.match(/(?:\+?\d[\d \t().-]{6,}\d)/g) ?? [];
  contact.phones = dedupePhones(
    phoneCandidates
      .map(normalizePhone)
      .filter((phone): phone is NormalizedPhone => phone !== null),
  );

  // Lines "used up" by email/phone/address detection are poor name/company/
  // designation candidates, so exclude them from the line-based heuristics below.
  const emailLower = contact.email.toLowerCase();
  const textLines = lines.filter((line) => {
    if (emailLower && line.toLowerCase().includes(emailLower)) return false;
    if (isAddressLike(line)) return false;
    const digits = line.replace(/\D/g, "");
    // Mostly-digit lines are phone/other numeric data, not names/companies.
    return digits.length < line.replace(/\s/g, "").length * 0.5;
  });

  // Name — heuristic: the first remaining line that reads like a person's
  // name (letters/spaces/typical name punctuation only, 1-5 words) — this
  // excludes designation/company lines and stray symbols/taglines so only
  // actual card content lands in the field.
  const nameIndex = textLines.findIndex((line) => looksLikeName(line));
  if (nameIndex !== -1) {
    contact.name = textLines[nameIndex];
  }

  const remaining = textLines.filter((_, i) => i !== nameIndex);

  // Designation — heuristic: a line containing a common job-title keyword
  // (e.g. "Branch Head", "Managing Director"), searched before company so a
  // title line is never mistaken for the company name.
  const designationIndex = remaining.findIndex((line) => looksLikeDesignation(line));
  if (designationIndex !== -1) {
    contact.designation = remaining[designationIndex];
  }
  const afterDesignation = remaining.filter((_, i) => i !== designationIndex);

  // Company — heuristic: once name/designation/email/phone/address lines are
  // removed, whatever text lines remain are almost always all part of the
  // company name/wordmark (many cards split it across 2+ lines, e.g. a brand
  // name on one line and "Flower Boutique" on the next) — so ALL remaining
  // lines are joined into one field, whether or not one of them happens to
  // match a suffix/keyword, to avoid silently dropping part of the name.
  if (afterDesignation.length > 0) {
    contact.company = afterDesignation.join(" ");
  }

  // Addresses — heuristic: lines that look like a street/postal address
  // (contain a number followed by words, or a postal-code-ish token). Multiple
  // addresses are captured as a list.
  contact.addresses = dedupe(lines.filter((line) => isAddressLike(line)));

  // Note and Category are not derivable from a plain business card via this
  // placeholder heuristic — left blank rather than guessed (§4).

  return contact;
}

/**
 * Strips Markdown syntax that may have leaked through from OCR output (image
 * refs, links, bold/italic, headings) so it can never end up verbatim in a
 * structured field. Mirrors M2's `stripMarkdown` — kept independent so M3
 * stays correct even if it's ever fed raw text from a different upstream.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // image refs — drop entirely, no text content
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links — keep the visible text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/^#{1,6}\s+/gm, ""); // headings
}

/**
 * Lines that carry no contact information even after Markdown stripping —
 * leftover Markdown table/rule syntax, bare URLs (logos/website banners), or
 * punctuation-only artifacts — so they're never mapped to name/company/etc.
 */
function isNoiseLine(line: string): boolean {
  if (/^[-_=*#|~`\s]+$/.test(line)) return true; // rules/table borders/bullets only
  if (/^(https?:\/\/|www\.)\S+$/i.test(line)) return true; // bare URL, no label text
  if (!/[A-Za-z]/.test(line)) return true; // no letters at all (symbols/numbers only)
  return false;
}

const DESIGNATION_KEYWORDS =
  /\b(ceo|cfo|coo|cto|founder|co-founder|president|vice president|vp|director|manager|head|lead|engineer|executive|officer|consultant|specialist|analyst|associate|partner|owner|proprietor|supervisor|coordinator|administrator|designer|architect|developer|representative|agent|advisor|chairman|chairperson)\b/i;

const COMPANY_KEYWORDS =
  /\b(inc|inc\.|llc|ltd|ltd\.|co\.|corp|corp\.|company|gmbh|plc|group|solutions|technologies|labs|enterprises|industries|associates|partners|studio|boutique|agency)\b/i;

/**
 * A line "looks like" a person's name if it's short (1-5 words), contains
 * only letters/spaces/typical name punctuation (periods, hyphens, apostrophes),
 * and isn't already a designation or company line — this keeps stray symbols,
 * taglines, and multi-clause text out of the name field.
 */
function looksLikeName(line: string): boolean {
  if (!/^[A-Za-z][A-Za-z.'-]*(?: [A-Za-z][A-Za-z.'-]*){0,4}$/.test(line)) return false;
  if (DESIGNATION_KEYWORDS.test(line)) return false;
  if (COMPANY_KEYWORDS.test(line)) return false;
  return true;
}

function looksLikeDesignation(line: string): boolean {
  return DESIGNATION_KEYWORDS.test(line);
}

function isAddressLike(line: string): boolean {
  // A leading/embedded street number followed by words, or a postal code token.
  const hasStreetNumber = /\b\d{1,5}\s+[A-Za-z][A-Za-z.]*/.test(line);
  const hasPostalCode = /\b\d{4,6}\b/.test(line) && /[A-Za-z]/.test(line);
  const hasAddressKeyword =
    /\b(street|st\.|avenue|ave\.?|road|rd\.?|blvd\.?|boulevard|suite|ste\.?|floor|fl\.?|drive|dr\.?|lane|ln\.?|way|court|ct\.?)\b/i.test(
      line,
    );
  return (hasStreetNumber || hasPostalCode) && (hasAddressKeyword || hasStreetNumber);
}

interface NormalizedPhone {
  /** Human-readable display form, e.g. "+91 91876 54321". */
  display: string;
  /** Canonical E.164 form (or the display form itself as a fallback) used for dedup. */
  canonical: string;
}

/**
 * Normalizes a raw phone match using `libphonenumber-js`, which knows real
 * country-code/area-code/subscriber-number boundaries — re-deriving that
 * grouping with regex guesswork produces wrong-looking numbers for most
 * countries (e.g. a naive fixed-width split turns "+91 22 6718 6718" into
 * "+91 22671 86718"). Only `+`-prefixed numbers are parsed (unambiguous,
 * self-describing country code); a bare national-format number is passed
 * through with punctuation normalized to spaces rather than guessing a region.
 * Returns null if too few digits remain to plausibly be a phone number.
 */
function normalizePhone(raw: string): NormalizedPhone | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return null;

  if (trimmed.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(trimmed);
    if (parsed?.isValid()) {
      return { display: parsed.formatInternational(), canonical: parsed.number };
    }
  }

  const display = trimmed.replace(/[^\d+]+/g, " ").trim();
  return { display, canonical: digits };
}

function dedupePhones(phones: NormalizedPhone[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const phone of phones) {
    if (seen.has(phone.canonical)) continue;
    seen.add(phone.canonical);
    result.push(phone.display);
  }
  return result;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
