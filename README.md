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

## Catalogue and orders

| Method | Path                                  | Notes                                                       |
| ------ | ------------------------------------- | ----------------------------------------------------------- |
| GET    | `/catalogue/categories`               | All ten, in marketing order, with sellable counts. Public.  |
| GET    | `/catalogue/services`                 | `?category=&q=&featured=&cursor=&limit=`. Public.           |
| GET    | `/catalogue/services/:category/:slug` | Public.                                                     |
| POST   | `/orders`                             | `{ category, service }`. Creates a `payment_pending` order. |
| GET    | `/orders`                             | The caller's own orders, newest first.                      |
| GET    | `/orders/:reference`                  | e.g. `LX-000142`.                                           |

**The catalogue stores pricing, not content.** The 259 pages on lawxygen.in keep the
organic search value and are not migrated. `npm run db:seed` imports the sellable
catalogue from `../LAWXYGEN_AGAIN_NEW_UI/data/serviceCatalog.ts`, reusing that repo's
`serviceSlug()` so the two agree. It is idempotent, and it never overwrites price,
turnaround, `active` or `featured` — those belong to admin.

**Services are keyed on `(category, slug)`, never slug alone.** 259 services produce
only 237 distinct slugs: 22 appear in two categories at once, always a done-for-you
filing that also exists as a `talk-*` consultation. `gst-audit-support` is both. They are
different products at different prices, distinguished by `fulfilment_type`, and a unique
index on slug alone would reject 44 rows.

**Seeded rows start inactive**, and the `services_priced_when_active` CHECK means a
service cannot be published without a price and a turnaround. A forgotten price is a
database error rather than a checkout showing ₹0.

**An order snapshots what was sold.** Title, price, currency and turnaround are copied
onto the order, not referenced. Repricing the catalogue tomorrow must not change what a
client agreed to pay today, because the invoice and the ledger both key off it.

**Asking for someone else's order returns `not_found`, not `forbidden`.** References are
sequential, so a 403 would confirm the reference exists and let anyone count the
platform's orders by walking upwards from `LX-000001`.

## Payments

| Method | Path                           | Notes                                                                      |
| ------ | ------------------------------ | -------------------------------------------------------------------------- |
| POST   | `/payments/:reference/intent`  | Creates the gateway order. Amount comes from the order, never the request. |
| GET    | `/payments/:reference/invoice` | The GST invoice, once captured.                                            |
| POST   | `/webhooks/razorpay`           | Gateway only. No session; signature-verified.                              |

**The webhook is the source of truth**, never the browser redirect. A redirect is a
claim made by the client's browser; a signed webhook is a statement by Razorpay. A
client who closes the tab after paying still ends up with a paid order.

**The webhook route reads a raw body.** It is mounted ahead of `express.json()` in
`app.ts` because the HMAC is computed over the exact bytes Razorpay signed — JSON
re-serialised after parsing differs in key order and spacing and would never match.

**Dedupe is on _processed_, not on _received_.** The obvious version inserts the event
id, treats a duplicate-key error as "already seen", and returns 200 — which silently
drops every retry of an event whose first attempt _failed_. The order stays unpaid while
the gateway dashboard shows successful delivery. So an event is recorded on arrival with
`processed_at` null, and only a row that already has a `processed_at` is a true
duplicate.

**Capture has two independent locks.** The order status transition is a conditional
`UPDATE` — only an order still awaiting payment can become paid — and `ledger_entries`
is unique on `(kind, source_ref)`. Either alone would do; both means a bypass of one
still cannot journal a capture twice.

**The captured amount is checked against the order.** If the gateway reports a figure
that differs from what the client agreed to, the transaction aborts and the event is
retried rather than journalling an amount nobody authorised.

### The ledger

Double-entry, with balance enforced by a **deferred constraint trigger** (migration
`0003`), checked at COMMIT rather than per statement — the lines of one entry are
inserted separately and are legitimately unbalanced in between. An application-level
check would be bypassed by any script that writes lines directly; a constraint is not.

A ₹5,000 order posts:

```
debit   ASSET:GATEWAY_RECEIVABLE   500000
credit  LIABILITY:GST_OUTPUT        76271
credit  INCOME:COMMISSION          127119
credit  LIABILITY:PRO_PAYABLE      296313
credit  LIABILITY:TDS_PAYABLE         297
```

Account codes are text, not an enum, because the GST determination below changes the
mapping and that should not be a migration.

`deriveAmounts` in `src/lib/money.ts` guarantees **the parts sum exactly to the gross**:
each split takes its last component as the residual rather than rounding it separately,
so the total cannot drift by a paisa. Tested across every rupee to ₹2,000 and every
plausible rate combination.

**Invoice numbers come from the `counters` table, allocated inside the capture
transaction.** Indian GST requires the series to be gapless within a financial year, and
a PostgreSQL sequence does not roll back — `nextval` would burn a number every time a
capture aborted. The financial year boundary is evaluated in **IST**: 20:30 UTC on 31
March is already the new year, and a server reasoning in UTC would leave a gap.

### Two open questions for a CA

Both change the invoice, not the ledger shape, and both are configuration today.

1. **Which withholding section applies.** §194-O (e-commerce operator, 0.1% of gross)
   most likely displaces §194J (professional fees, 10%) for a marketplace collecting on
   behalf of professionals — a hundredfold difference. `tdsSection` and `tdsBps` are
   settings, and every payout will record which was applied.
2. **Principal or agent for GST.** Whether Lawxygen invoices the client for the whole
   amount with the professional invoicing Lawxygen, or the professional supplies the
   client and Lawxygen charges only commission. The default here is principal.

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

**Never select a column through `sql<T>`.** It is an unchecked assertion that also
bypasses Drizzle's column mapping, so a `bigint` selected as `sql<number>` arrives as
the string `"249900"` while the type says `number`. Select the column; narrow in code.
Same failure shape as the one above, and it cost a debugging session here already.

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
