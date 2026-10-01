# Update 4.2: consistent full-width layout

- **One container everywhere.** `src/lib/layout.ts` now has a single `PAGE_CONTAINER`, used by the header, the update banner, every page and the footer. All pages share the same fluid, near-full width:
  - responsive side padding: 12px on phones, 20px on small tablets, 24px on laptops, 32px from 1280px and 40px from 1536px;
  - a 2400px cap that only applies on very large monitors.

  The width-per-page logic from 4.1 has been removed, so All Projects, Dashboard, Budget, Payments, Material Supply, Consultant Visits, Site Visits, Timeline, Audit, Users and Notifications all line up with the header.
- **Readable widths are kept by the components:**
  - dialogs, including Project settings, keep 576px / 896px;
  - Notification settings stays at its settings width;
  - notice text and page subtitles cap their line length;
  - wide tables and the Gantt scroll inside their own area.
- **Grids adapt.** All Projects shows 1 / 2 / 3 project cards per row on phone / laptop / large desktop. Dashboard rows already change column count with screen size.
- No data, permission, navigation or workflow changes, and no migration.

**Changed:**
- `src/lib/layout.ts`
- `src/App.tsx`
- `src/components/Header.tsx`
- `src/components/UpdateBanner.tsx`
- `src/components/ui.tsx` (page subtitle width)
- `src/pages/Portfolio.tsx`
- `tests/schedule-views.test.tsx`
- this file (new)

**Staging:** same update steps as Update 4 (no migration).
