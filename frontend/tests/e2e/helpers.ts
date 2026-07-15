import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Path to the captured signed-in storage state (see auth.setup.ts). */
export const AUTH_STATE = path.join(dir, ".auth", "user.json");

/** True once an interactive Google login has been captured. */
export function hasAuthState(): boolean {
  return fs.existsSync(AUTH_STATE);
}
