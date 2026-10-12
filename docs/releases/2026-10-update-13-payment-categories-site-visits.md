# Update 13: Payment cost categories from Master Items & Budget, and the Site Visits workflow

This update adds **one migration: `009_payment_categories_site_visits.sql`**. It is additive and repeatable.

## Migration 009
**Payments**
- Adds the nullable `payment_milestones.budget_category_id`, which references this project's `budget_categories`. The free-text `cost_category` is kept exactly as stored.
- Links only unambiguous records, and writes each link to the audit log as "system (migration 009)":
  1. A payment linked to a budget item gets that item's category. If the old text differs, it is kept and shown for review.
  2. A payment with no budget item whose text matches **exactly one** category name in the same project gets that category. The match ignores case and repeated spaces, and archived categories count.
- Everything else stays unlinked and is shown as "Legacy category text … needs review".

**Site visits**
- `Cancelled` is added to the allowed statuses.
- New columns: `actual_visit_at`, `started_at`, `cancel_reason` (default '') and `decisions` (default '').
- No date is inferred for historical visits.

**Both**
- Running the migration again changes nothing and writes no new audit entries.
- No amount, transfer, slip, contract, budget link, status, finding or file is changed.

## 1. Payments: cost category and budget item
- **One field in the form: "Related master budget item".** The separate Cost category dropdown was removed after staging review. Most budget categories hold a single item with the same name, so the two lists looked identical.
- **The category always follows the item.** Linking an item sets the payment's category to the item's Master Items & Budget category, and the form shows it under the field. Explicitly unlinking the item clears it.
- **Payments that already have a category but no item** keep it until an item is linked. An unrelated edit never changes it.

**Server rules**
- Item and category must belong to the project.
- The item's category is authoritative; a conflicting pair is rejected.
- Archived items and categories are refused for new links, while existing links stay viewable and editable.
- The existing payment permissions apply.

**Totals**
- Budget item scheduled and paid amounts still come only from `budget_item_id`, so a transfer is counted once.
- Control budget, finalized totals, miscellaneous, contract balance and scheduled-unpaid calculations are unchanged.

**Where categories appear**
- **List:** the category and budget line under each payment.
- **Filter:** "All cost categories", "No category" and "Legacy text needing review".
- **Search:** includes category and item names.
- **CSV export:** "Cost category", "Budget item" and "Legacy category text (needs review)".
- **Old free-text values** that didn't match are shown as legacy text for review. Linking a budget item classifies the payment.

## 1b. Master Items & Budget attachments
- The attachments window of a budget item now lists **only the files attached to that item**. The "Related documents on other records" list (contract and payment files) was removed, and its API endpoint (`GET /budget/items/:id/related`) is gone.
- Contract and payment files stay on their own records and in Contracts & Documents → All project files.

## 1c. File names garbled before the Arabic fix
- **Background:** Update 12 fixed new uploads only. Older names stay as stored until someone reviews them.
- **The register:** Contracts & Documents → All project files shows "Likely original: …" under each garbled name, and a banner leads to **Review names**.
- **Review names** lists each reliable repair (old name → likely original, with its source record). The user picks which to apply.
- **Applying a repair:**
  - Sets only the display name.
  - The stored file, id, links and original name never change, so the original can be restored or renamed again.
  - Is checked per record with the same permission as renaming that file, and audited.
  - Suggestions are recomputed on the server, never taken from the browser.
- **What is detected:** names misread as Latin-1 and as Windows-1252. Real Latin names (e.g. "Café") are not touched.
- **New endpoints:** `GET /documents/name-repairs`, `POST /documents/repair-names`.

## 2. Site Visits
**Scheduling**
- "Schedule site visit" collects:
  - purpose;
  - planned date and time;
  - assigned internal user;
  - optional areas;
  - optional company/contact (Contacts);
  - optional related task, material line and consultant visit;
  - notes.
- The historical free-text assigned name is kept, and shown in Edit details when it's set.

**The summary panel**
- It opens right after saving, with these sections:
  - **Overview:** planned and actual time, started time, assignee, company/contact, areas, related records with links.
  - **Findings:** observations & issues, decisions & instructions.
  - **Photos & documents.**
  - **Follow-up actions:** responsible person, due date, open/closed.
  - **Comments.**
  - **Activity history.**
- The panel fits the viewport with a scrollable body.

**Actions and permissions**
- **Start visit** and **Mark completed:** managers and the assigned user.
- **Reschedule** (also reopens a cancelled visit), **Cancel visit**, Edit details, reassignment and archiving: managers only (`site.write`).
- Every action is checked on the server.

**States**
- Stored statuses are kept and mapped: Planned / Rescheduled → Scheduled; In Progress → In progress; Completed; Cancelled.
- Completion needs an actual date and time, which can't be in the future.
- Cancelling needs a reason.
- Rescheduling records the old and new times in the history.
- Uploading files or recording findings never completes a visit. Completing never closes follow-up actions.

**Main page**
- Summary cards: upcoming, in progress, completed, open follow-up actions (with the past-due count). A note states their scope.
- Filters (Upcoming / In progress / Completed / Open actions / Cancelled / All), an assignee filter, search, List / Calendar views, and archived records.
- The calendar and list components are shared with Consultant Visits (`src/components/visits/shared.tsx`); Consultant Visits behaves as before.

**Integrations**
- **Dashboard, next 14 days:** site visits link to the visit and are labelled planned/completed; completed visits use their actual date. Cancelled visits are excluded.
- **Dashboard, Needs attention:** open site follow-up actions past their due date appear there. One action links to its visit; several link to Site Visits filtered to open actions. Actions on cancelled or archived visits are excluded.
- **Notifications:** the existing infrastructure now also tells the assignee when a visit is cancelled. Nothing is sent for historical records.
- **File register:** site files stay in the central project file register with their original permissions.
- **Backup & Restore** includes the new columns automatically.
