import { useAuth } from "@/features/auth/useAuth";
import { SPREADSHEET_TITLE } from "@/shared/lib/constants";

/**
 * Derives Google Sheet status for the dashboard card. spreadsheetTitle/Url now
 * come from the real backend (GET /api/auth/google/status), present once the
 * user has a provisioned sheet; the constant/null fallbacks only cover the
 * brief edge case where that hasn't happened yet.
 */
export function useSheetStatus() {
  const { authenticated, needsReconnect, status, isLoading } = useAuth();

  return {
    isLoading,
    connected: authenticated && !needsReconnect,
    needsReconnect,
    title: status?.spreadsheetTitle ?? SPREADSHEET_TITLE,
    url: status?.spreadsheetUrl ?? null,
    lastSyncedAt: status?.lastSyncedAt ?? null,
  };
}

/** Open the user's spreadsheet in a new tab (no-op if url unknown). */
export function openSheet(url: string | null): void {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Real, server-tracked total of contacts this user has ever saved (Postgres). */
export function useSavedContactsCount() {
  const { status, isLoading } = useAuth();
  return { count: status?.savedContactsCount ?? 0, isLoading };
}
