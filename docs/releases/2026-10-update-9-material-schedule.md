# Update 9: Simplified material dates (owner delivery / contractor work)

This update adds **one migration: `006_material_schedule.sql`**. It only adds four nullable columns:
- `planned_completion_date`
- `actual_completion_date`
- `delivery_schedule_confirmed_at`
- `work_schedule_confirmed_at`

No existing column, date, status, quantity or record is changed, moved or deleted, and no seed runs. Payments, budgets, contracts and uploads are not touched.

## What users see
| Supply responsibility | Section | Dates |
|---|---|---|
| Owner supply | **Delivery schedule** | Planned delivery date, Actual delivery date (quantity ordered / delivered kept) |
| Contractor supply | **Work schedule** | Planned completion date, Actual completion date (no delivery dates, no ordered / delivered tracking) |
| Needs confirmation | **Schedule** | No dates assumed. A prompt asks for Owner or Contractor supply first. |

- **Removed from the normal form:** Required on site / supply due, Supplier-confirmed delivery, Revised delivery and Delivery date note. Their saved values stay. When a line has any of them, they are shown under a collapsed **Previous date details** section, which does not appear on new lines.
- **Changing the planned date:** edit Planned delivery (or Planned completion) when plans change. Every change is kept in the audit history (`delivery_date_change` with before / after).
- **Switching responsibility:** the matching fields are shown at once. Hidden fields are never cleared on save, and only the visible fields are validated. If the new workflow needs a date confirmed, the form says so.

## Historical dates
**When a line is flagged "Dates need review"** (computed from saved values; nothing is stored or changed):
- **Owner supply:** an older field (required on site, supplier-confirmed or revised) holds a date and either the planned delivery is blank or the older date differs from it. An older field with the *same* date as the planned delivery is not a conflict.
- **Contractor supply:** the line has old delivery dates but no planned or actual completion. Old delivery dates are **never** reinterpreted as completion dates.
- **Needs confirmation:** the line has any saved date. Choose a responsibility first.

**While flagged:**
- The line keeps its **previous deadline and reminders** (revised > supplier-confirmed > planned > required on site), labelled e.g. "Required on site (previous date)".
- Nothing is silently replaced or dropped.
- The list, schedule (dashed amber marker), dashboard and CSV identify the date as a previous date awaiting review.

**How a flagged line is reconciled:** an admin or project manager confirms it in the line's form. This calls `POST /materials/:id/confirm-schedule`, which is project-scoped, needs materials.write and is audited as `schedule_confirmed`.
- **Owner supply:** choose which saved date (planned, required on site, supplier-confirmed or revised) becomes the planned delivery. "None" is offered only when the planned delivery is blank.
- **Contractor supply:** choose a saved date for the planned completion, or "Don't use an older date". Optionally confirm that the actual delivery date was also the actual completion. Nothing is preselected.
- Older fields always keep their values.

**After confirmation:**
- The simplified planned date is the only deadline.
- Previous dates are reference only.
- Obsolete revised / confirmed / required-on-site markers disappear from the schedule legend once no line is under review.

## Status and overdue rules
- **Owner supply:** overdue when the planned delivery has passed and delivery is outstanding. Outstanding means no actual delivery and no Delivered / Accepted status, **or** a partial delivery: status Partially Delivered, or some but not all of the ordered quantity delivered.
- **Contractor supply:** overdue when the planned completion has passed and there is no actual completion date. A Delivered status is material arrival, not completed work.
- **Excluded:** cancelled and archived lines. Inspection stays separate.
- **Nothing is completed automatically:** no line becomes complete because a date passed.
- **Contradictions are shown as warnings in the form; nothing is changed automatically.** For example:
  - Delivered without an actual date;
  - an actual date with a pre-delivery status;
  - less delivered than ordered;
  - Partially Delivered with the full quantity.
- **Blocked:** an actual delivery or completion date later than today (application time zone).
- **Date-only values** are compared as YYYY-MM-DD strings, so there are no time-zone shifts.

## Views updated
- **Material forms and read-only details:** the new schedule sections.
- **List and mobile cards:** a single Schedule column; ordered / delivered shown as "n/a" for contractor lines.
- **Filters:** the "Overdue" filter, plus a new "Dates need review" filter.
- **Header counts:** category headers show how many lines have dates to review.
- **Overdue KPI:** split into deliveries and contractor work.
- **Schedule:**
  - Week / month view and the timeline overlay ("Include materials & contractor work") use the new markers: planned delivery, actual delivery, planned completion, actual completion, and previous date awaiting review.
- **Dashboard:**
  - **Next 14 days:** "Material delivery" and "Contractor work" are labelled separately.
  - **Needs attention:** "Overdue delivery" and "Overdue contractor work" are listed separately, plus "Material dates need review".
  - **Setup checklist:** wording updated for the new dates.
- **CSV:** new columns Schedule, Planned date, Actual date, Deadline used, Date review and Overdue. Every saved field is kept: planned / actual delivery and completion, plus previous required-on-site, supplier-confirmed, revised and date note.
- **Reminders:** they use the same rule. The dedupe key is unchanged (`material.overdue|due_soon:<line>:<date>`), so a line whose deadline date doesn't change is never reminded twice. Contractor work reminders say "Contractor work is due soon / overdue".

## Files
Changed:
- `server/app.ts`
- `server/notify/events.ts`
- `server/notify/scheduler.ts`
- `server/permissions.ts`
- `server/routes/dashboard.ts`
- `server/routes/materials.ts`
- `src/components/dashboard/UpcomingPanel.tsx`
- `src/components/materials/MaterialCategorySection.tsx`
- `src/components/schedule/GanttChart.tsx`
- `src/components/schedule/MaterialSchedule.tsx`
- `src/components/schedule/ScheduleMarks.tsx`
- `src/components/ui.tsx` (RecordForm: section headings, conditional fields, custom blocks)
- `src/lib/dashboard.ts`
- `src/lib/materialFilters.ts`
- `src/lib/projectHealth.ts`
- `src/lib/schedule.ts`
- `src/lib/types.ts`
- `src/pages/AuditLog.tsx`
- `src/pages/Materials.tsx`
- `src/pages/Timeline.tsx`
- `tests/dashboard-api.test.ts`
- `tests/dashboard-calc.test.ts`
- `tests/dashboard-ui.test.tsx`
- `tests/material-filters.test.ts`
- `tests/material-list.test.tsx`
- `tests/migration.test.ts`
- `tests/schedule-fixtures.ts`
- `tests/schedule-views.test.tsx`
- `tests/schedule.test.ts`

New:
- `migrations/006_material_schedule.sql`
- `shared/materialSchedule.ts`
- `src/components/materials/MaterialScheduleParts.tsx`
- `tests/material-schedule.test.ts`
- this file

## Staging update (with migration)
One-time helper: a fingerprint of every saved material date, status and quantity.
```bash
cat > ~/matdates.sql <<'SQL'
SELECT count(*), md5(string_agg(concat_ws('|', id, required_on_site_date, planned_delivery_date, confirmed_delivery_date, revised_delivery_date, actual_delivery_date, delivery_date_note, status, qty_ordered, qty_delivered, supply_responsibility, archived_at), ',' ORDER BY id)) FROM material_items;
SQL
```
```bash
cd /opt/qonnect-smarthouse-staging
bash scripts/preflight.sh --update
bash scripts/backup.sh
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/qcheck.sql > ~/staging-before-update9.txt
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' < ~/matdates.sql > ~/staging-matdates-before.txt
git rev-parse --short HEAD | tee ~/smarthouse-staging-previous-commit.txt
git fetch origin && git log --oneline HEAD..origin/main
git pull --ff-only origin main
sed -i "s/^APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" .env
docker compose build app
docker compose stop app
docker compose run --rm app node dist-server/migrate.js   # expect: Applying migration 006_material_schedule.sql
docker compose up -d app
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/qcheck.sql > ~/staging-after-update9.txt
diff ~/staging-before-update9.txt ~/staging-after-update9.txt && echo "no data changed"
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' < ~/matdates.sql > ~/staging-matdates-after.txt
diff ~/staging-matdates-before.txt ~/staging-matdates-after.txt && echo "material dates unchanged"
```

## Rollback
The app code can be rolled back on its own: the previous version ignores the four new columns. The migration is left in place, because it removed nothing and dropping columns would delete any completion dates entered since.
```bash
PREV=$(cat ~/smarthouse-staging-previous-commit.txt)
git checkout "$PREV" && sed -i "s/^APP_TAG=.*/APP_TAG=$PREV/" .env
docker compose build app && docker compose up -d app
# before the next pull: git checkout main
```
Use `scripts/restore.sh` with the backup taken above only if a full database restore is ever needed.
