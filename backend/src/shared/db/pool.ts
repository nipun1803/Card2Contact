import { Pool } from "pg";

/**
 * Owns the Postgres connection only — no table or schema knowledge lives here
 * (that is `init.ts`'s job). Kept as a factory rather than a module-load
 * singleton so importing this file never requires a live database, which keeps
 * `createApp` and the unit tests DB-free (tests inject a fake UserStore).
 */
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}
