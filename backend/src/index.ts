import "dotenv/config";
import { createApp } from "./app";
import { createPool } from "./shared/db/pool";
import { initSchemaWithRetry } from "./shared/db/init";
import { PgUserStore } from "./shared/store/user-store";
import { IdentityTokenCodec } from "./shared/store/token-codec";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set");
  }

  const pool = createPool(databaseUrl);
  await initSchemaWithRetry(pool);

  // IdentityTokenCodec = tokens stored plaintext for now. To enable encryption,
  // swap in `new AesGcmTokenCodec(decodeEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY!))`
  // — no schema or store changes required.
  const userStore = new PgUserStore(pool, new IdentityTokenCodec());

  const app = createApp({ userStore });
  app.listen(PORT, () => {
    console.log(`Card2Contact backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
