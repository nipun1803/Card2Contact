import { describe, expect, it } from "vitest";
import { SHEET_HEADER, contactToRow } from "./google-sheets.service";
import { Contact } from "../../shared/types/contact";

const base: Contact = {
  name: "Ada Lovelace",
  designation: "Chief Analyst",
  phones: ["+1 555 111", "+1 555 222"],
  email: "ada@example.com",
  company: "Analytical Engines Inc",
  addresses: ["1 Mayfair", "2 London Rd"],
  note: "met at conf",
  category: "engineering",
};

describe("contactToRow", () => {
  it("maps fields in SHEET_HEADER column order", () => {
    const row = contactToRow(base);
    expect(row).toEqual([
      "Ada Lovelace",
      "Chief Analyst",
      "+1 555 111; +1 555 222",
      "ada@example.com",
      "Analytical Engines Inc",
      "1 Mayfair; 2 London Rd",
      "met at conf",
      "engineering",
    ]);
  });

  it("produces one cell per header column", () => {
    expect(contactToRow(base)).toHaveLength(SHEET_HEADER.length);
  });

  it("renders empty multi-value fields as empty strings", () => {
    const row = contactToRow({ ...base, phones: [], addresses: [] });
    expect(row[2]).toBe("");
    expect(row[5]).toBe("");
  });
});
