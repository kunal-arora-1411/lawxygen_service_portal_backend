import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { decoyPasswordHash, hashPassword, verifyPassword } from "../../lib/crypto.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import { issueSession, type IssuedSession, type SessionContext } from "./session.js";
import type { LoginInput, RegisterInput } from "./schemas.js";

/** Email and password sign-in. */

const INVALID_CREDENTIALS = "That email and password do not match.";

export type AuthenticatedUser = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: (typeof users.$inferSelect)["role"];
};

export async function registerWithPassword(
  input: RegisterInput,
  context: SessionContext = {},
): Promise<{ user: AuthenticatedUser; session: IssuedSession }> {
  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  let created;
  try {
    [created] = await db
      .insert(users)
      .values({
        name: input.name,
        email: input.email,
        phone: input.phone,
        passwordHash,
        whatsappConsent: input.whatsappConsent,
        whatsappConsentAt: input.whatsappConsent ? now : null,
        whatsappConsentSource: input.whatsappConsent ? "registration" : null,
      })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        role: users.role,
      });
  } catch (error) {
    // Which index was violated decides the message, which is why isUniqueViolation
    // takes a constraint name. "Email taken" and "phone taken" are different problems
    // with different fixes.
    if (isUniqueViolation(error, "users_email_lower_uq")) {
      throw new ApiError("conflict", "An account already exists with that email.", {
        cause: error,
        fieldErrors: { email: ["An account already exists with that email."] },
      });
    }
    if (isUniqueViolation(error, "users_phone_uq")) {
      throw new ApiError("conflict", "An account already exists with that phone number.", {
        cause: error,
        fieldErrors: { phone: ["An account already exists with that phone number."] },
      });
    }
    throw error;
  }

  if (!created) throw new ApiError("internal", "Could not create the account.");

  const session = await issueSession(created.id, context);

  await recordAudit({
    actor: { userId: created.id, role: created.role },
    action: "user.registered",
    resourceType: "user",
    resourceId: created.id,
    metadata: { method: "password", whatsappConsent: input.whatsappConsent },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return { user: created, session };
}

export async function loginWithPassword(
  input: LoginInput,
  context: SessionContext = {},
): Promise<{ user: AuthenticatedUser; session: IssuedSession }> {
  // Matched through the same lower(email) expression the unique index uses, so a
  // capitalised address resolves to the row that index considers a duplicate.
  const [found] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: users.role,
      status: users.status,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${input.email}`)
    .limit(1);

  // Verifying against a decoy when there is no account — or when the account exists but
  // only signs in with Google — keeps the response time identical in every case. See
  // decoyPasswordHash() for why this matters.
  const matches = await verifyPassword(
    found?.passwordHash ?? (await decoyPasswordHash()),
    input.password,
  );

  // One message for "no such account", "wrong password" and "this account only uses
  // Google", so none of them can be told apart from outside.
  if (!found || !found.passwordHash || !matches) {
    throw new ApiError("unauthenticated", INVALID_CREDENTIALS);
  }

  if (found.status !== "active") {
    await recordAudit({
      actor: { userId: found.id, role: found.role },
      action: "auth.login.blocked",
      resourceType: "user",
      resourceId: found.id,
      metadata: { reason: found.status },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    throw new ApiError("forbidden", "This account is not active. Contact support.");
  }

  const session = await issueSession(found.id, context);

  await recordAudit({
    actor: { userId: found.id, role: found.role },
    action: "auth.login",
    resourceType: "user",
    resourceId: found.id,
    metadata: { method: "password" },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return {
    user: {
      id: found.id,
      name: found.name,
      email: found.email,
      phone: found.phone,
      role: found.role,
    },
    session,
  };
}

/** Used by the "sign out everywhere" path and by admin suspension. */
export async function findUserById(id: string): Promise<AuthenticatedUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
}
