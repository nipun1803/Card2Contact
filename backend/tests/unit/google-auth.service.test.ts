import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * GoogleAuthService wraps google-auth-library's OAuth2Client. We mock the SDK
 * so we can assert the service's own logic — scope/consent-url construction,
 * id_token verification, and Credentials→TokenSet mapping — without a network
 * call or real client secret.
 */

const generateAuthUrl = vi.fn(() => "https://accounts.google.com/o/oauth2/auth?mock");
const getToken = vi.fn();
const verifyIdToken = vi.fn();
const setCredentials = vi.fn();
const on = vi.fn();

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    generateAuthUrl,
    getToken,
    verifyIdToken,
    setCredentials,
    on,
  })),
}));

import { GoogleAuthService } from "../../src/modules/google-auth/google-auth.service";

function makeService() {
  return new GoogleAuthService("client-id", "client-secret", "http://localhost/callback");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GoogleAuthService.buildConsentUrl", () => {
  it("requests offline access, forced consent, and the required scopes", () => {
    makeService().buildConsentUrl();

    expect(generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: "offline",
        prompt: "consent",
        scope: expect.arrayContaining([
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/spreadsheets",
        ]),
      }),
    );
  });
});

describe("GoogleAuthService.handleCallback", () => {
  it("exchanges the code, verifies the id_token, and returns identity + tokens", async () => {
    getToken.mockResolvedValue({
      tokens: {
        id_token: "idtok",
        access_token: "at",
        refresh_token: "rt",
        expiry_date: 1234,
      },
    });
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "google-sub-1", email: "ada@example.com" }),
    });

    const identity = await makeService().handleCallback("auth-code");

    expect(getToken).toHaveBeenCalledWith("auth-code");
    expect(identity).toEqual({
      googleUserId: "google-sub-1",
      email: "ada@example.com",
      tokens: { accessToken: "at", refreshToken: "rt", tokenExpiry: 1234 },
    });
  });

  it("throws when Google returns no id_token (openid scope missing)", async () => {
    getToken.mockResolvedValue({ tokens: { access_token: "at" } });
    await expect(makeService().handleCallback("c")).rejects.toThrow(/id_token/);
  });

  it("throws when the id_token payload lacks sub/email", async () => {
    getToken.mockResolvedValue({ tokens: { id_token: "idtok" } });
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "only-sub" }) });
    await expect(makeService().handleCallback("c")).rejects.toThrow(/sub\/email/);
  });

  it("maps missing token fields to null in the TokenSet", async () => {
    getToken.mockResolvedValue({ tokens: { id_token: "idtok", access_token: "at" } });
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "s", email: "e@x.com" }),
    });

    const identity = await makeService().handleCallback("c");

    expect(identity.tokens).toEqual({
      accessToken: "at",
      refreshToken: null,
      tokenExpiry: null,
    });
  });
});

describe("GoogleAuthService.authClientForUser", () => {
  it("sets stored credentials and registers an onRefresh listener", () => {
    const onRefresh = vi.fn();
    makeService().authClientForUser(
      { accessToken: "at", refreshToken: "rt", tokenExpiry: 999 },
      onRefresh,
    );

    expect(setCredentials).toHaveBeenCalledWith({
      access_token: "at",
      refresh_token: "rt",
      expiry_date: 999,
    });
    expect(on).toHaveBeenCalledWith("tokens", expect.any(Function));
  });

  it("forwards a silent token refresh to onRefresh as a TokenSet", () => {
    const onRefresh = vi.fn();
    makeService().authClientForUser(
      { accessToken: "at", refreshToken: "rt", tokenExpiry: 1 },
      onRefresh,
    );

    // Simulate the SDK emitting a refreshed access token.
    const listener = on.mock.calls.find(([evt]) => evt === "tokens")?.[1] as (
      c: unknown,
    ) => void;
    listener({ access_token: "new-at", expiry_date: 2 });

    expect(onRefresh).toHaveBeenCalledWith({
      accessToken: "new-at",
      refreshToken: null,
      tokenExpiry: 2,
    });
  });
});
