import type { Contact } from "./contact";

/** Response and request shapes for the M1–M5 pipeline + auth endpoints. */

export type CardMode = "single" | "double";

export interface SubmitCardResponse {
  cardId: string;
  mode: CardMode;
}

export interface RecognizeResponse {
  cardId: string;
  rawText: string;
}

export interface ExtractResponse {
  cardId: string;
  contact: Contact;
}

export interface ReviewResponse {
  cardId: string;
  contact: Contact;
}

export interface ConfirmResponse {
  cardId: string;
  confirmed: true;
  contact: Contact;
}

export interface SaveResponse {
  cardId: string;
  saved: true;
}

/**
 * Auth status. spreadsheetTitle/spreadsheetUrl are only present once the user
 * has a provisioned sheet (normally true from first login onward) — kept
 * optional so the UI still degrades gracefully for an edge case where it's
 * momentarily missing. savedContactsCount is a running Postgres total,
 * incremented once per successful M5 save; always present once authenticated.
 * lastSyncedAt isn't tracked by the backend yet, so it stays optional/unused.
 */
export interface AuthStatus {
  authenticated: boolean;
  email?: string;
  needsReconnect?: boolean;
  spreadsheetTitle?: string;
  spreadsheetUrl?: string;
  lastSyncedAt?: string;
  savedContactsCount?: number;
}

/**
 * GET /api/admin/auth/me and POST /api/admin/auth/login both return this.
 * The admin has no profile beyond the configured username in Phase 0.1.
 */
export interface AdminMe {
  username: string;
}
