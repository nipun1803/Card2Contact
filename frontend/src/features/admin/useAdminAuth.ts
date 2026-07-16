import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  adminLogin as adminLoginRequest,
  adminLogout as adminLogoutRequest,
  getAdminMe,
} from "@/shared/services/api";
import { queryKeys } from "@/shared/lib/queryClient";
import type { AdminMe } from "@/shared/types/api";

/**
 * Admin auth state. The operator-side mirror of useAuth, and deliberately a
 * separate hook against a separate query key: an admin is a different identity
 * from a Google user, and the two must never invalidate or shadow each other.
 *
 * See docs/modules/admin/Admin-Authentication.md.
 */
export function useAdminAuth() {
  const query = useQuery<AdminMe>({
    queryKey: queryKeys.adminAuth,
    queryFn: getAdminMe,
    /**
     * The shared queryClient already skips retries on 401. `false` additionally
     * covers 503 (admin not configured), which is equally pointless to retry —
     * and a retry loop against an unconfigured server is just noise.
     */
    retry: false,
  });

  /**
   * A 401 is an ANSWER ("you are not signed in"), not a failure to get one — the
   * same distinction useAuth draws for Session Revocation. Conflating them would
   * make AdminProtectedRoute show a "couldn't reach the server" retry screen to
   * someone who simply needs to log in.
   */
  const definitivelySignedOut = query.error instanceof ApiError && query.error.status === 401;

  return {
    isLoading: query.isLoading,
    /** A genuine failure to determine admin state — network, 5xx. Never a 401. */
    isError: query.isError && !definitivelySignedOut,
    authenticated: !query.isError && query.data !== undefined,
    username: query.data?.username,
    refetch: query.refetch,
  };
}

/** Imperative admin auth actions, keeping the query in sync. */
export function useAdminAuthActions() {
  const queryClient = useQueryClient();

  const login = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      adminLoginRequest(username, password),
    onSuccess: (me) => {
      // Seed the cache from the login response so the dashboard renders without
      // a second round-trip, then let it revalidate normally.
      queryClient.setQueryData(queryKeys.adminAuth, me);
    },
  });

  const logout = useMutation({
    mutationFn: adminLogoutRequest,
    onSuccess: () => {
      /**
       * removeQueries, not setQueryData(key, undefined): React Query treats an
       * undefined value as "no change" and leaves the cached entry in place, so
       * the dashboard would keep rendering a logged-out admin's username until
       * something else evicted it.
       *
       * Scoped to the admin key alone — a Google session, if any, is untouched.
       */
      queryClient.removeQueries({ queryKey: queryKeys.adminAuth });
    },
  });

  return { login, logout };
}
