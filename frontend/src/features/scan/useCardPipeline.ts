import { useCallback, useReducer } from "react";
import { toast } from "sonner";
import {
  ApiError,
  NetworkError,
  QuotaExceededError,
  ReauthError,
  ScanBlockedError,
  confirmContact,
  extractContact,
  recognizeCard,
  saveContact,
  submitCard,
  updateContact,
} from "@/shared/services/api";
import { addRecentScan } from "@/shared/services/recentScans";
import { useAuthActions } from "@/features/auth/useAuth";
import type { CardMode } from "@/shared/types/api";
import type { Contact } from "@/shared/types/contact";

/**
 * The scan wizard is a single client-side state machine. It sequences the
 * M1–M5 backend calls (which are strictly ordered and enforced server-side) and
 * exposes just two actions — submit() and confirm(). No business rules live
 * here; every decision belongs to the backend. We only sequence, render loading
 * states, and route failures.
 *
 * Why not TanStack Query mutations per step? The steps form one linear command
 * chain with 409-able ordering; a reducer + awaited calls reads far cleaner than
 * five chained onSuccess callbacks.
 */
export type PipelineStatus =
  | "capture"
  | "submitting"
  | "recognizing"
  | "extracting"
  | "review"
  | "saving"
  | "done"
  | "reconnect"
  // Scan quota gating (License Management): a signed-in user was refused at OCR.
  | "quotaExceeded" // 402 — out of allowance, resolvable by an admin grant/tier
  | "scanBlocked"; // 403 SCAN_BLOCKED — admin blocked this user's scanning

interface PipelineState {
  status: PipelineStatus;
  cardId: string | null;
  contact: Contact | null;
  /** Inline error shown on the current screen (non-fatal, e.g. save failed). */
  error: string | null;
}

type Action =
  | { type: "SUBMIT_START" }
  | { type: "RECOGNIZING"; cardId: string }
  | { type: "EXTRACTING" }
  | { type: "REVIEW"; contact: Contact }
  | { type: "SAVING"; contact: Contact }
  | { type: "DONE" }
  | { type: "RECONNECT" }
  | { type: "QUOTA_EXCEEDED" }
  | { type: "SCAN_BLOCKED" }
  | { type: "ERROR"; status: PipelineStatus; message: string }
  | { type: "RESET" };

const initialState: PipelineState = {
  status: "capture",
  cardId: null,
  contact: null,
  error: null,
};

function reducer(state: PipelineState, action: Action): PipelineState {
  switch (action.type) {
    case "SUBMIT_START":
      return { ...state, status: "submitting", error: null };
    case "RECOGNIZING":
      return { ...state, status: "recognizing", cardId: action.cardId };
    case "EXTRACTING":
      return { ...state, status: "extracting" };
    case "REVIEW":
      return { ...state, status: "review", contact: action.contact, error: null };
    case "SAVING":
      return { ...state, status: "saving", contact: action.contact, error: null };
    case "DONE":
      return { ...state, status: "done" };
    case "RECONNECT":
      return { ...state, status: "reconnect" };
    case "QUOTA_EXCEEDED":
      return { ...state, status: "quotaExceeded" };
    case "SCAN_BLOCKED":
      return { ...state, status: "scanBlocked" };
    case "ERROR":
      return { ...state, status: action.status, error: action.message };
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

function describe(err: unknown): string {
  if (err instanceof NetworkError) return "Network error — check your connection and try again.";
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * A 404 (card session gone from backend RAM) or 409 (out-of-order) mid-flow is
 * unrecoverable for this card — reset to capture with a clear toast.
 */
function isSessionLost(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 409);
}

export function useCardPipeline() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { refreshAuth } = useAuthActions();

  const submit = useCallback(
    async (mode: CardMode, front: File, back: File | null) => {
      dispatch({ type: "SUBMIT_START" });
      try {
        const { cardId } = await submitCard(mode, front, back);
        dispatch({ type: "RECOGNIZING", cardId });
        await recognizeCard(cardId);
        dispatch({ type: "EXTRACTING" });
        const { contact } = await extractContact(cardId);
        dispatch({ type: "REVIEW", contact });
      } catch (err) {
        // Quota gating first — a 402/403 here is a definitive "you can't scan",
        // routed to a dedicated panel (no toast, no retry), like RECONNECT.
        if (err instanceof QuotaExceededError) {
          dispatch({ type: "QUOTA_EXCEEDED" });
          return;
        }
        if (err instanceof ScanBlockedError) {
          dispatch({ type: "SCAN_BLOCKED" });
          return;
        }
        if (isSessionLost(err)) {
          toast.error("That scan session expired. Please start over.");
          dispatch({ type: "RESET" });
          return;
        }
        toast.error(describe(err));
        dispatch({ type: "ERROR", status: "capture", message: describe(err) });
      }
    },
    [],
  );

  const confirm = useCallback(
    async (edited: Contact) => {
      const { cardId } = state;
      if (!cardId) return;
      dispatch({ type: "SAVING", contact: edited });
      try {
        // Explicit review flow: persist edits (PATCH) so the saved row reflects
        // them, then confirm, then save.
        await updateContact(cardId, edited);
        await confirmContact(cardId);
        await saveContact(cardId, edited);
        addRecentScan(cardId, edited);
        // A save may have just recreated the user's sheet (trashed/deleted case),
        // which updates spreadsheetId/url/title in Postgres — refetch auth status
        // so the dashboard's sheet link/title picks up the change immediately
        // instead of waiting for a window-focus refetch.
        refreshAuth();
        dispatch({ type: "DONE" });
        toast.success("Contact saved to Google Sheets");
      } catch (err) {
        if (err instanceof ReauthError) {
          // Google access expired mid-save. The backend RAM session is likely
          // gone too, so the honest recovery is to reconnect and rescan — we do
          // NOT persist the draft (nothing reads it back, and it would only leak
          // contact PII into sessionStorage). Route to the reconnect screen.
          dispatch({ type: "RECONNECT" });
          return;
        }
        if (isSessionLost(err)) {
          toast.error("That scan session expired. Please start over.");
          dispatch({ type: "RESET" });
          return;
        }
        toast.error(describe(err));
        dispatch({ type: "ERROR", status: "review", message: describe(err) });
      }
    },
    [state, refreshAuth],
  );

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);

  return { state, submit, confirm, reset };
}
