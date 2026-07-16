import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bfcache/stale-route regression: a user who visited /admin/login, then
 * navigated to /login and signed in with Google, could hit the browser Back
 * button after the post-OAuth redirect and have the browser restore the
 * *frozen* /admin/login render straight from the back-forward cache — no
 * route guard runs, because the page was never re-fetched.
 *
 * `main.tsx` registers a `pageshow` listener at module scope (before React
 * mounts) that forces a reload whenever `event.persisted` is true. This test
 * imports that module directly (mocking out the React render so it doesn't
 * need a real #root/App tree) and fires a synthetic bfcache-restore event.
 */

vi.mock("react-dom/client", () => ({
  createRoot: vi.fn(() => ({ render: vi.fn() })),
}));
vi.mock("@/app/App", () => ({ App: () => null }));

describe("bfcache restore forces a reload", () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
    reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reloads when pageshow fires with persisted: true (a bfcache restore)", async () => {
    await import("@/main");

    // jsdom's Event doesn't support the PageTransitionEvent constructor
    // options in all versions — set persisted directly on the instance.
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload for a normal fresh page load (persisted: false)", async () => {
    await import("@/main");

    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: false });
    window.dispatchEvent(event);

    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
