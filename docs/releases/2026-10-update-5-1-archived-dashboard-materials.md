# Update 5.1: archived projects in the selector, less repetition on the dashboard, material quick filters

- **Archived projects (fix).** The project selector used to drop archived projects unless one was already open. Admins now see them under "Archived (read-only)", each marked "Archived · read-only"; selecting one opens it read-only, and switching back works as usual.
  - The server still decides who sees archived projects: only admins receive them, and writes to an archived project still return 409.
  - Non-admins never see archived projects, even ones they used to belong to.
  - `projectsForSelector` adds a second check in the browser.
- **Dashboard repetition.** Overdue payments and deliveries now appear only in Needs attention.
  - The lower panels became "Upcoming payments" (next 30 days) and "Materials due soon" (next 14 days). Each opens with a one-line count of overdue items, pointing to Needs attention.
  - Rows in both panels link to their record.
  - The KPI tiles are unchanged.
- **Direct setup actions.** The incomplete supply-responsibility and material-date steps now offer "Show these lines". It opens Material Supply filtered to exactly those lines.
  - The Needs attention links for "awaiting confirmation" and "N more overdue deliveries" open the matching filter.
  - The checklist still counts only saved data, and empty lists are never complete.
- **Material Supply quick filters.** Filter chips with counts:
  - All lines
  - Overdue delivery
  - No dates yet
  - Awaiting confirmation
  - Responsibility needs confirmation

  The chips work in both List and Schedule views, together with the existing filters, and support the keyboard (`aria-pressed`). They only read saved values. Dates, including supplier-confirmed dates, are still entered by an authorised user through the edit form.
- No migration, no new dependency, no data change. Schedule, notifications, payments, permissions and audit behaviour are unchanged.

Changed:
- `src/App.tsx`
- `src/components/Header.tsx`
- `src/components/ProjectHealth.tsx`
- `src/lib/projectHealth.ts`
- `src/pages/Dashboard.tsx`
- `src/pages/Materials.tsx`
- `tests/project-health.test.ts`

New:
- `src/lib/projects.ts`
- `src/lib/materialFilters.ts`
- `tests/project-selector.test.tsx`
- `tests/material-filters.test.ts`
- this file
