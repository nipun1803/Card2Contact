/**
 * Mirrors backend/src/shared/types/contact.ts. Frontend and backend are kept
 * completely separate (no shared import across the boundary), so this type is
 * intentionally duplicated to match the API's JSON contract.
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
