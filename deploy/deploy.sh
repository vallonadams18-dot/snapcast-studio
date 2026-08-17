#!/usr/bin/env bash
# Pull the latest code, build, and restart. Run as ROOT from /srv/snapcast:
#   bash deploy/deploy.sh
#
# Safe to re-run. Does NOT touch .env or the database.
#
# Why root: the build steps must run as the `snapcast` user (so file
# ownership stays correct), but `systemctl restart` needs root. Rather than
# have the unprivileged user call sudo — it's a --system account with no
# password, so that just hangs on a prompt it can never satisfy — this
# script runs as root and drops down to `snapcast` only for the build.

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="snapcast"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this as root (it needs systemctl):  bash deploy/deploy.sh" >&2
  exit 1
fi

cd "$APP_DIR"

echo "==> Pulling latest code"
# git refuses to operate on a repo owned by another user unless told it's ok.
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
git pull --ff-only

# Everything below writes into the app dir, so it runs as the app user to
# avoid leaving root-owned files the service can't read later.
run_as_app() {
  su -s /bin/bash "$APP_USER" -c "cd '$APP_DIR' && $1"
}

echo "==> Installing dependencies"
run_as_app "npm install"

echo "==> Generating Prisma client"
run_as_app "npx prisma generate"

# Build BEFORE touching the database: it's the slow step and needs no DB
# access, so doing it while the old version is still serving keeps downtime
# to just the migration below.
echo "==> Building"
run_as_app "npm run build"

SERVICE_INSTALLED=false
if systemctl list-unit-files snapcast.service >/dev/null 2>&1; then
  SERVICE_INSTALLED=true
fi

# SQLite allows only one writer, and the running app holds the file open.
# `prisma migrate deploy` needs an exclusive lock to write _prisma_migrations
# and fails with "database is locked" if the service is still up. Stop it for
# the migration, then bring it back on the new build.
if [ "$SERVICE_INSTALLED" = true ]; then
  echo "==> Stopping service for migration"
  systemctl stop snapcast
fi

echo "==> Applying database migrations"
# deploy (not dev) — applies pending migrations without ever prompting to
# reset, so a schema change can't silently wipe production data.
if ! run_as_app "npx prisma migrate deploy"; then
  echo "ERROR: migration failed." >&2
  # Don't leave the site down because a migration failed — the previous
  # build is still on disk and will serve fine against the un-migrated DB.
  if [ "$SERVICE_INSTALLED" = true ]; then
    echo "     Restarting service so the site stays up." >&2
    systemctl start snapcast || true
  fi
  exit 1
fi

if [ "$SERVICE_INSTALLED" = true ]; then
  echo "==> Starting service"
  systemctl start snapcast
  sleep 2
  systemctl --no-pager status snapcast | head -12
else
  echo "    (snapcast.service not installed yet — skipping restart)"
fi

echo
echo "==> Deploy complete."
