import { Router } from "express";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { handler, parse } from "../../lib/http.js";
import { clearSessionCookie, readSessionCookie, setSessionCookie } from "./cookies.js";
import { actorOf, requireAuth } from "./middleware.js";
import { findUserById, loginWithPassword, registerWithPassword } from "./password.js";
import { loginSchema, registerSchema } from "./schemas.js";
import { revokeAllSessions, revokeSession, type SessionContext } from "./session.js";

/**
 * Auth endpoints.
 *
 * The session token is returned only as an httpOnly cookie and never in a response body,
 * so no client can be tempted to keep a copy somewhere a script can read it.
 */
export function authRoutes(): Router {
  const router = Router();

  const contextOf = (req: {
    ip?: string;
    get: (h: string) => string | undefined;
  }): SessionContext => ({ ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null });

  router.post(
    "/register",
    handler(async (req, res) => {
      const input = parse(registerSchema, req.body);
      const { user, session } = await registerWithPassword(input, contextOf(req));
      setSessionCookie(res, session.token, session.expiresAt);
      return { user };
    }, 201),
  );

  router.post(
    "/login",
    handler(async (req, res) => {
      const input = parse(loginSchema, req.body);
      const { user, session } = await loginWithPassword(input, contextOf(req));
      setSessionCookie(res, session.token, session.expiresAt);
      return { user };
    }),
  );

  router.post(
    "/logout",
    handler(async (req, res) => {
      const token = readSessionCookie(req);
      if (token) await revokeSession(token);
      clearSessionCookie(res);
      // Deliberately not an error when there was no session — signing out twice, or
      // from a stale tab, should look the same as signing out once.
      return { signedOut: true };
    }),
  );

  router.post(
    "/logout-everywhere",
    requireAuth,
    handler(async (req, res) => {
      const actor = actorOf(req);
      const count = await revokeAllSessions(actor.userId);
      clearSessionCookie(res);
      await recordAudit({
        actor,
        action: "session.revoked.all",
        resourceType: "user",
        resourceId: actor.userId,
        metadata: { sessions: count },
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      return { signedOut: true, sessions: count };
    }),
  );

  router.get(
    "/me",
    requireAuth,
    handler(async (req) => {
      const actor = actorOf(req);
      const user = await findUserById(actor.userId);
      // The session resolved against a joined user row, so this cannot normally miss.
      if (!user) throw new ApiError("not_found", "Account not found.");
      return { user, impersonated: Boolean(actor.impersonatorId) };
    }),
  );

  return router;
}
