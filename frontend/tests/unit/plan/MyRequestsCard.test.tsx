import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MyRequestsCard } from "@/features/plan/MyRequestsCard";
import * as api from "@/shared/services/api";

/**
 * Profile's read-only history of the user's own upgrade requests
 * (GET /api/me/requests) — the counterpart to PlanCard's single "last decided"
 * summary.
 */

function request(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MyRequestsCard />
    </QueryClientProvider>,
  );
}

describe("MyRequestsCard", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows an empty state when there are no requests", async () => {
    vi.spyOn(api, "getMyRequests").mockResolvedValue({ data: { requests: [] } } as never);
    renderCard();
    await waitFor(() => expect(screen.getByText("No requests yet")).toBeInTheDocument());
  });

  it("lists a request with its ask and status", async () => {
    vi.spyOn(api, "getMyRequests").mockResolvedValue({
      data: { requests: [request()] },
    } as never);
    renderCard();
    await waitFor(() => expect(screen.getByText("Professional")).toBeInTheDocument());
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("shows the decision note for a decided request", async () => {
    vi.spyOn(api, "getMyRequests").mockResolvedValue({
      data: {
        requests: [
          request({ status: "rejected", decisionNote: "Not eligible yet", decidedAt: "2026-07-15T00:00:00.000Z" }),
        ],
      },
    } as never);
    renderCard();
    await waitFor(() => expect(screen.getByText("Rejected")).toBeInTheDocument());
    expect(screen.getByText(/not eligible yet/i)).toBeInTheDocument();
  });
});
