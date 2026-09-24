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
#
# Safe on a shared host: it never upgrades an existing Node, never replaces an existing
# PM2 boot unit or nginx site, and rotates only this app's logs.

set -euo pipefail

DOMAIN="api.lawxygen.in"
APP_USER="${SUDO_USER:-ubuntu}"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
REPO_DIR="/opt/lawxygen/api"
NODE_MAJOR=24
PRIVATE_NODE_DIR="/opt/lawxygen/node"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/bootstrap.sh" >&2
  exit 1
fi

log "Updating package lists"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

log "Installing base packages"
apt-get install -y -qq ca-certificates curl gnupg git ufw nginx

# The API needs Node >=22. If the host already has one, use it. If it has none, install it
# system-wide. If it has an older one, leave that alone — on a shared host something else
# is running on it (on 210.79.129.180, another PM2 app is) — and put a private Node 24 in
# ${PRIVATE_NODE_DIR}, which deploy.sh and ecosystem.config.cjs both prefer when present.
log "Node.js"
system_major=0
if command -v node >/dev/null 2>&1; then
  system_major="$(node -p 'process.versions.node.split(".")[0]')"
fi

if (( system_major >= 22 )); then
  echo "System Node $(node --version) is new enough."
elif (( system_major == 0 )); then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
  echo "Installed Node $(node --version)"
elif [[ -x "${PRIVATE_NODE_DIR}/bin/node" ]]; then
  echo "System Node is $(node --version); private Node $("${PRIVATE_NODE_DIR}/bin/node" --version) already in ${PRIVATE_NODE_DIR}."
else
  echo "System Node is $(node --version) and stays; installing a private Node ${NODE_MAJOR} in ${PRIVATE_NODE_DIR}."
  case "$(uname -m)" in
    x86_64) node_arch="x64" ;;
    aarch64) node_arch="arm64" ;;
    *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  work="$(mktemp -d)"
  curl -fsSL "${base}/SHASUMS256.txt" -o "${work}/SHASUMS256.txt"
  tarball="$(grep -oE "node-v[0-9.]+-linux-${node_arch}\.tar\.xz" "${work}/SHASUMS256.txt" | head -1)"
  curl -fsSL "${base}/${tarball}" -o "${work}/${tarball}"
  (cd "$work" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$PRIVATE_NODE_DIR"
  tar -xJf "${work}/${tarball}" -C "$PRIVATE_NODE_DIR" --strip-components=1
  rm -rf "$work"
  echo "Installed $("${PRIVATE_NODE_DIR}/bin/node" --version) in ${PRIVATE_NODE_DIR}"
fi

log "PM2"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
else
  echo "PM2 already present: $(pm2 --version)"
fi

# Registers a systemd unit that resurrects ${APP_USER}'s saved process list on boot.
# deploy.sh runs `pm2 save` after every successful deploy, so the list stays current.
# Skipped when the unit already exists: somebody else's PM2 apps may depend on it as-is.
log "PM2 on boot, for ${APP_USER}"
if systemctl is-enabled "pm2-${APP_USER}" >/dev/null 2>&1; then
  echo "pm2-${APP_USER} is already enabled."
else
  pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
fi

# pino writes every request to stdout, and PM2 keeps it in ~/.pm2/logs forever unless
# something rotates it. On a small disk that is an outage with a delay on it. System
# logrotate rather than the pm2-logrotate module: the module is per PM2 daemon, so it would
# also rotate every other app ${APP_USER} runs under PM2. This touches only our two files.
log "Log rotation for lawxygen-api"
cat > /etc/logrotate.d/lawxygen-api <<EOF
${APP_HOME}/.pm2/logs/lawxygen-api-out.log ${APP_HOME}/.pm2/logs/lawxygen-api-error.log {
    su ${APP_USER} ${APP_USER}
    daily
    maxsize 10M
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
logrotate --debug /etc/logrotate.d/lawxygen-api >/dev/null 2>&1 \
  || { echo "logrotate rejected /etc/logrotate.d/lawxygen-api" >&2; exit 1; }

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
# Only when absent. Once certbot has run it rewrites this file with the TLS block, and
# copying the plain-HTTP template over it again would take HTTPS down.
SITE_SRC="$(dirname "$0")/nginx/${DOMAIN}.conf"
SITE_DST="/etc/nginx/sites-available/${DOMAIN}"
if [[ -e "$SITE_DST" ]]; then
  echo "${SITE_DST} already exists; left alone."
elif [[ -f "$SITE_SRC" ]]; then
  cp "$SITE_SRC" "$SITE_DST"
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
