import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanCard } from "@/features/plan/PlanCard";
import * as api from "@/shared/services/api";

/**
 * The Profile "Your Plan" card — the user's primary self-service surface. It
 * must show the active tier + remaining scans, gate the upgrade action behind
 * "no pending request", and surface a pending request when one exists.
 */

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      quota: {
        freeLimit: 30,
        freeUsed: 5,
        freeRemaining: 25,
        paidRemaining: 0,
        totalRemaining: 25,
        unlimited: false,
        scanBlocked: false,
        activeTier: null,
        paidGrants: [],
      },
      availableTiers: [
        { id: 2, name: "Professional", isUnlimited: false, scanLimit: 1000, validityDays: 365, isDefault: false },
        { id: 1, name: "Free", isUnlimited: false, scanLimit: 30, validityDays: null, isDefault: true },
      ],
      pendingRequest: null,
      recentRequests: [],
      ...overrides,
    },
  };
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlanCard />
    </QueryClientProvider>,
  );
}

describe("PlanCard", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows the tier and remaining scans", async () => {
    vi.spyOn(api, "getMyPlan").mockResolvedValue(makePlan() as never);
    renderCard();
    await waitFor(() => expect(screen.getByText(/scans remaining/i)).toBeInTheDocument());
    expect(screen.getByText("25")).toBeInTheDocument();
    // Falls back to the Free label when no active tier.
    expect(screen.getAllByText(/free/i).length).toBeGreaterThan(0);
  });

  it("shows a pending banner (and hides the request button) when a request is open", async () => {
    vi.spyOn(api, "getMyPlan").mockResolvedValue(
      makePlan({
        pendingRequest: {
          id: 1,
          kind: "tier",
          requestedTierId: 2,
          requestedTierName: "Professional",
          requestedAmount: null,
          requestedDays: null,
          userNote: null,
          currentTierName: "Free",
          status: "pending",
          decidedAt: null,
          decisionNote: null,
          grantedTierId: null,
          grantedAmount: null,
          grantedDays: null,
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      }) as never,
    );
    renderCard();
    await waitFor(() => expect(screen.getByText(/request pending/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /request an upgrade/i })).not.toBeInTheDocument();
  });

  it("opens the upgrade dialog and files a tier request", async () => {
    vi.spyOn(api, "getMyPlan").mockResolvedValue(makePlan() as never);
    const create = vi
      .spyOn(api, "createUpgradeRequest")
      .mockResolvedValue({ data: {} } as never);
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /request an upgrade/i }));
    // Dialog open — the plan <select> is unique to it. Pick Professional + submit.
    await userEvent.selectOptions(await screen.findByLabelText(/^plan$/i), "2");
    await userEvent.click(screen.getByRole("button", { name: /submit request/i }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: "tier", tierId: 2 })),
    );
  });
});
