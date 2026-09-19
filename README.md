# lawxygen_service_portal_backend

API for the Lawxygen service portal (`api.lawxygen.in`). Express + Drizzle over PostgreSQL.

The portal at `app.lawxygen.in` is the only browser client. It holds no database
connection — every read and write goes through this API, which is what keeps
authorization in one place.

Delivery plan: `lawxygen_service_portal/docs/delivery-plan.md`.

## Getting started

Needs Docker running, for the local PostgreSQL.

```bash
npm install
cp .env.example .env.local     # the defaults match docker-compose.yml
docker compose up -d           # PostgreSQL 18 on port 5433
npm run db:migrate
npm run dev
```

The server refuses to start without a reachable database — a configuration error should
fail the boot, not turn into a stream of 500s.

```bash
curl http://localhost:4000/health        # liveness, no database
curl http://localhost:4000/health/ready  # readiness, checks the database
```

Port 5433 rather than 5432 so the container cannot collide with a PostgreSQL already
installed on the host and quietly serve the tests the wrong database.

## Commands

| Command                | Does                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `npm run dev`          | Watch mode via tsx                                          |
| `npm run verify`       | typecheck → lint → format:check → test. Run before pushing. |
| `npm run build`        | Emits `dist/`; `npm start` runs it                          |
| `npm run db:generate`  | Diffs the schema and writes a migration. Needs no database. |
| `npm run db:migrate`   | Applies pending migrations. Needs `DATABASE_URL`.           |
| `docker compose up -d` | Local PostgreSQL. `down -v` resets it completely.           |

Entry points must import `./lib/load-env.js` **first**. `env.ts` validates on import, so
anything loaded before it sees an empty environment and throws.

## Auth endpoints

| Method | Path                      | Notes                                                    |
| ------ | ------------------------- | -------------------------------------------------------- |
| POST   | `/auth/register`          | Email + password. Captures phone and WhatsApp consent.   |
| POST   | `/auth/login`             | Email + password.                                        |
| POST   | `/auth/otp/request`       | Sends a code. Same response whether the number is known. |
| POST   | `/auth/otp/verify`        | Signs in, creating the account if the number is new.     |
| GET    | `/auth/google/start`      | Redirects to Google (PKCE).                              |
| GET    | `/auth/google/callback`   | Redirects back to the portal.                            |
| POST   | `/auth/logout`            | Ends this session. Never an error.                       |
| POST   | `/auth/logout-everywhere` | Ends all of the user's sessions.                         |
| GET    | `/auth/me`                | The signed-in user.                                      |

The session token is only ever an httpOnly cookie — it is never in a response body.

The two Google routes are browser redirects and so are the only endpoints that do not
use the response envelope; a browser following a redirect cannot read one. Failures come
back as `PORTAL_ORIGIN/login?error=...` with `google_denied`, `google_failed`,
`email_in_use` or `google_unavailable`.

**Google never auto-links to an existing account with the same email.** Whoever controls
an address at the identity provider would otherwise inherit an account holding legal
documents and payment history. Carried over from the marketing repo's decision to disable
Auth.js's `allowDangerousEmailAccountLinking`.

Without an SMS provider configured, local development logs the OTP instead of sending it,
under `otpCodeForLocalDev` (the logger redacts `*.code`, so the stub uses a different key
on purpose). Any environment other than local refuses to send rather than logging it —
an OTP in a production log is an account handed to whoever can read logs.

## Conventions

These are load-bearing, and most of them exist because something expensive happened once.

**Every response uses one envelope** — `{ ok: true, data }` or
`{ ok: false, code, message, fieldErrors? }`, where `code` is a closed union. HTTP status
is derived from `code` in exactly one place (`src/lib/http.ts`); handlers never pick a
status. Clients switch on `code`, never on message text.

**Every list endpoint is cursor-paginated** from the first one written. Retrofitting
pagination onto a client that assumed a bare array means editing every call site.

**Authorization is re-checked inside every handler**, via `authorize()` in
`src/lib/auth/policy.ts`. Route guards and hidden UI are conveniences, never the boundary.

**Never read `error.code` on a query failure.** Drizzle wraps driver errors, so the
SQLSTATE lives on `error.cause`. Use `pgErrorCode()`, `isUniqueViolation()` and
`isExclusionViolation()` from `src/lib/db-errors.ts`. A naive `error.code === "23505"`
compiles, reads correctly, and silently never matches.

**Money is integer paise.** Never floating point, and always with its currency.

**Sessions live in the database, not in a JWT.** Suspending an account takes effect on the
next request and "sign out everywhere" is a `DELETE`. A JWT role cannot be revoked before
it expires, which is unacceptable on a platform where an admin suspending a professional
needs to stop work landing on them now.

**Tokens are stored hashed** — sessions, password resets, email verification, OTP codes.
The plaintext never touches the database.

**TypeScript is pinned to 6.0.3, deliberately.** `typescript-eslint` does not support
TS 7, and it supplies `no-floating-promises` / `no-misused-promises`. On a codebase doing
webhooks and payment capture, an unawaited promise is a money bug; a faster typecheck is
not worth it. Revisit when typescript-eslint ships TS 7 support.

## Database

Neon. A URL whose host contains `-pooler.` is detected automatically and prepared
statements are disabled for it, because the pooled endpoint is PgBouncer in transaction
mode and prepared statements break there intermittently under load.

Connecting is lazy so tooling and unit tests need no credentials; `assertDatabaseReachable()`
at boot is what makes the server itself fail fast.

Integration tests in `test/integration/` skip themselves when `DATABASE_URL` is absent.
Point them at a branch, never a shared database.
