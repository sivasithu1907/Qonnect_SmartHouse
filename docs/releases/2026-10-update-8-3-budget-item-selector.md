# Update 8.3: "Related budget item" selector

A presentation-only update. There is no migration and no seed, and no saved record, sort order, link or amount is changed.

## Order and grouping
- **One shared ordering rule** (`src/lib/budgetOrder.ts`) is used by Master Items & Budget, the payment milestone form and the contract form:
  1. category kind: Fixed costs → Finishing → Other;
  2. the saved `sort_order`;
  3. the name, natural and case-insensitive.

  Record IDs and created or updated dates are never used. New categories and items take part automatically.
- **Why the old list was mixed up:** it was sorted by item `sort_order` across all categories. Every single-item finishing category's item is 0, so Contractor Cost (0) was listed with the finishing items, and Consultant Cost (1) and Kahramaa Cost (2) came after them. Items are now grouped by category in budget-page order, so **Fixed Costs** lists Contractor Cost, Consultant Cost and Kahramaa Cost together.

## Labels
- **Item name once:** each item name appears once under its category heading. Single-item categories named the same as their item (Plumbing, Window, …) are listed under the kind heading (**Finishing categories**) instead of "Plumbing · Plumbing".
- **Category context:** the category is still searchable. It's shown next to the selected item (e.g. "Consultant Cost · Fixed Costs") where it adds context.
- **Empty choice:** "No linked budget item" is the first choice.

## Selector (shared `SearchSelect`)
- **Search:** filters by item or category name. Headings can't be selected. When nothing matches it shows "No matching items for "…"".
- **Selected item:** shown in bold sky text with a check mark, and the list opens scrolled to it.
- **Placement:** the list floats above the page, fits the visible viewport (including when a phone keyboard is open) and opens upward when there is more room above.
- **Keyboard:**
  - ↓ / ↑ on the field opens the list;
  - ↓ / ↑ / Home / End move through the options;
  - Enter selects;
  - Escape closes the list without closing the dialog;
  - Tab closes the list.
- **Touch:** you can tap to choose, and scrolling the list doesn't select anything.
- **Other forms:** the same component already serves the other searchable fields (timeline task, material line, contract, phase). They get the floating, viewport-aware list and the keyboard and touch behaviour. Their options and order are unchanged.

## Existing links
- **Values:** option values are still the budget item IDs.
- **Which items are offered:** active items in active categories of the current project. The budget list is only loaded for roles that can read the budget.
- **Archived links:** a record already linked to an archived item shows it with an **Archived** badge and keeps the link unless you choose something else. Saving other fields doesn't send the link.
- **No side effects:** linking never changes amounts or paid status. Server validation (same project) is unchanged.

## Files
Changed:
- `src/components/ui.tsx`
- `src/pages/Payments.tsx`
- `src/pages/Contracts.tsx`
- `src/pages/Budget.tsx`

New:
- `src/lib/budgetOrder.ts`
- `tests/budget-item-selector.test.ts`
- this file

## Staging and production
Use the same steps as update 8.2, with the file names `~/staging-before-update83.txt` and `~/staging-after-update83.txt`. Migrate should say "Database schema is up to date". For production, take a fresh backup first.
