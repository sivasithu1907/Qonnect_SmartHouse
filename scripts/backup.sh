#!/usr/bin/env bash
# Backs up the Smart House database (pg_dump custom format) and the private uploads volume.
# Read-only for the running app. Usage:  ./scripts/backup.sh [backup-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Missing .env"; exit 1; }
set -a; . ./.env; set +a
PROJECT="${COMPOSE_PROJECT_NAME:-qonnect-smarthouse}"
OUT="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
chmod 700 "$OUT"

echo "==> Dumping database (${POSTGRES_DB:-smarthouse}) from project ${PROJECT}"
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-smarthouse}" -d "${POSTGRES_DB:-smarthouse}" -Fc --no-owner \
  > "$OUT/db-$STAMP.dump"

echo "==> Archiving uploads volume ${PROJECT}_uploads"
docker run --rm -v "${PROJECT}_uploads:/data:ro" -v "$(cd "$OUT" && pwd):/backup" alpine:3 \
  tar -czf "/backup/uploads-$STAMP.tar.gz" -C /data .

( cd "$OUT" && sha256sum "db-$STAMP.dump" "uploads-$STAMP.tar.gz" > "SHA256SUMS-$STAMP" )
chmod 600 "$OUT"/*-"$STAMP"*
echo "==> Backup complete:"
ls -lh "$OUT"/*"$STAMP"*
