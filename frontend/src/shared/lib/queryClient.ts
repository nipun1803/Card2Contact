import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/shared/services/api";

/**
 * Single QueryClient. The only real query in this app is auth status; the
 * pipeline steps are sequential mutations handled in useCardPipeline.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 is never transient: the session is revoked, expired, or absent,
      // and retrying only delays the redirect. Retry genuine flakes once.
      retry: (failureCount, error) =>
        error instanceof ApiError && error.status === 401 ? false : failureCount < 1,
      staleTime: 30_000,
      /**
       * This is how a device whose session was revoked elsewhere finds out.
       *
       * Single active session means signing in on a second device revokes the
       * first. The revoked device only learns this when it next talks to the
       * backend — and an idle tab makes no requests. Refetching auth status on
       * window focus means the moment the user returns to that tab, /status
       * 401s with SESSION_REVOKED and they are told what happened. Without it
       * they would sit on a stale dashboard indefinitely.
       *
       * The alternative (polling) would cost a request per tab per interval,
       * forever, to cover a case that almost never happens.
       */
      refetchOnWindowFocus: true,
    },
  },
});

/** Query keys, centralized to avoid typos across invalidations. */
export const queryKeys = {
  auth: ["auth"] as const,
  /**
   * Admin auth status — deliberately a separate key from `auth`. Sharing one
   * would make an admin login invalidate the Google session query (and vice
   * versa): two unrelated identities refetching each other for no reason.
   */
  adminAuth: ["admin-auth"] as const,
};
