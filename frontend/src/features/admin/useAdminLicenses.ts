import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveTier,
  assignTier,
  bulkAssignTier,
  cloneTier,
  createTier,
  getLicense,
  getLicenseHistory,
  getLicenseSettings,
  getTierHistory,
  grantPaid,
  listLicenses,
  listTiers,
  recalculateQuota,
  removeFreeOverride,
  removeTier,
  resetUsed,
  revokeGrant,
  scanBlockUser,
  scanUnblockUser,
  setFreeLimit,
  updateLicenseSettings,
  updateTier,
  listUpgradeRequests,
  getUpgradeRequestCount,
  getUserUpgradeRequests,
  approveUpgradeRequest,
  rejectUpgradeRequest,
  type ListLicensesQuery,
} from "@/shared/services/api";
import { queryKeys } from "@/shared/lib/queryClient";
import type {
  LicenseSettingsPatch,
  TierInput,
  TierRequestStatus,
  ApproveOverrideInput,
} from "@/shared/types/api";

/**
 * License Management data hooks (Phase 4/5). Same cursor-based, keepPreviousData
 * conventions as useAdminUsers. Mutations invalidate by prefix so every cached
 * filter/cursor variant refreshes, plus the specific per-user detail/history.
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

export function useLicensesList(query: ListLicensesQuery) {
  return useQuery({
    queryKey: queryKeys.adminLicenses(query),
    queryFn: () => listLicenses(query),
    placeholderData: keepPreviousData,
  });
}

export function useLicenseDetail(googleUserId: string) {
  return useQuery({
    queryKey: queryKeys.adminLicense(googleUserId),
    queryFn: () => getLicense(googleUserId),
    refetchInterval: 15_000,
  });
}

export function useLicenseHistory(googleUserId: string, cursor: string | undefined) {
  return useQuery({
    queryKey: queryKeys.adminLicenseHistory(googleUserId, cursor),
    queryFn: () => getLicenseHistory(googleUserId, cursor),
    placeholderData: keepPreviousData,
  });
}

export function useTierHistory(googleUserId: string, cursor: string | undefined) {
  return useQuery({
    queryKey: queryKeys.adminTierHistory(googleUserId, cursor),
    queryFn: () => getTierHistory(googleUserId, cursor),
    placeholderData: keepPreviousData,
  });
}

export function useLicenseSettings() {
  return useQuery({
    queryKey: queryKeys.licenseSettings,
    queryFn: getLicenseSettings,
  });
}

export function useUpdateLicenseSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: LicenseSettingsPatch) => updateLicenseSettings(patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.licenseSettings }),
  });
}

/** Every per-user quota/tier action for one user, each invalidating the shared cache. */
export function useLicenseActions(googleUserId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin-licenses"] });
    void qc.invalidateQueries({ queryKey: queryKeys.adminLicense(googleUserId) });
    void qc.invalidateQueries({ queryKey: ["admin-license-history", googleUserId] });
    void qc.invalidateQueries({ queryKey: ["admin-tier-history", googleUserId] });
    void qc.invalidateQueries({ queryKey: ["admin-tiers"] }); // assigned counts change
  };
  return {
    setFreeLimit: useMutation({
      mutationFn: (limit: number) => setFreeLimit(googleUserId, limit),
      onSuccess: invalidate,
    }),
    removeFreeOverride: useMutation({
      mutationFn: () => removeFreeOverride(googleUserId),
      onSuccess: invalidate,
    }),
    grantPaid: useMutation({
      mutationFn: (v: { amount: number; expiresAt: string | null; reason?: string }) =>
        grantPaid(googleUserId, v.amount, v.expiresAt, v.reason),
      onSuccess: invalidate,
    }),
    revokeGrant: useMutation({
      mutationFn: (grantId: number) => revokeGrant(googleUserId, grantId),
      onSuccess: invalidate,
    }),
    resetUsed: useMutation({
      mutationFn: (pool: "free" | "paid" | "both") => resetUsed(googleUserId, pool),
      onSuccess: invalidate,
    }),
    recalculate: useMutation({
      mutationFn: () => recalculateQuota(googleUserId),
      onSuccess: invalidate,
    }),
    scanBlock: useMutation({ mutationFn: () => scanBlockUser(googleUserId), onSuccess: invalidate }),
    scanUnblock: useMutation({
      mutationFn: () => scanUnblockUser(googleUserId),
      onSuccess: invalidate,
    }),
    assignTier: useMutation({
      mutationFn: (tierId: number) => assignTier(googleUserId, tierId),
      onSuccess: invalidate,
    }),
    removeTier: useMutation({ mutationFn: () => removeTier(googleUserId), onSuccess: invalidate }),
  };
}

/* ---- Tier catalog -------------------------------------------------------- */

export function useTiers(search: string | undefined) {
  return useQuery({
    queryKey: queryKeys.adminTiers(search),
    queryFn: () => listTiers(search),
    placeholderData: keepPreviousData,
  });
}

export function useTierActions() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin-tiers"] });
    void qc.invalidateQueries({ queryKey: ["admin-licenses"] });
  };
  return {
    create: useMutation({ mutationFn: (input: TierInput) => createTier(input), onSuccess: invalidate }),
    update: useMutation({
      mutationFn: (v: { id: number; patch: Partial<TierInput> }) => updateTier(v.id, v.patch),
      onSuccess: invalidate,
    }),
    archive: useMutation({ mutationFn: (id: number) => archiveTier(id), onSuccess: invalidate }),
    clone: useMutation({
      mutationFn: (v: { id: number; name: string }) => cloneTier(v.id, v.name),
      onSuccess: invalidate,
    }),
    bulkAssign: useMutation({
      mutationFn: (v: { tierId: number; googleUserIds: string[] }) =>
        bulkAssignTier(v.tierId, v.googleUserIds),
      onSuccess: invalidate,
    }),
  };
}

/* ---- Tier Upgrade Requests (admin queue) --------------------------------- */

export function useUpgradeRequests(status: TierRequestStatus | undefined) {
  return useQuery({
    queryKey: queryKeys.adminRequests(status),
    queryFn: () => listUpgradeRequests({ status }),
    placeholderData: keepPreviousData,
    // The queue is a live inbox — pending items arrive while the admin watches.
    refetchInterval: 20_000,
  });
}

/** The pending-count badge for the admin nav. */
export function useUpgradeRequestCount() {
  return useQuery({
    queryKey: queryKeys.adminRequestCount,
    queryFn: getUpgradeRequestCount,
    refetchInterval: 30_000,
  });
}

/** A single user's requests (inline on the License Detail page). */
export function useUserUpgradeRequests(googleUserId: string) {
  return useQuery({
    queryKey: queryKeys.adminUserRequests(googleUserId),
    queryFn: () => getUserUpgradeRequests(googleUserId),
  });
}

export function useRequestActions() {
  const qc = useQueryClient();
  const invalidate = () => {
    // A decision changes the queue, the badge, every per-user request list, and —
    // because approve grants — the quota directory/detail and tier counts.
    void qc.invalidateQueries({ queryKey: ["admin-requests"] });
    void qc.invalidateQueries({ queryKey: queryKeys.adminRequestCount });
    void qc.invalidateQueries({ queryKey: ["admin-user-requests"] });
    void qc.invalidateQueries({ queryKey: ["admin-licenses"] });
    void qc.invalidateQueries({ queryKey: ["admin-license"] });
    void qc.invalidateQueries({ queryKey: ["admin-tiers"] });
  };
  return {
    approve: useMutation({
      mutationFn: (v: { id: number; override?: ApproveOverrideInput }) =>
        approveUpgradeRequest(v.id, v.override),
      onSuccess: invalidate,
    }),
    reject: useMutation({
      mutationFn: (v: { id: number; note?: string }) => rejectUpgradeRequest(v.id, v.note),
      onSuccess: invalidate,
    }),
  };
}
