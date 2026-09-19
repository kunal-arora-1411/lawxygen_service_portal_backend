import { describe, expect, it } from "vitest";
import {
  decoyPasswordHash,
  digestsMatch,
  generateNumericCode,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "./crypto.js";

describe("generateToken", () => {
  it("is URL-safe, so it survives a cookie and a query string unescaped", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateToken()));
    expect(seen.size).toBe(1000);
  });
});

describe("generateNumericCode", () => {
  it("is always the requested length, including when it starts with zeros", () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateNumericCode(6)).toMatch(/^\d{6}$/);
    }
  });

  /**
   * The implementation uses rejection sampling rather than `random % 1_000_000`, which
   * would over-represent low values. A biased OTP is a smaller keyspace than it looks.
   */
  it("reaches both ends of the range", () => {
    const codes = Array.from({ length: 5000 }, () => Number(generateNumericCode(6)));
    expect(Math.min(...codes)).toBeLessThan(100_000);
    expect(Math.max(...codes)).toBeGreaterThan(900_000);
  });
});

describe("hashToken", () => {
  it("is deterministic for the same input", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("differs for different inputs", () => {
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });

  it("never returns the input", () => {
    expect(hashToken("abc")).not.toContain("abc");
  });
});

describe("digestsMatch", () => {
  it("accepts identical digests", () => {
    const digest = hashToken("same");
    expect(digestsMatch(digest, digest)).toBe(true);
  });

  it("rejects different digests", () => {
    expect(digestsMatch(hashToken("a"), hashToken("b"))).toBe(false);
  });

  it("rejects mismatched lengths instead of throwing", () => {
    expect(digestsMatch("abcd", hashToken("a"))).toBe(false);
  });

  it("rejects empty input", () => {
    expect(digestsMatch("", "")).toBe(false);
  });
});

describe("password hashing", () => {
  it("round-trips a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "Correct horse battery staple")).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);
    expect(a).not.toBe(b);
  });

  /**
   * The login path verifies against a dummy hash when no account matches, to keep the
   * timing identical. If a malformed hash threw instead of returning false, that path
   * would turn into a 500 and re-expose the enumeration it exists to prevent.
   */
  it("returns false rather than throwing on a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
    expect(await verifyPassword("", "anything")).toBe(false);
  });
});

describe("decoyPasswordHash", () => {
  /**
   * The point of the decoy is that verifying against it costs the same as verifying
   * against a real hash. A malformed decoy would still return false — the login would
   * look correct — while failing to parse in microseconds and reopening the timing leak
   * it exists to close. So assert it is genuinely well-formed and genuinely verifiable.
   */
  it("is a well-formed argon2id hash carrying the real parameters", async () => {
    expect(await decoyPasswordHash()).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("verifies as a real hash would — false, but only after doing the work", async () => {
    expect(await verifyPassword(await decoyPasswordHash(), "any guess at all")).toBe(false);
  });

  it("is computed once and reused", async () => {
    expect(await decoyPasswordHash()).toBe(await decoyPasswordHash());
  });
});
