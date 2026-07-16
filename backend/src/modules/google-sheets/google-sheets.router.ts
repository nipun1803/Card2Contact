import { Router, RequestHandler } from "express";
import { M5Service } from "./google-sheets.service";
import { CardSessionStore } from "../../shared/store/card-session-store";
import { createGoogleSheetsClient } from "./google-sheets.client";
import { GoogleAuthService } from "../google-auth/google-auth.service";
import { ReauthRequiredError, UserDisabledError, ValidationError } from "../../shared/http/pipeline-errors";
import { UserStore } from "../../shared/store/user-store";
import { SheetsProvisioner } from "../../shared/sheets/sheets-provisioner";
import { AuditLogger } from "../../shared/audit/audit-logger";
import { Metrics } from "../../shared/observability/metrics";

/**
 * M5 router factory. The save endpoint requires an authenticated user and
 * targets THAT user's own spreadsheet. Per request it builds an OAuth2Client
 * from the user's stored tokens (persisting any silent refresh, and surfacing a
 * revoked refresh token as REAUTH_REQUIRED) and a per-user Sheets client.
 */
export function createM5Router(
  store: CardSessionStore,
  authService: GoogleAuthService,
  userStore: UserStore,
  provisioner: SheetsProvisioner,
  saveLimiter: RequestHandler,
  requireAuth: RequestHandler,
  audit: AuditLogger,
  metrics: Metrics
): Router {
  const router = Router();

  // POST /api/contacts/save — requires auth; { cardId, contact } in, { cardId, saved } out.
  // requireAuth precedes the limiter: the limiter keys on req.auth.googleUserId,
  // so an unauthenticated request must be rejected before it can consume a
  // budget keyed on a user that isn't there.
  router.post("/contacts/save", requireAuth, saveLimiter, async (req, res, next) => {
    const { user, sessionId } = req.auth!; // requireAuth guarantees this
    try {
      // Admin User Management: a disabled user's row (and any pre-existing
      // session) must not be able to save contacts. `user` already carries
      // disabledAt for free — the session middleware loaded the full record.
      if (user.disabledAt) {
        throw new UserDisabledError();
      }

      const { cardId, contact } = req.body ?? {};
      if (typeof cardId !== "string" || cardId.trim() === "") {
        throw new ValidationError("cardId is required");
      }
      if (contact === undefined || contact === null || typeof contact !== "object") {
        throw new ValidationError("contact is required");
      }

      const authClient = authService.authClientForUser(
        {
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          tokenExpiry: user.tokenExpiry,
        },
        (t) => {
          // Fire-and-forget: google-auth-library emits "tokens" synchronously
          // mid-request. Post-cutover updateTokens runs codec.encode(), which
          // throws on a bad key — without this catch that becomes an unhandled
          // rejection that can take the process down. A failed persist just
          // means the next request refreshes again; a crashed backend does not
          // recover.
          void userStore
            .updateTokens(user.googleUserId, t)
            .catch((err) =>
              console.error("[m5] failed to persist refreshed tokens", err)
            );
        }
      );
      const sheets = createGoogleSheetsClient(authClient);
      const service = new M5Service(store, sheets, provisioner, userStore, audit, metrics);

      const session = await service.save(cardId, user, authClient);
      audit.log({
        event: "contact_save",
        googleUserId: user.googleUserId,
        sessionId,
        cardId: session.cardId,
        outcome: "success",
      });
      res.json({ cardId: session.cardId, saved: session.saved });
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        /**
         * Refresh-token failure policy. Google rejected the refresh token
         * (invalid_grant) — the user revoked access in their Google settings,
         * or it aged out. Null the stored tokens so /status reports
         * needsReconnect and the dashboard shows the Reconnect prompt
         * proactively, instead of the user only discovering the problem on
         * their next save. Until this call existed, needsReconnect was
         * unreachable: nothing ever nulled the tokens.
         *
         * The session deliberately SURVIVES: losing Google access is not
         * losing your card2contact session — the user is still who they said
         * they are. Only logout and Session Replacement revoke.
         */
        await userStore.clearTokens(user.googleUserId).catch((e) =>
          console.error("[m5] failed to clear rejected tokens", e)
        );
        audit.log({
          event: "token_refresh_failed",
          googleUserId: user.googleUserId,
          sessionId,
          reason: "invalid_grant",
        });
        metrics.inc("token_refresh_failure");
        metrics.inc("reconnect_required");
      }
      next(err);
    }
  });

  return router;
}
