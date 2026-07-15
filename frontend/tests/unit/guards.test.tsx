import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * ProtectedRoute must distinguish three states: loading (splash), auth-fetch
 * error (retryable ErrorState — NOT a silent redirect), and unauthenticated
 * (redirect to /login). We mock useAuth to drive each.
 */
const useAuthMock = vi.fn();
vi.mock("@/features/auth/useAuth", () => ({ useAuth: () => useAuthMock() }));

import { ProtectedRoute } from "@/routes/guards";

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<div>PROTECTED CONTENT</div>} />
        </Route>
        <Route path="/login" element={<div>LOGIN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("ProtectedRoute", () => {
  it("renders the protected content when authenticated", () => {
    useAuthMock.mockReturnValue({ isLoading: false, isError: false, authenticated: true, refetch: vi.fn() });
    renderAt();
    expect(screen.getByText("PROTECTED CONTENT")).toBeInTheDocument();
  });

  it("redirects to /login when unauthenticated", () => {
    useAuthMock.mockReturnValue({ isLoading: false, isError: false, authenticated: false, refetch: vi.fn() });
    renderAt();
    expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument();
    expect(screen.queryByText("PROTECTED CONTENT")).not.toBeInTheDocument();
  });

  it("shows a retryable error (NOT a login redirect) when the auth fetch errors", () => {
    const refetch = vi.fn();
    useAuthMock.mockReturnValue({ isLoading: false, isError: true, authenticated: false, refetch });
    renderAt();

    // The distinguishing behavior: an error surfaces instead of a silent bounce.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/couldn’t verify your session/i)).toBeInTheDocument();
    expect(screen.queryByText("LOGIN PAGE")).not.toBeInTheDocument();
  });

  it("shows a loading splash while auth status resolves", () => {
    useAuthMock.mockReturnValue({ isLoading: true, isError: false, authenticated: false, refetch: vi.fn() });
    renderAt();
    expect(screen.queryByText("PROTECTED CONTENT")).not.toBeInTheDocument();
    expect(screen.queryByText("LOGIN PAGE")).not.toBeInTheDocument();
  });
});
