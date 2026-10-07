# Deployment guide — GitHub → staging → (later) production

Repository: `https://github.com/sivasithu1907/Qonnect_SmartHouse.git` · branch: **`main`**

Smart House runs on the existing cloud server (the one hosting the **Qonnect Operations Monitor**) as **two separate Docker Compose projects**:

| Stack | Compose project name | Localhost port | Env template | Checkout path (proposed — confirm) |
| --- | --- | --- | --- | --- |
| Staging | `qonnect-smarthouse-staging` | `127.0.0.1:8091` | `deploy/staging.env.example` | `/opt/qonnect-smarthouse-staging` |
| Production | `qonnect-smarthouse` | `127.0.0.1:8090` | `deploy/production.env.example` | `/opt/qonnect-smarthouse` |

Each stack has its own containers, PostgreSQL database, private network, data volume, uploads volume and `.env`. Neither stack joins, restarts or reconfigures the Operations Monitor, its database or Caddy.

**Ground rules on this shared server**

- Run `docker compose …` only inside the Smart House checkout directory (it reads that directory's `.env`).
- Never run `docker compose down -v`, `docker system prune`, `docker volume prune` or `docker network prune` — they can remove other projects' data.
- Passwords and admin credentials are typed on the server only. They are never committed, emailed or pasted into chat.
- Google Drive / Sheets links stay blank until you add them in the app. The control budget, approved amounts, the Installation 15% basis and the source grand totals stay unconfirmed / *Needs review* — nothing in deployment changes them.

**This release: do Parts A and B only.** Part C (production, Caddy route) is for later, after you've reviewed staging.

---

## Part A — Put the code on GitHub (your workstation)

The repository is currently empty. From the unzipped project folder:

```bash
unzip qonnect-smarthouse.zip
cd qonnect-smarthouse

git init -b main
git add .
git status --short | grep -E '(^|/)\.env$|node_modules|dist/|backups/|data/' && echo "STOP: unwanted files staged" || echo "clean"
git commit -m "Smart House: secure multi-project production app"
git remote add origin https://github.com/sivasithu1907/Qonnect_SmartHouse.git
git push -u origin main
```

GitHub asks for your username and a **personal access token** (not your password) for HTTPS pushes, or use SSH (`git@github.com:sivasithu1907/Qonnect_SmartHouse.git`) if your key is registered.

Alternative without git: on GitHub open the repository → **Add file → Upload files**, drag the *contents* of the `qonnect-smarthouse` folder (including the hidden `.gitignore`, `.dockerignore`, `.env.example`), and commit to `main`. Do not upload any real `.env` file.

The repository contains only `.env.example` and `deploy/*.env.example` templates (no secrets). `.gitignore` excludes `.env`, `node_modules/`, build output, `data/`, `backups/` and the optional Caddy override.

---

## Part B — Staging on the server

### B1. Read-only checks (changes nothing)

```bash
docker compose version                                   # needs Compose v2
docker ps --format 'table {{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}'
docker volume ls --format '{{.Name}}' | grep -i smarthouse || echo "no smarthouse volumes yet"

# are 8091 (staging) and 8090 (production) free?
for p in 8091 8090; do
  if sudo ss -ltnp "( sport = :$p )" | grep -q LISTEN; then echo "port $p IN USE:"; sudo ss -ltnp "( sport = :$p )"; else echo "port $p free"; fi
done
docker ps --format '{{.Names}} {{.Ports}}' | grep -E ':(8090|8091)->' || echo "no container publishes 8090/8091"
df -h /var/lib/docker
```

If either port is in use, pick another free port and use it in that stack's `.env` (`APP_PORT`) and, later, in the Caddy route.

The server needs outbound access to Docker Hub for `node:22-bookworm-slim`, `postgres:16-alpine` and (for backups) `alpine:3`.

### B2. Clone and configure

```bash
STAGING_DIR=/opt/qonnect-smarthouse-staging          # confirm or change
sudo mkdir -p "$STAGING_DIR" && sudo chown "$USER": "$STAGING_DIR"
git clone --branch main https://github.com/sivasithu1907/Qonnect_SmartHouse.git "$STAGING_DIR"
cd "$STAGING_DIR"

cp deploy/staging.env.example .env
chmod 600 .env
# generate a URL-safe database password directly into .env (never displayed or typed)
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
grep -v '^POSTGRES_PASSWORD=' .env                   # review the other settings
```

`openssl rand -hex 32` produces 64 characters of `0-9a-f`, which is safe in URLs, shell and Compose files. The app also receives the database credentials as separate values (`DB_USER`, `DB_PASSWORD`, …) and URL-encodes them itself, so a password with reserved characters would still connect — but avoid `$`, quotes and spaces, which Compose and shell would interpret. Don't use raw Base64 output.

### B3. Preflight (read-only)

```bash
./scripts/preflight.sh
```

It checks: Compose version, `.env` permissions and git-ignore, that the password is set and safe, **that port 8091 is free** (no other process or container), that no resources named `qonnect-smarthouse-staging` exist yet, and it lists the other Compose projects on the host (for information only). Continue only when it prints **Preflight passed**.

### B4. Build and start staging

```bash
cd /opt/qonnect-smarthouse-staging
export APP_TAG=$(git rev-parse --short HEAD)
sed -i "s/^APP_TAG=.*/APP_TAG=$APP_TAG/" .env

docker compose build app                                   # image: qonnect-smarthouse-staging-app:<commit>
docker compose up -d db                                    # staging database only
docker compose run --rm app node dist-server/migrate.js    # create tables
docker compose run --rm app node dist-server/seed.js       # the two supplied projects (skips existing codes)
```

Create the first admin. You type the values; they are not echoed or saved to files or shell history:

```bash
read -rp  "Admin email: " ADMIN_EMAIL
read -rp  "Admin name: "  ADMIN_NAME
read -rsp "Admin password (12+ chars, letters and numbers): " ADMIN_PASSWORD; echo
export ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD
docker compose run --rm -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD app node dist-server/create-admin.js
unset ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD
```

Start the app and verify:

```bash
docker compose up -d app
docker compose ps                                          # app → "healthy" within ~30 s
./scripts/smoke-test.sh http://127.0.0.1:8091
docker ps --format '{{.Names}} {{.Status}}' | grep -v smarthouse   # Operations Monitor containers: unchanged
```

Optional logged-in smoke test (credentials typed, not stored):

```bash
read -rp "Email: " SMOKE_EMAIL; read -rsp "Password: " SMOKE_PASSWORD; echo
SMOKE_EMAIL="$SMOKE_EMAIL" SMOKE_PASSWORD="$SMOKE_PASSWORD" ./scripts/smoke-test.sh http://127.0.0.1:8091
unset SMOKE_EMAIL SMOKE_PASSWORD
```

Take the first staging backup:

```bash
./scripts/backup.sh
```

### B5. Review staging from your computer (no Caddy change)

Staging is bound to `127.0.0.1` on the server, so open it through an SSH tunnel:

```bash
ssh -N -L 8091:127.0.0.1:8091 <user>@<server>
# then browse:  http://localhost:8091
```

Browsers accept `Secure` cookies on `http://localhost`, so login works with `COOKIE_SECURE=true`. If your browser still drops the session, set `COOKIE_SECURE=false` in the **staging** `.env` only and run `docker compose up -d app`.

### B6. Staging review checklist

1. The header shows **Umm Garn — PIN 70153699**; the selector also lists **Umm Garn — PIN 70153016**. The **Drive** button is dashed (no link yet).
2. **Master Items & Budget** (PIN 70153699): fixed costs 509,500.00 / 28,000.00 / 35,000.00; 16 categories with Variant A / B; every approved amount shows *Needs confirmation*; the summary figures (Installation 15%, grand totals, …) show *Needs review*; the control budget shows *Needs confirmation*.
3. **Payments**: QAR 0.00 paid, no milestones.
4. **Material Supply**: 40 lines, all *Status not confirmed*; only Ceramic tiles, Porcelain tiles, Marble and Granite show 10/10/2026; gypsum lines show *Contractor confirmation required*.
5. **PIN 70153016**: no prices, no material lines, no payments.
6. **Users & access**: create a test user per role (assigned to PIN 70153699 only) and check each role's access (README → Roles).
7. Optional functional test: schedule a payment, record a transfer, upload a PDF slip, then archive the test milestone. Keep test data on staging only.

Staging can stay running on its localhost port, or be paused with `docker compose stop` (data kept). To reset staging completely later, ask first — deleting its volumes is irreversible.

### B7. Updating staging after new commits

```bash
cd /opt/qonnect-smarthouse-staging
./scripts/preflight.sh --update
./scripts/backup.sh
git fetch origin && git log --oneline HEAD..origin/main
git pull --ff-only origin main
export APP_TAG=$(git rev-parse --short HEAD); sed -i "s/^APP_TAG=.*/APP_TAG=$APP_TAG/" .env
docker compose build app
docker compose stop app
docker compose run --rm app node dist-server/migrate.js
docker compose up -d app
./scripts/smoke-test.sh http://127.0.0.1:8091
```

### B8. Push notifications (optional, per stack)

Push stays off until the stack has its own VAPID keys. The bell list works without them. Generate the keys **on the server** and write them straight into `.env`, so the private key is never shown or typed. Use separate keys for staging and production.

```bash
cd /opt/qonnect-smarthouse-staging            # or /opt/qonnect-smarthouse for production
grep -q '^VAPID_PRIVATE_KEY=.' .env && echo "keys already set - leave them" || {
  sed -i '/^VAPID_PUBLIC_KEY=/d;/^VAPID_PRIVATE_KEY=/d' .env
  docker compose run --rm --no-deps -T app node dist-server/generate-vapid-keys.js | grep '^VAPID_P' >> .env
}
grep -q '^VAPID_SUBJECT=.' .env || { sed -i '/^VAPID_SUBJECT=/d' .env; echo 'VAPID_SUBJECT=mailto:YOUR-ADDRESS' >> .env; }
nano .env                                     # replace YOUR-ADDRESS with a mailbox you monitor
chmod 600 .env
docker compose up -d app                      # recreates the app container with the new settings
docker compose logs --tail=5 app              # expect: "web push enabled; due-date checks on"
```

Keep the keys once they are set: new keys mean every device has to enable push again. Web push and installation need a secure context. That means HTTPS on the public domain, or `http://localhost:8091` through the SSH tunnel, which only works on the computer running the tunnel. Phones therefore need the HTTPS Caddy route (C2).

---

## Part C — Later: production and the Caddy route (do not run yet)

### C1. Production stack

Same steps as Part B, with the production template, path and port:

```bash
APP_DIR=/opt/qonnect-smarthouse                        # confirm or change
sudo mkdir -p "$APP_DIR" && sudo chown "$USER": "$APP_DIR"
git clone --branch main https://github.com/sivasithu1907/Qonnect_SmartHouse.git "$APP_DIR"
cd "$APP_DIR"
cp deploy/production.env.example .env && chmod 600 .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env   # different from staging
./scripts/preflight.sh                                 # must confirm port 8090 is free
# then B4 (build, db, migrate, seed, create admin, up, smoke test on :8090) and ./scripts/backup.sh
```

Production starts with only the seeded source data; staging test records are not copied.

### C2. Caddy route (your decision; nothing is applied automatically)

First find out how Caddy runs (read-only):

```bash
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -i caddy || systemctl status caddy --no-pager
CADDY=<caddy container name from above>
docker inspect "$CADDY" --format 'network mode: {{.HostConfig.NetworkMode}}'
docker inspect "$CADDY" --format '{{range $k,$v := .NetworkSettings.Networks}}network: {{$k}}{{"\n"}}{{end}}'
docker inspect "$CADDY" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' | grep -i caddy   # where the Caddyfile lives
```

Then use `deploy/Caddyfile.smarthouse.example`:

- **Option A — Caddy on the host or `network_mode: host`:** add the Option A block with your subdomain; it proxies to `127.0.0.1:8090`.
- **Option B — Caddy in a container on a bridge network:** Caddy can't reach the app's localhost port. Attach only the Smart House app to Caddy's network with `deploy/compose.caddy-network.example.yml` (it changes only the Smart House stack; the database stays private), then add the Option B block (`reverse_proxy qonnect-smarthouse-web:8080`).

Applying the route is a change to the shared Caddy config, so do it at a time you choose: back up the Caddyfile, add the new site block (leave the Operations Monitor's block untouched), validate it (`caddy validate`, or `docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile`), then reload Caddy gracefully (`caddy reload` / `docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile`). A reload doesn't restart the container or drop the Operations Monitor. Finally set `APP_ORIGIN=https://<subdomain>` in the production `.env`, run `docker compose up -d app`, and run `./scripts/smoke-test.sh https://<subdomain>`.

### C3. Updating production

```bash
cd /opt/qonnect-smarthouse
git rev-parse --short HEAD | tee ~/smarthouse-previous-commit.txt
./scripts/preflight.sh --update
./scripts/backup.sh
git fetch origin && git log --oneline HEAD..origin/main
git diff --stat HEAD..origin/main -- migrations/
git pull --ff-only origin main
export APP_TAG=$(git rev-parse --short HEAD); sed -i "s/^APP_TAG=.*/APP_TAG=$APP_TAG/" .env
docker compose build app                    # old version keeps serving while this builds
docker compose stop app                     # downtime starts (this app only, typically 1–3 min)
docker compose run --rm app node dist-server/migrate.js
docker compose up -d app
./scripts/smoke-test.sh http://127.0.0.1:8090
```

Migrations are forward-only and transactional; a migration file changed after being applied is rejected.

### C4. Rollback

- **Code only:** `git checkout $(cat ~/smarthouse-previous-commit.txt)`, set `APP_TAG` in `.env` to that commit, `docker compose up -d app` (reuses the previous image; if it was removed, `docker compose build app` first).
- **Code and data:** after the code rollback, `./scripts/restore.sh backups/db-<STAMP>.dump backups/uploads-<STAMP>.tar.gz --yes`. It stops only this app and replaces only this project's database and uploads. Anything entered after that backup is lost.

### C5. Backups

**Full backup & restore (recommended for disaster recovery):** Settings → **Backup & restore** in the app (administrators), or `docker compose run --rm app node dist-server/backup.js create|validate|restore`. One verified archive holds the database and every uploaded file and can be restored on a new server — see [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) for usage and the A–Z recovery guide.

The script below remains available as an additional server-level copy (database dump + uploads volume):

`./scripts/backup.sh` writes `backups/db-<stamp>.dump`, `uploads-<stamp>.tar.gz` and checksums (mode 600). Optional nightly cron, 30-day retention:

```
15 2 * * * cd /opt/qonnect-smarthouse && ./scripts/backup.sh >> backups/backup.log 2>&1 && find backups -type f -mtime +30 -delete
```

Copy backups off the server regularly, and test a restore on staging now and then.

---

## Operations reference

| Task | Command (inside the stack's directory) |
| --- | --- |
| Status | `docker compose ps` |
| Health | `curl -fsS http://127.0.0.1:<port>/api/health` |
| Logs | `docker compose logs -f app` |
| Reset an admin password | re-run the admin block in B4 with the same email (sessions are revoked) |
| Pause / resume this stack only | `docker compose stop` / `docker compose up -d` |
| Database shell | `docker compose exec db psql -U smarthouse -d smarthouse` |
