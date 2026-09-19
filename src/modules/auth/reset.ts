import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { passwordResetTokens, sessions, users } from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { generateToken, hashPassword, hashToken } from "../../lib/crypto.js";
import { env } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";
import { sendEmail } from "../../lib/mailer.js";

/**
 * Forgotten passwords.
 *
 * `password_reset_tokens` was ported in M0 and nothing ever used it, so until now a
 * client who forgot their password was locked out permanently — there was no route, no
 * email, and no way back in short of somebody running SQL.
 *
 * Three rules shape this file.
 *
 * **Requesting a reset never says whether the address exists.** The response is
 * identical either way. An endpoint that answers "no such account" is an account
 * enumeration oracle, and for a platform whose users are named professionals that is
 * worth more to an attacker than it sounds.
 *
 * **The token is stored hashed.** What goes in the email is the only copy; the database
 * holds SHA-256 of it. A leaked database therefore does not hand over live reset links.
 *
 * **Using a reset signs out everywhere.** The commonest real reason for a reset is that
 * somebody else has the old password. Leaving their sessions alive would make the reset
 * theatre.
 */

const TOKEN_TTL_MS = 60 * 60 * 1000; // one hour
const RESEND_WINDOW_MS = 60 * 1000;
const MAX_PER_HOUR = 5;

/**
 * Starts a reset.
 *
 * Always resolves. The work — and the email — only happen for an address that exists,
 * but the caller cannot tell the difference from the outside.
 */
export async function requestPasswordReset(
  email: string,
  context: { ip?: string | null } = {},
): Promise<void> {
  const normalised = email.trim().toLowerCase();

  // The same lower(email) expression the partial unique index uses, so this matches
  // whatever registration matched.
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email, status: users.status })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalised}`)
    .limit(1);

  if (!user || user.status !== "active" || !user.email) {
    // Logged, not returned. Somebody probing addresses should leave a trace even
    // though they learn nothing.
    logger.info({ ip: context.ip ?? null }, "password reset requested for unknown address");
    return;
  }

  const now = new Date();
  const [recent] = await db
    .select({ createdAt: passwordResetTokens.createdAt, count: sql<number>`count(*) over ()` })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.userId, user.id),
        gt(passwordResetTokens.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
      ),
    )
    .orderBy(sql`${passwordResetTokens.createdAt} desc`)
    .limit(1);

  /**
   * Throttled silently. Telling a requester they are rate limited would restore the
   * enumeration oracle the blank response exists to close — only a real account can be
   * throttled, so the error message would itself confirm one.
   */
  if (recent) {
    if (now.getTime() - recent.createdAt.getTime() < RESEND_WINDOW_MS) return;
    if (Number(recent.count) >= MAX_PER_HOUR) {
      logger.warn({ userId: user.id }, "password reset throttled");
      return;
    }
  }

  const token = generateToken(32);
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const link = `${env.PORTAL_ORIGIN}/reset?token=${token}`;
  const heading = "Set a new password";
  const lines = [
    `${user.name ? `${user.name}, s` : "S"}omebody asked to reset the password on your Lawxygen account.`,
    "This link works once and expires in an hour.",
    "If it was not you, nothing has changed and you can ignore this. Your password only changes when the link is used.",
  ];

  await sendEmail({
    to: user.email,
    subject: "Reset your Lawxygen password",
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a2233">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fb;padding:28px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:30px 32px"><tr><td>
<div style="font-weight:700;font-size:17px;color:#1c5dd8;margin-bottom:22px">Lawxygen</div>
<h1 style="font-size:19px;margin:0 0 14px;font-weight:620">${heading}</h1>
${lines.map((l) => `<p style="font-size:14.5px;line-height:1.6;margin:0 0 13px;color:#404a5c">${l}</p>`).join("")}
<p style="margin:22px 0 4px"><a href="${link}" style="display:inline-block;background:#1c5dd8;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14.5px;font-weight:560">Set a new password</a></p>
</td></tr></table></td></tr></table></body></html>`,
    text: [heading, "", ...lines, "", link, "", "— Lawxygen"].join("\n"),
    /**
     * Per token, not per user. Two genuine requests an hour apart are two different
     * links and both have to arrive; keying on the user would suppress the second.
     */
    idempotencyKey: hashToken(token),
  });

  logger.info({ userId: user.id }, "password reset email sent");
}

/**
 * Completes a reset.
 *
 * Every failure returns the same message. Distinguishing "no such token" from "expired"
 * from "already used" would tell somebody holding a stale link which part to attack.
 */
export async function completePasswordReset(
  token: string,
  newPassword: string,
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ userId: string }> {
  const invalid = new ApiError("invalid_input", "That reset link is no longer valid.");
  const tokenHash = hashToken(token);

  const [row] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
      status: users.status,
    })
    .from(passwordResetTokens)
    .innerJoin(users, eq(users.id, passwordResetTokens.userId))
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row || row.usedAt || row.expiresAt <= new Date() || row.status !== "active") throw invalid;

  const passwordHash = await hashPassword(newPassword);

  const revoked = await db.transaction(async (tx) => {
    /**
     * Claimed by the same condition that validated it. Two tabs submitting the same
     * link race otherwise, and the loser would set a password the user never saw.
     */
    const [claimed] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)))
      .returning({ id: passwordResetTokens.id });

    if (!claimed) throw invalid;

    await tx.update(users).set({ passwordHash }).where(eq(users.id, row.userId));

    /**
     * Every other outstanding link for this user dies too. Someone who requested three
     * resets should not leave two live links behind after using one.
     */
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, row.userId), isNull(passwordResetTokens.usedAt)));

    // The whole point: whoever had the old password is signed out.
    const gone = await tx
      .delete(sessions)
      .where(eq(sessions.userId, row.userId))
      // Keyed on the token hash, not an id — sessions have no surrogate key.
      .returning({ tokenHash: sessions.tokenHash });

    await recordAudit(
      {
        actor: { userId: row.userId, role: "client" },
        action: "user.password.reset",
        resourceType: "user",
        resourceId: row.userId,
        metadata: {
          ip: context.ip ?? null,
          userAgent: context.userAgent ?? null,
          sessionsRevoked: gone.length,
        },
      },
      tx,
    );

    return gone.length;
  });

  logger.info({ userId: row.userId, sessionsRevoked: revoked }, "password reset completed");
  return { userId: row.userId };
}
