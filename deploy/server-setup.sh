#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 24.04 server.
# Run as root:  bash server-setup.sh
#
# Installs Node, ffmpeg, fonts, nginx, and certbot; creates a non-root user
# to run the app; and prepares the directories the app expects. Safe to
# re-run — every step is idempotent.

set -euo pipefail

APP_USER="snapcast"
APP_DIR="/srv/snapcast"
DATA_DIR="/var/lib/snapcast"

echo "==> Updating package lists"
apt-get update -y

echo "==> Installing system packages"
# ffmpeg: video clips + photo montages
# fonts-dejavu-core: drawtext caption burn-in needs a real font file
# nginx + certbot: reverse proxy and HTTPS
# build-essential + python3: better-sqlite3 compiles a native module
apt-get install -y \
  curl git ufw \
  ffmpeg fonts-dejavu-core \
  nginx certbot python3-certbot-nginx \
  build-essential python3

echo "==> Installing Node.js 22 LTS"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Creating app user '${APP_USER}'"
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  adduser --system --group --home "${APP_DIR}" --shell /bin/bash "${APP_USER}"
fi

echo "==> Creating directories"
# Database lives OUTSIDE the app dir so a redeploy can never overwrite it.
mkdir -p "${APP_DIR}" "${DATA_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" "${DATA_DIR}"

echo "==> Configuring firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo
echo "==> Base setup complete."
echo "    Node:   $(node --version)"
echo "    ffmpeg: $(ffmpeg -version | head -1 | cut -d' ' -f1-3)"
echo
echo "Next: deploy the app (see deploy/README.md)."
