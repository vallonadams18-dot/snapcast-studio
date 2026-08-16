#!/usr/bin/env bash
# Pull the latest code and restart. Run as the snapcast user from /srv/snapcast:
#   sudo -u snapcast bash deploy/deploy.sh
#
# Safe to re-run. Does NOT touch .env or the database.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Installing dependencies"
npm ci --omit=dev || npm install --omit=dev

echo "==> Generating Prisma client"
npx prisma generate

echo "==> Applying database migrations"
# deploy (not dev) — applies pending migrations without ever prompting to
# reset, so a schema change can't silently wipe production data.
npx prisma migrate deploy

echo "==> Building"
# Next needs devDependencies (typescript, tailwind) to build, so install the
# full set here rather than --omit=dev.
npm install
npm run build

echo "==> Restarting service"
sudo systemctl restart snapcast

sleep 2
sudo systemctl --no-pager status snapcast | head -12

echo
echo "==> Deploy complete."
