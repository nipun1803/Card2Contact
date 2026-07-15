import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  NetworkError,
  ReauthError,
  SessionRevokedError,
  getAuthStatus,
} from "@/shared/services/api";

/**
 * The error-classification contract between backend and frontend. Two 401s with
 * different `code` values mean very different things to the user, and the whole
 * UX of each depends on `request()` telling them apart:
 *
 *   REAUTH_REQUIRED  -> Google access lapsed; stay signed in, show Reconnect.
 *   SESSION_REVOKED  -> this session was ended (another device); go to /login.
 *   bare 401         -> never signed in.
 */

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: "Unauthorized",
      json: async () => body,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("401 classification", () => {
  it("throws SessionRevokedError for code SESSION_REVOKED", async () => {
    mockFetch(401, {
      error: "You were signed out because you signed in on another device",
      code: "SESSION_REVOKED",
    });

    await expect(getAuthStatus()).rejects.toBeInstanceOf(SessionRevokedError);
  });

  it("carries the server's explanation through to the UI", async () => {
    mockFetch(401, { error: "Ended elsewhere", code: "SESSION_REVOKED" });

    await expect(getAuthStatus()).rejects.toThrow("Ended elsewhere");
  });

  it("falls back to a sensible message when the body has none", async () => {
    mockFetch(401, { code: "SESSION_REVOKED" });

    await expect(getAuthStatus()).rejects.toThrow(/another device/i);
  });

  it("throws ReauthError for code REAUTH_REQUIRED", async () => {
    mockFetch(401, { error: "Please reconnect", code: "REAUTH_REQUIRED" });

    await expect(getAuthStatus()).rejects.toBeInstanceOf(ReauthError);
  });

  // The two must never be conflated: one keeps the user signed in, the other
  // signs them out.
  it("does not confuse a revoked session with a reauth prompt", async () => {
    mockFetch(401, { error: "x", code: "SESSION_REVOKED" });

    await expect(getAuthStatus()).rejects.not.toBeInstanceOf(ReauthError);
  });

  it("throws a plain ApiError for a 401 with no code (never signed in)", async () => {
    mockFetch(401, { error: "Google login required" });

    const err = await getAuthStatus().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(SessionRevokedError);
    expect(err).not.toBeInstanceOf(ReauthError);
  });
});

describe("other failures", () => {
  it("throws SessionRevokedError as an ApiError with status 401", async () => {
    // The queryClient's retry predicate keys off `instanceof ApiError` +
    // status, so the subclass must preserve both.
    mockFetch(401, { error: "x", code: "SESSION_REVOKED" });

    const err = await getAuthStatus().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it("throws NetworkError when the request cannot be made", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(getAuthStatus()).rejects.toBeInstanceOf(NetworkError);
  });

  it("throws ApiError for a 429 from a rate limiter", async () => {
    mockFetch(429, { error: "Too many requests — please try again later" });

    const err = await getAuthStatus().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/too many requests/i);
  });
});
