# Update 7.1: Dashboard polish

A presentation update to the project dashboard. It keeps the existing Qonnect colours, branding, calculations, permissions and data. There is no migration and no new dependency.

## Changes
- **New order:**
  1. Compact project overview
  2. Financial overview
  3. Construction phases
  4. Next 14 days and Needs attention
  5. Project setup and Prerequisites & documents

  At 1440 × 900 the overview and the financial overview fit in the first screen.
- **Compact overview.**
  - Top row: name and PIN, with Settings & links and View timeline.
  - Below it: task completion, current phase(s), planned start, target finish and next milestone, in one responsive row.
  - Short notices with an action: "Schedule not set → Open timeline", "Budget unconfirmed / not entered → Open settings" (admins), and a milestone warning.
  - The task-completion explanation is now in a keyboard-accessible info popover.
- **Financial overview.**
  - Four larger amounts with aligned, tabular figures.
  - Each definition is now in an info popover.
  - An unconfirmed budget shows one action, inside the budget tile.
  - The overdue strip appears only when something is overdue.
  - Not entered, unconfirmed and QAR 0 budgets stay distinct, and over-budget handling is unchanged.
- **Phase cards.**
  - Each card shows the phase number, a short display title, one status badge, done/total tasks with a bar, dates only when they exist, and Details.
  - Short titles are display-only: the stored phase name is unchanged and shown in Details.
  - The tracker opens at the phase in progress, or at the first phase when none is in progress.
- **Next 14 days.**
  - Items are grouped under date headings ("10 Oct 2026 · Saturday").
  - Each row has a type icon, title, one metadata line, status and Open.
  - Required-on-site dates are labelled "Required on site" with "Delivery date not entered".
  - Planned deliveries say "Not supplier-confirmed", and only supplier-confirmed dates read as confirmed deliveries.
- **Needs attention.**
  - The header summarises issues and the records they affect, e.g. "6 issues · 1 payment, 38 materials, 2 tasks, 1 visit".
  - Grouped issues show their record count.
  - Cards are lighter (severity dot and text label, no nested badges), and the panel is sized to its content.
- **Checklist.**
  - Project setup and Prerequisites & documents now collapse independently, each with its own count and progress bar.
  - Project setup reads "x of 6 setup steps complete", and each step shows its partial progress, e.g. "22/40 assigned".
  - There is no combined percentage, and setup is not presented as construction readiness.
  - The expand/collapse state is remembered per user, project and section, in that browser.
  - The empty prerequisites state is compact, with one Add item button.

## Backend change (small, read-only)
`GET /api/projects/:id/dashboard` now also returns, for each upcoming material, which date field was used (`dateKind`), whether a delivery date is supplier-confirmed (`deliveryStatus`), and the required-on-site date. The UI needs these to label required-on-site dates and unconfirmed deliveries correctly. The date selection logic is unchanged.

## Staging update
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
docker compose run --rm app node dist-server/migrate.js   # expect: no new migrations
docker compose up -d app
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
```

Then open http://localhost:8091 through the SSH tunnel and press Ctrl+F5.

Check:
- At normal zoom, the overview and the financial overview appear without scrolling.
- The info buttons open and close (also with Enter and Escape).
- Material rows show "Required on site" or the delivery state correctly.
- Collapsing a checklist section is remembered after a reload.
- On a phone, the page doesn't scroll sideways.

**Rollback:** `git checkout $(cat ~/smarthouse-staging-previous-commit.txt)`, set `APP_TAG` to that commit, then `docker compose build app && docker compose up -d app`. There are no database changes.

## Files
New:
- `src/components/InfoPopover.tsx`
- `src/components/dashboard/Section.tsx`
- this file

Changed:
- `src/pages/Dashboard.tsx`
- `src/components/dashboard/ProjectOverview.tsx`
- `src/components/dashboard/FinanceOverview.tsx`
- `src/components/dashboard/UpcomingPanel.tsx`
- `src/components/dashboard/ProjectChecklist.tsx`
- `src/components/ProjectHealth.tsx`
- `src/lib/dashboard.ts`
- `src/lib/projectHealth.ts`
- `server/routes/dashboard.ts`
- `tests/dashboard-ui.test.tsx`
- `tests/dashboard-calc.test.ts`
- `tests/dashboard-api.test.ts`
- `tests/project-health.test.ts`

Nothing to delete.
