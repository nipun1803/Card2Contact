import bcrypt from "bcrypt";
import { randomBytes, timingSafeEqual } from "crypto";
import { AdminConfig } from "./admin-auth.config";
import {
  AdminSessionFingerprint,
  AdminSessionRecord,
  AdminSessionStore,
} from "../../shared/store/admin-session-store";

/**
 * Admin authentication business rules. No HTTP here — the router owns cookies,
 * status codes, and audit; this owns "are these credentials right, and what
 * session do they get".
 *
 * See docs/modules/admin/Admin-Authentication.md.
 */

/**
 * bcrypt work factor. 12 ≈ 100ms per attempt on current hardware — deliberately
 * slow: combined with the 5-per-15-min limiter it is the primary control against
 * an anonymous guesser, not defence in depth.
 *
 * Exported so tests can hash at a low cost and stay fast, and so the value the
 * operator is told to use (in .env.example) has one home.
 */
export const BCRYPT_ROUNDS = 12;

/**
 * A real bcrypt hash of a value nobody knows, computed once at module load.
 *
 * This exists solely to burn the same ~100ms on a wrong USERNAME that a wrong
 * PASSWORD costs. Without it, `if (!usernameMatches) return false` would return
 * in microseconds while a real compare takes ~100ms — a remotely measurable
 * oracle that tells an attacker when they have found the username, halving the
 * problem from "guess two secrets" to "guess one".
 *
 * It MUST be generated, never a hand-written constant: bcrypt.compare() against
 * a malformed hash returns false immediately, which would restore the very
 * oracle this removes — silently, and while still looking correct.
 */
const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString("hex"), BCRYPT_ROUNDS);

/**
 * Constant-time string comparison.
 *
 * crypto.timingSafeEqual throws on a length mismatch, so lengths are checked
 * first. That check is itself a (tiny) timing leak of the username's LENGTH —
 * accepted, and immaterial: a username's length is not a meaningful secret, and
 * the caller runs a full bcrypt compare regardless, so the ~100ms bcrypt term
 * dominates any nanosecond-scale difference here.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AdminAuthService {
  constructor(
    private readonly config: AdminConfig,
    private readonly sessions: AdminSessionStore
  ) {}

  /**
   * True only if BOTH the username and password are correct.
   *
   * The shape of this function is load-bearing and must not be "optimized":
   *
   *   - Exactly ONE bcrypt.compare runs on EVERY path — right username, wrong
   *     username, empty input, all of them. Against DUMMY_HASH when the username
   *     misses, so the work is identical.
   *   - The `&&` short-circuits the RETURN VALUE, not the work: both operands
   *     have already been evaluated by the time it runs.
   *   - An early `if (!usernameOk) return false` would restore the enumeration
   *     oracle. That refactor looks like a pure win and is the single most
   *     likely way this protection gets removed — hence this comment, and the
   *     structural test that spies on bcrypt.compare's call count.
   */
  async verifyCredentials(username: string, password: string): Promise<boolean> {
    const usernameOk = timingSafeEqualStr(username, this.config.username);
    const hash = usernameOk ? this.config.passwordHash : DUMMY_HASH;
    const passwordOk = await bcrypt.compare(password, hash);
    return usernameOk && passwordOk;
  }

  /**
   * Verify and, on success, mint an Admin Session. Null on any failure — the
   * caller cannot tell which credential was wrong, and must not be able to.
   */
  async login(
    username: string,
    password: string,
    fp: AdminSessionFingerprint
  ): Promise<AdminSessionRecord | null> {
    if (!(await this.verifyCredentials(username, password))) return null;
    return this.sessions.create(this.config.username, fp);
  }

  /** Session Termination. Idempotent — an unknown id is a no-op. */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
  }

  /**
   * Resolve a session id to its Admin Session, or null if it is unknown,
   * expired, or revoked — deliberately indistinguishable (see admin-errors.ts).
   */
  async authenticate(sessionId: string): Promise<AdminSessionRecord | null> {
    return this.sessions.findActive(sessionId);
  }
}
