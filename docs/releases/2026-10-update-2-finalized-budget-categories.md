# Update 2 — Qonnect branding, finalized-only budget, managed categories

## What changed

| Area | Change |
| --- | --- |
| Branding | Qonnect logo added as `public/qonnect-logo.png` (proportions kept) and used in the header and login screen; favicon (`favicon.ico`, `favicon-64.png`, `apple-touch-icon.png`); page title "Qonnect Smart House". |
| Budget | Variant A / Variant B labels, amounts and summary figures removed from the UI, dashboard, charts, CSV export and API responses. Each item shows one amount: **Approved / Finalized Amount (QAR)**, blank and *Needs confirmation* until an admin enters it. Totals and charts use finalized amounts, scheduled payment commitments and recorded payments. The misc allowance is calculated only on finalized amounts. A "Budget comparison sheet" button opens the project's linked Google Sheet. |
| Categories | New **Manage categories** tab (admins) in Master Items & Budget, also available from Material Supply. Add, rename, reorder, archive / restore, and delete only when unused (the error explains why). Budget and material forms use category dropdowns; free-text material categories are gone. Categories are per project. |
| Material popup | All dialogs now fit the screen: fixed title, scrolling content, Save / Cancel pinned at the bottom, page behind locked. Checked at 1400×900 and 390×740. |
| Related timeline task | Consultant visits, site visits and contractor work updates use a searchable dropdown ordered by timeline sequence ("7.2  Water / flood test…", grouped by phase). The task "Depends on" list uses the same order. |
| Placeholders | Placeholder text is light grey (slate-400) everywhere, including empty date and select fields. Entered text, labels and help text are unchanged. |

## Database migration — `migrations/002_finalized_budget_and_categories.sql`

- Creates `material_categories` from the existing material lines, per project and in their current order. Names that differ only by case or spacing are merged. Every line and scope note is linked (`category_id`), and no line is removed.
- Sets `projects.misc_basis` to `approved_finishing` and restricts it to that value.
- Clears only the exact seeded Variant A/B note text and renames seeded items such as "Floor (category estimate)" to "Floor". Notes you wrote are untouched.
- **Does not copy any variant or source amount into `approved_amount`, and does not delete any amount.** The old `source_amount`, `source_variant_a`, `source_variant_b` and `source_status` columns and the `source_references` table stay in the database, unchanged, but the app no longer reads them. This includes the three fixed-cost source amounts (509,500 / 28,000 / 35,000); an admin must enter a finalized amount for them to appear.
- Runs in one transaction. If anything fails, nothing is changed.
- Rollback-compatible: the previous app version still works on the migrated database. A trigger links lines that the older code saves by category name.

## Backup first, then update (staging)

```bash
cd /opt/qonnect-smarthouse-staging
bash scripts/preflight.sh --update
bash scripts/backup.sh                                   # note the db-/uploads- file names it prints
git rev-parse --short HEAD | tee ~/smarthouse-staging-previous-commit.txt
git fetch origin && git log --oneline HEAD..origin/main
git pull --ff-only origin main
sed -i "s/^APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" .env
docker compose build app
docker compose stop app
docker compose run --rm app node dist-server/migrate.js  # expect: Applying migration 002_finalized_budget_and_categories.sql
docker compose up -d app
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
```

Downtime is only for this app's staging stack, about 1–2 minutes. Don't run `seed.js` for this update; existing data is kept as it is.

## Rollback

- **Code only (normally enough):** `git checkout $(cat ~/smarthouse-staging-previous-commit.txt)`, set `APP_TAG` in `.env` to that commit, then `docker compose up -d app`. The migrated database works with the previous version. Note that the previous version would show the preserved legacy estimate values again.
- **Code and database:** after the code rollback, `bash scripts/restore.sh backups/db-<stamp>.dump backups/uploads-<stamp>.tar.gz --yes` with the backup taken above. Anything entered after that backup is lost.

## Tests run for this update

`npm run typecheck`, `npm test` (97 tests on PostgreSQL 16, including a migration test on first-release data and category management tests), `npm run build`. A browser check ran on a migrated copy of first-release data at desktop and mobile sizes.
