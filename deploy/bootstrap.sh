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

set -euo pipefail

DOMAIN="api.lawxygen.in"
APP_USER="${SUDO_USER:-ubuntu}"
REPO_DIR="/opt/lawxygen/api"

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

log "Installing Docker Engine and the compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # shellcheck source=/dev/null
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
else
  echo "Docker already present: $(docker --version)"
fi

systemctl enable --now docker

log "Allowing ${APP_USER} to use Docker without sudo"
usermod -aG docker "$APP_USER"

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
# needs. Decide deliberately, having looked at `ss -tlnp` first.
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

  3. Put the application on the box and deploy:
         git clone <repo> ${REPO_DIR}
         cd ${REPO_DIR}
         cp .env.production.example .env.production   # then fill it in
         bash deploy/deploy.sh

  ${APP_USER} was added to the docker group — log out and back in before the
  docker command works without sudo.

EOF
