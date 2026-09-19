import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { oauthAccounts, users } from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { generateToken } from "../../lib/crypto.js";
import { isUniqueViolation } from "../../lib/db-errors.js";
import { env, required } from "../../lib/env.js";
import type { AuthenticatedUser } from "./password.js";
import { issueSession, type IssuedSession, type SessionContext } from "./session.js";

/**
 * Google sign-in, authorization-code flow with PKCE.
 *
 * Google is used to establish identity at sign-in and nothing else. No tokens are kept:
 * we never call an API on the user's behalf, so a stored refresh token would be a breach
 * liability with no corresponding capability.
 *
 * The profile is read from the userinfo endpoint rather than by decoding the ID token.
 * Both are equally trustworthy here because the code exchange happens server-to-server
 * over TLS, and reading JSON avoids hand-rolling JWT signature verification — which is a
 * classic place to get `alg: none` or a missing audience check wrong.
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const OAUTH_STATE_COOKIE = "lawxygen_oauth";
const STATE_TTL_MS = 10 * 60 * 1000;

export type GoogleProfile = {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
};

/** Exchanges an authorization code for a profile. Replaced in tests. */
export type GoogleExchange = (code: string, verifier: string) => Promise<GoogleProfile>;

function redirectUri(): string {
  return `${env.API_ORIGIN}/auth/google/callback`;
}

const liveExchange: GoogleExchange = async (code, verifier) => {
  const body = new URLSearchParams({
    code,
    client_id: required("GOOGLE_CLIENT_ID"),
    client_secret: required("GOOGLE_CLIENT_SECRET"),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
    code_verifier: verifier,
  });

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenRes.ok) {
    throw new ApiError("upstream_failure", "Could not complete Google sign-in.");
  }

  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) {
    throw new ApiError("upstream_failure", "Could not complete Google sign-in.");
  }

  const infoRes = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) {
    throw new ApiError("upstream_failure", "Could not read your Google profile.");
  }

  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!info.sub) throw new ApiError("upstream_failure", "Google did not identify the account.");

  return {
    sub: info.sub,
    email: info.email,
    emailVerified: info.email_verified,
    name: info.name,
    picture: info.picture,
  };
};

let exchange: GoogleExchange = liveExchange;

/** Test seam. Pass undefined to restore the real exchange. */
export function setGoogleExchange(override: GoogleExchange | undefined): void {
  exchange = override ?? liveExchange;
}

export type StartedFlow = { authorizeUrl: string; state: string; verifier: string };

/**
 * Builds the redirect to Google.
 *
 * PKCE is used even though this is a confidential client with a secret: it costs one
 * hash and removes the value of an intercepted authorization code entirely.
 */
export function startGoogleFlow(): StartedFlow {
  // A missing client id is a deployment that never configured Google, not a fault in
  // this request. Saying so beats a stack trace and a 500 that looks like an outage.
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ApiError("upstream_failure", "Google sign-in is not available right now.");
  }

  const state = generateToken(16);
  const verifier = generateToken(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const params = new URLSearchParams({
    client_id: required("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Ask for no refresh token: we do not act on the user's behalf after sign-in.
    access_type: "online",
    prompt: "select_account",
  });

  return { authorizeUrl: `${AUTHORIZE_URL}?${params.toString()}`, state, verifier };
}

export type StateCookie = { state: string; verifier: string; issuedAt: number };

export function encodeState(flow: StartedFlow): string {
  const payload: StateCookie = {
    state: flow.state,
    verifier: flow.verifier,
    issuedAt: Date.now(),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * The cookie is httpOnly and same-site, so its contents cannot be read or forged by a
 * page. The CSRF defence is the comparison against the `state` Google echoes back: a
 * callback that did not originate from this browser's own start request has no matching
 * cookie and is refused.
 */
export function decodeState(raw: string | undefined): StateCookie {
  if (!raw) throw new ApiError("invalid_input", "That sign-in link has expired. Try again.");

  let parsed: StateCookie;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as StateCookie;
  } catch {
    throw new ApiError("invalid_input", "That sign-in link is not valid. Try again.");
  }

  if (!parsed.state || !parsed.verifier || typeof parsed.issuedAt !== "number") {
    throw new ApiError("invalid_input", "That sign-in link is not valid. Try again.");
  }
  if (Date.now() - parsed.issuedAt > STATE_TTL_MS) {
    throw new ApiError("invalid_input", "That sign-in link has expired. Try again.");
  }

  return parsed;
}

export async function completeGoogleFlow(
  code: string,
  returnedState: string,
  cookie: StateCookie,
  context: SessionContext = {},
): Promise<{ user: AuthenticatedUser; session: IssuedSession; created: boolean }> {
  if (returnedState !== cookie.state) {
    throw new ApiError("invalid_input", "That sign-in could not be verified. Try again.");
  }

  const profile = await exchange(code, cookie.verifier);
  const { user, created } = await linkOrCreate(profile);

  if (user.status !== "active") {
    throw new ApiError("forbidden", "This account is not active. Contact support.");
  }

  const session = await issueSession(user.id, context);

  await recordAudit({
    actor: { userId: user.id, role: user.role },
    action: created ? "user.registered" : "auth.login",
    resourceType: "user",
    resourceId: user.id,
    metadata: { method: "google" },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return {
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role },
    session,
    created,
  };
}

type FoundUser = AuthenticatedUser & { status: "active" | "suspended" | "deleted" };

const SELECTION = {
  id: users.id,
  name: users.name,
  email: users.email,
  phone: users.phone,
  role: users.role,
  status: users.status,
};

async function linkOrCreate(
  profile: GoogleProfile,
): Promise<{ user: FoundUser; created: boolean }> {
  // Matched on the provider's immutable subject, never on email — a Google account can
  // change its email address, and the subject is what actually identifies it.
  const [linked] = await db
    .select(SELECTION)
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(
      and(eq(oauthAccounts.provider, "google"), eq(oauthAccounts.providerAccountId, profile.sub)),
    )
    .limit(1);

  if (linked) return { user: linked, created: false };

  /**
   * Deliberately NOT auto-linking to an existing account with the same email.
   *
   * Carried forward from the marketing repo's decision to disable Auth.js's
   * `allowDangerousEmailAccountLinking`. Linking on email means whoever controls an
   * address at the identity provider inherits the existing account, and the blast radius
   * here is a client's legal documents and payment history. The user signs in the way
   * they signed up, or links the accounts deliberately from their profile later.
   */
  if (profile.email) {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${profile.email.toLowerCase()}`)
      .limit(1);

    if (existing) {
      throw new ApiError(
        "conflict",
        "An account already exists with this email. Sign in with your password instead.",
      );
    }
  }

  const emailToStore = profile.emailVerified ? profile.email : undefined;

  try {
    const [created] = await db
      .insert(users)
      .values({
        name: profile.name ?? null,
        // Only a verified address is recorded. An unverified one from any provider is a
        // claim, not a fact, and it is the thing every future lookup would trust.
        email: emailToStore ?? null,
        emailVerified: emailToStore ? new Date() : null,
        image: profile.picture ?? null,
      })
      .returning(SELECTION);

    if (!created) throw new ApiError("internal", "Could not create the account.");

    await db
      .insert(oauthAccounts)
      .values({ userId: created.id, provider: "google", providerAccountId: profile.sub });

    return { user: created, created: true };
  } catch (error) {
    // Two simultaneous first sign-ins for the same Google account: the composite primary
    // key on (provider, provider_account_id) decides, and the loser reads the winner's row.
    if (isUniqueViolation(error)) {
      const [raced] = await db
        .select(SELECTION)
        .from(oauthAccounts)
        .innerJoin(users, eq(users.id, oauthAccounts.userId))
        .where(
          and(
            eq(oauthAccounts.provider, "google"),
            eq(oauthAccounts.providerAccountId, profile.sub),
          ),
        )
        .limit(1);
      if (raced) return { user: raced, created: false };
    }
    throw error;
  }
}
