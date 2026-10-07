# Update 10: Contacts / Companies directory

This update adds **one migration: `007_directory.sql`**. It is additive only. No existing column, record, name, amount, file or setting is changed, moved or deleted, and no seed runs.

## Migration 007 — what it does
| Change | Purpose |
|---|---|
| New table `directory_specializations` (10 default rows) | Configurable specialization list (Civil, Gypsum, Tiles / Marble, Plumbing, Electrical, AC / HVAC, KNX / Home Automation, CCTV / ELV, Painting, Landscaping) |
| New sequence `directory_ref_seq` and table `directory_entries` | One shared directory of companies and independent individuals. Each gets a readable reference (`DIR-0001`…), at least one business role, and active / archived and created / updated info |
| New table `directory_contacts` | Contact people under an entry (at most one active primary contact). They are not users |
| New table `directory_assignments` | Project assignment: roles, scope, responsible contact, start / end dates, active / archived (at most one active assignment per entry per project) |
| `contracts`, `payment_milestones`, `material_items`, `consultant_visits`, `site_visits`, `timeline_tasks`: two new **nullable** columns `directory_entry_id`, `directory_contact_id` and partial indexes | Optional manual link. The existing text names (company / payee / vendor / consultant / assigned / responsible) stay as they are |
| `attachments.project_id` becomes nullable | Needed for shared company documents |
| New check: `project_id` may be empty **only** when `entity_type = 'directory_entry'` | Every existing project file keeps its project, and no project file can lose one |
| `attachments` entity / kind checks extended with `directory_entry`, `company_profile`, `trade_license` | Allows directory documents |

Existing rows get NULL in every new column, so nothing is linked automatically.

## Access
| Role | Contacts |
|---|---|
| Admin | Whole directory. Edit / archive shared details and contact people, shared documents, specializations, assign to any project |
| Project manager | Sees active entries so they can be reused, but assignments, documents and related records only for their own projects. Can create entries, add contact people, assign to their own active projects and upload project documents. Cannot edit or archive shared details |
| Viewer | Read only: entries assigned to their projects |
| Contractor, Consultant | No access to the directory (no menu, and every directory API returns 403) |

**Never exposed:**
- Other projects' names, codes, counts, records or documents (in lists, search, details, related records, duplicate checks and document downloads);
- contract values, for users without payment access.

Every change is audited. Nothing is deleted: entries, contacts, assignments and documents are archived instead.

## Linking existing records
- **Record forms** (contracts, payment milestones, material lines, consultant visits, site visits, timeline tasks) get an optional **Directory …** selector and a **Contact person** selector.
  - They list only active entries assigned to the current project.
  - **Not listed? Assign an existing entry or add a new one…** opens a dialog on top of the form, so the unsaved form is kept.
- **Linking does not:**
  - change amounts;
  - create milestones or transfers;
  - change task status or dates;
  - replace assigned users;
  - rewrite the recorded name.
- **Possible matches:** the entry's Related records tab lists unlinked records with a similar recorded name, showing the original name next to the proposed entry. Each one is linked only after you confirm it. Nothing is linked automatically or in bulk.
- **Renaming or archiving an entry** keeps every link. Records keep their recorded text, and an archived link is still shown (marked archived).

## Duplicate warnings
- **Phone numbers:** stored as digits. The default country is Qatar (+974); international numbers are supported.
- **What triggers a warning:**
  - same phone, email or registration number;
  - similar name.
- **Shared numbers:** a shared office phone or general email (info@, sales@ …) is flagged as "may be shared", not as proof of a duplicate.
- **Continuing:** the user can always continue after a warning. Nothing is merged.
- **Entries you cannot open:** only a generic "ask an administrator" message is shown — no name or reference.

## Validation performed
- `npm run typecheck`: OK. `npm run build`: OK.
- `vitest`: 35 files, 339 tests passed. New tests:
  - `tests/directory.test.ts` (API, 14 tests);
  - `tests/directory-ui.test.tsx` (UI, 8 tests).
- **Migration preservation:**
  - Built a database with migrations 001–006 and the seed, plus fixture contracts, milestones, transfers, visits, vendor / responsible names and an attachment.
  - Fingerprinted all 29 tables (row count plus md5 over the original columns), applied 007, then fingerprinted again: **identical**.
  - All new link columns are NULL, and re-running migrations is a no-op.
- **Browser (Chromium):**
  - Contacts list on desktop (1366 px) and phone (390 px, no horizontal scroll).
  - Duplicate warning while typing; create-and-assign; contact person; detail tabs.
  - On the contract form: the directory selector scrolls inside the modal, Escape closes only the dropdown, and quick-add from the form kept the unsaved title and company name and selected the new entry.

## Rollback
- **Code:** check out the previous commit and rebuild. The previous version ignores the new tables and columns.
- **Migration 007:** leave it in place. **Do not drop it.** Dropping it would remove directory data and links.
- **Shared documents:** a code rollback leaves them stored, but unreachable until the update is re-applied. Project files are not affected.
