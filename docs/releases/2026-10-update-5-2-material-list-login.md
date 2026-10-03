# Update 5.2: Material Supply list sections and login password toggle

- **Category sections.** Each material category is now its own bordered section with a header button (keyboard: Tab, then Enter or Space; `aria-expanded`).
  - The header shows the category name, the number of visible lines, and text indicators: **overdue**, **no dates**, **awaiting confirmation**. Archived lines count only towards the total.
  - All counts follow the current filters and quick filters.
  - **Expand all / Collapse all** sit above the list. Categories open automatically when the list is filtered or short (20 lines or fewer); otherwise they start collapsed. Your own choice wins until the filters change.
  - A notification or dashboard link to a line opens its category.
- **Scope notes.** Owner-supply and contractor-scope notes now sit in a closed "Scope notes" disclosure inside each category, with labelled boxes. Editors still have the "Scope notes" edit button in the header.
- **Desktop and tablet (768 px and up):** the same table and columns as before, inside each open category; wide tables scroll inside the section.
- **Phones:** one labelled card per line, showing status, responsibility, required on site, delivery dates, quantity, ordered / delivered / remaining, vendor / assigned, inspection, follow-up and amount. Each card has a labelled Edit / View button (44 px).
- **Login.** An eye button inside the password field shows or hides the password.
  - It is hidden by default, never submits the form, and keeps the typed text.
  - The label switches between "Show password" and "Hide password" (`aria-pressed`).
  - The button is 44 × 44 px, and `autocomplete="current-password"` is kept for password managers.
- No change to data, dates, statuses, categories, permissions, notifications or the API. No migration, no new dependency.

Changed: `src/pages/Materials.tsx`, `src/components/Login.tsx`, `src/lib/materialFilters.ts`.
New: `src/components/materials/MaterialCategorySection.tsx`, `tests/material-list.test.tsx`, this file.
