import * as Sentry from "@sentry/react";
import type { Contact, ContactEdits } from "@/shared/types/contact";
import type {
  AdminAuditResponse,
  AdminForceLogoutResponse,
  AdminMe,
  AdminUserDetailResponse,
  AdminUserListResponse,
  AuthStatus,
  CardMode,
  ConfirmResponse,
  ExtractResponse,
  LicenseDetailResponse,
  LicenseHistoryResponse,
  LicenseListResponse,
  LicenseSettingsPatch,
  LicenseSettingsResponse,
  RecognizeResponse,
  ReviewResponse,
  SaveResponse,
  SubmitCardResponse,
  TierHistoryResponse,
  TierInput,
  TierListResponse,
  TierResponse,
  TierRequestStatus,
  MyPlanResponse,
  MyRequestsResponse,
  TierRequestResponse,
  CreateRequestInput,
  ApproveOverrideInput,
  AdminRequestListResponse,
  AdminApproveResponse,
} from "@/shared/types/api";

/**
 * The only module in the frontend that knows about HTTP or API shapes.
 * Components call these functions and never construct requests themselves —
 * this keeps the frontend API-driven with no business logic of its own.
 *
 * Every request sends `credentials: "include"` (baked into `request`) so the
 * httpOnly session cookie rides along, required for the authenticated save.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * A 401 whose body carries `code: "REAUTH_REQUIRED"` — the user's Google access
 * was revoked/expired. The UI routes this to the "reconnect" screen instead of
 * treating it as a generic failure.
 */
export class ReauthError extends ApiError {
  constructor(message: string) {
    super(401, message);
    this.name = "ReauthError";
  }
}

/**
 * A 401 whose body carries `code: "SESSION_REVOKED"` — this session was ended
 * server-side, almost always because the user signed in on another device
 * (single active session). Distinct from a plain 401 (never signed in): the UI
 * explains why the user was signed out rather than bouncing silently to /login.
 */
export class SessionRevokedError extends ApiError {
  constructor(message: string) {
    super(401, message);
    this.name = "SessionRevokedError";
  }
}

/**
 * A 403 whose body carries `code: "USER_DISABLED"` — an admin revoked this
 * user's access. Distinct from ReauthError (Google itself rejected the
 * tokens) and SessionRevokedError (a specific session was ended): this is an
 * administrative decision, so the UI explains it as such rather than
 * prompting "reconnect" or "signed in elsewhere".
 */
export class UserDisabledError extends ApiError {
  constructor(message: string) {
    super(403, message);
    this.name = "UserDisabledError";
  }
}

/**
 * A 402 whose body carries `code: "QUOTA_EXCEEDED"` — the signed-in user has no
 * scan allowance left. Resolvable by an admin grant/tier; the scan UI shows an
 * "out of scans, contact your administrator" panel rather than a generic error.
 */
export class QuotaExceededError extends ApiError {
  constructor(message: string) {
    super(402, message);
    this.name = "QuotaExceededError";
  }
}

/**
 * A 403 whose body carries `code: "SCAN_BLOCKED"` — an admin blocked this user's
 * scanning (they stay signed in; only scanning is refused). DISTINCT from
 * UserDisabledError (also 403, whole-account Revoke Access): the two are told
 * apart by `code`, never by the shared 403 status.
 */
export class ScanBlockedError extends ApiError {
  constructor(message: string) {
    super(403, message);
    this.name = "ScanBlockedError";
  }
}

/** A network-level failure (server unreachable, offline). */
export class NetworkError extends Error {
  constructor(message = "Network request failed") {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * Every API call's volume and latency, as Sentry metrics — never the request
 * or response body (which can carry contact data or tokens), only method,
 * status, and timing.
 */
function recordApiCallMetric(method: string, status: number | "network_error", durationMs: number) {
  const statusTag = String(status);
  Sentry.metrics.count("api_call", 1, { attributes: { method, status: statusTag } });
  Sentry.metrics.distribution("api_call.duration_ms", durationMs, {
    unit: "millisecond",
    attributes: { method, status: statusTag },
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const start = performance.now();
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", ...init });
  } catch {
    recordApiCallMetric(method, "network_error", performance.now() - start);
    throw new NetworkError();
  }
  recordApiCallMetric(method, res.status, performance.now() - start);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 401 && body.code === "REAUTH_REQUIRED") {
      throw new ReauthError(body.error ?? "Please reconnect Google");
    }
    if (res.status === 401 && body.code === "SESSION_REVOKED") {
      throw new SessionRevokedError(
        body.error ?? "You were signed out because you signed in on another device",
      );
    }
    if (res.status === 403 && body.code === "USER_DISABLED") {
      throw new UserDisabledError(body.error ?? "This account has been disabled");
    }
    if (res.status === 402 && body.code === "QUOTA_EXCEEDED") {
      throw new QuotaExceededError(body.error ?? "Scan quota exhausted — contact your administrator");
    }
    // SCAN_BLOCKED shares 403 with USER_DISABLED — branch on the code, not status.
    if (res.status === 403 && body.code === "SCAN_BLOCKED") {
      throw new ScanBlockedError(
        body.error ?? "Scanning is blocked for your account — contact your administrator",
      );
    }
    throw new ApiError(res.status, body.error ?? res.statusText);
  }

  // 204/empty bodies return undefined; callers that expect a body type them.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ---- Auth ---------------------------------------------------------------- */

export function getAuthStatus(): Promise<AuthStatus> {
  return request<AuthStatus>("/api/auth/google/status");
}

export async function logout(): Promise<void> {
  await request<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

/** Full-page navigation into the backend's Google OAuth redirect flow. */
export function googleSignInUrl(): string {
  return "/api/auth/google";
}

/**
 * Session Conflict resolution. Both authenticate via the short-lived
 * `c2c_pending` cookie the backend set during the OAuth callback — the caller
 * has no Active Session yet, by construction.
 */

/** Confirm Session Replacement: activate this device, sign the other one out. */
export async function continueSession(): Promise<void> {
  await request<{ ok: true }>("/api/auth/session/continue", { method: "POST" });
}

/** Abandon this sign-in and leave the other device signed in. */
export async function cancelSession(): Promise<void> {
  await request<{ ok: true }>("/api/auth/session/cancel", { method: "POST" });
}

/* ---- Admin auth ---------------------------------------------------------- */

/**
 * The operator login, entirely separate from the Google flow above. All three
 * ride the `admin_session` cookie via `request`'s credentials: "include".
 *
 * These deliberately need no special-casing in `request`: the backend's admin
 * codes (ADMIN_INVALID_CREDENTIALS / ADMIN_NOT_AUTHENTICATED /
 * ADMIN_NOT_CONFIGURED) are distinct from REAUTH_REQUIRED and SESSION_REVOKED,
 * so they fall through to a plain ApiError carrying the status — which is
 * exactly right. An admin 401 must never be mistaken for a Google Session
 * Revocation and bounce the user to /login.
 */

/** 401 (bad credentials), 429 (rate limited), or 503 (admin not configured). */
export async function adminLogin(username: string, password: string): Promise<AdminMe> {
  return request<AdminMe>("/api/admin/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

/** Idempotent — succeeds even with no session. */
export async function adminLogout(): Promise<void> {
  await request<{ ok: true }>("/api/admin/auth/logout", { method: "POST" });
}

/** 401 when there is no live Admin Session — a definitive answer, not an error. */
export function getAdminMe(): Promise<AdminMe> {
  return request<AdminMe>("/api/admin/auth/me");
}

/* ---- Pipeline ------------------------------------------------------------ */

// M1 — submit a new card
export function submitCard(
  mode: CardMode,
  frontImage: File,
  backImage: File | null,
): Promise<SubmitCardResponse> {
  const form = new FormData();
  form.set("mode", mode);
  form.set("frontImage", frontImage);
  if (backImage) form.set("backImage", backImage);
  return request<SubmitCardResponse>("/api/cards", { method: "POST", body: form });
}

// M2 — run OCR
export function recognizeCard(cardId: string): Promise<RecognizeResponse> {
  return request<RecognizeResponse>(`/api/cards/${cardId}/recognize`, { method: "POST" });
}

// M3 — extract structured contact fields
export function extractContact(cardId: string): Promise<ExtractResponse> {
  return request<ExtractResponse>(`/api/cards/${cardId}/extract`, { method: "POST" });
}

// M4 — apply user edits (arrays are replaced wholesale by the backend)
export function updateContact(cardId: string, edits: ContactEdits): Promise<ReviewResponse> {
  return request<ReviewResponse>(`/api/cards/${cardId}/contact`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

// M4 — confirm the contact (400 if name is blank)
export function confirmContact(cardId: string): Promise<ConfirmResponse> {
  return request<ConfirmResponse>(`/api/cards/${cardId}/confirm`, { method: "POST" });
}

// M5 — save to Google Sheets (requires auth)
export function saveContact(cardId: string, contact: Contact): Promise<SaveResponse> {
  return request<SaveResponse>("/api/contacts/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId, contact }),
  });
}

/* ---- Admin user management (Phase 1) -------------------------------------
 *
 * All ride the admin_session cookie via `request`'s credentials: "include".
 * Cursor-based, not page-number based — see ListUsersQuery.cursor.
 */

export interface ListUsersQuery {
  cursor?: string;
  limit?: number;
  search?: string;
  status?: "all" | "active" | "disabled";
  sortField?: "createdAt" | "lastLoginAt" | "savedContactsCount" | "email";
  sortDirection?: "asc" | "desc";
  registeredAfter?: string;
  registeredBefore?: string;
  lastLoginAfter?: string;
}

function toQueryString(q: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function listAdminUsers(query: ListUsersQuery = {}): Promise<AdminUserListResponse> {
  return request<AdminUserListResponse>(`/api/admin/users${toQueryString({ ...query })}`);
}

export function getAdminUser(googleUserId: string): Promise<AdminUserDetailResponse> {
  return request<AdminUserDetailResponse>(`/api/admin/users/${encodeURIComponent(googleUserId)}`);
}

export function getAdminUserAudit(
  googleUserId: string,
  cursor?: string,
  limit = 20,
): Promise<AdminAuditResponse> {
  return request<AdminAuditResponse>(
    `/api/admin/users/${encodeURIComponent(googleUserId)}/audit${toQueryString({ cursor, limit })}`,
  );
}

/** Revoke Access. */
export function disableAdminUser(googleUserId: string): Promise<AdminUserDetailResponse> {
  return request<AdminUserDetailResponse>(
    `/api/admin/users/${encodeURIComponent(googleUserId)}/disable`,
    { method: "POST" },
  );
}

/** Restore Access. */
export function restoreAdminUser(googleUserId: string): Promise<AdminUserDetailResponse> {
  return request<AdminUserDetailResponse>(
    `/api/admin/users/${encodeURIComponent(googleUserId)}/restore`,
    { method: "POST" },
  );
}

/** Kick any active session(s) without disabling the account. */
export function forceLogoutAdminUser(googleUserId: string): Promise<AdminForceLogoutResponse> {
  return request<AdminForceLogoutResponse>(
    `/api/admin/users/${encodeURIComponent(googleUserId)}/force-logout`,
    { method: "POST" },
  );
}

/* ---- License Management (Phase 4/5) --------------------------------------
 *
 * Scan quotas, per-user tier assignment, and the tier catalog. All ride the
 * admin_session cookie via `request`. Cursor-based like the user directory.
 */

export interface ListLicensesQuery {
  cursor?: string;
  limit?: number;
  search?: string;
  status?: "all" | "low" | "over" | "custom" | "scan_blocked";
  sortField?: "freeUsed" | "totalRemaining" | "googleUserId";
  sortDirection?: "asc" | "desc";
}

function adminLicense(path: string): string {
  return `/api/admin/licenses${path}`;
}

function userPath(googleUserId: string, suffix = ""): string {
  return adminLicense(`/quotas/${encodeURIComponent(googleUserId)}${suffix}`);
}

const jsonPost = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

// ── Settings ────────────────────────────────────────────────────────────────
export function getLicenseSettings(): Promise<LicenseSettingsResponse> {
  return request<LicenseSettingsResponse>(adminLicense("/settings"));
}

export function updateLicenseSettings(patch: LicenseSettingsPatch): Promise<LicenseSettingsResponse> {
  return request<LicenseSettingsResponse>(adminLicense("/settings"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// ── Quota directory + detail ─────────────────────────────────────────────────
export function listLicenses(query: ListLicensesQuery = {}): Promise<LicenseListResponse> {
  return request<LicenseListResponse>(adminLicense(`/quotas${toQueryString({ ...query })}`));
}

export function getLicense(googleUserId: string): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId));
}

export function getLicenseHistory(
  googleUserId: string,
  cursor?: string,
  limit = 20,
): Promise<LicenseHistoryResponse> {
  return request<LicenseHistoryResponse>(userPath(googleUserId, `/history${toQueryString({ cursor, limit })}`));
}

export function getTierHistory(
  googleUserId: string,
  cursor?: string,
  limit = 20,
): Promise<TierHistoryResponse> {
  return request<TierHistoryResponse>(userPath(googleUserId, `/tier-history${toQueryString({ cursor, limit })}`));
}

// ── Per-user quota actions (all return the updated EffectiveQuota) ────────────
export function setFreeLimit(googleUserId: string, limit: number): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId, "/free"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit }),
  });
}

export function removeFreeOverride(googleUserId: string): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId, "/free"), { method: "DELETE" });
}

export function grantPaid(
  googleUserId: string,
  amount: number,
  expiresAt: string | null,
  reason?: string,
): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(
    userPath(googleUserId, "/paid/grants"),
    jsonPost({ amount, expiresAt, reason }),
  );
}

export function revokeGrant(googleUserId: string, grantId: number): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId, `/paid/grants/${grantId}`), {
    method: "DELETE",
  });
}

export function resetUsed(
  googleUserId: string,
  pool: "free" | "paid" | "both",
): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId, "/reset"), jsonPost({ pool }));
}

export function recalculateQuota(googleUserId: string): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId, "/recalculate"), { method: "POST" });
}

export function scanBlockUser(googleUserId: string): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId, "/scan-block"), { method: "POST" });
}

export function scanUnblockUser(googleUserId: string): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId, "/scan-unblock"), { method: "POST" });
}

// ── Tier assignment ──────────────────────────────────────────────────────────
export function assignTier(googleUserId: string, tierId: number): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId, "/tier"), jsonPost({ tierId }));
}

export function removeTier(googleUserId: string): Promise<LicenseDetailResponse> {
  return request<LicenseDetailResponse>(userPath(googleUserId, "/tier"), { method: "DELETE" });
}

// ── Tier catalog ─────────────────────────────────────────────────────────────
export function listTiers(search?: string): Promise<TierListResponse> {
  return request<TierListResponse>(adminLicense(`/tiers${toQueryString({ search })}`));
}

export function createTier(input: TierInput): Promise<TierResponse> {
  return request<TierResponse>(adminLicense("/tiers"), jsonPost(input));
}

export function updateTier(id: number, patch: Partial<TierInput>): Promise<TierResponse> {
  return request<TierResponse>(adminLicense(`/tiers/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function archiveTier(id: number): Promise<void> {
  return request<void>(adminLicense(`/tiers/${id}`), { method: "DELETE" });
}

export function cloneTier(id: number, name: string): Promise<TierResponse> {
  return request<TierResponse>(adminLicense(`/tiers/${id}/clone`), jsonPost({ name }));
}

export function bulkAssignTier(
  tierId: number,
  googleUserIds: string[],
): Promise<{ data: { assigned: number } }> {
  return request<{ data: { assigned: number } }>(
    adminLicense(`/tiers/${tierId}/bulk-assign`),
    jsonPost({ googleUserIds }),
  );
}

/* ---- User-facing plan + upgrade requests (/api/me) ----------------------- */

export function getMyPlan(): Promise<MyPlanResponse> {
  return request<MyPlanResponse>("/api/me/plan");
}

export function getMyRequests(): Promise<MyRequestsResponse> {
  return request<MyRequestsResponse>("/api/me/requests");
}

/** File an upgrade request. A 409 REQUEST_ALREADY_PENDING means one is open. */
export function createUpgradeRequest(input: CreateRequestInput): Promise<TierRequestResponse> {
  return request<TierRequestResponse>("/api/me/requests", jsonPost(input));
}

/* ---- Admin: upgrade request queue --------------------------------------- */

export function listUpgradeRequests(
  query: { status?: TierRequestStatus; cursor?: string; limit?: number } = {},
): Promise<AdminRequestListResponse> {
  return request<AdminRequestListResponse>(adminLicense(`/requests${toQueryString({ ...query })}`));
}

export function getUpgradeRequestCount(): Promise<{ data: { pendingCount: number } }> {
  return request<{ data: { pendingCount: number } }>(adminLicense("/requests/count"));
}

export function getUserUpgradeRequests(googleUserId: string): Promise<MyRequestsResponse> {
  return request<MyRequestsResponse>(userPath(googleUserId, "/requests"));
}

/** Approve a request. Omit override fields to approve exactly as asked. */
export function approveUpgradeRequest(
  id: number,
  override: ApproveOverrideInput = {},
): Promise<AdminApproveResponse> {
  return request<AdminApproveResponse>(adminLicense(`/requests/${id}/approve`), jsonPost(override));
}

export function rejectUpgradeRequest(id: number, note?: string): Promise<TierRequestResponse> {
  return request<TierRequestResponse>(adminLicense(`/requests/${id}/reject`), jsonPost({ note }));
}
