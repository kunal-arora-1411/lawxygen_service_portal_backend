# Lawxygen — API

Read this before touching anything. It is the project's working memory: what exists,
what was decided and why, and the mistakes already made so they are not made twice.

Companion documents, both in the **portal** repo (`../lawxygen_service_portal/docs/`):

- `delivery-plan.md` — the agreed plan, milestones M0–M5, locked decisions
- `backlog.md` — **the task list.** 25 numbered items, priority-ordered, kept current

---

## What this is

An Indian legal / CA / CS services marketplace. Three repos:

| Repo                              | Deploys to        | What it is                                                                                                                            |
| --------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `LAWXYGEN_AGAIN_NEW_UI`           | `lawxygen.in`     | Static marketing site, 259 service pages. **Not being migrated.** Its only pending change is that its CTAs should point at the portal |
| `lawxygen_service_portal`         | `app.lawxygen.in` | Next.js 16 App Router portal — client, professional and admin surfaces                                                                |
| `lawxygen_service_portal_backend` | `api.lawxygen.in` | This repo. Express 5 + Drizzle + PostgreSQL                                                                                           |

**The funnel.** Client reads a service page → clicks through → logs in → pays → a
qualified professional is assigned **automatically within seconds** → both sides track
the matter to completion. Nobody at Lawxygen touches it.

---

## Where it is now

M0–M4 are substantially built, WhatsApp is code-complete, and **263 tests pass**. A real Razorpay test-mode payment
has been taken end to end: order `LX-001654`, invoice `LX/2026-27/001191`, ledger
balanced to zero, assigned automatically to a professional.

Built and working: auth (password, Google OAuth, mobile OTP, password reset), catalogue,
checkout, payments with a double-entry ledger, GST invoicing, automatic assignment,
payouts, refunds, daily reconciliation, professional onboarding, transactional email,
and WhatsApp — templates authored and submitted to Meta from here, outbound sends off
the outbox, inbound webhooks, threads, and a chat on both dashboards.

**The biggest gaps** (see `backlog.md` for all 25):

- No email provider configured, so nothing sends outside local
- No WhatsApp credentials, so nothing sends there either — and **local values must be
  blank, not placeholders** (see mistake 16)
- Invoices are issued but never shown to the client — no page, no PDF
- No file upload anywhere: documents cannot pass between client and professional
- Money settings (commission, GST, TDS) are constants in code, not configuration
- Impersonation is half-built: the policy blocklist exists, no route sets it
- No staging. Production is PM2 on a VPS behind nginx (`docs/deployment.md`), not yet
  run end to end on the server

**Blocked on someone else:** Razorpay production account, RazorpayX for payouts, DLT
registration for SMS, two CA determinations (below), real prices, professional
recruitment.

---

## Locked decisions

| Decision   | Choice                                        | Why                                                                                                                                                                                             |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database   | **PostgreSQL + Drizzle** (Neon in production) | Reversed from an initial MongoDB pick. Webhook idempotency, `FOR UPDATE SKIP LOCKED`, gapless invoice numbers and ledger CHECK constraints are one-liners here and hand-built conventions there |
| Sessions   | **Server-side, not JWT**                      | Suspending an account takes effect on the next request; "sign out everywhere" is a `DELETE`                                                                                                     |
| TypeScript | **Pinned at 6.0.3**                           | `typescript-eslint` refuses TS 7, and it provides `no-floating-promises`. On a codebase doing webhooks and payment capture, an unawaited promise is a money bug                                 |
| Payouts    | Collect 100%, pay out in batches              | Razorpay Route needs ₹40L+ turnover proof. The ledger records the professional's share as a liability at capture, so switching later needs no migration                                         |
| Realtime   | Polling (~15s)                                | Meets "within seconds" with no connection state                                                                                                                                                 |
| WhatsApp   | **Phase 2**                                   | Seams are built: outbox, plus E.164 phone and messaging consent captured at registration                                                                                                        |

---

## Rules that are not negotiable

- **Money is integer paise.** Never floating point. Currency stored explicitly beside
  every amount. Rates are basis points.
- **Parts must sum exactly to the whole.** `lib/money.ts` uses residuals, not rounding,
  so GST + commission + professional net + TDS is precisely the gross.
- **The webhook is the source of truth** for payment success, never the browser.
  `/payments/:ref/confirm` exists only to _trigger an authoritative check_, not to be
  believed.
- **Authorization is re-checked server-side in every handler** via `authorize()`. Route
  guards and hidden UI are conveniences, never the boundary.
- **Never test `error.code`.** Drizzle wraps driver errors; SQLSTATE lives on
  `error.cause`. Use `pgErrorCode()` / `isUniqueViolation()` from `lib/db-errors.ts`.
- **State changes emit domain events through the outbox, in the same transaction.**
  Notifications, WhatsApp and analytics all attach as subscribers. Handlers must be
  idempotent — a partial failure re-runs every subscriber for that event.
- **Every list endpoint is cursor-paginated** from the first one written.
- **One response envelope:** `{ ok: true, data }` or
  `{ ok: false, code, message, fieldErrors? }`. The portal switches on `code`, never on
  message text.
- **Privileged actions are audit-logged** — who, what, when, before and after.
  Append-only.
- **`lib/load-env.ts` must be the first import** in any entry point.

---

## Mistakes already made — do not repeat these

Each of these cost real debugging time. Most are also commented at the site of the fix.

1. **Capacity breach via EvalPlanQual.** `SELECT … FOR UPDATE SKIP LOCKED` with a
   `count(*)` subquery over _another table_ in the WHERE does **not** do what it looks
   like. Under READ COMMITTED, EPQ re-checks only the locked row; a subquery against a
   different table still reads the original snapshot. A professional capped at 2 took 3.
   **Fix: lock first, then re-count in a separate statement while holding the lock.**
   See `modules/assignment/engine.ts`.

2. **Ledger attribution reversal.** Generalising the attribution helper, I toggled
   _which line_ carried `subjectId`. It read as symmetric and was not — reversing
   credited the professional instead of debiting them, doubling what they appeared to be
   owed. **The subject always sits on the same line; only directions swap.** See
   `modules/assignment/attribution.ts`.

3. **`sql<number>` bypasses Drizzle's bigint mapping.** A price arrived as the string
   `"249900"` while the type said `number`. Select the real column.

4. **Conditional render is not a privacy boundary.** A server component's props are
   serialised into the HTML, so hiding contact details behind a condition still ships
   them to the browser. (Portal-side, but the same class of mistake.)

5. **Committing with failing tests.** Twice — because I chained `grep` after the test
   command and grep succeeded. **Gate on the actual exit code:**
   `if npm run verify > /tmp/v.log 2>&1; then … fi`

6. **Test pollution, three separate rounds.** Suites share one database and write global
   state (`update professionals set available = false`). The worst version: the _dev
   server_ shared a database with the test suite and its outbox dispatcher ate test
   events. Fixed by `scripts/prepare-test-db.ts` giving tests their own database. Still
   a live hazard — pick a service slug no other suite uses.

7. **Postgres 18 refuses `/var/lib/postgresql/data`.** Mount `/var/lib/postgresql`.

8. **A literal NUL byte in a source file** made git treat it as binary. The cursor
   separator in `lib/pagination.ts` is `|` for this reason.

9. **Drizzle expands a JS array to a tuple**, but `ANY` needs an array. Use `inArray`.

10. **The logger redacts `*.code`**, which hid the OTP that the local stub exists to
    print. The key is deliberately named `otpCodeForLocalDev`.

11. **`pino-http` has no default export** under ESM/nodenext. Use the named import.

12. **Dev and test databases migrate separately.** The test harness migrates itself; the
    dev database does not. Reconciliation 500'd until `npm run db:migrate` was run by
    hand. **After pulling, run it.**

13. **Config read straight off the parsed `env`.** Three separate times. `env` is
    frozen at import, so a test setting `process.env` in `beforeEach` changes nothing.
    Anything a test needs to vary belongs in a config holder with a `setXxx()` seam —
    see `modules/whatsapp/client.ts`.

14. **A signature-verifying webhook must mount before `express.json()`.** The signature
    covers the exact bytes the provider sent; once the body is parsed and re-serialised
    it can never match. The WhatsApp webhook first landed after the JSON parser and
    would have rejected every real delivery.

15. **Non-empty placeholder credentials make an adapter think it is configured.** Fake
    values in `.env.local` had the WhatsApp adapter genuinely call Meta and fail. That
    is correct behaviour — attempt or refuse, never silently no-op — so **local config
    must be blank, not fake.**

16. **`pkill -f "tsx watch"` does not kill the Windows process holding the port.** A
    stale server answered health checks with old code for several minutes. Use
    `Get-NetTCPConnection -LocalPort N` and `Stop-Process` from PowerShell.

17. **pino buffers when stdout is a redirected file.** Twice I tried to read the local
    mail stub's output from a dev-server log and got nothing. Read the `notifications`
    table instead, or call the module directly.

---

## Layout

```
src/
  modules/
    auth/          sessions, password, OTP, Google, password reset
    catalogue/     sellable services and pricing
    professionals/ onboarding, verification, availability, matters
    orders/        state machine
    payments/      Razorpay, webhooks, capture, refunds, ledger, reconciliation
    payouts/       batch runs, TDS withholding
    assignment/    claim engine, escalation, ledger attribution
    notifications/ templates, delivery, outbox subscribers
    admin/         queues, read models, overrides
    events/        outbox and subscriber registry
  db/              schema, migrations, seed
  lib/             env, api contract, money, crypto, field encryption, mailer
  jobs/            outbox dispatcher, escalation, queue drain, reconcile, notify-retry
```

**Every external adapter follows one pattern** — a live implementation over `fetch`, a
`setXxx()` test seam, and a refusal when unconfigured. See
`modules/payments/razorpay.ts`, `modules/payouts/transfer.ts`, `lib/mailer.ts`,
`modules/auth/sms.ts`. A deployed environment must never silently no-op something that
moves money or sends a message; locally it may log instead.

---

## Domain facts worth knowing

- **Service slugs are not globally unique.** 259 services produce 237 distinct slugs; 22
  appear in two categories each. The unique constraint is `(category_id, slug)` and every
  deep link carries both. A filing and a consultation about it are genuinely different
  products with different prices.
- **Invoice numbers are gapless per Indian financial year** (April–March, IST), allocated
  from a counter _row_ inside the capture transaction. Not a sequence — `nextval` does
  not roll back.
- **GST is 18% inclusive**: the displayed price already contains it.
- **TDS is currently 0.1% under §194-O.** Unverified — see below.
- Five directories under the marketing site contain a literal `u2013`. They are generator
  orphans, already 301'd, and the seed must never produce them.

---

## WhatsApp

Lawxygen talks to Meta's Cloud API directly. **PingMe is not in the loop at all** — not
its service, not its console, not its account. It was built for a client; only its code
was reusable, and `src/lib/whatsapp/graph.ts` and `classify.ts` are ports of it.

Four rules of Meta's shape the whole feature:

1. **A template does not open the reply window.** Only a message _from the client_ does.
   Until they write, every outreach must be another approved template.
2. **The window is 24 hours** from the client's last message. Outside it, free text is
   refused — locally, with a message saying to send a template, rather than by Meta.
3. **Meta sets the template category from the wording**, not from what we ask for.
   Utility is about ₹0.12 a message, marketing about ₹0.86, and the decision lasts the
   life of the template. Whatever Meta returns is what gets stored.
4. **A rejected template name cannot be reused.** `POST /admin/whatsapp/templates/check`
   validates without submitting, so a name is never spent finding out.

Conversations key on `(phoneNumberId, contactPhone)` — the number _and_ the contact.
That is what makes the planned pool of five or six numbers a no-migration change, and
it stops two professionals sharing one client's thread once a number is allocated per
matter.

`whatsapp_send_attempts` is the same idea as the payment capture path: reserve on an
idempotency key, claim with an owner token, send, settle. `delivery_unknown` means the
request left and Meta never answered, so it is never retried automatically.

## The two tax questions — unresolved, and already asserted on issued invoices

Both need a practising CA. The engineering survives either answer, but invoices have
already gone out stating a position.

1. **§194-O (0.1%, e-commerce operator) versus §194J (10%, professional fees).** A
   hundredfold difference in what is withheld. Payouts record which section and rate
   applied _per payout_, so history is safe, but the rate is a constant in
   `lib/money.ts` today. Backlog item 7 makes it configuration.
2. **GST: principal or agent?** We invoice the client for the full amount, which is the
   principal treatment. The ledger shape supports both; **the invoice renderer is not
   portable between them**, which is why backlog item 3 is blocked.

---

## Running it

```bash
docker compose up -d          # PostgreSQL 18 on port 5433, not 5432
npm install
npm run db:migrate            # dev database — the test one migrates itself
npm run db:seed               # 10 categories, 259 services, all inactive until priced
npm run dev                   # API on :4000
npm run verify                # typecheck, lint, format, test — the gate before committing
npm run smoke:razorpay        # proves the live gateway adapters against the real test API
```

`.env.local` is gitignored and **does not travel between devices.** Copy `.env.example`
and fill in:

- `DATABASE_URL` — `postgres://lawxygen:lawxygen_local_only@localhost:5433/lawxygen`
- `SESSION_SECRET` — any long string locally. Also keys the OTP HMAC
- `FIELD_ENCRYPTION_KEY` — `openssl rand -base64 32`. Encrypts PAN and bank details.
  **Changing it makes existing encrypted rows unreadable**
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — test-mode keys from the Razorpay dashboard
- `RAZORPAY_WEBHOOK_SECRET` — any string locally. Razorpay cannot reach localhost, so no
  webhook ever arrives; locally `/payments/:ref/confirm` and reconciliation carry the
  load. **Set the real one wherever webhooks can actually arrive.**
- `MAIL_PROVIDER_KEY` / `MAIL_FROM` — unset means local logs the message and any other
  environment refuses to send

There is **no committed demo-data script.** The `client@` / `admin@` / `pro@lawxygen.test`
accounts referenced in earlier sessions were created ad hoc and will not exist on a fresh
database. Register through the API, then
`update users set role = 'admin' where email = …`.

## Deploying

**No Docker in production.** The repo is cloned onto the VPS at `/opt/lawxygen/api`,
built there, and run by PM2 from `ecosystem.config.cjs`; the database is Neon.
`bash deploy/deploy.sh` is the whole deploy. `docs/deployment.md` has the rest. Two things
in the PM2 config are load-bearing:

- **`instances: 1`, fork mode.** The jobs run in-process and reconciliation takes no
  lock (backlog item 18). A second instance runs it twice.
- **`HOST: "127.0.0.1"`.** Without it the API listens on every interface, and ufw is off
  on that shared host.

---

## Testing

Integration tests hit a real PostgreSQL — they assert on partial unique indexes, cascade
behaviour and SQLSTATE codes, none of which a fake reproduces. `npm test` prepares a
separate test database first.

Write the concurrency tests _before_ the features they cover. They are the ones that lose
money silently: webhook idempotency, ledger balance after any sequence of operations,
assignment under simultaneous payments, invoice numbering with no gaps, session
revocation taking effect on the next request.

**Known flake:** roughly 1 run in 15, an "outbox event errored" assertion fires. Not
reproduced in dozens of runs since. Hypothesis is a deadlock between concurrent
assignment transactions, which the outbox would retry in production. The assertion now
prints the stored error so the next occurrence diagnoses itself. Do not close it until it
has been seen and explained.
