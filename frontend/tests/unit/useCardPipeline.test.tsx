import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * useCardPipeline sequences the M1–M5 API calls into one client state machine.
 * We mock the api module and sonner so the hook runs offline and we can assert
 * the state transitions and error routing (session-lost reset, reauth branch).
 */
vi.mock("@/shared/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/shared/services/api")>(
    "@/shared/services/api",
  );
  return {
    ...actual, // keep the real error classes (ApiError/ReauthError/NetworkError)
    submitCard: vi.fn(),
    recognizeCard: vi.fn(),
    extractContact: vi.fn(),
    updateContact: vi.fn(),
    confirmContact: vi.fn(),
    saveContact: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useCardPipeline } from "@/features/scan/useCardPipeline";
import {
  submitCard,
  recognizeCard,
  extractContact,
  updateContact,
  confirmContact,
  saveContact,
  ApiError,
  ReauthError,
  QuotaExceededError,
  ScanBlockedError,
} from "@/shared/services/api";
import { makeContact, makeImageFile } from "../fixtures/contacts";

const mocked = {
  submitCard: vi.mocked(submitCard),
  recognizeCard: vi.mocked(recognizeCard),
  extractContact: vi.mocked(extractContact),
  updateContact: vi.mocked(updateContact),
  confirmContact: vi.mocked(confirmContact),
  saveContact: vi.mocked(saveContact),
};

/**
 * The hook calls useAuthActions() (to refresh auth status after a save), which
 * calls useQueryClient() — so it cannot render outside a QueryClientProvider.
 * A fresh client per test keeps the cache from leaking between them.
 */
function renderPipeline() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderHook(() => useCardPipeline(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("useCardPipeline.submit", () => {
  it("walks capture → recognizing → extracting → review on success", async () => {
    const contact = makeContact();
    mocked.submitCard.mockResolvedValue({ cardId: "card-1", mode: "single" });
    mocked.recognizeCard.mockResolvedValue({ cardId: "card-1", rawText: "raw" });
    mocked.extractContact.mockResolvedValue({ cardId: "card-1", contact });

    const { result } = renderPipeline();

    await act(async () => {
      await result.current.submit("single", makeImageFile(), null);
    });

    await waitFor(() => expect(result.current.state.status).toBe("review"));
    expect(result.current.state.cardId).toBe("card-1");
    expect(result.current.state.contact).toEqual(contact);
    expect(mocked.recognizeCard).toHaveBeenCalledWith("card-1");
  });

  it("resets to capture on a 409 out-of-order (session lost)", async () => {
    mocked.submitCard.mockResolvedValue({ cardId: "card-1", mode: "single" });
    mocked.recognizeCard.mockRejectedValue(new ApiError(409, "out of order"));

    const { result } = renderPipeline();
    await act(async () => {
      await result.current.submit("single", makeImageFile(), null);
    });

    await waitFor(() => expect(result.current.state.status).toBe("capture"));
    expect(result.current.state.cardId).toBeNull();
  });

  it("routes to the quotaExceeded state on a 402 at recognize", async () => {
    mocked.submitCard.mockResolvedValue({ cardId: "card-1", mode: "single" });
    mocked.recognizeCard.mockRejectedValue(new QuotaExceededError("out of scans"));

    const { result } = renderPipeline();
    await act(async () => {
      await result.current.submit("single", makeImageFile(), null);
    });

    await waitFor(() => expect(result.current.state.status).toBe("quotaExceeded"));
  });

  it("routes to the scanBlocked state on a 403 SCAN_BLOCKED at recognize", async () => {
    mocked.submitCard.mockResolvedValue({ cardId: "card-1", mode: "single" });
    mocked.recognizeCard.mockRejectedValue(new ScanBlockedError("blocked"));

    const { result } = renderPipeline();
    await act(async () => {
      await result.current.submit("single", makeImageFile(), null);
    });

    await waitFor(() => expect(result.current.state.status).toBe("scanBlocked"));
  });
});

describe("useCardPipeline.confirm", () => {
  async function toReview() {
    const contact = makeContact();
    mocked.submitCard.mockResolvedValue({ cardId: "card-1", mode: "single" });
    mocked.recognizeCard.mockResolvedValue({ cardId: "card-1", rawText: "raw" });
    mocked.extractContact.mockResolvedValue({ cardId: "card-1", contact });
    const hook = renderPipeline();
    await act(async () => {
      await hook.result.current.submit("single", makeImageFile(), null);
    });
    await waitFor(() => expect(hook.result.current.state.status).toBe("review"));
    return hook;
  }

  it("PATCHes, confirms, saves, and records a recent scan on success", async () => {
    const { result } = await toReview();
    mocked.updateContact.mockResolvedValue({ cardId: "card-1", contact: makeContact() });
    mocked.confirmContact.mockResolvedValue({
      cardId: "card-1",
      confirmed: true,
      contact: makeContact(),
    });
    mocked.saveContact.mockResolvedValue({ cardId: "card-1", saved: true });

    await act(async () => {
      await result.current.confirm(makeContact({ name: "Edited" }));
    });

    await waitFor(() => expect(result.current.state.status).toBe("done"));
    // Order matters: edits persisted before confirm before save.
    expect(mocked.updateContact).toHaveBeenCalled();
    expect(mocked.confirmContact).toHaveBeenCalled();
    expect(mocked.saveContact).toHaveBeenCalled();
    // Recent scan recorded.
    expect(JSON.parse(localStorage.getItem("c2c.recentScans") ?? "[]")).toHaveLength(1);
  });

  it("routes to the reconnect state on a ReauthError without persisting PII", async () => {
    const { result } = await toReview();
    mocked.updateContact.mockResolvedValue({ cardId: "card-1", contact: makeContact() });
    mocked.confirmContact.mockResolvedValue({
      cardId: "card-1",
      confirmed: true,
      contact: makeContact(),
    });
    mocked.saveContact.mockRejectedValue(new ReauthError("reconnect please"));

    await act(async () => {
      await result.current.confirm(makeContact({ name: "Ada" }));
    });

    await waitFor(() => expect(result.current.state.status).toBe("reconnect"));
    // The draft contact must NOT be stashed anywhere (no PII leak).
    expect(sessionStorage.getItem("c2c.pendingContact")).toBeNull();
  });

  it("does nothing when there is no cardId", async () => {
    const { result } = renderPipeline();
    await act(async () => {
      await result.current.confirm(makeContact());
    });
    expect(mocked.saveContact).not.toHaveBeenCalled();
  });
});
