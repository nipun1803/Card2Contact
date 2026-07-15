import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthStatus, logout as logoutRequest } from "@/shared/services/api";
import { queryKeys } from "@/shared/lib/queryClient";
import type { AuthStatus } from "@/shared/types/api";

/**
 * The single source of truth for auth state. Wraps GET /api/auth/google/status
 * in a query so every screen sees a consistent, cached view. This is the only
 * genuine "query" in the app — the pipeline steps are sequential mutations.
 */
export function useAuth() {
  const query = useQuery<AuthStatus>({
    queryKey: queryKeys.auth,
    queryFn: getAuthStatus,
  });

  const status = query.data;

  return {
    /** Undefined until the first fetch resolves — callers gate on isLoading. */
    isLoading: query.isLoading,
    isError: query.isError,
    authenticated: status?.authenticated ?? false,
    needsReconnect: status?.needsReconnect ?? false,
    email: status?.email,
    status,
    refetch: query.refetch,
  };
}

/** Imperative helpers to mutate auth state and keep the query in sync. */
export function useAuthActions() {
  const queryClient = useQueryClient();

  async function logout() {
    await logoutRequest();
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth });
  }

  function refreshAuth() {
    return queryClient.invalidateQueries({ queryKey: queryKeys.auth });
  }

  return { logout, refreshAuth };
}
