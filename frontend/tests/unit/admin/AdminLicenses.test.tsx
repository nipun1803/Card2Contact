import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/admin/useAdminLicenses", () => ({ useLicensesList: vi.fn() }));

import AdminLicenses from "@/routes/admin/AdminLicenses";
import { useLicensesList } from "@/features/admin/useAdminLicenses";
import type { EffectiveQuota } from "@/shared/types/api";

const mocked = vi.mocked(useLicensesList);
type ListState = ReturnType<typeof useLicensesList>;

function state(over: Partial<ListState> = {}): ListState {
  return { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(), ...over } as ListState;
}

function quota(over: Partial<EffectiveQuota> = {}): EffectiveQuota {
  return {
    googleUserId: "u1",
    email: "ada@example.com",
    freeLimit: 30,
    freeUsed: 5,
    freeRemaining: 25,
    hasFreeOverride: false,
    paidRemaining: 0,
    totalRemaining: 25,
    scanBlocked: false,
    scanBlockedAt: null,
    scanBlockedBy: null,
    unlimited: false,
    activeTier: null,
    paidGrants: [],
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminLicenses />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("AdminLicenses", () => {
  it("renders the stat cards from the response", () => {
    mocked.mockReturnValue(
      state({
        data: {
          data: {
            quotas: [],
            stats: { usersWithQuota: 7, scanBlocked: 1, totalFreeUsed: 42, totalPaidUsed: 3, lowRemaining: 2 },
          },
          meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } },
        },
      }),
    );
    renderPage();
    expect(screen.getByText("42")).toBeInTheDocument(); // totalFreeUsed
    expect(screen.getByText("7")).toBeInTheDocument(); // usersWithQuota
  });

  it("shows an Unlimited badge for an unlimited-tier user", () => {
    mocked.mockReturnValue(
      state({
        data: {
          data: {
            quotas: [
              quota({
                unlimited: true,
                activeTier: { tierId: 3, name: "Enterprise", unlimited: true, unlimitedUntil: null, expiresAt: null },
              }),
            ],
            stats: { usersWithQuota: 1, scanBlocked: 0, totalFreeUsed: 0, totalPaidUsed: 0, lowRemaining: 0 },
          },
          meta: { page: { total: 1, totalPages: 1, nextCursor: null, limit: 20 } },
        },
      }),
    );
    renderPage();
    expect(screen.getByText("Unlimited")).toBeInTheDocument();
  });

  it("renders an error state and offers retry", () => {
    mocked.mockReturnValue(state({ isError: true, error: new Error("boom") }));
    renderPage();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows the user's email as the User column, not the Google id", () => {
    mocked.mockReturnValue(
      state({
        data: {
          data: {
            quotas: [quota({ googleUserId: "u-123", email: "ada@example.com" })],
            stats: { usersWithQuota: 1, scanBlocked: 0, totalFreeUsed: 0, totalPaidUsed: 0, lowRemaining: 0 },
          },
          meta: { page: { total: 1, totalPages: 1, nextCursor: null, limit: 20 } },
        },
      }),
    );
    renderPage();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.queryByText("u-123")).not.toBeInTheDocument();
  });

  it("clicking the Scan-Blocked stat card sets the status filter to scan_blocked", async () => {
    mocked.mockReturnValue(
      state({
        data: {
          data: {
            quotas: [],
            stats: { usersWithQuota: 7, scanBlocked: 1, totalFreeUsed: 42, totalPaidUsed: 3, lowRemaining: 2 },
          },
          meta: { page: { total: 0, totalPages: 0, nextCursor: null, limit: 20 } },
        },
      }),
    );
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /scan-blocked/i }));

    const statusSelect = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(statusSelect.value).toBe("scan_blocked");

    // Clicking the same card again clears the filter back to "all".
    await user.click(screen.getByRole("button", { name: /scan-blocked/i }));
    expect(statusSelect.value).toBe("all");
  });

  it("falls back to the Google id when email is missing", () => {
    mocked.mockReturnValue(
      state({
        data: {
          data: {
            quotas: [quota({ googleUserId: "u-123", email: null })],
            stats: { usersWithQuota: 1, scanBlocked: 0, totalFreeUsed: 0, totalPaidUsed: 0, lowRemaining: 0 },
          },
          meta: { page: { total: 1, totalPages: 1, nextCursor: null, limit: 20 } },
        },
      }),
    );
    renderPage();
    expect(screen.getByText("u-123")).toBeInTheDocument();
  });
});
