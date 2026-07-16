/**
 * Admin credentials, resolved from the environment.
 *
 * There is no `admins` table: Phase 0.1 has exactly one operator, and a
 * single-row identity table would be a schema, a migration, and a store to
 * maintain for one username. The credential lives in `.env` alongside
 * SESSION_SECRET and TOKEN_ENCRYPTION_KEY — the same trust boundary, the same
 * operator, the same rotation story (edit `.env`, redeploy).
 *
 * See docs/modules/admin/Admin-Authentication.md.
 */

/**
 * A bcrypt modular-crypt hash: `$2<variant>$<cost>$<22-char salt><31-char digest>`,
 * the salt+digest being 53 chars of bcrypt's base64 alphabet.
 *
 * This shape check is the single control that makes a plaintext password in
 * ADMIN_PASSWORD_HASH impossible to boot with. It matters more than it looks:
 * bcrypt.compare() against a non-hash does not throw — it quietly returns false
 * forever, which presents to the operator as "my password is wrong" with no
 * cause and no log. Failing loudly at boot converts a silent lockout into a
 * message naming the variable.
 *
 * Accepts $2a$/$2b$/$2y$ (all in the wild, all valid for compare) and any cost.
 */
export const BCRYPT_HASH_SHAPE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export interface AdminConfig {
  username: string;
  /** A bcrypt hash. The plaintext password is never held anywhere. */
  passwordHash: string;
}

/** Read as unset: absent, or present-but-blank (a common `.env` accident). */
function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * Resolve the admin credential, or `null` when the feature is switched off.
 *
 * Three outcomes, deliberately:
 *
 * 1. **Neither var set → `null`.** The admin panel is off; its routes answer 503
 *    (see AdminNotConfiguredError). This is what every existing deployment and
 *    the whole test suite hit, which is why admin config CANNOT be mandatory:
 *    createApp throwing here would break every env that predates this feature,
 *    and would force a live admin credential into tests/helpers/env.ts for the
 *    entire suite — a worse security posture, not a better one.
 *
 * 2. **Exactly one set → throw.** The real trap. A username with no hash is a
 *    half-configured admin; treating it as "off" would silently ignore an
 *    operator's clear intent to turn the panel on, and they would debug a 503
 *    against a var they can see is set.
 *
 * 3. **Both set → validate, throw on anything malformed.** A blank password can
 *    never be accepted because a blank hash fails the shape check here, at boot,
 *    before any request exists.
 *
 * So: absent is quiet and safe, present is strictly validated and loud. This
 * mirrors SESSION_SECRET's "validate at construction, throw with a specific
 * message" convention (app.ts), with an off-switch SESSION_SECRET can't have.
 *
 * Takes `env` as a parameter rather than reading process.env directly so it is
 * testable without mutating global state.
 */
export function resolveAdminConfig(
  env: NodeJS.ProcessEnv = process.env
): AdminConfig | null {
  const username = env.ADMIN_USERNAME;
  const passwordHash = env.ADMIN_PASSWORD_HASH;

  const noUsername = blank(username);
  const noHash = blank(passwordHash);

  // 1. Feature off.
  if (noUsername && noHash) return null;

  // 2. Half-configured — name the missing one specifically.
  if (noHash) {
    throw new Error(
      "ADMIN_USERNAME is set but ADMIN_PASSWORD_HASH is missing — set both to enable " +
        "the admin panel, or neither to disable it. Generate a hash with: " +
        `node -e "console.log(require('bcrypt').hashSync(process.argv[1],12))" 'your-password'`
    );
  }
  if (noUsername) {
    throw new Error(
      "ADMIN_PASSWORD_HASH is set but ADMIN_USERNAME is missing — set both to enable " +
        "the admin panel, or neither to disable it."
    );
  }

  // 3. Both present: validate.
  if (!BCRYPT_HASH_SHAPE.test(passwordHash!)) {
    // Deliberately does NOT echo the value: it is a credential, and this message
    // reaches stdout.
    throw new Error(
      "ADMIN_PASSWORD_HASH is not a bcrypt hash (expected $2a$/$2b$/$2y$ followed by a " +
        "2-digit cost and 53 chars). A plaintext password here would never match and " +
        "would lock the admin out with no error. Generate one with: " +
        `node -e "console.log(require('bcrypt').hashSync(process.argv[1],12))" 'your-password'`
    );
  }

  return { username: username!.trim(), passwordHash: passwordHash! };
}
