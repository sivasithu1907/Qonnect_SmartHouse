# Update 7: Redesigned project dashboard and Prerequisites & documents

The dashboard follows the approved layout and keeps the app's existing colours (slate, sky, emerald, amber, rose), shared components and header. No demo data is included. Every figure comes from the selected project's saved records, using today's date in the configured time zone (`APP_TIMEZONE`, default Asia/Qatar).

## Dashboard, top to bottom

### 1. Project overview
- Project name and PIN, current phase(s), planned start, target finish, next milestone, and "View full timeline".
- Several phases can be current at once.
- **Next milestone** is the next open inspection hold point with a planned date. A warning appears when it falls within the next 14 days or depends directly on a blocked or on-hold task.
- **Task completion** = completed tasks ÷ tasks, never an average of phase percentages. With no tasks it shows "No tasks yet". It is labelled as not consultant-certified physical progress.

### 2. Construction phase tracker
- Shows each phase's number, name, status, completed / total tasks, progress bar, and planned dates or "Not scheduled".
- Status comes from task statuses only. The tracker scrolls sideways inside itself and has previous / next buttons.
- **Open details** lists the phase's tasks, with status, hold points, dates, assignee and dependencies. Each task opens in Timeline.

### 3. Financial overview
- Shows only for roles with budget and payments access, as before.
- **Confirmed control budget.** Shows "Needs confirmation" until an admin confirms it.
- **Actual paid** = recorded transfers.
- **Scheduled unpaid** = outstanding milestone balances.
- **Budget remaining** = confirmed control budget − actual paid. Over budget shows "Over budget by QAR …".
- **Spending vs control budget** bar and percentage. No percentage is shown for a QAR 0 budget.
- **Overdue** is shown as part of scheduled unpaid.
- Contract values are never added to these figures. The totals reuse the existing payments calculation.

### 4. Next 14 days
- Lists material deliveries (existing expected-date order and labels), task planned starts and finishes, and consultant and site visits, dated today to today + 13.
- Visit dates are worked out in the app's time zone.
- Tabs (All / Materials / Tasks / Visits & Inspections) show counts, and there is a search box. Items are in date order.
- **Open record** goes to the record in the current project. Overdue items are left out here; they appear in Needs attention.

### 5. Needs attention
- Lists overdue payments (finance roles only), overdue deliveries, blocked or on-hold tasks, a milestone within 14 days, a milestone waiting for a blocked task, and completed consultant visits from the last 30 days with no consultant report uploaded.
- It also shows the existing "awaiting confirmation" material count.
- Critical items come first, most overdue first. Each shows a text label and one link: View payment, Open material, View task or Open visit.
- The list shows "Showing 6 of N" with "Show all".

### 6. Project setup & prerequisites (collapsible)
- **Project setup** is the existing set of setup steps, completed from saved data.
- **Prerequisites & documents** is new. It holds records per project; none are created automatically.
  - Authorised users can add, edit, reorder, archive and restore items.
  - Each item has a title, status (Not started / In progress / Awaiting review / Completed / Not applicable), related phase, responsible person (a project member or a name), due date, notes, an optional linked **existing contract** (no duplicate upload), an optional document link, and uploaded files through the existing secure attachments.
  - **Completed** and **Not applicable** are recorded decisions. The app saves who decided, when, and the completion date (it can't be in the future), and adds an audit entry. Changing back clears the decision.
  - Uploading or opening a file never changes the status.
  - Not applicable items are left out of the completion count and shown separately.
  - Checklist progress is kept separate from task completion.
- Filters: All / Outstanding / Completed. A search box appears for longer lists. An empty list shows "Add the first item".

## Permissions
| Role | Prerequisites |
|---|---|
| Admin, Project manager | Read, add, edit, reorder, archive, record decisions, upload files |
| Viewer | Read; preview and download files |
| Contractor, Consultant | No access (the same rule as Contracts & Documents) |

- The rules are enforced on the server: project isolation (other projects get 404), same-project checks for phase, contract and responsible person, and archived projects are read-only (409).
- A linked contract's details follow the existing contracts permission.

## Database migration: `005_prerequisites.sql` (required, additive)
- Adds an empty `project_prerequisites` table.
- Widens the `attachments` record-type check to allow `prerequisite`.
- Existing data, files, budgets and payments are not touched.
- The previous app version ignores the new table, so a code-only rollback is enough.

## Staging update (backup first)

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
docker compose run --rm app node dist-server/migrate.js  # expect: Applying migration 005_prerequisites.sql
docker compose up -d app
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
```

Optional read-only check (expect 0):

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) AS prerequisites FROM project_prerequisites;"'
```

Don't run `seed.js`. Caddy and other services are not touched.

### Manual checks on staging (http://localhost:8091 through the SSH tunnel; Ctrl+F5 first)
1. Open each project's dashboard.
   - The figures match Payments (paid, pending, overdue) and project settings (control budget).
   - The colours match the rest of the app.
2. Click a phase card: its tasks are listed, and a task opens in Timeline.
3. In Next 14 days, switch tabs and search, then click Open record: the right material, task or visit opens in the same project.
4. In Needs attention, each action opens its record.
5. Add a prerequisite with a phase and a linked contract, and upload a PDF.
   - The status stays as it was.
   - Record Completed: the completion date and your name appear, and the Audit page lists the change.
6. Switch projects: no records from the other project appear.
7. Sign in as a viewer (read-only, no Add item) and as a contractor (no finance, no prerequisites).
8. Check on a phone or a narrow window: the page doesn't scroll sideways, and only the phase tracker scrolls.

## Rollback
- **Code only (normally enough):** `git checkout $(cat ~/smarthouse-staging-previous-commit.txt)`, set `APP_TAG` in `.env` to that commit, then `docker compose build app && docker compose up -d app`. The new table stays but goes unused.
- **Code and database:** after the code rollback, run `bash scripts/restore.sh backups/db-<stamp>.dump backups/uploads-<stamp>.tar.gz --yes` with the backup taken above. Anything entered after that backup is lost.

## Files
New:
- `migrations/005_prerequisites.sql`
- `server/routes/prerequisites.ts`
- `src/lib/dashboard.ts`
- `src/components/dashboard/ProjectOverview.tsx`
- `src/components/dashboard/FinanceOverview.tsx`
- `src/components/dashboard/UpcomingPanel.tsx`
- `src/components/dashboard/ProjectChecklist.tsx`
- `tests/dashboard-calc.test.ts`
- `tests/dashboard-api.test.ts`
- `tests/dashboard-ui.test.tsx`
- `tests/prerequisites.test.ts`
- this file

Changed:
- `server/routes/dashboard.ts` (next-14-days list, tasks, missing reports, transfer / unpaid counts, project dates)
- `server/app.ts` (route)
- `server/permissions.ts` (`prerequisites.read` / `prerequisites.write`)
- `server/routes/attachments.ts` (prerequisite files)
- `shared/constants.ts`
- `src/pages/Dashboard.tsx` (new layout)
- `src/components/ProjectHealth.tsx` (Needs attention with paging, setup row)
- `src/lib/projectHealth.ts` (attention items)
- `src/App.tsx` (the dashboard resets on project switch)
- `tests/migration.test.ts`
- `tests/project-health.test.ts`

Nothing has to be deleted. `src/components/charts.tsx` is no longer used by the dashboard and is left in place; it can be removed later.
