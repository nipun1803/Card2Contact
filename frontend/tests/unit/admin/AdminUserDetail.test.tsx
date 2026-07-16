import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/admin/useAdminUsers", () => ({
  useAdminUserDetail: vi.fn(),
  useAdminUserAudit: vi.fn(),
  useAdminUserActions: vi.fn(),
}));

import AdminUserDetail from "@/routes/admin/AdminUserDetail";
import {
  useAdminUserActions,
  useAdminUserAudit,
  useAdminUserDetail,
} from "@/features/admin/useAdminUsers";
import type { AdminUserDetail as AdminUserDetailType } from "@/shared/types/api";

const mockedDetail = vi.mocked(useAdminUserDetail);
const mockedAudit = vi.mocked(useAdminUserAudit);
const mockedActions = vi.mocked(useAdminUserActions);

const USER: AdminUserDetailType = {
  googleUserId: "u1",
  email: "ada@example.com",
  spreadsheetTitle: "Card2Contact Contacts",
  savedContactsCount: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: "2026-07-01T00:00:00.000Z",
  disabled: false,
  disabledAt: null,
  disabledBy: null,
  restoredAt: null,
  restoredBy: null,
  activeSession: { device: "macOS", browser: "Chrome", ip: "203.0.113.1", lastActivityAt: "2026-07-16T00:00:00.000Z" },
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/users/u1"]}>
      <Routes>
        <Route path="/admin/users/:googleUserId" element={<AdminUserDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mutationState(overrides: Record<string, unknown> = {}) {
  return { mutateAsync: vi.fn(), isPending: false, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedDetail.mockReturnValue({
    data: { data: USER },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useAdminUserDetail>);
  mockedAudit.mockReturnValue({
    data: { data: { entries: [] }, meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } } },
    isLoading: false,
  } as unknown as ReturnType<typeof useAdminUserAudit>);
  mockedActions.mockReturnValue({
    disable: mutationState(),
    restore: mutationState(),
    forceLogout: mutationState(),
  } as unknown as ReturnType<typeof useAdminUserActions>);
});

describe("AdminUserDetail", () => {
  it("renders profile, session, and spreadsheet sections", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "ada@example.com" })).toBeInTheDocument();
    expect(screen.getByText("macOS")).toBeInTheDocument();
    expect(screen.getByText("Card2Contact Contacts")).toBeInTheDocument();
  });

  it("shows the empty state when there is no audit history", () => {
    renderPage();
    expect(screen.getByText("No audit history")).toBeInTheDocument();
  });

  it("does not render a link to the user's spreadsheet", () => {
    renderPage();
    expect(screen.queryByRole("link", { name: /open in google sheets/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/docs\.google\.com/i)).not.toBeInTheDocument();
  });

  it("shows the mutation error and keeps the dialog open when Force Logout fails", async () => {
    const forceLogout = mutationState({
      mutateAsync: vi.fn().mockRejectedValue(new Error("Network request failed")),
      error: new Error("Network request failed"),
    });
    mockedActions.mockReturnValue({
      disable: mutationState(),
      restore: mutationState(),
      forceLogout,
    } as unknown as ReturnType<typeof useAdminUserActions>);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /force logout/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /force logout/i }));

    await waitFor(() => expect(forceLogout.mutateAsync).toHaveBeenCalled());
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Network request failed");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("clicking Revoke Access opens a confirm dialog with no reason/note input", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /revoke access/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("confirming Revoke Access calls disable()", async () => {
    const disable = mutationState();
    mockedActions.mockReturnValue({
      disable,
      restore: mutationState(),
      forceLogout: mutationState(),
    } as unknown as ReturnType<typeof useAdminUserActions>);
    const user = userEvent.setup();
    renderPage();

    // Opens the dialog, which renders a second "Revoke Access" button (the
    // confirm action) — target it within the dialog to disambiguate.
    await user.click(screen.getByRole("button", { name: /revoke access/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /revoke access/i }));

    await waitFor(() => expect(disable.mutateAsync).toHaveBeenCalled());
  });

  it("Force Logout is disabled when there is no active session", () => {
    mockedDetail.mockReturnValue({
      data: { data: { ...USER, activeSession: null } },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAdminUserDetail>);

    renderPage();

    expect(screen.getByRole("button", { name: /force logout/i })).toBeDisabled();
  });

  it("shows Restore Access instead of Revoke when the user is disabled", () => {
    mockedDetail.mockReturnValue({
      data: { data: { ...USER, disabled: true, disabledAt: "2026-07-16T00:00:00.000Z", disabledBy: "admin" } },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAdminUserDetail>);

    renderPage();

    expect(screen.getByRole("button", { name: /restore access/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke access/i })).not.toBeInTheDocument();
  });
});
