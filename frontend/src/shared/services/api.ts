import type { Contact, ContactEdits } from "@/shared/types/contact";
import type {
  AuthStatus,
  CardMode,
  ConfirmResponse,
  ExtractResponse,
  RecognizeResponse,
  ReviewResponse,
  SaveResponse,
  SubmitCardResponse,
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

/** A network-level failure (server unreachable, offline). */
export class NetworkError extends Error {
  constructor(message = "Network request failed") {
    super(message);
    this.name = "NetworkError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", ...init });
  } catch {
    throw new NetworkError();
  }

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
