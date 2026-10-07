# Backup & Restore — usage and disaster recovery

Qonnect Smart House can make a **full backup** of one installation and restore it on a **fresh, compatible installation** (for example, a new server after the old one failed), or replace an existing installation. The same archive format is used by:

- the web page **Settings → Backup & restore** (account menu, administrators only), and
- the command-line tool `dist-server/backup.js`, which works even when the web application cannot start.

> **The archive is not encrypted.** It contains every project, payment, contract and user (including password hashes). Store it like a confidential document. Download it only to a protected location, and copy it off the server regularly.

---

## 1. What a backup contains

| Included | Not included (by design) |
|---|---|
| Every table of the application database, read from **one consistent PostgreSQL snapshot**: projects and settings, categories, budget items and allowances, contracts and amendments, payment milestones and transfers, materials, timeline phases / tasks / dependencies / work updates, consultant and site visits and actions, contacts / companies / contact people / project assignments, users, roles and project memberships, notification history and preferences, and the audit history | Sign-in sessions (everyone signs in again after a restore) |
| Every uploaded file referenced by an attachment record (payment slips, reports, signed contracts, photos, contact documents). Original file names, IDs and record links are kept | Device push registrations (each device re-enables push after a restore) |
| Applied database migrations (the schema version), and the values of database sequences | `.env`, database password, VAPID keys, TLS certificates, Caddy configuration and any other server secret |
| `manifest.json`: format version, application version and commit, schema version, creation time and creator, record counts, exact totals of every money column, the attachment inventory and a SHA-256 checksum of every entry | Orphaned files with no attachment record |

New tables added by future updates are included automatically: the backup reads the table list from PostgreSQL, so it does not rely on a fixed list.

Money values, dates, times and IDs are stored exactly. They are written as PostgreSQL `row_to_json` text and read back by PostgreSQL itself. Totals are compared to the cent after a restore.

**Archive layout.** One uncompressed `.tar` file, so it can be streamed:

```
README.txt
database/schema.json                      tables, columns, sequences, migrations
database/tables/<table>.ndjson.gz         rows of one table (one JSON object per line)
files/<project-id or _directory>/<name>   uploaded files
manifest.json                             written last: versions, counts, totals, checksums
```

**Consistency.**

- **Web backup:** new write requests are held for a moment, at most a few seconds, while the database snapshot is taken. Reads continue. The download itself never blocks the application.
- **Files:** an uploaded file is always written to disk before its database record is committed, so every record in the snapshot has its file.
- **Missing or damaged files:** if a referenced file is missing or does not match its recorded checksum, the backup is marked **Incomplete** (never "Verified"), and the missing files are listed.
- **Verification:** every archive is re-read and verified (checksums, row counts, attachment links) before it is reported as successful.

## 2. Where backups are stored

| | Inside the app container | Docker volume |
|---|---|---|
| Backup archives, metadata, uploads in progress, restore journals | `/data/backups` (`BACKUP_DIR`) | `<COMPOSE_PROJECT_NAME>_backups`, e.g. `qonnect-smarthouse_backups` |
| Live uploaded files | `/data/uploads` (`UPLOAD_DIR`) | `<COMPOSE_PROJECT_NAME>_uploads` |

- **Access:** the backup folder is private (mode 700, app user only). It is never served by the web server; archives are downloaded only through the authenticated administrator routes.
- **Deleting an archive** removes only that archive and its metadata, never live files.
- **Retention:**
  - the newest **10** manual / command-line backups (`BACKUP_RETENTION`), **3** safety backups and **5** uploaded archives are kept;
  - failed records are kept for 30 days;
  - uploads that were never finished are removed after 24 hours.
- **Settings** (optional, in `.env`): `BACKUP_RETENTION=10`, and `BACKUP_MAX_UPLOAD_MB=20480` for the largest archive accepted for upload.

**Backup storage permissions.** The page shows "Backup storage is not available" if the volume is not writable. Fix it once, inside the stack's directory:

```bash
docker compose run --rm --no-deps --user root app chown -R node:node /data/backups
docker compose run --rm --no-deps --user root app chmod 700 /data/backups
```

## 3. Using the web page (administrators)

**Create and download a backup**

1. Account menu → **Backup & restore** → **Create full backup**. Progress is shown; you can keep working.
2. When the result is **Verified**, click the download icon. The file is named `qonnect-backup-YYYYMMDD-HHMMSS-xxxxxxxx.tar`.
3. Keep the downloaded copy somewhere protected and off the server.

**Restore**

1. **Upload backup for validation.**
   - The file is sent in 8 MB parts; a dropped connection resumes where it stopped.
   - Uploading changes nothing.
   - The archive is checked completely: format, checksums, unsafe paths, links, decompressed size, every row against its table, record ↔ file consistency, and compatibility with this version.
2. Review the details: backup date and version, record counts, projects, attachment count and size, compatibility, warnings, and **what will be replaced**. Incompatible or corrupt archives are rejected here, and no restore button is offered.
3. Enter **your password** and type the confirmation phrase shown, for example `RESTORE 1a2b3c4d`. Then click **Replace all data with this backup**.
4. **During the restore:**
   - the application is in **maintenance mode**: other requests get "restore in progress";
   - due-date checks and notifications are paused;
   - a **safety backup** of the current data is created and verified first;
   - the archive is loaded into an isolated staging copy and checked;
   - the switch happens only after every check passes.
5. **When it finishes:** everyone is signed out. Sign in with an account **from the restored backup**.
6. Background jobs and notifications stay **paused**. Complete the recovery checks listed on the page, then click **Resume background jobs**.

**If a restore fails**, nothing is replaced: the database transaction is rolled back, and only the files this restore added are removed. The page shows the reason. The previous data, its files and the jobs setting are kept.

**What a restore never does:**

- merge records;
- re-send old notifications;
- trigger payments or any external action;
- restore sessions or device push registrations;
- overwrite or delete existing uploaded files.

After a restore, every user's "push notifications on" setting is switched off, so each device enables push again from the Notifications page.

## 4. Command line (same format)

Run these inside the stack's directory (`/opt/qonnect-smarthouse` for production, `/opt/qonnect-smarthouse-staging` for staging). The CLI uses the stack's own database and volumes.

```bash
docker compose run --rm app node dist-server/backup.js help
docker compose run --rm app node dist-server/backup.js create          # verified backup into the backups volume
docker compose run --rm app node dist-server/backup.js list
```

**Copy a backup off the server.** With the app running:

```bash
docker compose cp app:/data/backups/archives/<id>.tar ~/qonnect-backup.tar
chmod 600 ~/qonnect-backup.tar
# from your computer:  scp root@<server>:~/qonnect-backup.tar .
```

**Validate or restore an archive file** that is on the server, in a folder such as `/root/qonnect-restore`. The container runs as user 1000, so give that user read access:

```bash
sudo mkdir -p /root/qonnect-restore && sudo mv ~/qonnect-backup.tar /root/qonnect-restore/
sudo chown 1000:1000 /root/qonnect-restore/qonnect-backup.tar && sudo chmod 600 /root/qonnect-restore/qonnect-backup.tar
docker compose run --rm -v /root/qonnect-restore:/restore:ro app node dist-server/backup.js validate /restore/qonnect-backup.tar
docker compose stop app                      # restore refuses to run while the web app is running
docker compose run --rm -v /root/qonnect-restore:/restore:ro app node dist-server/backup.js restore /restore/qonnect-backup.tar --yes
#   add --replace-existing when the installation already has projects or users (a safety backup is made first)
docker compose up -d app
```

**After recovery:**

```bash
docker compose run --rm app node dist-server/backup.js resume-jobs && docker compose restart app   # or use the web button
docker compose run --rm app node dist-server/backup.js previous-db status
docker compose stop app && docker compose run --rm app node dist-server/backup.js previous-db rollback --yes && docker compose up -d app
docker compose run --rm app node dist-server/backup.js previous-db discard --yes                   # frees the space
```

- `previous-db status` shows the previous data kept in the database.
- `previous-db rollback` switches back to the data from before the last restore.
- `previous-db discard` drops the previous data and frees the space.

**Command-line backups while the app is running.** A `create` made while the web app is running has no write freeze, but it is still consistent. The database is read from one snapshot, and files are always written before their records. For a guaranteed quiet backup, run `docker compose stop app` first.

## 5. Disaster recovery on a new server (A–Z)

Use this when the original server is gone and you have a downloaded archive. The paths match `DEPLOYMENT.md`. Use `/opt/qonnect-smarthouse` and the production template for production; use the staging path and template for a staging rehearsal.

**1. Get compatible application code from GitHub.** The backup's review (or `validate`) shows its application version, commit and database version. Use the same or a newer commit. A backup from a newer version than the code you install is rejected.

```bash
APP_DIR=/opt/qonnect-smarthouse
sudo mkdir -p "$APP_DIR" && sudo chown "$USER": "$APP_DIR"
git clone --branch main https://github.com/sivasithu1907/Qonnect_SmartHouse.git "$APP_DIR"
cd "$APP_DIR"
# optional, to match the backup exactly:  git checkout <commit shown in the backup>
```

**2. Configure the new server and its secrets.** None of these are in the backup.

```bash
cp deploy/production.env.example .env && chmod 600 .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
export APP_TAG=$(git rev-parse --short HEAD); sed -i "s/^APP_TAG=.*/APP_TAG=$APP_TAG/" .env
nano .env    # APP_ORIGIN (https://<domain>, once HTTPS works), COOKIE_SECURE=true, APP_TIMEZONE, VAPID_* (optional)
./scripts/preflight.sh
```

| Secret / setting | What to do |
|---|---|
| `POSTGRES_PASSWORD` | A new one is fine. It is not in the backup and is never needed to restore |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Reuse the old keys if you kept them, or generate new ones: `docker compose run --rm --no-deps app node dist-server/generate-vapid-keys.js`. Devices re-enable push either way |
| `APP_ORIGIN`, `COOKIE_SECURE`, `TRUST_PROXY` | Set for the new domain (step 7) |
| `COMPOSE_PROJECT_NAME`, `APP_PORT`, `APP_BIND` | As in the templates (production 8090, staging 8091, bound to 127.0.0.1) |
| Caddy / TLS | Configured separately (step 7) |

**3. Start the required services.**

```bash
docker compose build app
docker compose up -d db
docker compose ps          # db → healthy
```

You don't need to run migrations or the seed: the restore builds the database structure itself. Do **not** run `seed.js` on a server you are going to restore.

**4. Upload and validate the backup.**

```bash
# from your computer:  scp qonnect-backup-….tar root@<new-server>:~/
sudo mkdir -p /root/qonnect-restore && sudo mv ~/qonnect-backup-*.tar /root/qonnect-restore/
sudo chown 1000:1000 /root/qonnect-restore/*.tar && sudo chmod 600 /root/qonnect-restore/*.tar
docker compose run --rm -v /root/qonnect-restore:/restore:ro app node dist-server/backup.js validate /restore/<file>.tar
```

Continue only when it prints **VALID backup archive** and "Compatible".

**5. Restore.**

- **Command line** (recommended on a new server):

  ```bash
  docker compose run --rm -v /root/qonnect-restore:/restore:ro app node dist-server/backup.js restore /restore/<file>.tar --yes
  docker compose up -d app
  ```

- **Web page instead:**
  - run `docker compose run --rm app node dist-server/migrate.js`;
  - create a temporary admin with the `create-admin` block in DEPLOYMENT.md B4;
  - run `docker compose up -d app`, sign in, then go to Backup & restore → upload → review → restore.

  The temporary admin is replaced by the restored accounts.

**6. Verify records and attachments.**

```bash
docker compose ps                                   # app → healthy
./scripts/smoke-test.sh http://127.0.0.1:8090
docker compose run --rm app node dist-server/backup.js list
```

Then:

- Sign in with a restored administrator account. Every old session is invalid, so everyone signs in again.
- Compare the project count, payment totals and contract values with the counts shown by `validate`, or with the backup review page.
- Open several attachments (payment slips, signed contracts) and check users' project access.

**7. Configure the domain and HTTPS if needed.** Follow DEPLOYMENT.md **C2** (Caddy route, validate, reload). Then set `APP_ORIGIN=https://<domain>` in `.env`, run `docker compose up -d app` and `./scripts/smoke-test.sh https://<domain>`.

**8. Resume jobs and re-enable device notifications.**

- When the checks pass, resume jobs: Backup & restore → **Resume background jobs**, or `docker compose run --rm app node dist-server/backup.js resume-jobs && docker compose restart app`.
- Ask each user to sign in and turn push notifications on again, on each device (Notifications page).
- Old notifications are not re-sent: the notification history keeps their de-duplication keys.

Finally, take a fresh backup on the new server and copy it off-site.

## 6. Compatibility and limits

- **Versions:** a backup restores into the **same or a newer** application version.
  - Older backups get the newer database changes applied after loading.
  - A backup from a newer version is rejected with a message to install that version first.
  - Format version 1.
- **Database:** PostgreSQL 13 or newer (the stack uses 16).
  - The database user must be able to create schemas and rename `public`. The database owner can; the Compose `POSTGRES_USER` is a superuser.
- **Size:** one archive entry (a table's data, or one file) may be up to 8 GiB. Archives above `BACKUP_MAX_UPLOAD_MB` are not accepted for upload; use the CLI for larger ones.
- **Free space:**
  - a backup needs roughly the database size plus the attachments in `BACKUP_DIR`;
  - a restore needs the attachment size in the uploads volume, and about twice the database size, because the previous data is kept until it is discarded.
- **Previous data:** the previous data is kept as one `pre_restore_<date>_<time>` schema in the same database. The next restore drops it, or you drop it with `previous-db discard`.
  - While it exists, `scripts/backup.sh` (pg_dump) also includes it.
  - The `pgcrypto` extension (created by migration 001, not used by the application) may stay with the previous data. This is harmless.
- **Scope:**
  - full-system restore only: no merging, no single-project restore, one web application container per stack;
  - maintenance mode applies to the web process that runs the restore.
- **Not done:**
  - no encryption: protect the file yourself, for example with an encrypted disk or a password-protected storage location;
  - no signing: checksums detect corruption and accidental changes, not deliberate tampering. Only restore archives you created.

## 7. Troubleshooting

| Message | Meaning / action |
|---|---|
| "Another backup or restore operation is running" | Wait for it (one operation at a time, web and CLI) |
| "The web application is still running. Stop it first" | CLI restore: run `docker compose stop app` first |
| "This installation already has data … Add --replace-existing" | CLI restore on a non-empty installation |
| "Not enough free disk space" | Delete old archives (web page) or add disk space; nothing was changed |
| "The archive was rejected before any change: …" | Corrupt, truncated or incompatible archive. Download it again, or use matching application code |
| Jobs paused after a restart: "A restore was interrupted; the previous data was kept unchanged" | The server stopped during a restore. The database was rolled back and the files it had added were removed. Check, then resume jobs |
