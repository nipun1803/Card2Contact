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

const toastInfo = vi.fn();
vi.mock("sonner", () => ({ toast: { info: (...args: unknown[]) => toastInfo(...args) } }));

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

/**
 * Session Revocation — the user signed in on another device (single active
 * session). It is a definitive ANSWER from the server, not a failure to get
 * one, so it must not be confused with the retryable "couldn't verify" state.
 */
describe("ProtectedRoute — a revoked session", () => {
  function revoked(message = "You were signed out because you signed in on another device") {
    return {
      isLoading: false,
      // useAuth suppresses isError for a revoked session precisely so the guard
      // can tell these apart; mirror that contract here.
      isError: false,
      sessionRevoked: true,
      sessionRevokedMessage: message,
      authenticated: false,
      refetch: vi.fn(),
    };
  }

  it("redirects to /login", () => {
    useAuthMock.mockReturnValue(revoked());
    renderAt();
    expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument();
    expect(screen.queryByText("PROTECTED CONTENT")).not.toBeInTheDocument();
  });

  // The whole reason SESSION_REVOKED exists as a distinct code: without the
  // toast the user is thrown back to /login with no idea why.
  it("explains why, with the server's message", () => {
    useAuthMock.mockReturnValue(revoked("You were signed out because you signed in on another device"));
    renderAt();
    expect(toastInfo).toHaveBeenCalledWith(
      "You were signed out because you signed in on another device",
    );
  });

  it("falls back to a default message when the server sends none", () => {
    useAuthMock.mockReturnValue({ ...revoked(), sessionRevokedMessage: undefined });
    renderAt();
    expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/another device/i));
  });

  it("announces once, not on every re-render", () => {
    useAuthMock.mockReturnValue(revoked());
    const { rerender } = renderAt();
    rerender(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<div>PROTECTED CONTENT</div>} />
          </Route>
          <Route path="/login" element={<div>LOGIN PAGE</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  // A Retry button here would offer an action that can never succeed.
  it("never shows the retryable error state", () => {
    useAuthMock.mockReturnValue({ ...revoked(), isError: true });
    renderAt();
    expect(screen.queryByText(/couldn’t verify your session/i)).not.toBeInTheDocument();
    expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument();
  });
});
