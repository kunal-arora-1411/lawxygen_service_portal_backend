# Deployment

How Lawxygen gets to `app.lawxygen.in` and `api.lawxygen.in`, what is already done, and
what is waiting on somebody.

| Piece                                   | Where                             | State                                |
| --------------------------------------- | --------------------------------- | ------------------------------------ |
| Portal (`lawxygen_service_portal`)      | Vercel, project `lawxygen-portal` | **Deployed**, on a `.vercel.app` URL |
| API (`lawxygen_service_portal_backend`) | Ubuntu VPS `210.79.129.180`       | Deploying                            |
| Database                                | Neon                              | **Not created yet**                  |
| DNS                                     | GoDaddy                           | **Records not created yet**          |

---

## Architecture

```
            browser
               │
      ┌────────┴────────┐
      │                 │
app.lawxygen.in    api.lawxygen.in
   (Vercel,           (VPS: nginx :443
    region bom1)       → Docker :4000)
                            │
                            └── Neon PostgreSQL (TLS)
```

The portal holds no database connection. Every read and write goes through the API, and
the session is an httpOnly cookie scoped to `.lawxygen.in` so both hosts see it.

**Both names share a registrable domain on purpose.** That makes requests between them
same-site, which is why `sameSite: "lax"` on the session cookie works and no CSRF
exception is needed. Moving the portal to a different domain would force `SameSite=None`
and a CSRF defence that `lax` currently gives for free.

---

## What you need to do

### 1. DNS — two records at GoDaddy

Neither name exists yet. Both are new records on `lawxygen.in`; the existing apex `A`
record for the marketing site is untouched.

| Type    | Name  | Value                  | TTL |
| ------- | ----- | ---------------------- | --- |
| `A`     | `api` | `210.79.129.180`       | 600 |
| `CNAME` | `app` | `cname.vercel-dns.com` | 600 |

Check them before going further — a certificate request against DNS that has not
propagated burns a Let's Encrypt rate limit:

```bash
dig +short api.lawxygen.in     # expect 210.79.129.180
dig +short app.lawxygen.in     # expect a cname.vercel-dns.com chain
```

Once `app` resolves, tell me and I will attach the domain to the Vercel project. It
cannot be attached before then: Vercel verifies control via DNS, and the apex
`lawxygen.in` sits in a **different Vercel account** from the portal, so there is no
ownership shortcut.

### 2. The API host is shared

`210.79.129.180` is an Ubuntu 24.04 box (2 vCPU, 3.8GB RAM, ~7.5GB disk free) that is
**already serving hostelmanage.com** — nginx with two live sites, plus a Docker API and
Redis container. Lawxygen is a second tenant on it, and the deployment is shaped around
not disturbing the first:

- `bootstrap.sh` **stages ufw rules but does not enable ufw.** It is currently inactive,
  and switching a firewall on underneath a working service is how an unrelated site goes
  dark. Enable deliberately with `ENABLE_UFW=1 sudo -E bash deploy/bootstrap.sh`.
- The stock `sites-enabled/default` is only removed if it really is the stock file.
- `deploy.sh` prunes images **filtered by label**, so it never collects another
  project's dangling layers.
- Docker, Compose, nginx and certbot were already installed, so most of `bootstrap.sh`
  is a no-op here. It stays idempotent for the next host.

Disk is the thing to watch: 68% used, with roughly 6GB of Docker build cache belonging
to the other project. `docker builder prune` would reclaim it, but that cache is not ours.

### 3. Neon

Create a project with a **production** branch and a **staging** branch. Take the pooled
connection string for production — the API opens many short-lived queries — and keep
`?sslmode=require`.

### 4. Turn off Vercel Deployment Protection

New Vercel projects are protected by default, so every request currently redirects to a
Vercel SSO login. Fine for a preview URL, wrong for a public portal.

Project → Settings → Deployment Protection → Vercel Authentication → **Disabled**.

Until this is off, `app.lawxygen.in` shows a Vercel login wall to the public.

---

## Deploying the API

Once the host answers, from your machine:

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@210.79.129.180
```

**Once, to prepare the box:**

```bash
git clone <repo> /opt/lawxygen/api
cd /opt/lawxygen/api
sudo bash deploy/bootstrap.sh
```

That installs Docker, nginx, certbot and ufw, opens 22/80/443, installs the nginx site
and removes the default one. It does not request a certificate — that comes next, by
hand, so a DNS mistake fails visibly.

**Then, once `api.lawxygen.in` resolves to the box:**

```bash
sudo certbot --nginx -d api.lawxygen.in --agree-tos -m you@lawxygen.in --no-eff-email
```

certbot rewrites `/etc/nginx/sites-available/api.lawxygen.in` in place, adding the TLS
block and the `:80 → :443` redirect, and registers automatic renewal. This is why the
committed nginx config is plain HTTP: a hand-written TLS block is one certbot cannot
manage, and renewal then stops working silently.

**Then configure and deploy:**

```bash
cd /opt/lawxygen/api
cp .env.production.example .env.production
chmod 600 .env.production
# generate the two secrets on the box and paste them in:
openssl rand -base64 48    # SESSION_SECRET
openssl rand -base64 32    # FIELD_ENCRYPTION_KEY
nano .env.production

bash deploy/deploy.sh
```

`deploy.sh` pulls, builds, **migrates, then restarts**, then waits for `/health` and
checks `/health/ready` separately. Every step gates the next, so a failed migration
leaves the previous version serving rather than a half-updated system running.

### Back up `FIELD_ENCRYPTION_KEY` somewhere that is not the server

It encrypts PAN and bank details at rest. **Changing or losing it makes every existing
encrypted row permanently unreadable** — there is no rotation path built yet (backlog
item 20). Set it once, store it in a password manager, and do not touch it again.

---

## After the API is up

- **Razorpay webhook** → `https://api.lawxygen.in/webhooks/razorpay`, and put the secret
  it gives you in `RAZORPAY_WEBHOOK_SECRET`. This matters more here than locally: the
  gateway cannot reach a laptop, so local relies on `/payments/:ref/confirm` and
  reconciliation. In production **the webhook is the source of truth** for payment
  success, and a wrong secret rejects every real notification.
- **Google OAuth** → add `https://api.lawxygen.in/auth/google/callback` to the authorised
  redirect URIs, or sign-in fails at the callback.
- **Meta webhook** → `https://api.lawxygen.in/webhooks/whatsapp`, verify token is
  `WHATSAPP_APP_SECRET`. Leave all four WhatsApp values blank until the number is
  connected — a non-empty placeholder makes the adapter call Meta for real.
- **Email** — `MAIL_PROVIDER_KEY` and `MAIL_FROM` are a launch blocker, not a nicety.
  Blank in production means the API _refuses to send_ rather than dropping receipts
  silently, so no client gets a receipt and no professional gets an assignment notice.
- **Seed the catalogue and make yourself an admin.** There is no committed demo-data
  script, so a fresh database has no accounts:

  ```bash
  docker compose -f docker-compose.prod.yml --profile tools run --rm migrate npm run db:seed
  # register through the portal, then:
  #   update users set role = 'admin' where email = '…';
  ```

---

## Why the pieces are shaped the way they are

**Two build targets, one Dockerfile.** `drizzle-kit` is a devDependency, so
`npm install drizzle-kit` inside a `--omit=dev` image is a silent no-op — the first
build of this hit exactly that and produced an image whose migration step could not run.
Migrations therefore run from a `migrate` target built off the build stage, which already
has the full dependency tree. The runtime image carries no build tooling and is 375MB
against the migrate image's 735MB.

**The migrate service sits behind a compose profile.** `docker compose up -d` must never
apply schema changes as a side effect of a restart. `deploy.sh` invokes it explicitly.

**The API binds to `127.0.0.1:4000`, not `0.0.0.0`.** nginx terminates TLS and proxies to
it; the API is never directly reachable. A bare `4000:4000` in compose would publish it
to the internet _and_ punch through ufw while doing it, because Docker writes its own
iptables rules ahead of ufw's.

**nginx must not touch request bodies.** Razorpay and Meta both sign the exact bytes they
send and the app verifies against a raw `Buffer`. nginx passes bodies through unaltered;
the rule is to keep it that way and never add a request-rewriting module to that location.

**Vercel functions run in `bom1` (Mumbai).** The portal's pages are `force-dynamic`
server components that call the API on every render. With functions in the default
`iad1`, each render would cross the Atlantic and back to reach an India-hosted API.

**Git auto-deploy is disconnected.** `vercel link` connected the GitHub repository
automatically, and that repository's default branch is `master` — which holds the _old
Vite prototype_, not this app. A push to `master` would have replaced the portal with it.
To re-enable safely, first make `main` the default branch on GitHub (or set Production
Branch to `main` in project settings), then `vercel git connect`.

---

## What is verified and what is not

**Verified** on a real Docker daemon against a real PostgreSQL:

- Both images build.
- The migrate image contains `drizzle-kit` and applied all 10 migrations successfully.
- The runtime image boots with `NODE_ENV=production`, runs as the unprivileged `node`
  user, connects to the database, and answers `/health` and `/health/ready`.
- `/catalogue/categories` returns real data in the correct envelope.
- CORS returns `Access-Control-Allow-Origin: https://app.lawxygen.in` with credentials.
- The Vercel production build succeeds, renders the portal, and has
  `https://api.lawxygen.in` inlined — no `localhost` leaked into the bundle.

**Not verified**, because the host is unreachable:

- `bootstrap.sh` and `deploy.sh` have never been run end to end.
- The nginx config has never been loaded by nginx.
- certbot has never issued this certificate.
- No deployment has been made against Neon.

Treat the first run of `bootstrap.sh` as something to watch, not fire and forget.
