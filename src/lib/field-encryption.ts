import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "./api.js";
import { required } from "./env.js";

/**
 * Field-level encryption for the few values worth the most if they leak.
 *
 * PAN, GSTIN and bank account numbers. Disk encryption protects a stolen drive and
 * nothing else — it does not help against SQL injection, a leaked read-replica
 * credential, or a backup copied somewhere it should not be. In all three the attacker
 * reads rows, and in all three these fields stay ciphertext.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather than
 * quietly producing different plaintext. A random IV per value, because reusing one
 * with GCM is catastrophic rather than merely weak.
 *
 * Stored as `v1:<iv>:<tag>:<ciphertext>`, all base64url. The version prefix is what
 * makes key rotation possible later without guessing how old a value is.
 */

const VERSION = "v1";
const IV_BYTES = 12;

let cachedKey: Buffer | undefined;

/**
 * The key is 32 raw bytes, supplied base64. Deriving it from a passphrase would make
 * it only as strong as the passphrase, which is the usual way this goes wrong.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = Buffer.from(required("FIELD_ENCRYPTION_KEY"), "base64");
  if (raw.length !== 32) {
    throw new Error(
      `FIELD_ENCRYPTION_KEY must be 32 bytes base64-encoded, got ${String(raw.length)}. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  cachedKey = raw;
  return raw;
}

/** Test seam, for asserting that a rotated key cannot read old values. */
export function resetEncryptionKeyCache(): void {
  cachedKey = undefined;
}

export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptField(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");

  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new ApiError("internal", "Stored value is not in a readable encrypted format.");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    // Authentication failure: the wrong key, or the ciphertext was altered. Both mean
    // the value must not be used, so neither is recoverable here.
    throw new ApiError("internal", "Could not decrypt a stored value.", { cause: error });
  }
}

/** The part of an account number safe to show without decrypting anything. */
export function last4(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, "");
  return digits.slice(-4).padStart(4, "0");
}
