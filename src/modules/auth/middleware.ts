import type { Request, RequestHandler } from "express";
import { Forbidden, Unauthenticated, hasAtLeast, type Actor } from "../../lib/auth/policy.js";
import type { Role } from "../../db/schema/index.js";
import { readSessionCookie } from "./cookies.js";
import { resolveSession } from "./session.js";

/**
 * Resolving the current actor.
 *
 * `attachActor` runs on every request and is permissive: no cookie, an unknown token or
 * a suspended account all simply leave `req.actor` undefined. Rejecting is the job of
 * `requireAuth` / `requireRole` on the routes that need it, and of `authorize()` inside
 * the handler — which remains the actual boundary. A guard here is a convenience that
 * produces a clean 401 instead of a confusing failure deeper in.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

export const attachActor: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const token = readSessionCookie(req);
      if (token) {
        const resolved = await resolveSession(token);
        if (resolved) req.actor = resolved.actor;
      }
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/** The actor, or a thrown `unauthenticated`. Use inside handlers that require a user. */
export function actorOf(req: Request): Actor {
  if (!req.actor) throw new Unauthenticated();
  return req.actor;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.actor ? undefined : new Unauthenticated());
};

/** Rejects below `minimum`. The handler still calls `authorize()` for the specific action. */
export function requireRole(minimum: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor) return next(new Unauthenticated());
    if (!hasAtLeast(req.actor.role, minimum)) return next(new Forbidden());
    next();
  };
}
