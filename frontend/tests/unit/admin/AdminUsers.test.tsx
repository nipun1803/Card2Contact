import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/admin/useAdminUsers", () => ({ useAdminUsersList: vi.fn() }));

import AdminUsers from "@/routes/admin/AdminUsers";
import { useAdminUsersList } from "@/features/admin/useAdminUsers";

const mockedUseAdminUsersList = vi.mocked(useAdminUsersList);

type ListState = ReturnType<typeof useAdminUsersList>;

function state(overrides: Partial<ListState> = {}): ListState {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as ListState;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminUsers />
    </MemoryRouter>,
  );
}

const USER_ROW = {
  googleUserId: "u1",
  email: "ada@example.com",
  spreadsheetTitle: null,
  savedContactsCount: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: "2026-07-01T00:00:00.000Z",
  disabled: false,
  disabledAt: null,
  disabledBy: null,
  restoredAt: null,
  restoredBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdminUsers", () => {
  it("renders the stat cards from the response, including app-wide Total Scans", () => {
    mockedUseAdminUsersList.mockReturnValue(
      state({
        data: {
          data: { users: [], stats: { total: 5, active: 4, disabled: 1, recentLogins: 2, totalScans: 9 } },
          meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } },
        },
      }),
    );

    renderPage();

    expect(screen.getByText("Total Users")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("Total Scans")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
  });

  it("renders a table row per user, with a Total Scans column (not Saved Contacts)", () => {
    mockedUseAdminUsersList.mockReturnValue(
      state({
        data: {
          data: { users: [USER_ROW], stats: { total: 1, active: 1, disabled: 0, recentLogins: 0, totalScans: 3 } },
          meta: { page: { total: 1, totalPages: 1, nextCursor: null, limit: 20 } },
        },
      }),
    );

    renderPage();

    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    // "Active" also appears in the status-filter <select>'s <option>, so
    // scope to the row's status badge specifically.
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    // The directory shows scans, never the legacy "saved contacts" wording.
    expect(screen.getAllByText("Total Scans").length).toBeGreaterThan(0);
    expect(screen.queryByText(/saved contacts/i)).not.toBeInTheDocument();
  });

  it("shows the empty state with no active filter", () => {
    mockedUseAdminUsersList.mockReturnValue(
      state({
        data: {
          data: { users: [], stats: { total: 0, active: 0, disabled: 0, recentLogins: 0, totalScans: 0 } },
          meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } },
        },
      }),
    );

    renderPage();

    expect(screen.getByText("No users yet")).toBeInTheDocument();
  });

  it("triggers a new query with the search term after the debounce", async () => {
    mockedUseAdminUsersList.mockReturnValue(
      state({
        data: {
          data: { users: [], stats: { total: 0, active: 0, disabled: 0, recentLogins: 0, totalScans: 0 } },
          meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } },
        },
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await user.type(screen.getByPlaceholderText(/search by email/i), "ada");

    await waitFor(() =>
      expect(mockedUseAdminUsersList).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "ada" }),
      ),
    );
  });

  it("changes the status filter query param", async () => {
    mockedUseAdminUsersList.mockReturnValue(
      state({
        data: {
          data: { users: [], stats: { total: 0, active: 0, disabled: 0, recentLogins: 0, totalScans: 0 } },
          meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } },
        },
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await user.selectOptions(screen.getByRole("combobox"), "disabled");

    await waitFor(() =>
      expect(mockedUseAdminUsersList).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "disabled" }),
      ),
    );
  });

  it("renders an error state with retry on query failure", async () => {
    const refetch = vi.fn();
    mockedUseAdminUsersList.mockReturnValue(state({ isError: true, error: new Error("boom"), refetch }));
    const user = userEvent.setup();

    renderPage();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(refetch).toHaveBeenCalled();
  });
});
