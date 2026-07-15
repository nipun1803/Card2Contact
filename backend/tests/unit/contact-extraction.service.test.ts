import { describe, expect, it } from "vitest";
import {
  M3Service,
  parseContactFromText,
} from "../../src/modules/contact-extraction/contact-extraction.service";
import { PipelineOrderError } from "../../src/shared/http/pipeline-errors";
import { CardNotFoundError } from "../../src/shared/store/card-session-store";
import { makeCardStore } from "../mocks/stores";
import { makeCardSession, OCR_SAMPLES } from "../fixtures/contacts";

/**
 * M3 — Contact Extraction. The technique is a documented, swappable placeholder
 * heuristic (docs/modules/M3 "Out of Scope"), so these tests pin the CURRENT
 * heuristic behavior — including one confirmed defect (see KNOWN BUG below) —
 * rather than an idealized spec. When the parser is replaced/fixed, the KNOWN
 * BUG assertion should flip to the `.todo` expectation.
 */
describe("parseContactFromText", () => {
  it("extracts the email (first RFC-ish match)", () => {
    const c = parseContactFromText(OCR_SAMPLES.simple);
    expect(c.email).toBe("ada@analyticalengines.com");
  });

  it("uses the first non-numeric line as the name", () => {
    const c = parseContactFromText(OCR_SAMPLES.simple);
    expect(c.name).toBe("Ada Lovelace");
  });

  it("detects a company via a known suffix (Inc)", () => {
    const c = parseContactFromText(OCR_SAMPLES.simple);
    expect(c.company).toBe("Analytical Engines Inc");
  });

  it("captures an address-like line", () => {
    const c = parseContactFromText(OCR_SAMPLES.simple);
    expect(c.addresses).toContain("1 Mayfair Road, London W1");
  });

  it("captures multiple phone numbers as a list", () => {
    const c = parseContactFromText(OCR_SAMPLES.multiPhone);
    expect(c.phones.length).toBeGreaterThanOrEqual(2);
    expect(c.phones.some((p) => p.includes("5550100"))).toBe(true);
    expect(c.phones.some((p) => p.includes("5550199"))).toBe(true);
  });

  it("leaves note and category blank (not derivable from a plain card)", () => {
    const c = parseContactFromText(OCR_SAMPLES.simple);
    expect(c.note).toBe("");
    expect(c.category).toBe("");
  });

  it("returns an all-blank contact for empty text", () => {
    const c = parseContactFromText(OCR_SAMPLES.empty);
    expect(c.name).toBe("");
    expect(c.email).toBe("");
    expect(c.phones).toEqual([]);
    expect(c.addresses).toEqual([]);
  });

  it("handles a name-only card without throwing", () => {
    const c = parseContactFromText(OCR_SAMPLES.nameOnly);
    expect(c.name).toBe("Alan Turing");
    expect(c.email).toBe("");
  });

  it("de-duplicates repeated phone numbers", () => {
    const dupPhones = "Bob\n+1 555 999 0000\n+1 555 999 0000";
    const c = parseContactFromText(dupPhones);
    expect(c.phones).toEqual(["+15559990000"]);
  });

  /**
   * Regression for the fixed cross-line bleed (was: the phone regex's `\s`
   * matched the newline before "1 Mayfair Road", producing "+155501018421").
   * The separator class now uses literal space/tab, so the phone stops at the
   * line break and does NOT swallow the address's leading digit.
   */
  it("does not bleed a following line's leading digit into the phone", () => {
    const c = parseContactFromText(OCR_SAMPLES.simple);
    expect(c.phones).toEqual(["+15550101842"]);
  });
});

describe("M3Service.extract", () => {
  it("parses rawText and stores the contact on the session", () => {
    const session = makeCardSession({ cardId: "c1", rawText: OCR_SAMPLES.simple });
    const store = makeCardStore([session]);
    const svc = new M3Service(store);

    const updated = svc.extract("c1");

    expect(updated.contact?.name).toBe("Ada Lovelace");
    expect(updated.contact?.email).toBe("ada@analyticalengines.com");
  });

  it("throws PipelineOrderError when rawText is missing (M2 not run)", () => {
    const session = makeCardSession({ cardId: "c2", rawText: null });
    const store = makeCardStore([session]);
    const svc = new M3Service(store);
    expect(() => svc.extract("c2")).toThrow(PipelineOrderError);
  });

  it("throws CardNotFoundError for an unknown card", () => {
    const svc = new M3Service(makeCardStore());
    expect(() => svc.extract("ghost")).toThrow(CardNotFoundError);
  });
});
