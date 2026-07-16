import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  disableAdminUser,
  forceLogoutAdminUser,
  getAdminUser,
  getAdminUserAudit,
  listAdminUsers,
  restoreAdminUser,
  type ListUsersQuery,
} from "@/shared/services/api";
import { queryKeys } from "@/shared/lib/queryClient";

/**
 * Admin User Management data hooks (Phase 1). Cursor-based, not page-number
 * based: the page component holds a small stack of visited cursors so
 * "Previous" can pop back to an already-known cursor — the backend has no
 * "give me page N" concept by design (see PgUserStore.list's keyset
 * pagination rationale).
 *
 * See docs/modules/admin/USER_MANAGEMENT.md.
 */

export function useAdminUsersList(query: ListUsersQuery) {
  return useQuery({
    queryKey: queryKeys.adminUsers(query),
    queryFn: () => listAdminUsers(query),
    // Avoids a loading flash when the user changes page/sort/filter — the
    // previous page's rows stay visible (slightly stale) until the new page
    // resolves, instead of flashing a skeleton on every keystroke/click.
    placeholderData: keepPreviousData,
  });
}

export function useAdminUserDetail(googleUserId: string) {
  return useQuery({
    queryKey: queryKeys.adminUser(googleUserId),
    queryFn: () => getAdminUser(googleUserId),
    // The target user's session can be created (or expire) on their own
    // device at any time, with nothing on the admin's end to invalidate this
    // query — refetchOnWindowFocus alone only catches it if the admin leaves
    // and returns to the tab. Poll while this page is open so the Session
    // card and the Force Logout button's enabled state don't go stale for an
    // admin who's just sitting on the page.
    refetchInterval: 15_000,
  });
}

export function useAdminUserAudit(googleUserId: string, cursor: string | undefined) {
  return useQuery({
    queryKey: queryKeys.adminUserAudit(googleUserId, cursor),
    queryFn: () => getAdminUserAudit(googleUserId, cursor),
    placeholderData: keepPreviousData,
  });
}

/** Revoke / Restore / Force Logout — the three account-management actions. */
export function useAdminUserActions(googleUserId: string) {
  const queryClient = useQueryClient();

  // The directory list (any filter/sort/cursor variant), this user's own
  // detail, and their audit history (every action here logs a new entry —
  // admin_user_disabled/_restored, admin_user_sessions_revoked) must all
  // reflect the change immediately, or the admin sees the dialog close with
  // no visible effect anywhere on the page.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.adminUser(googleUserId) });
    void queryClient.invalidateQueries({ queryKey: ["admin-user-audit", googleUserId] });
  };

  const disable = useMutation({
    mutationFn: () => disableAdminUser(googleUserId),
    onSuccess: invalidate,
  });

  const restore = useMutation({
    mutationFn: () => restoreAdminUser(googleUserId),
    onSuccess: invalidate,
  });

  const forceLogout = useMutation({
    mutationFn: () => forceLogoutAdminUser(googleUserId),
    onSuccess: invalidate,
  });

  return { disable, restore, forceLogout };
}
