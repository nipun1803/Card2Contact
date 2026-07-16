import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/admin/useAdminAuth", () => ({ useAdminAuth: vi.fn() }));

/**
 * G5's mechanism: if AdminProtectedRoute ever reaches for the GOOGLE session
 * hook, this throws and the test fails loudly. The two identities are unrelated
 * and the admin guard must never consult useAuth.
 */
vi.mock("@/features/auth/useAuth", () => ({
  useAuth: () => {
    throw new Error("AdminProtectedRoute must not depend on the Google session (useAuth)");
  },
  useAuthActions: () => {
    throw new Error("AdminProtectedRoute must not depend on the Google session (useAuthActions)");
  },
}));

import { AdminProtectedRoute } from "@/routes/admin/guards";
import { useAdminAuth } from "@/features/admin/useAdminAuth";

const mockedUseAdminAuth = vi.mocked(useAdminAuth);

type AdminAuthState = ReturnType<typeof useAdminAuth>;

function state(overrides: Partial<AdminAuthState> = {}): AdminAuthState {
  return {
    isLoading: false,
    isError: false,
    authenticated: false,
    username: undefined,
    refetch: vi.fn(),
    ...overrides,
  } as AdminAuthState;
}

/** Renders the guard around a probe, with a stand-in login page to detect bounces. */
function renderGuard() {
  return render(
    <MemoryRouter initialEntries={["/admin/dashboard"]}>
      <Routes>
        <Route element={<AdminProtectedRoute />}>
          <Route path="/admin/dashboard" element={<div>ADMIN CONTENT</div>} />
        </Route>
        <Route path="/admin/login" element={<div>ADMIN LOGIN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdminProtectedRoute", () => {
  it("G1: renders the admin area for an authenticated admin", () => {
    mockedUseAdminAuth.mockReturnValue(state({ authenticated: true, username: "admin" }));

    renderGuard();

    expect(screen.getByText("ADMIN CONTENT")).toBeInTheDocument();
  });

  it("G2: redirects an unauthenticated visitor to /admin/login", () => {
    mockedUseAdminAuth.mockReturnValue(state({ authenticated: false }));

    renderGuard();

    expect(screen.getByText("ADMIN LOGIN PAGE")).toBeInTheDocument();
    expect(screen.queryByText("ADMIN CONTENT")).not.toBeInTheDocument();
  });

  it("G3: shows the splash while the check is in flight, never a flash of either page", () => {
    mockedUseAdminAuth.mockReturnValue(state({ isLoading: true }));

    renderGuard();

    expect(screen.queryByText("ADMIN CONTENT")).not.toBeInTheDocument();
    expect(screen.queryByText("ADMIN LOGIN PAGE")).not.toBeInTheDocument();
    // AppSplash renders the message twice (the Spinner's label + a span).
    expect(screen.getAllByText(/checking admin access/i).length).toBeGreaterThan(0);
  });

  /**
   * G4. A failed fetch is not a signed-out admin. Bouncing here would tell an
   * operator their session ended when the server is merely unreachable — and
   * they would log in again, pointlessly, against a server that cannot answer.
   */
  it("G4: shows a retryable error on a fetch failure instead of redirecting", () => {
    const refetch = vi.fn();
    mockedUseAdminAuth.mockReturnValue(state({ isError: true, refetch }));

    renderGuard();

    expect(screen.getByText(/couldn’t verify admin access/i)).toBeInTheDocument();
    expect(screen.queryByText("ADMIN LOGIN PAGE")).not.toBeInTheDocument();
  });

  /**
   * G5. The mocked useAuth above throws if touched, so simply rendering the
   * guard in every state proves it never consults the Google session.
   */
  it("G5: never calls useAuth in any state", () => {
    for (const s of [
      state({ authenticated: true }),
      state({ authenticated: false }),
      state({ isLoading: true }),
      state({ isError: true }),
    ]) {
      mockedUseAdminAuth.mockReturnValue(s);
      expect(() => renderGuard()).not.toThrow();
    }
  });
});
