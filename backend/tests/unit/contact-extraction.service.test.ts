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
 * heuristic (docs/modules/M3 "Out of Scope"). These tests pin the CURRENT
 * heuristic behavior across several realistic card shapes, including the
 * reported bug where OCR Markdown artifacts (image refs, bold wordmarks)
 * leaked verbatim into structured fields.
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
    expect(c.phones).toEqual(["+1 202 555 0100", "+1 202 555 0199"]);
  });

  it("leaves note and category blank (not derivable from a plain card)", () => {
    const c = parseContactFromText(OCR_SAMPLES.simple);
    expect(c.note).toBe("");
    expect(c.category).toBe("");
  });

  it("leaves designation blank when the card has no job-title line", () => {
    const c = parseContactFromText(OCR_SAMPLES.simple);
    expect(c.designation).toBe("");
  });

  it("returns an all-blank contact for empty text", () => {
    const c = parseContactFromText(OCR_SAMPLES.empty);
    expect(c.name).toBe("");
    expect(c.designation).toBe("");
    expect(c.email).toBe("");
    expect(c.phones).toEqual([]);
    expect(c.addresses).toEqual([]);
  });

  it("handles a name-only card without throwing", () => {
    const c = parseContactFromText(OCR_SAMPLES.nameOnly);
    expect(c.name).toBe("Alan Turing");
    expect(c.email).toBe("");
  });

  it("de-duplicates repeated phone numbers by canonical value, not display string", () => {
    const dupPhones = "Bob\n+1 555 999 0000\n+1 (555) 999-0000";
    const c = parseContactFromText(dupPhones);
    expect(c.phones).toEqual(["+1 555 999 0000"]);
  });

  it("does not bleed a following line's leading digit into the phone", () => {
    const c = parseContactFromText(OCR_SAMPLES.simple);
    expect(c.phones).toEqual(["+1 555 010 1842"]);
  });

  describe("Markdown artifact removal (reported bug)", () => {
    const c = parseContactFromText(OCR_SAMPLES.markdownArtifacts);

    it("drops an image-ref line entirely instead of using it as the name", () => {
      expect(c.name).toBe("Sonia Arora");
      expect(c.name).not.toContain("img-0.jpeg");
      expect(c.name).not.toContain("![");
    });

    it("strips bold markdown asterisks from the company field", () => {
      expect(c.company).not.toContain("*");
    });

    it("preserves the complete multi-line company name/wordmark", () => {
      expect(c.company).toBe("Infinity Flower Boutique");
    });

    it("extracts the designation into its own field, separate from company", () => {
      expect(c.designation).toBe("Branch Head");
    });

    it("normalizes and readably formats both phone numbers per their country grouping", () => {
      expect(c.phones).toEqual(["+91 91876 54321", "+91 22 6718 6718"]);
    });

    it("extracts the email correctly despite surrounding artifacts", () => {
      expect(c.email).toBe("sonia.a@mail.web");
    });
  });

  describe("two-column layout: company/logo column read before the name column (reported bug)", () => {
    const c = parseContactFromText(OCR_SAMPLES.companyColumnBeforeName);

    it("extracts the person's name, not the company/logo text that reads first", () => {
      expect(c.name).toBe("Sonia Arora");
    });

    it("extracts the designation adjacent to the name", () => {
      expect(c.designation).toBe("Branch Head");
    });

    it("extracts the full company name, not just part of it", () => {
      expect(c.company).toBe("Infinity Flower Boutique");
    });

    it("does not put company text in the name field or name text in company", () => {
      expect(c.name).not.toContain("Infinity");
      expect(c.company).not.toContain("Sonia Arora");
    });

    it("still extracts both phone numbers and the email correctly", () => {
      expect(c.phones).toEqual(["+91 91876 54321", "+91 22 6718 6718"]);
      expect(c.email).toBe("sonia.a@mail.web");
    });
  });

  describe("two-column layout: single-line company with legal suffix before the name column", () => {
    const c = parseContactFromText(OCR_SAMPLES.companyColumnBeforeNameWithSuffix);

    it("extracts the name near the designation, not the company line that reads first", () => {
      expect(c.name).toBe("Marcus Chen");
    });

    it("extracts the multi-word designation", () => {
      expect(c.designation).toBe("Vice President, Engineering");
    });

    it("extracts the company with its legal suffix intact", () => {
      expect(c.company).toBe("Nimbus Cloud Solutions Inc");
    });
  });

  describe("two-column layout: designation line reads before the name line", () => {
    const c = parseContactFromText(OCR_SAMPLES.designationBeforeNameInColumn);

    it("still finds the name via adjacency, even though it comes after the designation", () => {
      expect(c.name).toBe("Priya Nair");
    });

    it("extracts the designation", () => {
      expect(c.designation).toBe("Founder");
    });

    it("attributes the leading company line to company, not name", () => {
      expect(c.company).toBe("Bloom & Co");
    });
  });

  describe("designation before a company-suffix line", () => {
    const c = parseContactFromText(OCR_SAMPLES.designationAndSuffix);

    it("extracts a multi-word designation distinct from the company", () => {
      expect(c.designation).toBe("Vice President, Engineering");
    });

    it("still detects the company with its legal suffix intact", () => {
      expect(c.company).toBe("Nimbus Cloud Solutions Inc");
    });

    it("formats a US number with standard grouping", () => {
      expect(c.phones).toEqual(["+1 415 555 0134"]);
    });

    it("captures the full street address", () => {
      expect(c.addresses).toEqual(["500 Market Street, Suite 12, San Francisco, CA 94105"]);
    });
  });

  describe("card with no designation line", () => {
    const c = parseContactFromText(OCR_SAMPLES.noDesignation);

    it("leaves designation blank rather than guessing", () => {
      expect(c.designation).toBe("");
    });

    it("still extracts a company without a legal suffix", () => {
      expect(c.company).toBe("Bloom & Co");
    });
  });

  describe("only actual card content is mapped to fields", () => {
    it("does not map a bare URL/logo-caption line to any field", () => {
      const text = "Jane Doe\nwww.example.com\nAcme Inc\njane@acme.com";
      const c = parseContactFromText(text);
      expect(c.name).toBe("Jane Doe");
      expect(c.company).toBe("Acme Inc");
      expect(JSON.stringify(c)).not.toContain("www.example.com");
    });

    it("does not map a symbol-only decorative line to any field", () => {
      const text = "Jane Doe\n----------\nAcme Inc";
      const c = parseContactFromText(text);
      expect(c.name).toBe("Jane Doe");
      expect(c.company).toBe("Acme Inc");
    });
  });

  describe("multi-line address without a street/road keyword (reported bug)", () => {
    const c = parseContactFromText(OCR_SAMPLES.multiLineAddress);

    it("joins both address lines into a single complete entry", () => {
      expect(c.addresses).toEqual(["4th Floor, Tower B, Cyber City, Gurugram 122002"]);
    });

    it("does not let the address lines bleed into name/company/designation", () => {
      expect(c.name).toBe("Rahul Mehta");
      expect(c.designation).toBe("Regional Sales Manager");
      expect(c.company).toBe("Zenith Retail Pvt Ltd");
    });
  });

  it("leaves addresses as an empty list when the card has no address at all", () => {
    const c = parseContactFromText(OCR_SAMPLES.noAddress);
    expect(c.addresses).toEqual([]);
  });

  it("does not mistake a phone number's digit run for a street number or postal code", () => {
    const c = parseContactFromText(OCR_SAMPLES.multiPhone);
    expect(c.addresses).toEqual(["1 Anchor Way, Arlington 22201"]);
  });

  it("keeps two blank-line-separated addresses as two separate list entries", () => {
    const c = parseContactFromText(OCR_SAMPLES.twoAddresses);
    expect(c.addresses).toEqual([
      "10 Harbor St, Boston MA 02110",
      "42 Wharf Ave, Brooklyn NY 11201",
    ]);
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
