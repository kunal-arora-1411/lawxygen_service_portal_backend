import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { required } from "./env.js";

/**
 * Token generation, hashing and comparison.
 *
 * Every secret this system stores is stored as a keyed digest, never as plaintext: session
 * tokens, password-reset tokens, email verification tokens and OTP codes.
 *
 * The digest is **HMAC-SHA256 keyed with SESSION_SECRET**, not a bare SHA-256, and the
 * reason is the OTP code specifically. A session token is 256 bits of entropy — a plain
 * hash of it is unguessable and a key adds little. A six-digit OTP has a million possible
 * values, so a bare SHA-256 of one is recoverable from a leaked database in milliseconds
 * by hashing every candidate. The key is what makes the digests useless without also
 * stealing the application secret, and it costs nothing to apply it uniformly.
 *
 * Passwords are the exception: they use argon2id, which is deliberately slow and salted
 * per row. An HMAC is fast by design and is the wrong tool for a value humans choose.
 */

/** A URL-safe random token. 32 bytes — do not lower this. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** A numeric OTP code of the given length, uniformly distributed. */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  // Rejection sampling: `randomBytes % max` would bias the low values.
  const limit = Math.floor(0xffffffff / max) * max;
  let value: number;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return String(value % max).padStart(digits, "0");
}

/** Keyed digest of a secret, for storage and lookup. Hex, so it is index-friendly. */
export function hashToken(token: string): string {
  return createHmac("sha256", required("SESSION_SECRET")).update(token).digest("hex");
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Used where a value is compared rather than looked up — an equality check that returns
 * early leaks, byte by byte, how much of a guess was correct.
 */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * argon2id parameters.
 *
 * OWASP's current floor is 19 MiB of memory, 2 iterations and parallelism 1. Memory cost
 * is what actually resists GPU cracking; raising the iteration count instead buys far less
 * per millisecond spent.
 */
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON);
}

/** False rather than throwing when the stored hash is malformed or absent. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password, ARGON);
  } catch {
    return false;
  }
}

let decoy: Promise<string> | undefined;

/**
 * A valid hash of a value nobody knows, for the login path to verify against when no
 * account matches.
 *
 * Without it, "no such user" returns in under a millisecond while "wrong password" takes
 * ten, and the login endpoint becomes an email-enumeration oracle no matter how carefully
 * the error messages are worded.
 *
 * Derived from ARGON rather than pasted in as a literal, so it cannot silently stop
 * matching the real cost when those parameters are tuned — a hardcoded decoy carrying
 * stale parameters would verify at a different speed and quietly reopen the leak.
 * Computed once, on first use.
 */
export function decoyPasswordHash(): Promise<string> {
  decoy ??= hashPassword(generateToken());
  return decoy;
}
