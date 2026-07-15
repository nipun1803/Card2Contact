/**
 * setupFile (see vitest.config.ts): guarantees the env vars that `createApp`
 * reads at construction time exist with harmless test defaults, so integration
 * specs can build a real Express app without any real secrets. Individual specs
 * still inject fakes for the DB / Google / Mistral boundaries — these values are
 * only here so the wiring in `app.ts` (which throws on missing config) is happy.
 */
// Must be >= 32 chars: app.ts rejects a short secret, since this is the only
// thing standing between a user and a forged session cookie.
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-chars-long";
process.env.MISTRAL_API_KEY ??= "test-mistral-key";
process.env.GOOGLE_OAUTH_CLIENT_ID ??= "test-client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET ??= "test-client-secret";
process.env.GOOGLE_OAUTH_REDIRECT_URI ??= "http://localhost:4000/api/auth/google/callback";
process.env.FRONTEND_URL ??= "http://localhost:5173";
// 32 zero bytes as hex. Only index.ts reads this (createApp takes an already
// built UserStore), but a spec that constructs AesGcmTokenCodec directly needs
// a valid key to exist.
process.env.TOKEN_ENCRYPTION_KEY ??= "00".repeat(32);

/**
 * Disables the rate limiters (see shared/http/rate-limit.ts). Integration specs
 * fire dozens of requests at the same route from the same fake IP and would
 * otherwise trip a 429 spuriously — testing the limiter's own behaviour is
 * rate-limit.test.ts's job, where it is enabled explicitly.
 */
process.env.NODE_ENV ??= "test";
