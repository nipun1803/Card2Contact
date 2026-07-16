import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/admin/useAdminLicenses", () => ({
  useTiers: vi.fn(),
  useTierActions: vi.fn(),
}));

import AdminTiers from "@/routes/admin/AdminTiers";
import { useTiers, useTierActions } from "@/features/admin/useAdminLicenses";
import type { Tier } from "@/shared/types/api";

const mockedTiers = vi.mocked(useTiers);
const mockedActions = vi.mocked(useTierActions);

function tier(over: Partial<Tier> = {}): Tier {
  return {
    id: 1,
    name: "Professional",
    isUnlimited: false,
    scanLimit: 1000,
    validityDays: 365,
    isDefault: false,
    sortOrder: 1,
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: null,
    assignedCount: 128,
    ...over,
  };
}

function mutation() {
  return { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false, error: null } as unknown as ReturnType<
    typeof useTierActions
  >["create"];
}

function setup(tiers: Tier[]) {
  mockedTiers.mockReturnValue({
    data: { data: { tiers } },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useTiers>);
  mockedActions.mockReturnValue({
    create: mutation(),
    update: mutation(),
    archive: mutation(),
    clone: mutation(),
    bulkAssign: mutation(),
  } as unknown as ReturnType<typeof useTierActions>);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminTiers />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("AdminTiers", () => {
  it("lists tiers with their type and assigned count", () => {
    setup([tier(), tier({ id: 3, name: "Enterprise", isUnlimited: true, scanLimit: null, assignedCount: 4 })]);
    renderPage();
    expect(screen.getByText("Professional")).toBeInTheDocument();
    expect(screen.getByText("Enterprise")).toBeInTheDocument();
    expect(screen.getByText("Unlimited")).toBeInTheDocument(); // the unlimited tier's type badge
    expect(screen.getByText(/128 users/)).toBeInTheDocument();
  });

  it("editing a tier shows the impact note referencing the assigned count", async () => {
    setup([tier({ assignedCount: 128 })]);
    renderPage();
    await userEvent.click(screen.getAllByRole("button", { name: /edit/i })[0]);
    // The impact note must say changes affect future assignments only, and
    // reference the count of currently-assigned users. The count is interpolated
    // into the sentence, so match on the paragraph's full text content.
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" &&
          (el.textContent ?? "").includes("128 users currently hold this tier") &&
          (el.textContent ?? "").includes("future assignments only"),
      ),
    ).toBeInTheDocument();
  });

  it("the editor hides the scan-limit input when Unlimited is chosen", async () => {
    setup([tier()]);
    renderPage();
    await userEvent.click(screen.getAllByRole("button", { name: /edit/i })[0]);
    // Limited by default → scan limit input visible.
    expect(screen.getByLabelText(/scan limit/i)).toBeInTheDocument();
    // Switch to Unlimited → the scan limit input disappears.
    await userEvent.selectOptions(screen.getByLabelText(/type/i), "unlimited");
    expect(screen.queryByLabelText(/scan limit/i)).not.toBeInTheDocument();
  });
});
