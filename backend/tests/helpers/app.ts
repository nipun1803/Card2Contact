import type { Express } from "express";
import { createApp } from "../../src/app";
import { UserStore } from "../../src/shared/store/user-store";
import { makeUserStore } from "../mocks/stores";

/**
 * Build a real Express app for supertest, with the DB boundary (UserStore)
 * injected as a fake. The env vars `createApp` needs are set by the global
 * setupFile (tests/helpers/env.ts).
 *
 * IMPORTANT — external SDK boundaries:
 * `createApp` constructs the Mistral OCR client (M2) and the Google OAuth
 * client (auth/M5) internally, so integration specs that exercise those routes
 * must `vi.mock("@mistralai/mistralai")` / `vi.mock("googleapis")` /
 * `vi.mock("google-auth-library")` at the top of the file BEFORE importing this
 * helper. Specs that only touch M1/M3/M4 need no such mock.
 *
 * The pipeline (M1–M4) shares a single process-wide in-memory
 * `cardSessionStore` (a module singleton). Tests that submit a card and then
 * act on it work fine within one file; they must not assume isolation between
 * unrelated card ids.
 */
export function buildTestApp(userStore: UserStore = makeUserStore()): Express {
  return createApp({ userStore });
}
