#!/usr/bin/env bash
#
# Deploy the API. Run from the repository root on the server, as the user that owns PM2:
#
#   cd /opt/lawxygen/api && bash deploy/deploy.sh
#
# Pull, install, build, migrate, reload, verify. Every step gates the next, and the order
# is chosen so that a failure leaves the previous version serving:
#
#   - The build goes to dist.next and only replaces dist/ once it has succeeded, so a
#     broken build never becomes the code PM2 would restart into.
#   - Migrations run after the build, so a build failure never leaves the schema changed.
#     Drizzle wraps each migration in a transaction; a failed one changes nothing.
#   - The previous build is kept as dist.prev for a quick rollback.
#
# The body is one function, called on the last line. `git pull` rewrites this file while it
# runs, and bash reads scripts incrementally — without the function, the rest of the run
# would execute from whatever byte offset the new version happens to have.

set -euo pipefail

APP_NAME="lawxygen-api"
ENV_FILE=".env.production"
HEALTH_URL="http://127.0.0.1:4000/health"
READY_URL="http://127.0.0.1:4000/health/ready"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

main() {
  [[ -f ecosystem.config.cjs ]] || fail "Run this from the repository root."
  [[ -f "$ENV_FILE" ]] || fail "${ENV_FILE} is missing. Copy .env.production.example and fill it in."
  command -v pm2 >/dev/null 2>&1 || fail "pm2 is not installed. Run deploy/bootstrap.sh first."

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  (( node_major >= 22 )) || fail "Node ${node_major} is too old; package.json needs >=22."

  # A deploy that silently starts with half its configuration is worse than one that
  # refuses. The app validates the rest at boot; these are the ones with no safe default.
  log "Checking required configuration"
  local key
  for key in DATABASE_URL SESSION_SECRET FIELD_ENCRYPTION_KEY PORTAL_ORIGIN API_ORIGIN COOKIE_DOMAIN; do
    grep -qE "^${key}=.+" "$ENV_FILE" || fail "${key} is unset or empty in ${ENV_FILE}"
  done

  local previous
  previous="$(git rev-parse --short HEAD)"

  log "Pulling the latest code (currently ${previous})"
  git pull --ff-only
  log "Now at $(git rev-parse --short HEAD)"

  # Dev dependencies are needed on the box: tsc builds, drizzle-kit migrates, tsx seeds.
  # --include=dev because npm silently omits them if NODE_ENV=production is exported.
  log "Installing dependencies"
  npm ci --include=dev --no-audit --no-fund

  log "Building"
  rm -rf dist.next
  npx tsc -p tsconfig.build.json --outDir dist.next \
    || fail "Build failed. Nothing was migrated or restarted; ${previous} is still serving."

  # drizzle-kit's config loads .env.local / .env itself, and neither exists here, so the
  # production file is handed to Node directly.
  log "Applying database migrations"
  node --env-file="$ENV_FILE" node_modules/drizzle-kit/bin.cjs migrate \
    || fail "Migration failed. Nothing was restarted; ${previous} is still serving."

  log "Swapping in the new build"
  rm -rf dist.prev
  if [[ -d dist ]]; then mv dist dist.prev; fi
  mv dist.next dist

  log "Reloading ${APP_NAME}"
  pm2 startOrReload ecosystem.config.cjs --update-env

  log "Waiting for health"
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      log "Healthy after ${attempt}s"
      curl -fsS "$HEALTH_URL"; echo
      break
    fi
    if [[ $attempt -eq 30 ]]; then
      printf '\n--- last 60 log lines ---\n' >&2
      pm2 logs "$APP_NAME" --lines 60 --nostream >&2 || true
      fail "API did not become healthy within 30s. To roll back the code:
    git reset --hard ${previous} && npm ci --include=dev && rm -rf dist && mv dist.prev dist && pm2 reload ${APP_NAME}
  (Migrations already applied are not reverted.)"
    fi
    sleep 1
  done

  # Readiness is the one that touches the database. Checked separately so a deploy that
  # comes up but cannot reach Neon is reported as such, rather than passing on liveness.
  log "Checking database connectivity"
  curl -fsS --max-time 10 "$READY_URL" >/dev/null \
    || fail "The API is up but cannot reach the database. Check DATABASE_URL in ${ENV_FILE}."

  # So a reboot brings the API back — `pm2 startup` (in bootstrap.sh) resurrects this list.
  pm2 save >/dev/null

  log "Deployed."
  pm2 status "$APP_NAME"
}

main "$@"
