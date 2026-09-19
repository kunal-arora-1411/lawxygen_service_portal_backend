import { Router } from "express";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { handler, parse } from "../../lib/http.js";
import { env } from "../../lib/env.js";
import {
  clearSessionCookie,
  readNamedCookie,
  readSessionCookie,
  setSessionCookie,
} from "./cookies.js";
import { actorOf, requireAuth } from "./middleware.js";
import {
  completeGoogleFlow,
  decodeState,
  encodeState,
  OAUTH_STATE_COOKIE,
  startGoogleFlow,
} from "./google.js";
import { requestOtp, verifyOtp } from "./otp.js";
import { completePasswordReset, requestPasswordReset } from "./reset.js";
import { findUserById, loginWithPassword, registerWithPassword } from "./password.js";
import {
  forgotPasswordSchema,
  loginSchema,
  otpRequestSchema,
  otpVerifySchema,
  registerSchema,
  resetPasswordSchema,
} from "./schemas.js";
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

  /**
   * Forgotten passwords.
   *
   * Both of these answer identically whatever the outcome. "No such account" and
   * "you are rate limited" each confirm an address exists, and for a platform whose
   * users are named professionals that is worth having.
   */
  router.post(
    "/password/forgot",
    handler(async (req) => {
      const { email } = parse(forgotPasswordSchema, req.body);
      await requestPasswordReset(email, contextOf(req));
      return { requested: true };
    }),
  );

  /**
   * Completing a reset signs the user out everywhere, including here — the commonest
   * real reason for a reset is that somebody else knows the old password. They log in
   * again afterwards with the new one.
   */
  router.post(
    "/password/reset",
    handler(async (req, res) => {
      const { token, password } = parse(resetPasswordSchema, req.body);
      await completePasswordReset(token, password, contextOf(req));
      clearSessionCookie(res);
      return { reset: true };
    }),
  );

  /**
   * Requesting a code never says whether the number is known. Registration and sign-in
   * are the same call, so the response cannot be used to enumerate customers.
   */
  router.post(
    "/otp/request",
    handler(async (req) => {
      const { phone } = parse(otpRequestSchema, req.body);
      const { challengeId, expiresAt, resendAfter } = await requestOtp(phone, contextOf(req));
      return { challengeId, expiresAt, resendAfter };
    }),
  );

  router.post(
    "/otp/verify",
    handler(async (req, res) => {
      const { challengeId, code } = parse(otpVerifySchema, req.body);
      const { user, session, created } = await verifyOtp(challengeId, code, contextOf(req));
      setSessionCookie(res, session.token, session.expiresAt);
      // `created` tells the portal to collect a name, email and messaging consent.
      return { user, created };
    }),
  );

  /**
   * These two are browser redirects, not JSON calls, so they are the only endpoints that
   * do not use the response envelope — a browser following a redirect cannot read one.
   * Failures land back on the portal with an `error` query parameter.
   */
  router.get("/google/start", (_req, res, next) => {
    let flow;
    try {
      flow = startGoogleFlow();
    } catch (error) {
      if (error instanceof ApiError) {
        res.redirect(`${env.PORTAL_ORIGIN}/login?error=google_unavailable`);
        return;
      }
      next(error);
      return;
    }
    res.cookie(OAUTH_STATE_COOKIE, encodeState(flow), {
      httpOnly: true,
      secure: env.APP_ENV !== "local",
      sameSite: "lax",
      path: "/auth/google",
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(flow.authorizeUrl);
  });

  router.get("/google/callback", (req, res, next) => {
    void (async () => {
      const clearState = () => res.clearCookie(OAUTH_STATE_COOKIE, { path: "/auth/google" });
      try {
        // Google reports a refusal here (e.g. the user pressed cancel) rather than by
        // failing the request, so it has to be handled before anything else.
        if (typeof req.query.error === "string") {
          clearState();
          res.redirect(`${env.PORTAL_ORIGIN}/login?error=google_denied`);
          return;
        }

        const code = typeof req.query.code === "string" ? req.query.code : "";
        const state = typeof req.query.state === "string" ? req.query.state : "";
        const cookie = decodeState(readNamedCookie(req, OAUTH_STATE_COOKIE));

        const { session, created } = await completeGoogleFlow(code, state, cookie, contextOf(req));

        clearState();
        setSessionCookie(res, session.token, session.expiresAt);
        // `created` sends a brand-new account to profile completion, where it supplies a
        // phone number and decides about messaging consent.
        res.redirect(created ? `${env.PORTAL_ORIGIN}/welcome` : `${env.PORTAL_ORIGIN}/dashboard`);
      } catch (error) {
        clearState();
        if (error instanceof ApiError) {
          const reason = error.code === "conflict" ? "email_in_use" : "google_failed";
          res.redirect(`${env.PORTAL_ORIGIN}/login?error=${reason}`);
          return;
        }
        next(error);
      }
    })();
  });

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
