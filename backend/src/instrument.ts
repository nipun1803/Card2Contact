import * as Sentry from "@sentry/node";

/**
 * Imported first (see index.ts) so instrumentation is active before any other
 * module — including express and the DB pool — is loaded. A no-op when unset,
 * e.g. local dev and CI/test.
 */
const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn });
}
