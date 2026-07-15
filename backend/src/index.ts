import "dotenv/config";
import { createApp } from "./app";
import { createPool } from "./shared/db/pool";
import { initSchemaWithRetry } from "./shared/db/init";
import { PgUserStore } from "./shared/store/user-store";
import { PgSessionStore } from "./shared/store/session-store";
import { AesGcmTokenCodec, decodeEncryptionKey } from "./shared/store/token-codec";
import { StdoutAuditLogger } from "./shared/audit/audit-logger";
import { StdoutMetrics } from "./shared/observability/metrics";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

/** How often to reclaim expired/long-revoked rows. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set");
  }

  /**
   * AES-256-GCM is mandatory (Token Cutover). Fail fast here rather than start
   * a server that throws on every token read — decodeEncryptionKey validates
   * the length at wiring time.
   *
   * Note it can only check the key's LENGTH, not that it is the *right* key: a
   * wrong-but-valid key boots fine and presents as every user needing to
   * Reconnect (PgUserStore.dec degrades to null rather than throwing, so this
   * stays recoverable — restore the correct key and redeploy). See the rollback
   * notes in docs/ARCHITECTURE.md.
   */
  const rawKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be set (32 bytes as 64 hex chars or base64). " +
        "Generate one with: openssl rand -hex 32"
    );
  }
  const codec = new AesGcmTokenCodec(decodeEncryptionKey(rawKey));

  const pool = createPool(databaseUrl);
  // Runs the Token Cutover wipe, so no plaintext survives to reach decode().
  // Must precede store construction for that reason.
  await initSchemaWithRetry(pool);

  const userStore = new PgUserStore(pool, codec);
  const sessionStore = new PgSessionStore(pool);
  const audit = new StdoutAuditLogger();
  const metrics = new StdoutMetrics();
  metrics.start();

  const app = createApp({ userStore, sessionStore, audit, metrics });
  app.listen(PORT, () => {
    console.log(`Card2Contact backend listening on http://localhost:${PORT}`);
  });

  /**
   * Reclaim expired sessions and long-revoked rows hourly. NOT a correctness
   * mechanism — findActive enforces both lifetime bounds in SQL, so an expired
   * session stops working whether or not this ever runs. Purely space.
   * unref()'d so it never holds the process open during shutdown.
   */
  const purge = setInterval(() => {
    void sessionStore
      .purgeExpired()
      .then(({ sessions, pending }) => {
        if (sessions || pending) {
          console.log(`[purge] removed ${sessions} session(s), ${pending} pending`);
        }
      })
      .catch((err) => console.warn("[purge] failed", err));
  }, PURGE_INTERVAL_MS);
  purge.unref();
}

main().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
