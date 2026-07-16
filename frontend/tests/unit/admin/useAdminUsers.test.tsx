import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/shared/services/api")>(
    "@/shared/services/api",
  );
  return {
    ...actual,
    listAdminUsers: vi.fn(),
    getAdminUser: vi.fn(),
    getAdminUserAudit: vi.fn(),
    disableAdminUser: vi.fn(),
    restoreAdminUser: vi.fn(),
    forceLogoutAdminUser: vi.fn(),
  };
});

import {
  useAdminUserActions,
  useAdminUserAudit,
  useAdminUserDetail,
  useAdminUsersList,
} from "@/features/admin/useAdminUsers";
import { queryKeys } from "@/shared/lib/queryClient";
import {
  ApiError,
  disableAdminUser,
  forceLogoutAdminUser,
  getAdminUser,
  getAdminUserAudit,
  listAdminUsers,
  restoreAdminUser,
} from "@/shared/services/api";
import type { AdminUserDetail } from "@/shared/types/api";

const mocked = {
  listAdminUsers: vi.mocked(listAdminUsers),
  getAdminUser: vi.mocked(getAdminUser),
  getAdminUserAudit: vi.mocked(getAdminUserAudit),
  disableAdminUser: vi.mocked(disableAdminUser),
  restoreAdminUser: vi.mocked(restoreAdminUser),
  forceLogoutAdminUser: vi.mocked(forceLogoutAdminUser),
};

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

const USER: AdminUserDetail = {
  googleUserId: "u1",
  email: "ada@example.com",
  spreadsheetTitle: null,
  savedContactsCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  disabled: false,
  disabledAt: null,
  disabledBy: null,
  restoredAt: null,
  restoredBy: null,
  activeSession: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAdminUsersList", () => {
  it("composes the query key from the query params", async () => {
    mocked.listAdminUsers.mockResolvedValue({
      data: { users: [], stats: { total: 0, active: 0, disabled: 0, recentLogins: 0, totalScans: 0 } },
      meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } },
    });
    const { client, Wrapper } = wrapper();

    renderHook(() => useAdminUsersList({ search: "ada" }), { wrapper: Wrapper });

    await waitFor(() =>
      expect(client.getQueryState(queryKeys.adminUsers({ search: "ada" }))?.status).toBe("success"),
    );
    expect(mocked.listAdminUsers).toHaveBeenCalledWith({ search: "ada" });
  });
});

describe("useAdminUserDetail", () => {
  it("surfaces a 404 as the query's error", async () => {
    mocked.getAdminUser.mockRejectedValue(new ApiError(404, "User not found"));
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useAdminUserDetail("ghost"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
  });
});

describe("useAdminUserActions", () => {
  it("disable() invalidates the users list, this user's detail, AND their audit history", async () => {
    mocked.disableAdminUser.mockResolvedValue({
      data: { ...USER, disabled: true, disabledAt: "2026-07-16T00:00:00.000Z", disabledBy: "admin" },
    });
    const { client, Wrapper } = wrapper();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useAdminUserActions("u1"), { wrapper: Wrapper });
    await act(async () => {
      await result.current.disable.mutateAsync();
    });

    expect(mocked.disableAdminUser).toHaveBeenCalledWith("u1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["admin-users"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.adminUser("u1") });
    // Every action here (disable/restore/force-logout) logs a new audit
    // entry — without this invalidation the Audit History panel keeps
    // showing stale data after a successful action, which is exactly what
    // reads to an admin as "the button did nothing."
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["admin-user-audit", "u1"] });
  });

  it("restore() also invalidates this user's audit history", async () => {
    mocked.restoreAdminUser.mockResolvedValue({ data: USER });
    const { client, Wrapper } = wrapper();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useAdminUserActions("u1"), { wrapper: Wrapper });
    await act(async () => {
      await result.current.restore.mutateAsync();
    });

    expect(mocked.restoreAdminUser).toHaveBeenCalledWith("u1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["admin-user-audit", "u1"] });
  });

  it("forceLogout() calls the force-logout endpoint and invalidates this user's audit history", async () => {
    mocked.forceLogoutAdminUser.mockResolvedValue({ data: { revokedCount: 1 } });
    const { client, Wrapper } = wrapper();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useAdminUserActions("u1"), { wrapper: Wrapper });
    await act(async () => {
      await result.current.forceLogout.mutateAsync();
    });

    expect(mocked.forceLogoutAdminUser).toHaveBeenCalledWith("u1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["admin-user-audit", "u1"] });
  });

  // The end-to-end regression: not just "was invalidateQueries called with
  // the right key" but "does a live useAdminUserAudit consumer actually
  // refetch and see the new entry" — on a real QueryClient, no mocked
  // invalidation spy. This is the exact user-visible symptom the missing
  // invalidation caused: Force Logout appeared to do nothing because Audit
  // History kept showing the pre-action snapshot.
  it("forceLogout() causes a mounted useAdminUserAudit to refetch with the new entry", async () => {
    mocked.getAdminUserAudit
      .mockResolvedValueOnce({
        data: { entries: [] },
        meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } },
      })
      .mockResolvedValueOnce({
        data: {
          entries: [
            {
              id: 1,
              ts: "2026-07-16T00:00:00.000Z",
              event: "admin_user_sessions_revoked",
              googleUserId: "u1",
              adminUsername: "admin",
              sessionId: null,
              device: null,
              browser: null,
              ip: null,
              outcome: "success",
              reason: "user_revoked",
              cardId: null,
              revokedCount: 1,
            },
          ],
        },
        meta: { page: { total: 1, totalPages: 1, nextCursor: null, limit: 20 } },
      });
    mocked.forceLogoutAdminUser.mockResolvedValue({ data: { revokedCount: 1 } });
    const { Wrapper } = wrapper();

    const { result } = renderHook(
      () => ({
        audit: useAdminUserAudit("u1", undefined),
        actions: useAdminUserActions("u1"),
      }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.audit.data?.data.entries).toHaveLength(0));

    await act(async () => {
      await result.current.actions.forceLogout.mutateAsync();
    });

    await waitFor(() => expect(result.current.audit.data?.data.entries).toHaveLength(1));
    expect(result.current.audit.data?.data.entries[0].event).toBe("admin_user_sessions_revoked");
  });
});
