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
- **Fields:** "Cost category" is the group from Master Items & Budget. It's a searchable dropdown in budget-page order, with an empty "Select category" option. "Related master budget item" is the budget line that receives the allocation.
- **Linking an item:**
  - Selecting a budget item sets its category.
  - While an item is linked, the category is shown as derived and can't be edited. To change it, change or unlink the item.
- **Choosing a category first** filters the items. With no category, all eligible items are listed.
- **Category without an item:** allowed, and labelled "No budget item linked".
- **Unlinking an item** keeps its category as the editable selection.
- **New categories:** the payment form never accepts typed category text. Categories are added in Master Items & Budget → Manage categories (existing permission).

**Server rules**
- Category and item must belong to the project.
- The item's category is authoritative; a conflicting pair is rejected.
- Archived categories and items are refused for **new** links. Records that already use them stay viewable and editable.
- An edit that touches neither field never reclassifies a record.
- The existing payment permissions apply.

**Totals**
- Category-only payments count in project payment totals, and are not attributed to any budget item.
- Budget item scheduled and paid amounts still come only from `budget_item_id`, so a transfer is counted once.
- Control budget, finalized totals, miscellaneous, contract balance and scheduled-unpaid calculations are unchanged.

**Where categories appear**
- **List:** under each payment.
- **Filter:** "All cost categories", "No category" and "Legacy text needing review".
- **Search:** includes category and item names.
- **CSV export:** "Cost category", "Budget item" and "Legacy category text (needs review)".

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
