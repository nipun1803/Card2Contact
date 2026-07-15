import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Encryption seam for OAuth tokens at rest. The user store calls
 * `encode`/`decode` around every token write/read, so *whether* tokens are
 * encrypted is a wiring decision (which impl is constructed in index.ts), not a
 * store-code decision. This lets us ship plaintext now and enable AES later
 * with no schema or store changes.
 */
export interface TokenCodec {
  /** Transform a plaintext token into its stored form. */
  encode(plaintext: string): string;
  /** Reverse `encode`. */
  decode(stored: string): string;
}

/**
 * Pass-through codec — stores tokens verbatim. Wired now (encryption is
 * deliberately postponed for the MMVP). Swap for AesGcmTokenCodec in index.ts
 * before handling real user data.
 */
export class IdentityTokenCodec implements TokenCodec {
  encode(plaintext: string): string {
    return plaintext;
  }
  decode(stored: string): string {
    return stored;
  }
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the standard/recommended size for GCM
const KEY_LENGTH = 32; // 256-bit key

/**
 * AES-256-GCM codec. Written and tested now but NOT wired this phase. Each
 * `encode` uses a fresh random IV so identical plaintexts produce different
 * ciphertexts; GCM's auth tag makes tampering detectable on `decode`.
 *
 * Stored form: `iv:tag:ciphertext`, each part base64. Enabling it later is a
 * one-line change in index.ts plus a TOKEN_ENCRYPTION_KEY env var.
 */
export class AesGcmTokenCodec implements TokenCodec {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_LENGTH) {
      throw new Error(`AesGcmTokenCodec key must be ${KEY_LENGTH} bytes, got ${key.length}`);
    }
  }

  encode(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
  }

  decode(stored: string): string {
    const [ivB64, tagB64, dataB64] = stored.split(":");
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error("Malformed encrypted token payload");
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(), // throws if the auth tag doesn't verify (tampered/wrong key)
    ]);
    return plaintext.toString("utf8");
  }
}

/**
 * Decode a raw key string (hex or base64) into a 32-byte Buffer, throwing early
 * (at wiring time) if it isn't exactly 32 bytes. Used only when AES is enabled.
 */
export function decodeEncryptionKey(rawKey: string): Buffer {
  // Try hex first (64 hex chars = 32 bytes), then base64.
  const hex = /^[0-9a-fA-F]{64}$/.test(rawKey) ? Buffer.from(rawKey, "hex") : null;
  const key = hex ?? Buffer.from(rawKey, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (64 hex chars or base64), got ${key.length}`
    );
  }
  return key;
}
