# Update 3: installable app, in-app alerts and web push

## What changed
- **Installable app (PWA).**
  - Manifest named "Qonnect Smart House" (short name "Qonnect"), standalone display, icons made from the Qonnect logo.
  - A service worker with safe updates: when a new version is ready, a banner offers a reload instead of the app switching versions mid-task.
  - **Install app** in the user menu. iPhone/iPad Home Screen steps are included, and browsers that can't install get a short explanation.
- **Caching is limited to the static shell and hashed `/assets/*`.** The service worker never intercepts `/api/*`, so no project data, payments, documents or other signed-in responses are cached. There are no offline edits and no queued writes.
- **Notifications page** (user menu → Notifications):
  - state: not supported / Add to Home Screen first (iOS) / not requested / blocked / enabled;
  - an Enable button, which is the only place the permission prompt can appear, and Qonnect never asks again after a block;
  - event-type choices filtered by role, a push on/off switch, project mutes, "my devices" and a test button.
- **Bell list** in the header with unread count, per-user read state and "mark all read". Tapping an alert opens the project and the exact record: the material or visit popup opens, the payment milestone is highlighted, and the timeline phase is expanded.
- **Events:**
  - site/consultant visit assigned or rescheduled;
  - timeline task assigned (new optional **Assigned user** field on tasks), due within 3 days, or overdue;
  - material delivery date changed, due within 3 days, or overdue;
  - payment milestone due within 3 days or overdue, sent only to roles with payment access.
  Minor edits (notes, quantities, status tweaks) don't notify, and the person making the change is never notified.
- **Web Push** with VAPID and end-to-end encrypted payloads. Payloads are generic, e.g. "Qonnect · PIN 70153699 — A payment milestone needs attention", with no amounts, names or notes.
  - Limited to 10 pushes per user per 10 minutes.
  - Each event is sent once.
  - Expired or repeatedly failing devices are removed automatically.

## Database migration: `migrations/003_notifications_push.sql`
- **Additive only.** It adds four new tables (`push_subscriptions`, `notification_preferences`, `notification_project_mutes`, `notifications`) and one nullable column, `timeline_tasks.assigned_user_id`. No existing row is changed or deleted.
- Runs in one transaction.
- The previous app version still works on the migrated database, so a code-only rollback is enough.

## New settings (all optional)
| Variable | Purpose |
| --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push key pair, one per stack. Push stays off while blank. |
| `VAPID_SUBJECT` | `mailto:` address you monitor |
| `PUSH_ALLOWED_HOSTS` | Extra push-service hosts. The major services are allowed by default. |
| `NOTIFY_SCHEDULER` | Hourly due-soon/overdue checks, default `true` |

Without the VAPID keys, the app works as before, plus the bell list. The first hourly check runs about 1 minute after start. It adds one bell entry per item that is already due or overdue, and pushes only to devices where users have enabled push.

## Staging update (backup first)

```bash
cd /opt/qonnect-smarthouse-staging
bash scripts/preflight.sh --update
bash scripts/backup.sh
git rev-parse --short HEAD | tee ~/smarthouse-staging-previous-commit.txt
git fetch origin && git log --oneline HEAD..origin/main
git pull --ff-only origin main
sed -i "s/^APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" .env
docker compose build app
docker compose stop app
docker compose run --rm app node dist-server/migrate.js   # expect: Applying migration 003_notifications_push.sql
docker compose up -d app
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
```

Then turn on push for staging with DEPLOYMENT.md **B8**. It generates keys on the server straight into `.env` and recreates the app container. Don't run `seed.js`. Caddy and other services are not touched.

## Manual device tests (staging)

Push and install need HTTPS, or `http://localhost:8091` through the SSH tunnel on your computer. Phones need the HTTPS domain, so test them once the Caddy route exists.

1. **Desktop Chrome/Edge (tunnel):**
   1. Sign in, then open the user menu → **Install app** → Install. It opens in its own window.
   2. Go to Notifications → **Enable notifications** → Allow. The status should show "Enabled on this device".
   3. Tap **Send test notification**; a system notification should appear.
   4. Click the notification; Qonnect comes to the front.
2. **Real event:**
   1. As a manager, assign a site visit to a second test user who enabled push in another browser profile.
   2. That user gets "A site visit has been assigned to you."
   3. Tapping it opens the visit popup.
3. **Denied flow:**
   1. In a fresh browser profile, tap Enable → **Block**.
   2. The page shows "Blocked in this browser" with instructions and no Enable button.
   3. Reload: the browser doesn't ask again.
4. **Turn off:** "Turn off on this device" removes the device from **My devices**. The test button then reports that no device received it.
5. **Android Chrome (HTTPS domain only):** open the site, then menu → Install app (or Add to Home screen). Repeat steps 1.2–1.4.
6. **iPhone/iPad, iOS/iPadOS 16.4 or later (HTTPS domain only):**
   1. In Safari, tap Share → **Add to Home Screen**, then open Qonnect from the icon and sign in.
   2. Go to Notifications → Enable → Allow, then send a test.
   3. In Safari itself (not installed), the page correctly shows "Add to Home Screen first".
7. **Sign-out on a shared device:** signing out detaches that device, so it stops receiving the user's alerts.

## Rollback
- **Code only (normally enough):** `git checkout $(cat ~/smarthouse-staging-previous-commit.txt)`, set `APP_TAG` in `.env` to that commit, then `docker compose up -d app`. The new tables stay but go unused, and the VAPID lines in `.env` are ignored.
- **Code and database:** `bash scripts/restore.sh backups/db-<stamp>.dump backups/uploads-<stamp>.tar.gz --yes` with the backup taken above. Anything entered after that backup is lost.
- Pages still load the rolled-back version, because the service worker fetches pages from the network first and hashed assets are fetched on demand. To clear it completely, remove the site data in the browser.

## Tested for this update (sandbox)
- `npm run typecheck`: clean. `npm run build`: OK.
- `npm test`: 122 tests in 13 files pass against PostgreSQL 16. They cover:
  - CSRF and validation;
  - endpoint allowlist, duplicates and ownership;
  - preferences and project mutes;
  - role filtering (payments go only to admin/PM/viewer);
  - cross-project isolation;
  - per-user read state;
  - 410 and repeated-failure cleanup;
  - rate limit and deduplication;
  - the "server not configured" and malformed-VAPID cases;
  - migration safety on existing data.
- **Real `web-push` delivery to a local HTTPS push-service stand-in.** The payload was decrypted like a browser would (aes128gcm) and the VAPID signature was verified.
- **Chromium (Playwright) against the production build:**
  - The manifest has no errors, and the page is installable (no installability errors in a normal profile).
  - The service worker controls the page, and the cache holds only shell and `/assets` files (nothing from `/api`).
  - A push delivered to the service worker shows the notification with the Qonnect icon.
  - The blocked state shows the explanation without an Enable button. The not-yet-requested state shows the Enable button. An iPhone Safari user agent shows the Home Screen steps.
  - Deep links open the record after login.
- **Not tested:** delivery through real Google/Mozilla/Apple push services and real phones (the sandbox can't reach them), and the Docker image build.
