import express, { Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { OAuth2Client } from "google-auth-library";
import { cardSessionStore } from "./shared/store/card-session-store";
import { errorHandler } from "./shared/http/error-handler";
import { createSessionMiddleware } from "./shared/http/session";
import { UserRecord, UserStore } from "./shared/store/user-store";
import { SheetsProvisioner } from "./shared/sheets/sheets-provisioner";
import { createM1Router } from "./modules/image-acquisition/image-acquisition.router";
import { createM2Router } from "./modules/text-recognition/text-recognition.router";
import { createM3Router } from "./modules/contact-extraction/contact-extraction.router";
import { createM4Router } from "./modules/contact-review/contact-review.router";
import { createM5Router } from "./modules/google-sheets/google-sheets.router";
import { createGoogleSheetsClient } from "./modules/google-sheets/google-sheets.client";
import { SHEET_HEADER, SPREADSHEET_TITLE } from "./modules/google-sheets/google-sheets.service";
import { GoogleAuthService } from "./modules/google-auth/google-auth.service";
import { createGoogleAuthRouter } from "./modules/google-auth/google-auth.router";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

function createGoogleAuthService(): GoogleAuthService {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI must all be set"
    );
  }
  return new GoogleAuthService(clientId, clientSecret, redirectUri);
}

/**
 * The SheetsProvisioner implementation lives here in the composition root —
 * the only place allowed to know both the google-sheets and users modules. It
 * closes over the per-user Sheets client factory + the user store so the
 * google-auth module can trigger provisioning through the shared interface
 * without importing google-sheets.
 */
function createSheetsProvisioner(userStore: UserStore): SheetsProvisioner {
  return {
    async ensureSpreadsheet(user: UserRecord, authClient: OAuth2Client): Promise<string> {
      const sheets = createGoogleSheetsClient(authClient);
      const spreadsheetId = await sheets.createSpreadsheetWithHeader(
        SPREADSHEET_TITLE,
        [...SHEET_HEADER]
      );
      await userStore.setSpreadsheetId(user.googleUserId, spreadsheetId);
      return spreadsheetId;
    },
  };
}

/**
 * Composition root: wires the shared stores (CardSessionStore, UserStore),
 * session cookie handling, and the GoogleAuthService/SheetsProvisioner into
 * each module's router. Modules never import one another — this is the only
 * file that knows all five pipeline modules plus google-auth exist.
 *
 * `userStore` is injected (built in index.ts from the DB pool) so createApp
 * stays synchronous and DB-free for unit tests.
 */
export function createApp(deps: { userStore: UserStore }): Express {
  const { userStore } = deps;
  const app = express();
  const googleAuthService = createGoogleAuthService();
  const provisioner = createSheetsProvisioner(userStore);

  // Credentialed CORS with an explicit origin — a wildcard origin is illegal
  // once cookies (credentials) are sent, so the session cookie can ride along.
  app.use(cors({ origin: FRONTEND_URL, credentials: true }));
  app.use(express.json());

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET must be set");
  }
  app.use(cookieParser(sessionSecret));
  app.use(createSessionMiddleware(userStore));

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api", createM1Router(cardSessionStore));
  app.use("/api", createM2Router(cardSessionStore));
  app.use("/api", createM3Router(cardSessionStore));
  app.use("/api", createM4Router(cardSessionStore));
  app.use("/api", createM5Router(cardSessionStore, googleAuthService, userStore, provisioner));
  app.use(
    "/api",
    createGoogleAuthRouter(googleAuthService, userStore, provisioner, SPREADSHEET_TITLE)
  );

  app.use(errorHandler);

  return app;
}
