import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminRequests from "@/routes/admin/AdminRequests";
import * as api from "@/shared/services/api";

/**
 * The admin upgrade-request queue. Pending requests are actionable (approve /
 * reject); approval flows through the standard grant path server-side, so the UI
 * just expresses the decision and confirms the mutation is called.
 */

const PENDING = {
  data: {
    requests: [
      {
        id: 7,
        googleUserId: "u1",
        kind: "tier",
        requestedTierId: 2,
        requestedTierName: "Professional",
        requestedAmount: null,
        requestedDays: null,
        userNote: "Big event next week",
        currentTierName: "Free",
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        grantedTierId: null,
        grantedAmount: null,
        grantedDays: null,
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    ],
    pendingCount: 1,
  },
  meta: { page: { total: 1, nextCursor: null, limit: 20 } },
};

function renderQueue() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminRequests />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AdminRequests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "listUpgradeRequests").mockResolvedValue(PENDING as never);
  });

  it("lists a pending request with its type, ask, and reason", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByText("Professional")).toBeInTheDocument());
    expect(screen.getByText(/big event next week/i)).toBeInTheDocument();
    // "Pending" appears both as a filter option and the row badge — assert the row has one.
    expect(screen.getByRole("row", { name: /professional/i })).toHaveTextContent(/pending/i);
  });

  it("approves a request as asked", async () => {
    const approve = vi
      .spyOn(api, "approveUpgradeRequest")
      .mockResolvedValue({ data: {} } as never);
    renderQueue();
    await userEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
    // Dialog → confirm.
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: /^approve$/i }),
    );
    await waitFor(() => expect(approve).toHaveBeenCalledWith(7, expect.any(Object)));
  });

  it("rejects a request with a reason", async () => {
    const reject = vi
      .spyOn(api, "rejectUpgradeRequest")
      .mockResolvedValue({ data: {} } as never);
    renderQueue();
    await userEvent.click(await screen.findByRole("button", { name: /^reject$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/reason/i), "Contact sales");
    await userEvent.click(within(dialog).getByRole("button", { name: /^reject$/i }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith(7, "Contact sales"));
  });
});
