# Update 8.2: PDF View (file preview) fix

A server-side header fix for viewing stored files, plus readable error pages. There is no migration and no seed. No saved record, file, amount or setting changes. Existing uploads work as they are and don't need to be uploaded again.

## What was wrong
Every stored-file response, both **View** (`/download?inline=1`) and **Download**, carried the same Content-Security-Policy:

```
sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'
```

`sandbox` without `allow-scripts` removes script and extension permissions from the document. Chromium's built-in PDF viewer is an extension that needs both, so a sandboxed PDF tab can be refused, and Chromium reports that as `ERR_BLOCKED_BY_CLIENT`.

**Download** was not affected, because an `attachment` response is saved and never rendered. **Images** are not affected either, because they render without the viewer.

**Verified on a local copy:**
- The View and Download responses differ only in `Content-Disposition`. Both return the real PDF bytes (`%PDF-`) with `application/pdf`, not a login or error response.
- The service worker never intercepts `/api/`, so it doesn't touch file requests.
- The Caddy example adds no headers.

**Not confirmed:** in the Chromium 141 used for testing, the old sandboxed PDF still rendered, so the exact `ERR_BLOCKED_BY_CLIENT` wasn't reproduced. The headers your browser receives through Caddy, and the Chrome version and extensions involved, are still to be checked. See "Collecting headers" below.

## What changed
- **PDF View** keeps `inline` with `application/pdf`. Its policy has no `sandbox` but still blocks everything else:
  ```
  default-src 'none'; object-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
  ```
  That means no page scripts, connections, forms, framing or base-URL changes. This policy applies only to a PDF View response.
- **Downloads and image previews** keep the fully sandboxed policy, now with `frame-ancestors 'none'` added.
- **Preview only when the bytes still match.** At View time the stored file's first bytes are checked against its saved type. If they don't match, the file is sent as a download.
- **Unsupported types** (DOCX, XLSX, HEIC) are always downloaded, even if `inline=1` is requested.
- **Filenames:** `Content-Disposition` now carries an ASCII `filename="…"` fallback as well as the exact UTF-8 `filename*`. Quotes, `;`, `%` and control characters are made safe.
- **Other headers:** `Content-Length` is added, and `Cache-Control: private, no-store, max-age=0` keeps private files out of browser and shared caches. The service worker still ignores `/api/`, and there's a test for View navigations.
- **Readable errors:** when a View tab opens with an ended session, no access, or a missing or archived file, it now shows a short page instead of raw JSON. The pages say "Sign in to view this file", "You can't view this file" and "File not available". The app's own requests still get JSON.
- **Access rules are unchanged.** Login, project isolation, role checks and per-record access apply to View and Download exactly as before. There's one shared server route and one shared `Attachments` component, so payments, consultant reports, contracts, prerequisites, materials, site visits and work updates all get the same fix.

## Files
Changed:
- `server/routes/attachments.ts`
- `server/app.ts`
- `shared/constants.ts`
- `src/components/Attachments.tsx`
- `tests/service-worker.test.ts`

New:
- `tests/file-preview.test.ts`
- this file

## Staging update
```bash
cd /opt/qonnect-smarthouse-staging
bash scripts/preflight.sh --update
bash scripts/backup.sh
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/qcheck.sql > ~/staging-before-update82.txt
git rev-parse --short HEAD | tee ~/smarthouse-staging-previous-commit.txt
git fetch origin && git log --oneline HEAD..origin/main
git pull --ff-only origin main
sed -i "s/^APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" .env
docker compose build app
docker compose stop app
docker compose run --rm app node dist-server/migrate.js   # expect: Database schema is up to date
docker compose up -d app
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/qcheck.sql > ~/staging-after-update82.txt
diff ~/staging-before-update82.txt ~/staging-after-update82.txt && echo "no data changed"
```

**Rollback** (code only):
```bash
PREV=$(cat ~/smarthouse-staging-previous-commit.txt)
git checkout "$PREV" && sed -i "s/^APP_TAG=.*/APP_TAG=$PREV/" .env
docker compose build app && docker compose up -d app
# later, before the next pull: git checkout main
```

For production, use the same steps in `/opt/qonnect-smarthouse` after a fresh backup. The smoke test URL is https://qonnectsh.duckdns.org.

## Collecting headers (no cookies or passwords)
In Chrome:
1. Open the payment, press **F12** and open the **Network** tab. Tick **Preserve log**.
2. Click **View** on the PDF. In the new tab, open DevTools again and reload.
3. Select the `download?inline=1` request. Copy only the **Status Code** and the **Response Headers**. Do **not** copy Request Headers, because they contain your session cookie.
4. Note the Chrome version (`chrome://version`) and test the same View in an **Incognito** window, where extensions are off unless you allowed them.

To see any headers Caddy adds, run this on the server. It sends no credentials, so it returns the 401 page:
```bash
curl -sS -D - -o /dev/null -H 'Accept: text/html' 'https://qonnectsh.duckdns.org/api/projects/00000000-0000-0000-0000-000000000000/attachments/00000000-0000-0000-0000-000000000000/download?inline=1'
```
