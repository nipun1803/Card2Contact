import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * The Session Conflict page — shown when the user signs in while already having
 * an Active Session on another device. Continue means Session Replacement (the
 * other device is signed out); Cancel abandons this sign-in.
 */

vi.mock("@/shared/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/services/api")>();
  return {
    ...actual, // keep the real error classes
    continueSession: vi.fn(),
    cancelSession: vi.fn(),
  };
});

const refreshAuth = vi.fn();
vi.mock("@/features/auth/useAuth", () => ({
  useAuthActions: () => ({ refreshAuth, logout: vi.fn() }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

import SessionConflict from "@/routes/SessionConflict";
import { cancelSession, continueSession } from "@/shared/services/api";

const QUERY =
  "?device=iPhone&browser=Safari&lastActive=2026-07-15T11:55:00.000Z";

function renderPage(search = QUERY) {
  return render(
    <MemoryRouter initialEntries={[`/session-conflict${search}`]}>
      <Routes>
        <Route path="/session-conflict" element={<SessionConflict />} />
        <Route path="/dashboard" element={<div>DASHBOARD</div>} />
        <Route path="/login" element={<div>LOGIN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SessionConflict — the other device", () => {
  it("names the other device so the user can recognise it", () => {
    renderPage();
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
    expect(screen.getByText(/last active/i)).toBeInTheDocument();
  });

  it("says plainly that continuing signs the other device out", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: /signed in somewhere else/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out the other device/i })).toBeInTheDocument();
  });

  // The query params are display-only and attacker-influencable in principle;
  // the page must not break on absent or junk values.
  it("degrades to Unknown when the details are missing", () => {
    renderPage("");
    expect(screen.getByText("Unknown browser on Unknown device")).toBeInTheDocument();
    expect(screen.queryByText(/last active/i)).not.toBeInTheDocument();
  });
});

describe("SessionConflict — Continue (Session Replacement)", () => {
  it("activates this session and lands on the dashboard", async () => {
    vi.mocked(continueSession).mockResolvedValue(undefined);
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /sign out the other device/i }));

    await waitFor(() => expect(screen.getByText("DASHBOARD")).toBeInTheDocument());
    expect(continueSession).toHaveBeenCalledTimes(1);
  });

  // Without this the guard would still hold a cached authenticated:false and
  // bounce the user straight back to /login.
  it("refreshes cached auth state before navigating", async () => {
    vi.mocked(continueSession).mockResolvedValue(undefined);
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /sign out the other device/i }));

    await waitFor(() => expect(refreshAuth).toHaveBeenCalled());
  });

  it("disables both actions while in flight", async () => {
    let resolve!: () => void;
    vi.mocked(continueSession).mockReturnValue(new Promise<void>((r) => (resolve = r)));
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /sign out the other device/i }));

    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    resolve();
  });

  /**
   * A Pending Session lives 5 minutes. Leaving the user on a page whose only
   * action no longer works would strand them, so send them back to sign in.
   */
  it("sends the user back to /login when the pending session expired", async () => {
    vi.mocked(continueSession).mockRejectedValue(new Error("expired"));
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /sign out the other device/i }));

    await waitFor(() => expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument());
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/expired/i));
  });
});

describe("SessionConflict — Cancel", () => {
  it("discards the pending sign-in and returns to /login", async () => {
    vi.mocked(cancelSession).mockResolvedValue(undefined);
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument());
    expect(cancelSession).toHaveBeenCalledTimes(1);
  });

  // Cancel is idempotent server-side and the pending session expires anyway, so
  // a failed request changes nothing the user cares about.
  it("still returns to /login if the cancel request fails", async () => {
    vi.mocked(cancelSession).mockRejectedValue(new Error("network"));
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument());
  });

  it("never signs the other device out", async () => {
    vi.mocked(cancelSession).mockResolvedValue(undefined);
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(cancelSession).toHaveBeenCalled());
    expect(continueSession).not.toHaveBeenCalled();
  });
});
