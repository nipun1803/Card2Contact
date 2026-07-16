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

/* ---- Admin User Management (Phase 1) -------------------------------------
 *
 * Every /api/admin/users* success response is wrapped in {data, meta?} — a
 * convention scoped to this surface only (see
 * docs/modules/admin/USER_MANAGEMENT.md's "Endpoints" section).
 * Errors are unchanged: still {error, code?}.
 */

export interface AdminUserSummary {
  googleUserId: string;
  email: string;
  spreadsheetTitle: string | null;
  savedContactsCount: number;
  createdAt: string;
  lastLoginAt: string | null;
  disabled: boolean;
  disabledAt: string | null;
  disabledBy: string | null;
  restoredAt: string | null;
  restoredBy: string | null;
}

export interface AdminActiveSession {
  device: string | null;
  browser: string | null;
  ip: string | null;
  lastActivityAt: string;
}

export interface AdminUserDetail extends AdminUserSummary {
  activeSession: AdminActiveSession | null;
}

export interface AdminUserStats {
  total: number;
  active: number;
  disabled: number;
  recentLogins: number;
  /** App-wide total of successful M5 saves ("scans") across every user. */
  totalScans: number;
}

/** Cursor-pagination metadata, shared by every list endpoint under /api/admin/users*. */
export interface PageMeta {
  total: number;
  totalPages: number;
  nextCursor: string | null;
  limit: number;
}

export interface AdminUserListResponse {
  data: { users: AdminUserSummary[]; stats: AdminUserStats };
  meta: { page: PageMeta };
}

export interface AdminUserDetailResponse {
  data: AdminUserDetail;
}

export interface AdminForceLogoutResponse {
  data: { revokedCount: number };
}

export interface AdminAuditEntry {
  id: number;
  ts: string;
  event: string;
  googleUserId: string | null;
  adminUsername: string | null;
  sessionId: string | null;
  device: string | null;
  browser: string | null;
  ip: string | null;
  outcome: "success" | "failure" | null;
  reason: string | null;
  cardId: string | null;
  revokedCount: number | null;
}

export interface AdminAuditResponse {
  data: { entries: AdminAuditEntry[] };
  meta: { page: PageMeta };
}
