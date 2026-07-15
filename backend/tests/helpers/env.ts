/**
 * setupFile (see vitest.config.ts): guarantees the env vars that `createApp`
 * reads at construction time exist with harmless test defaults, so integration
 * specs can build a real Express app without any real secrets. Individual specs
 * still inject fakes for the DB / Google / Mistral boundaries — these values are
 * only here so the wiring in `app.ts` (which throws on missing config) is happy.
 */
process.env.SESSION_SECRET ??= "test-session-secret";
process.env.MISTRAL_API_KEY ??= "test-mistral-key";
process.env.GOOGLE_OAUTH_CLIENT_ID ??= "test-client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET ??= "test-client-secret";
process.env.GOOGLE_OAUTH_REDIRECT_URI ??= "http://localhost:4000/api/auth/google/callback";
process.env.FRONTEND_URL ??= "http://localhost:5173";
