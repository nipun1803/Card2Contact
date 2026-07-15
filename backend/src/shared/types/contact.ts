/**
 * Structured contact fields, as defined by M3 (Contact Extraction) §4
 * and consumed/mutated by M4 (Contact Review).
 */
export interface Contact {
  name: string;
  phones: string[];
  email: string;
  company: string;
  addresses: string[];
  note: string;
  category: string;
}

/** Partial edits accepted by M4's PATCH endpoint — any subset of Contact fields. */
export type ContactEdits = Partial<Contact>;

export function createEmptyContact(): Contact {
  return {
    name: "",
    phones: [],
    email: "",
    company: "",
    addresses: [],
    note: "",
    category: "",
  };
}
