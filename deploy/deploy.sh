#!/usr/bin/env bash
#
# Deploy the API. Run from the repository root on the server:
#
#   cd /opt/lawxygen/api && bash deploy/deploy.sh
#
# Build, migrate, restart, verify. The order matters and the failure behaviour matters
# more: every step gates the next, so a bad migration stops the deploy with the previous
# version still serving rather than leaving a half-updated system running.

set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
HEALTH_URL="http://127.0.0.1:4000/health"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f docker-compose.prod.yml ]] || fail "Run this from the repository root."
[[ -f .env.production ]] || fail ".env.production is missing. Copy .env.production.example and fill it in."

# A deploy that silently starts with half its configuration is worse than one that
# refuses. The app validates the rest at boot; these are the ones with no safe default.
log "Checking required configuration"
for key in DATABASE_URL SESSION_SECRET FIELD_ENCRYPTION_KEY PORTAL_ORIGIN API_ORIGIN COOKIE_DOMAIN; do
  if ! grep -qE "^${key}=.+" .env.production; then
    fail "${key} is unset or empty in .env.production"
  fi
done

log "Pulling the latest code"
git pull --ff-only

log "Building the images"
$COMPOSE --profile tools build

# Migrations run in a one-off container built from the same commit, before anything is
# restarted. Drizzle wraps each migration in a transaction, so a failure here leaves the
# database as it was and the currently running version still serving correctly.
log "Applying database migrations"
$COMPOSE --profile tools run --rm migrate \
  || fail "Migration failed. The previous version is still running and untouched."

log "Restarting the API"
$COMPOSE up -d --remove-orphans

log "Waiting for health"
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    log "Healthy after ${attempt}s"
    curl -fsS "$HEALTH_URL"; echo
    break
  fi
  if [[ $attempt -eq 30 ]]; then
    printf '\n--- last 60 log lines ---\n' >&2
    $COMPOSE logs --tail=60 api >&2 || true
    fail "API did not become healthy within 30s."
  fi
  sleep 1
done

# Readiness is the one that touches the database. Checked separately so a deploy that
# comes up but cannot reach Neon is reported as such, rather than passing on liveness.
log "Checking database connectivity"
curl -fsS --max-time 10 http://127.0.0.1:4000/health/ready >/dev/null \
  || fail "The API is up but cannot reach the database. Check DATABASE_URL in .env.production."

# Filtered by label, not a blanket prune: this host is shared, and an unfiltered
# `docker image prune` would collect other projects' dangling layers too.
log "Removing images left behind by this build"
docker image prune -f --filter "label=org.opencontainers.image.title=lawxygen-api" >/dev/null

log "Deployed."
$COMPOSE ps
