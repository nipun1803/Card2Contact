import { QueryClient } from "@tanstack/react-query";

/**
 * Single QueryClient. The only real query in this app is auth status; the
 * pipeline steps are sequential mutations handled in useCardPipeline. Keep
 * retries conservative so a 401/reauth doesn't get retried into confusion.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

/** Query keys, centralized to avoid typos across invalidations. */
export const queryKeys = {
  auth: ["auth"] as const,
};
