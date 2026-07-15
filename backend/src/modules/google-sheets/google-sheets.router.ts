import { Router } from "express";
import { M5Service } from "./google-sheets.service";
import { CardSessionStore } from "../../shared/store/card-session-store";
import { createGoogleSheetsClient } from "./google-sheets.client";
import { GoogleAuthService } from "../google-auth/google-auth.service";
import { ValidationError } from "../../shared/http/pipeline-errors";
import { UserStore } from "../../shared/store/user-store";
import { SheetsProvisioner } from "../../shared/sheets/sheets-provisioner";
import { requireAuth } from "../../shared/http/require-auth";

/**
 * M5 router factory. The save endpoint now requires an authenticated user and
 * targets THAT user's own spreadsheet. Per request it builds an OAuth2Client
 * from the user's stored tokens (persisting any silent refresh, and surfacing a
 * revoked refresh token as REAUTH_REQUIRED) and a per-user Sheets client.
 */
export function createM5Router(
  store: CardSessionStore,
  authService: GoogleAuthService,
  userStore: UserStore,
  provisioner: SheetsProvisioner
): Router {
  const router = Router();

  // POST /api/contacts/save — requires auth; { cardId, contact } in, { cardId, saved } out.
  router.post("/contacts/save", requireAuth, async (req, res, next) => {
    try {
      const { cardId, contact } = req.body ?? {};
      if (typeof cardId !== "string" || cardId.trim() === "") {
        throw new ValidationError("cardId is required");
      }
      if (contact === undefined || contact === null || typeof contact !== "object") {
        throw new ValidationError("contact is required");
      }

      const { user } = req.auth!; // requireAuth guarantees this
      const authClient = authService.authClientForUser(
        { accessToken: user.accessToken, refreshToken: user.refreshToken, tokenExpiry: user.tokenExpiry },
        (t) => void userStore.updateTokens(user.googleUserId, t)
      );
      const sheets = createGoogleSheetsClient(authClient);
      const service = new M5Service(store, sheets, provisioner, userStore);

      const session = await service.save(cardId, user, authClient);
      res.json({ cardId: session.cardId, saved: session.saved });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
