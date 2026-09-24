# Deployment

How Lawxygen gets to `app.lawxygen.in` and `api.lawxygen.in`, what is already done, and
what is waiting on somebody.

| Piece                                   | Where                             | State                                |
| --------------------------------------- | --------------------------------- | ------------------------------------ |
| Portal (`lawxygen_service_portal`)      | Vercel, project `lawxygen-portal` | **Deployed**, on a `.vercel.app` URL |
| API (`lawxygen_service_portal_backend`) | Ubuntu VPS `210.79.129.180`       | **Live** under PM2, deployed by CI   |
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
    region bom1)       → PM2 → node :4000)
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
Redis container. Lawxygen is a second tenant on it. It does **not** use Docker: the
repository is cloned onto the box, built there, and run by PM2. The deployment is shaped
around not disturbing the first tenant:

- `bootstrap.sh` **stages ufw rules but does not enable ufw.** It is currently inactive,
  and switching a firewall on underneath a working service is how an unrelated site goes
  dark. Enable deliberately with `ENABLE_UFW=1 sudo -E bash deploy/bootstrap.sh`.
- The stock `sites-enabled/default` is only removed if it really is the stock file.
- **The system Node is v20, and the other tenant's PM2 app runs on it.** It is never
  upgraded. `bootstrap.sh` puts a private Node 24 in `/opt/lawxygen/node` instead;
  `deploy.sh` puts it first on `PATH` and `ecosystem.config.cjs` pins the API to it.
- **PM2 is shared.** Both apps live in `ubuntu`'s one PM2 daemon and boot unit. Only ever
  address ours by name — `pm2 restart lawxygen-api`, never `pm2 restart all`,
  `pm2 kill` or `pm2 update`.
- The API binds to `127.0.0.1:4000`, so it is not reachable from outside whether or not
  ufw is ever enabled. Check nothing else on the host already holds port 4000
  (`ss -tlnp | grep :4000`) before the first deploy.
- nginx and certbot were already installed, so that part of `bootstrap.sh` is a no-op
  here. It stays idempotent for the next host.

Disk is the thing to watch: 68% used, with roughly 6GB of Docker build cache belonging
to the other project. `docker builder prune` would reclaim it, but that cache is not ours.
Our footprint is the repository, its `node_modules` (dev dependencies included — see
below) and PM2's logs, which `/etc/logrotate.d/lawxygen-api` caps at 7 × 10MB. That is
system logrotate, not the `pm2-logrotate` module, because the module would rotate the
other tenant's PM2 logs too.

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

**Once, to prepare the box** — as `ubuntu`, not root, because PM2 keeps a separate
process list per user and `deploy.sh` must talk to the same one every time:

```bash
sudo mkdir -p /opt/lawxygen && sudo chown "$USER": /opt/lawxygen
git clone <repo> /opt/lawxygen/api
cd /opt/lawxygen/api
sudo bash deploy/bootstrap.sh
```

That installs Node 24, PM2 (registered with systemd so it survives a reboot) and
log rotation for this app only, plus nginx, certbot and ufw rules for 22/80/443. It installs the nginx
site and removes the default one. It does not request a certificate — that comes next,
by hand, so a DNS mistake fails visibly.

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

`deploy.sh` pulls, runs `npm ci`, builds into `dist.next`, **migrates, then swaps the
build in and reloads PM2**, then waits for `/health` and checks `/health/ready`
separately. Every step gates the next, so a failed build or migration leaves the
previous version serving rather than a half-updated system running. The previous build
is kept as `dist.prev`, and a failed health check prints the exact rollback command.

### Continuous deployment

**Every push to `main` deploys itself** once CI passes. The `deploy` job in
`.github/workflows/ci.yml` runs after `verify`, SSHes to the box and runs `deploy.sh`,
then checks `https://api.lawxygen.in/health/ready` from outside. Deploys queue behind
each other and are never cancelled part-way. A push that fails verification never
deploys.

The job's key can do exactly one thing. Its line in `~ubuntu/.ssh/authorized_keys`
carries a forced command:

```
command="cd /opt/lawxygen/api && exec bash deploy/deploy.sh 2>&1",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 … github-actions-deploy@lawxygen-api
```

Whatever the job sends, sshd runs that instead. A leaked key can redeploy `main` and
nothing else — no shell, no forwarding. The private half exists only in the repository
secret `DEPLOY_SSH_KEY`. The other three secrets are `DEPLOY_HOST`, `DEPLOY_USER`, and
`DEPLOY_KNOWN_HOSTS`, which pins the server's host keys so a spoofed host is refused
rather than trusted on first use.

To rotate the key: generate a new pair, replace that line on the server (keeping the
`command=` prefix), and `gh secret set DEPLOY_SSH_KEY < new_key`.

By hand, a deploy is still one line: `cd /opt/lawxygen/api && bash deploy/deploy.sh`.

### Operating it

```bash
pm2 status                         # is it up, how many restarts
pm2 logs lawxygen-api              # live logs (pino JSON); --lines 200 --nostream for history
pm2 restart lawxygen-api           # restart without deploying, e.g. after editing .env.production
pm2 monit                          # CPU and memory
```

`hostel-backend` is in the same list. Always name `lawxygen-api`.

`.env.production` is read by Node at process start, so an edit takes effect on the next
restart, not before.

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
  cd /opt/lawxygen/api
  node --env-file=.env.production --import tsx src/db/seed-catalogue.ts
  # register through the portal, then:
  #   update users set role = 'admin' where email = '…';
  ```

---

## Why the pieces are shaped the way they are

**No Docker.** The database is Neon, so nothing stateful runs on the box, and one Node
process does not need a container around it. PM2 supervises it, restarts it on a crash
with exponential backoff, and brings it back on boot.

**Exactly one PM2 instance, in fork mode.** The background jobs (`src/jobs/runner.ts`)
run inside the API process, and reconciliation takes no lock. Cluster mode or
`instances: 2` would run it twice concurrently. Backlog item 18 is the fix; until then,
`instances: 1` in `ecosystem.config.cjs` is load-bearing.

**Dev dependencies are installed on the server.** `tsc` builds, `drizzle-kit` migrates
and `tsx` seeds, and all three are devDependencies. `deploy.sh` passes `--include=dev`
because npm silently omits them whenever `NODE_ENV=production` is set in the shell.

**Node reads `.env.production` itself** (`node --env-file`), for both the API and the
migration. Sourcing it from bash would fail on `MAIL_FROM=Lawxygen <no-reply@…>`, and
PM2 has no env-file support of its own. Values in `ecosystem.config.cjs` — `NODE_ENV`,
`APP_ENV`, `HOST`, `PORT` — win over the file, because Node never overwrites a variable
that is already set.

**The API binds to `127.0.0.1:4000`, not `0.0.0.0`.** nginx terminates TLS and proxies to
it; the API is never directly reachable. That is `HOST` in `ecosystem.config.cjs`.
Without it the process listens on every interface, and with ufw inactive on this host,
port 4000 would be open to the internet.

**Migrations run after the build and before the reload.** A build failure never leaves
the schema changed, and a migration failure never restarts anything. Migrations must stay
backward compatible with the version still serving, as they always had to.

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

**Verified on the server** (24 September 2026, when the API moved from Docker to PM2):

- `deploy.sh` runs end to end: install, build, migrate against Neon, reload, both
  health checks, `pm2 save`.
- The API runs under PM2 on the private Node 24, fork mode, one instance, bound to
  `127.0.0.1:4000` only. `https://api.lawxygen.in/health/ready` answers through nginx and
  certbot's TLS.
- `hostel-backend` and the hostelmanage containers were untouched throughout — same
  PIDs, same restart counts.
- The Docker `lawxygen-api` container is stopped and removed. Its images
  (`lawxygen-api`, `lawxygen-api-migrate`) are still on disk and can be deleted with
  `docker rmi` once nobody wants a fallback.
- The Vercel production build succeeds, renders the portal, and has
  `https://api.lawxygen.in` inlined — no `localhost` leaked into the bundle.

**Not verified:**

- `bootstrap.sh` as a whole has not been run on this host. Its steps were applied by
  hand (private Node, logrotate entry), because `apt-get install` of packages that are
  already present can upgrade nginx underneath the other tenant's sites. On a fresh host
  it is the right entry point.
- A reboot. The PM2 boot unit (`pm2-ubuntu`) was already enabled and the process list
  has been saved, so both apps should resurrect; it has not been observed.
