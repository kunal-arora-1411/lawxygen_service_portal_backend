import type { CookieOptions, Request, Response } from "express";
import { env } from "../../lib/env.js";

/**
 * The session cookie.
 *
 * `httpOnly` so a cross-site scripting bug cannot read the session. `secure` everywhere
 * but local, because a cookie sent over plain HTTP is a cookie handed to anyone on the
 * network.
 *
 * `sameSite: "lax"` is correct here despite the portal and the API being different
 * origins: `app.lawxygen.in` and `api.lawxygen.in` share a registrable domain, so
 * requests between them are same-site, and locally `localhost:3000` → `localhost:4000`
 * is same-site too because ports are not part of the definition. `none` would be needed
 * only if the portal moved to a different domain entirely, and would then require
 * `secure` and a CSRF defence that `lax` gives for free.
 *
 * COOKIE_DOMAIN is set in staging and production (`.lawxygen.in`) so the cookie is
 * visible to both subdomains, and left unset locally so it stays host-only.
 */

export const SESSION_COOKIE = "lawxygen_session";

function options(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env.APP_ENV !== "local",
    sameSite: "lax",
    path: "/",
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, options(expiresAt));
}

/** Clearing must use the same attributes it was set with, or the browser keeps it. */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, options());
}

/**
 * cookie-parser types `req.cookies` as `any`, so reading it directly defeats the
 * type-aware lint rules everywhere it is touched. Narrowed once, here.
 */
export function readNamedCookie(req: Request, name: string): string | undefined {
  const jar: unknown = req.cookies;
  if (typeof jar !== "object" || jar === null) return undefined;
  const value = (jar as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readSessionCookie(req: Request): string | undefined {
  return readNamedCookie(req, SESSION_COOKIE);
}
