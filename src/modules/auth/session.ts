import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sessions, users } from "../../db/schema/index.js";
import { generateToken, hashToken } from "../../lib/crypto.js";
import type { Actor } from "../../lib/auth/policy.js";

/**
 * Server-side sessions.
 *
 * The session row is the source of truth for identity, role and account status, read on
 * every request. That is the whole reason this is not a JWT: a token's claims are frozen
 * at issue, so suspending an account or demoting a professional would not take effect
 * until it expired. Here, suspension takes effect on the next request and "sign out
 * everywhere" is a DELETE.
 *
 * The cost is one indexed lookup per request, joined to the user row. That join is not
 * an optimisation target — it is the mechanism.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Refresh `lastSeenAt` at most this often, to avoid a write on every single request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type IssuedSession = { token: string; expiresAt: Date };

export type SessionContext = {
  ip?: string | null;
  userAgent?: string | null;
  /** Set only when an admin is opening a session as someone else. */
  impersonatorId?: string | null;
};

/**
 * Creates a session and returns the plaintext token, which is the only time it exists.
 * The database stores a keyed digest — a leaked `sessions` table cannot be replayed.
 */
export async function issueSession(
  userId: string,
  context: SessionContext = {},
  ttlMs = THIRTY_DAYS_MS,
): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);

  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt,
    impersonatorId: context.impersonatorId ?? null,
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
  });

  return { token, expiresAt };
}

export type ResolvedSession = {
  actor: Actor;
  userId: string;
  expiresAt: Date;
};

/**
 * Resolves a token to an actor, or null.
 *
 * Returns null — rather than throwing — for every rejection reason: unknown token,
 * expired row, suspended or deleted account. The caller decides whether absence of an
 * actor is an error, because some endpoints are legitimately optional-auth.
 *
 * Expiry is filtered in SQL rather than compared in JavaScript so that a clock
 * disagreement between app and database cannot extend a session.
 */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const tokenHash = hashToken(token);

  const [row] = await db
    .select({
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      impersonatorId: sessions.impersonatorId,
      role: users.role,
      status: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;

  // A suspended or deleted account keeps its session row but stops being an actor. The
  // row is left in place so that reinstating an account does not also sign them out.
  if (row.status !== "active") return null;

  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash));
  }

  return {
    actor: {
      userId: row.userId,
      role: row.role,
      impersonatorId: row.impersonatorId,
    },
    userId: row.userId,
    expiresAt: row.expiresAt,
  };
}

/** Ends one session. Idempotent — signing out twice is not an error. */
export async function revokeSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Ends every session for a user. This is "sign out everywhere" and account suspension. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ tokenHash: sessions.tokenHash });
  return removed.length;
}

/**
 * Deletes expired rows. Expiry is already enforced on read, so this is housekeeping
 * rather than a security control — it keeps the table and its indexes from growing
 * without bound.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ tokenHash: sessions.tokenHash });
  return removed.length;
}
