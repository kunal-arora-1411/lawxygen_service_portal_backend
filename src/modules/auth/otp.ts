import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { otpChallenges, users } from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { digestsMatch, generateNumericCode, hashToken } from "../../lib/crypto.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import type { AuthenticatedUser } from "./password.js";
import { issueSession, type IssuedSession, type SessionContext } from "./session.js";
import { sendOtpSms } from "./sms.js";

/**
 * Mobile OTP sign-in.
 *
 * A six-digit code is 20 bits. Everything here exists to make sure an attacker only ever
 * gets a handful of guesses at it:
 *
 *   - the code is stored as a keyed digest, so a database leak does not yield the code
 *     (a bare SHA-256 of six digits is reversible by hashing all million candidates);
 *   - attempts are counted by the database, incremented in the same statement that reads
 *     the challenge, so parallel guesses cannot share one budget;
 *   - consumption is a conditional UPDATE, so a code works exactly once even if two
 *     requests present it simultaneously;
 *   - a new code cannot be requested faster than the resend window, which otherwise lets
 *     an attacker mint fresh attempt budgets indefinitely.
 */

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_WINDOW_MS = 60 * 1000;
const MAX_PER_HOUR = 5;

const INVALID_CODE = "That code is not valid. Request a new one.";

export type OtpRequestResult = { challengeId: string; expiresAt: Date; resendAfter: Date };

export async function requestOtp(
  phone: string,
  context: SessionContext = {},
): Promise<OtpRequestResult> {
  const now = new Date();

  const [recent] = await db
    .select({ createdAt: otpChallenges.createdAt, count: sql<number>`count(*) over ()` })
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phone, phone),
        gt(otpChallenges.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
      ),
    )
    .orderBy(sql`${otpChallenges.createdAt} desc`)
    .limit(1);

  if (recent) {
    if (now.getTime() - recent.createdAt.getTime() < RESEND_WINDOW_MS) {
      throw new ApiError("rate_limited", "A code was just sent. Wait a minute before retrying.");
    }
    if (Number(recent.count) >= MAX_PER_HOUR) {
      throw new ApiError("rate_limited", "Too many codes requested. Try again in an hour.");
    }
  }

  const code = generateNumericCode(6);
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);

  const [challenge] = await db
    .insert(otpChallenges)
    .values({ phone, codeHash: hashToken(code), expiresAt, ip: context.ip ?? null })
    .returning({ id: otpChallenges.id });

  if (!challenge) throw new ApiError("internal", "Could not start sign-in.");

  // Sent after the row exists: a code delivered with nothing to verify it against is
  // worse than a send that failed, because the user acts on it and nothing works.
  await sendOtpSms(phone, code);

  return {
    challengeId: challenge.id,
    expiresAt,
    resendAfter: new Date(now.getTime() + RESEND_WINDOW_MS),
  };
}

export async function verifyOtp(
  challengeId: string,
  code: string,
  context: SessionContext = {},
): Promise<{ user: AuthenticatedUser; session: IssuedSession; created: boolean }> {
  // Read and spend an attempt in one statement. Reading first and incrementing after
  // would let N parallel requests each see the same attempt count and get N guesses for
  // the price of one.
  const [claimed] = await db
    .update(otpChallenges)
    .set({ attempts: sql`${otpChallenges.attempts} + 1` })
    .where(
      and(
        eq(otpChallenges.id, challengeId),
        eq(otpChallenges.consumed, false),
        gt(otpChallenges.expiresAt, new Date()),
        sql`${otpChallenges.attempts} < ${MAX_ATTEMPTS}`,
      ),
    )
    .returning({ phone: otpChallenges.phone, codeHash: otpChallenges.codeHash });

  // Unknown id, already used, expired, or out of attempts — all one message, so probing
  // cannot distinguish them.
  if (!claimed) throw new ApiError("unauthenticated", INVALID_CODE);

  if (!digestsMatch(claimed.codeHash, hashToken(code))) {
    throw new ApiError("unauthenticated", INVALID_CODE);
  }

  // Conditional consume. If a concurrent request consumed it a moment ago this matches
  // nothing, and the code is correctly refused the second time.
  const [consumed] = await db
    .update(otpChallenges)
    .set({ consumed: true })
    .where(and(eq(otpChallenges.id, challengeId), eq(otpChallenges.consumed, false)))
    .returning({ id: otpChallenges.id });

  if (!consumed) throw new ApiError("unauthenticated", INVALID_CODE);

  const { user, created } = await findOrCreateByPhone(claimed.phone);

  if (user.status !== "active") {
    throw new ApiError("forbidden", "This account is not active. Contact support.");
  }

  const session = await issueSession(user.id, context);

  await recordAudit({
    actor: { userId: user.id, role: user.role },
    action: created ? "user.registered" : "auth.login",
    resourceType: "user",
    resourceId: user.id,
    metadata: { method: "otp" },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return {
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role },
    created,
    session,
  };
}

type FoundUser = AuthenticatedUser & { status: "active" | "suspended" | "deleted" };

/**
 * An OTP sign-in for an unknown number creates the account. The row has a verified phone
 * and nothing else — no name, no email, and WhatsApp consent left false, because consent
 * has to be given rather than assumed. The portal collects the rest on first sign-in.
 */
async function findOrCreateByPhone(phone: string): Promise<{ user: FoundUser; created: boolean }> {
  const existing = await selectByPhone(phone);
  if (existing) {
    if (!existing.phoneVerified) {
      await db.update(users).set({ phoneVerified: new Date() }).where(eq(users.id, existing.id));
    }
    return { user: existing, created: false };
  }

  try {
    const [inserted] = await db
      .insert(users)
      .values({ phone, phoneVerified: new Date() })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        role: users.role,
        status: users.status,
        phoneVerified: users.phoneVerified,
      });
    if (!inserted) throw new ApiError("internal", "Could not create the account.");
    return { user: inserted, created: true };
  } catch (error) {
    // Two first-time sign-ins for the same number can race here. The unique index is
    // what decides; the loser re-reads the winner's row rather than failing.
    if (isUniqueViolation(error, "users_phone_uq")) {
      const raced = await selectByPhone(phone);
      if (raced) return { user: raced, created: false };
    }
    throw error;
  }
}

async function selectByPhone(
  phone: string,
): Promise<(FoundUser & { phoneVerified: Date | null }) | undefined> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: users.role,
      status: users.status,
      phoneVerified: users.phoneVerified,
    })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);
  return row;
}
