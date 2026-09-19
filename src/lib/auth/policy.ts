import { ApiError } from "../api.js";
import type { Role } from "../../db/schema/index.js";

/**
 * Access policy — pure rules, no session machinery.
 *
 * Deliberately free of any dependency on the database or the HTTP layer, so it can be
 * unit tested directly and reasoned about without a running system. The session-bound
 * helpers that resolve the current actor live in `./actor.ts`.
 *
 * Ported from the marketing repo's `lib/auth/policy.ts`. The route-prefix helpers
 * (`PROTECTED_PREFIXES`, `requiredRoleForPath`, `homeForRole`) were deliberately left
 * behind: they describe the portal's URL structure, and an API has no business knowing
 * where its client puts its pages. They belong in the portal repo.
 */

export type Actor = {
  userId: string;
  role: Role;
  /** Present only when role === "professional". */
  professionalId?: string;
  /** Set when an admin is impersonating. Every write records both identities. */
  impersonatorId?: string | null;
};

const ROLE_RANK: Record<Role, number> = {
  client: 0,
  professional: 1,
  admin: 2,
  superadmin: 3,
};

/**
 * Actions refused while an admin is impersonating someone, without exception.
 *
 * The restriction is on the *mode*, not the rank — a superadmin acting as someone else is
 * still refused. Support needs to see what a user sees; it never needs to move their money
 * while wearing their face.
 */
const FORBIDDEN_WHILE_IMPERSONATING = new Set([
  "payout.release",
  "payout.hold",
  "refund.approve",
  // Repairs a missed capture, which issues an invoice and assigns a professional.
  "reconciliation.run",
  "invoice.reissue",
  "user.role.change",
  "user.delete",
]);

export class Unauthenticated extends ApiError {
  constructor() {
    super("unauthenticated", "Please sign in to continue.");
  }
}

export class Forbidden extends ApiError {
  constructor(message = "You do not have access to this.") {
    super("forbidden", message);
  }
}

export function hasAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** True when this actor may act on a resource owned by `ownerUserId`. */
export function ownsOrAdmin(actor: Actor, ownerUserId: string): boolean {
  return actor.userId === ownerUserId || hasAtLeast(actor.role, "admin");
}

/**
 * Asserts an actor may perform a named action. `action` is the same dotted verb written to
 * the audit log, so what is checked and what is recorded cannot drift apart.
 *
 * Call this inside the handler, on every mutation. Route guards and hidden UI are
 * conveniences; this is the boundary.
 */
export function authorize(
  actor: Actor,
  action: string,
  options?: { minimumRole?: Role; ownerUserId?: string },
): void {
  if (actor.impersonatorId && FORBIDDEN_WHILE_IMPERSONATING.has(action)) {
    throw new Forbidden(
      `"${action}" cannot be performed while impersonating another user. Act as yourself.`,
    );
  }

  if (options?.minimumRole && !hasAtLeast(actor.role, options.minimumRole)) {
    throw new Forbidden();
  }

  if (options?.ownerUserId && !ownsOrAdmin(actor, options.ownerUserId)) {
    throw new Forbidden();
  }
}
