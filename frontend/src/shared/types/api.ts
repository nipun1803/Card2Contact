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

/* ---- License Management (Phase 4/5) --------------------------------------
 * Mirror the backend serializers in admin-licenses.router.ts exactly. The
 * {data, meta?} envelope convention extends to /api/admin/licenses*.
 */

export interface LicenseSettings {
  defaultFreeLimit: number;
  defaultPaidLimit: number;
  freeEnabled: boolean;
  paidEnabled: boolean;
  enforcementEnabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}
export type LicenseSettingsPatch = Partial<
  Pick<
    LicenseSettings,
    "defaultFreeLimit" | "defaultPaidLimit" | "freeEnabled" | "paidEnabled" | "enforcementEnabled"
  >
>;
export interface LicenseSettingsResponse {
  data: LicenseSettings;
}

export interface PaidGrant {
  id: number;
  amount: number;
  used: number;
  remaining: number;
  expiresAt: string | null;
  grantedAt: string;
  grantedBy: string;
  status: "active" | "expired" | "revoked";
  reason: string | null;
}

export interface ActiveTier {
  tierId: number | null;
  name: string;
  unlimited: boolean;
  unlimitedUntil: string | null;
  expiresAt: string | null;
}

export interface EffectiveQuota {
  googleUserId: string;
  /** The user's email for admin display; null when unknown (fall back to the id). */
  email: string | null;
  freeLimit: number;
  freeUsed: number;
  freeRemaining: number;
  hasFreeOverride: boolean;
  paidRemaining: number;
  totalRemaining: number;
  scanBlocked: boolean;
  scanBlockedAt: string | null;
  scanBlockedBy: string | null;
  unlimited: boolean;
  activeTier: ActiveTier | null;
  paidGrants: PaidGrant[];
}

export interface QuotaStats {
  usersWithQuota: number;
  scanBlocked: number;
  totalFreeUsed: number;
  totalPaidUsed: number;
  lowRemaining: number;
}

export interface LicenseListResponse {
  data: { quotas: EffectiveQuota[]; stats: QuotaStats };
  meta: { page: PageMeta };
}
export interface LicenseDetailResponse {
  data: EffectiveQuota;
}

export interface QuotaLedgerEntry {
  id: number;
  ts: string;
  kind: string;
  pool: "free" | "paid" | "unlimited" | null;
  grantId: number | null;
  delta: number | null;
  reason: string | null;
  adminUsername: string | null;
}
export interface LicenseHistoryResponse {
  data: { entries: QuotaLedgerEntry[] };
  meta: { page: PageMeta };
}

export interface TierAssignmentEntry {
  id: number;
  tierId: number | null;
  tierName: string | null;
  isUnlimited: boolean | null;
  scanLimit: number | null;
  validityDays: number | null;
  expiresAt: string | null;
  previousTierId: number | null;
  previousTierName: string | null;
  action: "assigned" | "changed" | "removed";
  assignedBy: string | null;
  assignedAt: string;
}
export interface TierHistoryResponse {
  data: { entries: TierAssignmentEntry[] };
  meta: { page: PageMeta };
}

export interface Tier {
  id: number;
  name: string;
  isUnlimited: boolean;
  scanLimit: number | null;
  validityDays: number | null;
  isDefault: boolean;
  sortOrder: number;
  archivedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
  /** Present on the list endpoint: how many users currently hold this tier. */
  assignedCount?: number;
}
export interface TierInput {
  name: string;
  isUnlimited: boolean;
  scanLimit: number | null;
  validityDays: number | null;
  sortOrder?: number;
}
export interface TierListResponse {
  data: { tiers: Tier[] };
}
export interface TierResponse {
  data: Tier;
}

/* ---- Tier Upgrade Requests ----------------------------------------------- */

export type TierRequestKind = "tier" | "custom";
export type TierRequestStatus = "pending" | "approved" | "rejected";

export interface TierRequest {
  id: number;
  /** Present on the admin queue; omitted from the user's own view. */
  googleUserId?: string;
  /** The user's email for admin display; null when unknown (fall back to the id). */
  email?: string | null;
  kind: TierRequestKind;
  requestedTierId: number | null;
  requestedTierName: string | null;
  requestedAmount: number | null;
  requestedDays: number | null;
  userNote: string | null;
  currentTierName: string | null;
  status: TierRequestStatus;
  /** Admin who decided (admin queue only). */
  decidedBy?: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  grantedTierId: number | null;
  grantedAmount: number | null;
  grantedDays: number | null;
  createdAt: string;
}

/** A tier as a user sees it in the upgrade picker — no internal fields. */
export interface PublicTier {
  id: number;
  name: string;
  isUnlimited: boolean;
  scanLimit: number | null;
  validityDays: number | null;
  isDefault: boolean;
}

/** The user's own quota (a trimmed EffectiveQuota — no admin-only fields). */
export interface MyQuota {
  freeLimit: number;
  freeUsed: number;
  freeRemaining: number;
  paidRemaining: number;
  totalRemaining: number;
  unlimited: boolean;
  scanBlocked: boolean;
  activeTier: ActiveTier | null;
  paidGrants: Array<Pick<PaidGrant, "id" | "amount" | "used" | "remaining" | "expiresAt" | "status">>;
}

export interface MyPlanResponse {
  data: {
    quota: MyQuota;
    availableTiers: PublicTier[];
    pendingRequest: TierRequest | null;
    recentRequests: TierRequest[];
  };
}
export interface MyRequestsResponse {
  data: { requests: TierRequest[] };
}
export interface TierRequestResponse {
  data: TierRequest;
}

export interface CreateRequestInput {
  kind: TierRequestKind;
  tierId?: number | null;
  amount?: number | null;
  days?: number | null;
  note?: string | null;
}

export interface ApproveOverrideInput {
  tierId?: number | null;
  amount?: number | null;
  days?: number | null;
  note?: string | null;
}

export interface AdminRequestListResponse {
  data: { requests: TierRequest[]; pendingCount: number };
  meta: { page: PageMeta };
}
export interface AdminApproveResponse {
  data: { request: TierRequest; quota: EffectiveQuota };
}
