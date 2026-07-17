import * as Sentry from "@sentry/node";

/**
 * Imported first (see index.ts) so instrumentation is active before any other
 * module — including express and the DB pool — is loaded. A no-op when unset,
 * e.g. local dev and CI/test.
 */
const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    integrations: [
      Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
      // Overrides the default httpIntegration (which auto-logs every
      // request) to drop the health check — it fires every 10s from
      // Docker's own healthcheck and drowns out real traffic in Sentry.
      Sentry.httpIntegration({
        ignoreIncomingRequests: (url) => url.startsWith("/api/health"),
      }),
    ],
    enableLogs: true,
  });
}
