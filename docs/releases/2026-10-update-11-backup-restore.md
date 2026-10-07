# Update 11: Backup & Restore

This update adds **Settings → Backup & restore** (administrators only) and the disaster-recovery CLI `dist-server/backup.js`. Both use one archive format. Full usage and the A–Z recovery guide are in [docs/BACKUP_RESTORE.md](../BACKUP_RESTORE.md).

- **No database migration.**
- **No existing record, file or setting is changed.** Backups only read data, and the restore runs only when an administrator confirms it.
- **Docker:** the stack gets one new private Docker volume, `<COMPOSE_PROJECT_NAME>_backups`, mounted at `/data/backups`.

## What it does
- **Backup:**
  - one consistent PostgreSQL snapshot of every application table (discovered automatically) plus every attachment file;
  - a manifest with versions, counts, exact money totals and SHA-256 checksums;
  - each archive is verified after it is written;
  - **Incomplete** is shown when files are missing; it is never reported as fully recoverable.
- **Excluded:** sessions, device push subscriptions and server secrets.
- **Validation:**
  - format and size, checksums, safe paths only (no links or extension headers), bounded decompression;
  - every row checked against its table's columns, and every attachment record against its file;
  - application / schema compatibility.
- **Restore:**
  - requires password re-check, typed confirmation and a verified safety backup;
  - runs in maintenance mode with jobs paused;
  - loads into an isolated staging schema inside one database transaction, re-checks foreign keys, counts and totals, then switches;
  - files are only added: written under a temporary name, checksum-verified and journaled, never overwriting.
  - A failure or crash leaves the previous data and files exactly as they were.
- **After a restore:**
  - all sessions are invalid and push registrations cleared;
  - every user's push setting is turned off;
  - background jobs and notifications stay paused until an administrator resumes them;
  - audit events are recorded: `restore_started` / `restore_failed` in the old data, `restore_completed` in the restored data.

## Files
New:
- `server/backup/format.ts`
- `server/backup/tar.ts`
- `server/backup/ops.ts`
- `server/backup/store.ts`
- `server/backup/dbinfo.ts`
- `server/backup/create.ts`
- `server/backup/validate.ts`
- `server/backup/restore.ts`
- `server/backup/service.ts`
- `server/routes/backup.ts`
- `server/cli/backup.ts`
- `shared/backup.ts`
- `src/pages/BackupRestore.tsx`
- `src/components/RecoveryBanner.tsx`
- `tests/backup.test.ts`
- `docs/BACKUP_RESTORE.md`
- this file

Changed:
- `server/app.ts` — maintenance / write-freeze gate, `/api/system/status`, admin backup routes
- `server/index.ts` — startup recovery, running-app lock, scheduler pause
- `server/config.ts` — `BACKUP_DIR`, `BACKUP_RETENTION`, `BACKUP_MAX_UPLOAD_MB`, `MIGRATIONS_DIR`
- `server/permissions.ts` — `backup.manage` (admin only)
- `server/lib/migrate.ts` — `readMigrations`
- `server/notify/notifier.ts` — no push while paused
- `server/notify/scheduler.ts` — paused checks
- `src/App.tsx`, `src/components/Header.tsx`, `src/components/Login.tsx`, `src/lib/api.ts`, `src/lib/types.ts`
- `tests/helpers.ts`
- `Dockerfile` — `/data/backups`, `BACKUP_DIR`
- `docker-compose.yml` — `backups` volume, backup settings, `APP_COMMIT` from `APP_TAG`
- `deploy/staging.env.example`, `deploy/production.env.example`
- `scripts/build-server.mjs` — CLI bundle
- `DEPLOYMENT.md` — C5

## Staging update
```bash
cd /opt/qonnect-smarthouse-staging
bash scripts/preflight.sh --update
bash scripts/backup.sh
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/qcheck.sql > ~/staging-before-update11.txt
git rev-parse --short HEAD | tee ~/smarthouse-staging-previous-commit.txt
git fetch origin && git log --oneline HEAD..origin/main
git pull --ff-only origin main
sed -i "s/^APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" .env
docker compose build app
docker compose stop app
docker compose run --rm app node dist-server/migrate.js   # expect: Database schema is up to date
docker compose up -d app                                  # creates qonnect-smarthouse-staging_backups
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
docker compose exec -T app sh -c 'touch /data/backups/.w && rm /data/backups/.w && echo "backup storage writable"'
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/qcheck.sql > ~/staging-after-update11.txt
diff ~/staging-before-update11.txt ~/staging-after-update11.txt && echo "no data changed"
```
If the storage check fails, run the permission fix in docs/BACKUP_RESTORE.md §2.

## Rollback
- **Code only:** `git checkout $(cat ~/smarthouse-staging-previous-commit.txt)`, set `APP_TAG` to that commit, then run `docker compose build app && docker compose up -d app`.
- **Leftovers:** the previous version ignores `/data/backups` and the new volume. Archives already created stay in the volume until you remove them.
- **No database change to undo.**
- **If a restore was done with this version:** the restored data has the same schema, so the previous code reads it normally. Use `previous-db discard` first if you want to drop the kept pre-restore copy.
