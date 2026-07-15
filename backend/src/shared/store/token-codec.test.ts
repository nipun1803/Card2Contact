import { describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import { AesGcmTokenCodec, IdentityTokenCodec, decodeEncryptionKey } from "./token-codec";

describe("IdentityTokenCodec", () => {
  it("passes tokens through unchanged", () => {
    const codec = new IdentityTokenCodec();
    expect(codec.encode("ya29.some-token")).toBe("ya29.some-token");
    expect(codec.decode("ya29.some-token")).toBe("ya29.some-token");
  });
});

describe("AesGcmTokenCodec", () => {
  const key = randomBytes(32);

  it("round-trips a token", () => {
    const codec = new AesGcmTokenCodec(key);
    const plaintext = "1//refresh-token-value";
    expect(codec.decode(codec.encode(plaintext))).toBe(plaintext);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const codec = new AesGcmTokenCodec(key);
    expect(codec.encode("same")).not.toBe(codec.encode("same"));
  });

  it("throws when the key is not 32 bytes", () => {
    expect(() => new AesGcmTokenCodec(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("rejects a tampered payload", () => {
    const codec = new AesGcmTokenCodec(key);
    const encoded = codec.encode("secret");
    const [iv, tag, data] = encoded.split(":");
    // Flip a byte in the ciphertext so the GCM auth tag no longer verifies.
    const corrupted = Buffer.from(data, "base64");
    corrupted[0] ^= 0xff;
    const tampered = [iv, tag, corrupted.toString("base64")].join(":");
    expect(() => codec.decode(tampered)).toThrow();
  });

  it("rejects a malformed payload", () => {
    const codec = new AesGcmTokenCodec(key);
    expect(() => codec.decode("not-a-valid-payload")).toThrow(/Malformed/);
  });
});

describe("decodeEncryptionKey", () => {
  it("accepts a 64-char hex key", () => {
    expect(decodeEncryptionKey("a".repeat(64)).length).toBe(32);
  });

  it("accepts a base64 32-byte key", () => {
    expect(decodeEncryptionKey(randomBytes(32).toString("base64")).length).toBe(32);
  });

  it("throws on the wrong length", () => {
    expect(() => decodeEncryptionKey("tooshort")).toThrow(/32 bytes/);
  });
});
