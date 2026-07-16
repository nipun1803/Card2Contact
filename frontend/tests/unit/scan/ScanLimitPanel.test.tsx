import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScanLimitPanel } from "@/features/scan/ScanLimitPanel";
import * as api from "@/shared/services/api";

/**
 * The two scan-gating panels must carry DISTINCT copy — a quota-exhausted user
 * (402) and a Scan-Blocked user (403) are different states the backend reports
 * with different codes, and the UI must not conflate them. The quota panel also
 * surfaces the user's plan and a request-upgrade action (fed by GET /me/plan).
 */

function renderPanel(kind: "quota" | "blocked", onBack = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ScanLimitPanel kind={kind} onBack={onBack} />
    </QueryClientProvider>,
  );
  return { onBack };
}

const PLAN = {
  data: {
    quota: {
      freeLimit: 10,
      freeUsed: 10,
      freeRemaining: 0,
      paidRemaining: 0,
      totalRemaining: 0,
      unlimited: false,
      scanBlocked: false,
      activeTier: null,
      paidGrants: [],
    },
    availableTiers: [
      { id: 2, name: "Professional", isUnlimited: false, scanLimit: 1000, validityDays: 365, isDefault: false },
    ],
    pendingRequest: null,
    recentRequests: [],
  },
};

describe("ScanLimitPanel", () => {
  beforeEach(() => {
    vi.spyOn(api, "getMyPlan").mockResolvedValue(PLAN as never);
  });

  it("shows 'out of scans' copy and the current plan for the quota kind", async () => {
    renderPanel("quota");
    expect(screen.getByText(/out of scans/i)).toBeInTheDocument();
    // The enriched panel shows the plan badge (Free) and a request action.
    await waitFor(() => expect(screen.getByText(/current plan/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /request upgrade/i })).toBeInTheDocument();
  });

  it("shows 'scanning is blocked' copy for the blocked kind", () => {
    renderPanel("blocked");
    expect(screen.getByText(/scanning is blocked/i)).toBeInTheDocument();
    // The blocked panel is admin-resolvable only — no request action.
    expect(screen.queryByRole("button", { name: /request upgrade/i })).not.toBeInTheDocument();
  });

  it("calls onBack when the Back button is clicked", async () => {
    const { onBack } = renderPanel("quota");
    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
