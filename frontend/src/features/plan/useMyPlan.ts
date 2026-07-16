import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createUpgradeRequest, getMyPlan, getMyRequests } from "@/shared/services/api";
import { queryKeys } from "@/shared/lib/queryClient";
import type { CreateRequestInput } from "@/shared/types/api";

/**
 * User-facing plan hooks — the counterpart to useAdminLicenses. Reads the user's
 * own "Your Plan" payload (quota + tier catalog + pending request + history) and
 * files an upgrade request. Filing a request invalidates the plan so the pending
 * banner appears immediately without a manual refresh.
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

export function useMyPlan() {
  return useQuery({
    queryKey: queryKeys.myPlan,
    queryFn: getMyPlan,
    // The admin may grant while the user is looking — poll so "remaining" and a
    // just-approved tier show up without a reload (matches useLicenseDetail).
    refetchInterval: 30_000,
  });
}

export function useMyRequests() {
  return useQuery({
    queryKey: queryKeys.myRequests,
    queryFn: getMyRequests,
  });
}

export function useCreateUpgradeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRequestInput) => createUpgradeRequest(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.myPlan });
      void qc.invalidateQueries({ queryKey: queryKeys.myRequests });
    },
  });
}
