import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SessionRevokedError,
  getAuthStatus,
  logout as logoutRequest,
} from "@/shared/services/api";
import { queryKeys } from "@/shared/lib/queryClient";
import type { AuthStatus } from "@/shared/types/api";

/**
 * The single source of truth for auth state. Wraps GET /api/auth/google/status
 * in a query so every screen sees a consistent, cached view. This is the only
 * genuine "query" in the app — the pipeline steps are sequential mutations.
 *
 * The query refetches on window focus (see queryClient), which is how a device
 * whose session was revoked elsewhere discovers it.
 */
export function useAuth() {
  const query = useQuery<AuthStatus>({
    queryKey: queryKeys.auth,
    queryFn: getAuthStatus,
  });

  const status = query.data;

  /**
   * Session Revocation is an *answer*, not a failure to get one — the server
   * told us plainly that this session was ended. It must be distinguished from
   * isError (we couldn't reach the server), or the UI would offer a Retry
   * button for something retrying can never fix.
   */
  const sessionRevoked = query.error instanceof SessionRevokedError;

  return {
    /** Undefined until the first fetch resolves — callers gate on isLoading. */
    isLoading: query.isLoading,
    /** A genuine failure to determine auth state. Excludes Session Revocation. */
    isError: query.isError && !sessionRevoked,
    /** This session was ended server-side (almost always Session Replacement). */
    sessionRevoked,
    /** Why, in the server's words — shown to the user on the way to /login. */
    sessionRevokedMessage: sessionRevoked ? (query.error as SessionRevokedError).message : undefined,
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
