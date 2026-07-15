import { Credentials, OAuth2Client } from "google-auth-library";
import { TokenSet } from "../../shared/store/user-store";

/**
 * Scopes requested at login:
 * - openid/email/profile: identify the user (we read `sub` + `email` from the
 *   verified id_token) so each user maps to their own row + spreadsheet.
 * - spreadsheets: create and append to the user's own sheet (M5).
 * - drive.file: read the `trashed` flag on the sheet we created. The Sheets API
 *   cannot tell us this — a trashed spreadsheet reads and writes normally and
 *   never 404s — so without Drive we would silently append contacts to a bin
 *   the user cannot see. drive.file is the narrowest scope that works: it
 *   grants access ONLY to files this app created, never the user's wider Drive.
 *
 * Changing this list invalidates existing grants: `prompt: "consent"` below
 * means every user re-consents on their next sign-in, which is what we want.
 */
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

/** Identity + tokens extracted from a completed OAuth login. */
export interface GoogleIdentity {
  googleUserId: string; // id_token `sub`
  email: string;
  tokens: TokenSet;
}

/** Credentials -> our persisted TokenSet shape. */
function toTokenSet(tokens: Credentials): TokenSet {
  return {
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    tokenExpiry: tokens.expiry_date ?? null,
  };
}

/**
 * Stateless helper around Google OAuth mechanics. It holds only client config —
 * NOT any user's tokens. Persistence is the router/UserStore's job, which keeps
 * this service DB-free and testable and makes the app genuinely multi-user
 * (one OAuth2Client is built per user, on demand, from their stored tokens).
 */
export class GoogleAuthService {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string
  ) {}

  private newClient(): OAuth2Client {
    return new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri);
  }

  /** URL the browser is redirected to, to start (or re-)consent. */
  buildConsentUrl(): string {
    return this.newClient().generateAuthUrl({
      access_type: "offline", // required to receive a refresh_token
      prompt: "consent", // force a refresh_token even on re-login
      scope: SCOPES,
    });
  }

  /**
   * Exchange the authorization code for tokens and verify the id_token to
   * learn who logged in. Does NOT touch the database — returns identity +
   * tokens for the caller to persist.
   */
  async handleCallback(code: string): Promise<GoogleIdentity> {
    const client = this.newClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) {
      throw new Error("Google did not return an id_token (openid scope missing?)");
    }
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new Error("id_token missing sub/email");
    }
    return {
      googleUserId: payload.sub,
      email: payload.email,
      tokens: toTokenSet(tokens),
    };
  }

  /**
   * Build an OAuth2Client authorized as a specific user, from their stored
   * tokens. `onRefresh` is invoked when google-auth-library silently refreshes
   * the access token mid-request, so the caller can persist the new token
   * durably (the refresh response carries only a new access_token, so callers
   * merge rather than overwrite the refresh_token).
   */
  authClientForUser(tokens: TokenSet, onRefresh: (t: TokenSet) => void): OAuth2Client {
    const client = this.newClient();
    client.setCredentials({
      access_token: tokens.accessToken ?? undefined,
      refresh_token: tokens.refreshToken ?? undefined,
      expiry_date: tokens.tokenExpiry ?? undefined,
    });
    client.on("tokens", (refreshed) => onRefresh(toTokenSet(refreshed)));
    return client;
  }
}
