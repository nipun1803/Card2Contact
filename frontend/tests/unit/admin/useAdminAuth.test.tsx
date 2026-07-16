import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/shared/services/api")>(
    "@/shared/services/api",
  );
  return {
    ...actual, // keep the real error classes — the hook classifies on them
    adminLogin: vi.fn(),
    adminLogout: vi.fn(),
    getAdminMe: vi.fn(),
  };
});

import { useAdminAuth, useAdminAuthActions } from "@/features/admin/useAdminAuth";
import { queryKeys } from "@/shared/lib/queryClient";
import {
  ApiError,
  NetworkError,
  adminLogin,
  adminLogout,
  getAdminMe,
} from "@/shared/services/api";

const mocked = {
  adminLogin: vi.mocked(adminLogin),
  adminLogout: vi.mocked(adminLogout),
  getAdminMe: vi.mocked(getAdminMe),
};

/** A fresh client per test — no retries, so a rejection surfaces immediately. */
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAdminAuth", () => {
  it("reports the signed-in admin", async () => {
    mocked.getAdminMe.mockResolvedValue({ username: "admin" });
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useAdminAuth(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.authenticated).toBe(true);
    expect(result.current.username).toBe("admin");
  });

  /**
   * H3. A 401 is an ANSWER ("not signed in"), not a failure to get one. If this
   * regressed to isError, AdminProtectedRoute would show a retryable "couldn't
   * verify" screen — with a Retry button that can never succeed — to an operator
   * who simply needs to log in.
   */
  it("H3: treats a 401 as signed-out, not an error", async () => {
    mocked.getAdminMe.mockRejectedValue(new ApiError(401, "Admin login required"));
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useAdminAuth(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.authenticated).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it("H4: reports a network failure as a genuine error", async () => {
    // This is what drives the guard's retryable error state (G4).
    mocked.getAdminMe.mockRejectedValue(new NetworkError());
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useAdminAuth(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isError).toBe(true);
    expect(result.current.authenticated).toBe(false);
  });

  it("reports a 503 (admin not configured) as signed-out, not authenticated", async () => {
    mocked.getAdminMe.mockRejectedValue(new ApiError(503, "Admin access is not configured"));
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useAdminAuth(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.authenticated).toBe(false);
  });
});

describe("useAdminAuthActions", () => {
  it("logs in and caches the admin identity", async () => {
    mocked.adminLogin.mockResolvedValue({ username: "admin" });
    const { client, Wrapper } = wrapper();

    const { result } = renderHook(() => useAdminAuthActions(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.login.mutateAsync({ username: "admin", password: "pw" });
    });

    expect(mocked.adminLogin).toHaveBeenCalledWith("admin", "pw");
    // Seeded from the response so the dashboard renders without a second fetch.
    expect(client.getQueryData(queryKeys.adminAuth)).toEqual({ username: "admin" });
  });

  /**
   * H1/H2 — the isolation half of the frontend contract. Admin and Google auth
   * are unrelated identities; sharing a query key (or invalidating the other's)
   * would make an admin login silently refetch the user's session, and vice
   * versa.
   */
  it("H1: login touches the admin query key and NOT the Google auth key", async () => {
    mocked.adminLogin.mockResolvedValue({ username: "admin" });
    const { client, Wrapper } = wrapper();
    // Seed a Google auth entry that must survive untouched.
    client.setQueryData(queryKeys.auth, { authenticated: true, email: "ada@example.com" });

    const { result } = renderHook(() => useAdminAuthActions(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.login.mutateAsync({ username: "admin", password: "pw" });
    });

    expect(client.getQueryData(queryKeys.auth)).toEqual({
      authenticated: true,
      email: "ada@example.com",
    });
  });

  it("H2: logout clears the admin key and leaves the Google auth key alone", async () => {
    mocked.adminLogout.mockResolvedValue(undefined);
    const { client, Wrapper } = wrapper();
    client.setQueryData(queryKeys.auth, { authenticated: true });
    client.setQueryData(queryKeys.adminAuth, { username: "admin" });

    const { result } = renderHook(() => useAdminAuthActions(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.logout.mutateAsync();
    });

    expect(client.getQueryData(queryKeys.adminAuth)).toBeUndefined();
    expect(client.getQueryData(queryKeys.auth)).toEqual({ authenticated: true });
  });

  it("the two query keys are distinct", () => {
    expect(queryKeys.adminAuth).not.toEqual(queryKeys.auth);
  });

  it("surfaces a login failure as the mutation's error", async () => {
    mocked.adminLogin.mockRejectedValue(new ApiError(401, "Invalid credentials"));
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useAdminAuthActions(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.login.mutateAsync({ username: "admin", password: "wrong" }).catch(() => {});
    });

    await waitFor(() => expect(result.current.login.error).toBeInstanceOf(ApiError));
  });
});
