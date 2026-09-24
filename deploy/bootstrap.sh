#!/usr/bin/env bash
#
# One-time preparation of a fresh Ubuntu host for api.lawxygen.in.
#
# Run it once, as a user with sudo, on the server:
#
#   ssh ubuntu@<host>
#   sudo bash deploy/bootstrap.sh
#
# Idempotent: running it twice is safe and changes nothing the second time. It does not
# deploy the application — deploy.sh does that.
#
# It deliberately does NOT request a certificate. That step needs api.lawxygen.in to
# already resolve to this host, and is run by hand afterwards so a DNS mistake fails
# visibly rather than burning a Let's Encrypt rate limit.
#
# The database is Neon, so nothing stateful is installed here: Node, PM2, nginx, certbot.

set -euo pipefail

DOMAIN="api.lawxygen.in"
APP_USER="${SUDO_USER:-ubuntu}"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
REPO_DIR="/opt/lawxygen/api"
NODE_MAJOR=24

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/bootstrap.sh" >&2
  exit 1
fi

# Everything PM2 does below must happen as the user who will run deploy.sh: PM2 keeps a
# separate daemon and process list per user, and root's is not the one deploy.sh talks to.
as_app() { sudo -u "$APP_USER" -H "$@"; }

log "Updating package lists"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

log "Installing base packages"
apt-get install -y -qq ca-certificates curl gnupg git ufw nginx

log "Node.js ${NODE_MAJOR}"
if command -v node >/dev/null 2>&1; then
  current="$(node -p 'process.versions.node.split(".")[0]')"
  if (( current < 22 )); then
    # Not upgraded automatically: this host is shared, and replacing the system Node
    # underneath another project is how an unrelated service breaks.
    echo "Node $(node --version) is installed and too old (need >=22). Upgrade it deliberately," >&2
    echo "having checked nothing else on this host depends on it, then re-run." >&2
    exit 1
  fi
  echo "Node already present: $(node --version)"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
  echo "Installed Node $(node --version)"
fi

log "PM2"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
else
  echo "PM2 already present: $(pm2 --version)"
fi

# Registers a systemd unit that resurrects ${APP_USER}'s saved process list on boot.
# deploy.sh runs `pm2 save` after every successful deploy, so the list stays current.
log "PM2 on boot, for ${APP_USER}"
pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
systemctl enable "pm2-${APP_USER}" >/dev/null 2>&1 || true

# pino writes every request to stdout, and PM2 keeps stdout in ~/.pm2/logs forever unless
# something rotates it. On a 7GB disk that is an outage with a delay on it. The module is
# per PM2 daemon, so it also rotates anything else ${APP_USER} runs under PM2.
log "PM2 log rotation"
if ! as_app pm2 describe pm2-logrotate >/dev/null 2>&1; then
  as_app pm2 install pm2-logrotate
fi
as_app pm2 set pm2-logrotate:max_size 10M >/dev/null
as_app pm2 set pm2-logrotate:retain 5 >/dev/null
as_app pm2 set pm2-logrotate:compress true >/dev/null

log "Installing certbot"
apt-get install -y -qq certbot python3-certbot-nginx

log "Firewall"
# Rules are always added — they are inert while ufw is inactive and correct once it is
# not. Order matters: SSH is allowed before anything could enable ufw, or enabling it
# ends this session and locks everyone out of the box.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp

# Enabling is opt-in: `ENABLE_UFW=1 sudo -E bash deploy/bootstrap.sh`.
#
# This host may already be running something else — it is, at the time of writing, also
# serving hostelmanage.com. Turning a firewall on underneath a working service is how an
# unrelated site goes dark at 2am, and the rules above cover only what *this* service
# needs. Decide deliberately, having looked at `ss -tlnp` first. The API binds to
# 127.0.0.1 regardless (ecosystem.config.cjs), so it is not exposed either way.
if [[ "${ENABLE_UFW:-0}" == "1" ]]; then
  log "Enabling ufw (ENABLE_UFW=1)"
  ufw --force enable
  ufw status verbose
else
  echo "ufw left as-is (currently: $(ufw status | head -1)). Rules are staged."
  echo "Other services are listening on this host:"
  ss -tlnp 2>/dev/null | awk 'NR>1 {print "  " $4 "  " $6}' | head -10
  echo "Enable only once you are sure those are covered: ENABLE_UFW=1 sudo -E bash deploy/bootstrap.sh"
fi

log "Creating ${REPO_DIR}"
mkdir -p "$REPO_DIR"
chown -R "$APP_USER":"$APP_USER" /opt/lawxygen

log "Installing the nginx site"
SITE_SRC="$(dirname "$0")/nginx/${DOMAIN}.conf"
if [[ -f "$SITE_SRC" ]]; then
  cp "$SITE_SRC" "/etc/nginx/sites-available/${DOMAIN}"
else
  echo "warning: ${SITE_SRC} not found; copy the site config manually" >&2
fi

ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

# The packaged default answers on every unmatched hostname, which means this box would
# serve an nginx welcome page to anyone who scans it. Only removed if it is actually the
# stock file — on a shared host somebody may have put real configuration there.
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  if grep -q "Welcome to nginx" /etc/nginx/sites-available/default 2>/dev/null; then
    rm -f /etc/nginx/sites-enabled/default
  else
    echo "note: sites-enabled/default is not the stock file; left alone" >&2
  fi
fi

# `nginx -t` validates every enabled site, not just this one. A failure here means the
# reload is skipped and whatever was already being served keeps being served.
nginx -t
systemctl reload nginx

cat <<EOF

Bootstrap complete.

Next, in order:

  1. Point DNS at this host:
         A   api   $(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<this server IP>')
     and wait for it to resolve:
         dig +short ${DOMAIN}

  2. Get the certificate (only once DNS resolves):
         sudo certbot --nginx -d ${DOMAIN} --agree-tos -m <you@lawxygen.in> --no-eff-email

  3. As ${APP_USER} (not root), deploy. The repository belongs at ${REPO_DIR};
     clone it there first if it is not already:
         cd ${REPO_DIR}
         cp .env.production.example .env.production && chmod 600 .env.production
         # fill it in, then:
         bash deploy/deploy.sh

EOF
