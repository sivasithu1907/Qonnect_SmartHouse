# Update 4: Material Supply schedule and Timeline Gantt

## What changed
- **Material Supply → List / Schedule.** List is still the default. The schedule:
  - shows one row per material line, grouped by category;
  - has week and month views, previous/next, Today, and "previous / next dated" jumps;
  - uses the existing category, status, responsibility, "assigned to me" and archived filters.
- **Expected delivery date.** The schedule uses the first date that exists, in this order:
  1. revised delivery
  2. supplier-confirmed delivery
  3. planned delivery
  4. required on site

  The label always says which field the date came from. A required-on-site date is shown as **Required on site** (dashed amber square), never as a supplier confirmation.
- **Other dates are shown separately.**
  - Actual delivery has its own green tick.
  - A required-on-site date still appears next to a delivery date, so lateness against the need-by date is visible.
  - Open lines whose expected date has passed without delivery are marked **Overdue**.
- **Not scheduled area.** Lines with no date at all are listed here. Nothing is filled in.
- **Clicking a line** opens the existing material dialog. Read-only users now see a labelled summary of every date in that dialog; before, they saw only the files.
- **Project Timeline → List / Gantt.** List is still the default. The Gantt:
  - groups tasks under their phases;
  - draws bars from each task's planned start → planned finish, with duration, status colour, hold-point icon and assigned user;
  - shows the phase bar from the phase's own dates, with the completed-task share;
  - draws dependency links (amber when a task is planned to start before its predecessor finishes);
  - has a today line, week/month zoom, scroll buttons and Today;
  - has an option to hide phases without dates.
- **Single dates in the Gantt.** A task with only a start or only a finish is shown as a "Start only" / "Finish only" marker, not stretched into a bar. Tasks with neither date are listed under **Not scheduled**.
- **Include material deliveries** (Gantt option) adds existing dated material lines as milestones under a Materials group, one row per category. It uses the same precedence, shapes and labels as the schedule. Clicking a milestone lists those lines, with a link to open each one in Material Supply.
- **Clicking a phase or task in the Gantt:** editors get the existing edit form. Everyone else gets a read-only summary.

## Safeguards
- **No dragging.** Dates change only through the existing edit forms and their usual save and dependency-confirmation steps.
- **Reads existing records only.** Both views read `/materials` and `/timeline` as before. No new records, no copied dates, no schedule tables.
- **No backend or database changes.** There is no migration in this update.
- **Permissions unchanged.** All server checks apply. Viewers, consultants and contractors still get 403 when changing task or phase dates, and contractors can change dates only on material lines assigned to them.

## Files
- New:
  - `src/lib/schedule.ts`
  - `src/components/schedule/ScheduleMarks.tsx`
  - `src/components/schedule/MaterialSchedule.tsx`
  - `src/components/schedule/GanttChart.tsx`
  - `tests/schedule.test.ts`
  - `tests/schedule-views.test.tsx`
  - `tests/schedule-fixtures.ts`
  - this file
- Changed:
  - `shared/calc.ts` (adds `expectedDeliveryDate`; the existing `effectiveDeliveryDate` is unchanged)
  - `src/pages/Materials.tsx`
  - `src/pages/Timeline.tsx`
  - `vitest.config.ts` (also runs `*.test.tsx`)

## Staging update (no migration)

```bash
cd /opt/qonnect-smarthouse-staging
bash scripts/preflight.sh --update
bash scripts/backup.sh
git rev-parse --short HEAD | tee ~/smarthouse-staging-previous-commit.txt
git pull --ff-only origin main
sed -i "s/^APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" .env
docker compose build app
docker compose stop app
docker compose run --rm app node dist-server/migrate.js   # expect: no pending migrations
docker compose up -d app
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
```

## Staging checks before production
1. Material Supply → Schedule, as admin:
   - Lines with dates appear in the right week and month.
   - The labels match the dates in each line's edit form.
   - Undated lines appear under Not scheduled.
   - The filters change both views.
2. Click a schedule entry. The existing edit form opens. Change a date, save, and the entry moves.
3. Timeline → Gantt:
   - Bars match each task's planned dates.
   - Dependency arrows appear and the today line is shown.
   - Week/Month zoom, the arrows and Today all scroll correctly.
   - "Include material deliveries" shows milestones, and "Open in Material Supply" opens the line.
4. Sign in as a viewer or consultant. Clicks open read-only summaries with no date fields.
5. As a contractor, only material lines assigned to them can be edited from the schedule.
6. On a phone: both views scroll horizontally, labels stay readable, and the page itself doesn't scroll sideways.

## Rollback
Code only: `git checkout $(cat ~/smarthouse-staging-previous-commit.txt)`, set `APP_TAG`, then `docker compose up -d app`. No data was changed by this update.

## Known limitations
- Weeks start on Sunday (Qatar working week). Weekends and holidays are not shaded, and durations are calendar days, not working days.
- Tasks have no percent-complete field. Progress is shown as status and completed / total tasks per phase, and nothing is estimated.
- In week zoom the month name appears at the start of each month only, so when you scroll mid-month, use the day numbers or tooltips.
- When several material lines fall in the same category on the same date in the Gantt, they share one marker with a count. The marker uses the first line's date kind, and the tooltip and click list show every line.
- Phase rows without their own dates show a dashed line covering their scheduled tasks. This is for display only, and the phase dates stay blank.

---

# Update 4.1: layout and "Not scheduled" refinements

- **Wider pages.** Material Supply and Project Timeline now use a fluid page width, up to 2400px, with responsive side padding (`src/lib/layout.ts`). The header and footer use the same width so everything lines up. Other pages keep the standard width.
  - Notice text is capped at a readable line length.
  - Dialogs and forms keep their own widths.
  - On very wide screens, the Timeline list uses a 3 + 1 column split.
  - In Gantt mode, contractor work updates are shown in columns.
- **Not scheduled** is a shared panel with:
  - the total count ("Not scheduled — 43 tasks");
  - a search box covering name, status, responsibility, assignee and phase/category name;
  - Expand all / Collapse all;
  - one expandable section per phase or category, with its item count. Sections start collapsed when there are more than 12 items in total.

  Expanded sections show readable rows: name, status, and supply responsibility (materials) or hold point and assignee (tasks). Clicking a row opens the existing edit form, or the read-only summary for read-only users.
- **Compact empty states.** "No dates entered yet" and "Nothing scheduled in this week/month" are now single-line messages. The week/month message keeps the earlier/later counts and the Previous dated / Next dated buttons inline. When there are no dates at all, the Gantt's Today and scroll buttons are disabled.
- **Controls and legends.** Legends wrap onto their own row on smaller screens. "Hide phases without dates" now says "(chart rows only)" and has a tooltip: hidden phases' tasks still appear under Not scheduled.
- Date rules, filters, permissions and the List/Schedule/Gantt behaviour are unchanged. No data changes, no migration.

Changed: `src/App.tsx`, `src/components/Header.tsx`, `src/components/ui.tsx` (notice text width), `src/components/schedule/MaterialSchedule.tsx`, `src/components/schedule/GanttChart.tsx`, `src/components/schedule/ScheduleMarks.tsx`, `src/pages/Timeline.tsx`, `tests/schedule-views.test.tsx`, this file.
New: `src/lib/layout.ts`, `src/components/schedule/UnscheduledPanel.tsx`.

Staging update: same steps as Update 4 (no migration).
