#!/usr/bin/env bash
# Restores a backup made by backup.sh. DESTRUCTIVE: replaces the current database and uploads
# of THIS compose project only. Usage:
#   ./scripts/restore.sh backups/db-YYYYmmdd-HHMMSS.dump backups/uploads-YYYYmmdd-HHMMSS.tar.gz --yes
set -euo pipefail
cd "$(dirname "$0")/.."
DUMP="${1:?path to db-*.dump}"; UPL="${2:?path to uploads-*.tar.gz}"
[ "${3:-}" = "--yes" ] || { echo "Refusing to restore without --yes (this overwrites the current data)."; exit 1; }
[ -f .env ] || { echo "Missing .env"; exit 1; }
set -a; . ./.env; set +a
PROJECT="${COMPOSE_PROJECT_NAME:-qonnect-smarthouse}"
DB="${POSTGRES_DB:-smarthouse}"; U="${POSTGRES_USER:-smarthouse}"

echo "==> Stopping app (database stays up)"
docker compose stop app

echo "==> Restoring database $DB in project $PROJECT"
docker compose exec -T db psql -U "$U" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"$DB\";" -c "CREATE DATABASE \"$DB\" OWNER \"$U\";"
docker compose exec -T db pg_restore -U "$U" -d "$DB" --no-owner --exit-on-error < "$DUMP"

echo "==> Restoring uploads into volume ${PROJECT}_uploads"
docker run --rm -v "${PROJECT}_uploads:/data" -v "$(cd "$(dirname "$UPL")" && pwd):/backup:ro" alpine:3 \
  sh -c "find /data -mindepth 1 -delete && tar -xzf /backup/$(basename "$UPL") -C /data && chown -R 1000:1000 /data"

echo "==> Starting app"
docker compose up -d app
echo "==> Restore complete. Check: curl -fsS http://127.0.0.1:${APP_PORT:-8090}/api/health"
