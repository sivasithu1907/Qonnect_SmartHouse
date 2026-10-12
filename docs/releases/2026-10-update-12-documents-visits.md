# Update 12: Project documents, budget item files, consultant visit workflow, contact people, Arabic file names, dashboard polish

This update adds **one migration: `008_documents_visits.sql`**. It is additive only:
- **New tables:** `project_documents`, `prerequisite_documents` and `visit_comments`.
- **New nullable or defaulted columns:**
  - on `attachments`: `display_name`, `description`;
  - on `budget_items`: `drive_url`;
  - on `consultant_visits`: `actual_visit_at`, `assigned_user_id`, `related_milestone_id`, `cancel_reason`;
  - on `visit_actions`: `responsible_user_id`;
  - on `directory_contacts`: `whatsapp`, `whatsapp_normalized`;
  - on `directory_assignments`: `status` (default `active`).
- **Widened CHECK lists:** `attachments.entity_type` allows `project_document` and `budget_item`; `attachments.kind` allows specification, invoice, drawing, permit, approval and other.

No existing row, file, ID, amount, status or audit entry is rewritten, moved or deleted. No seed runs. Financial calculation rules are unchanged.

## 1. Project documents and prerequisites
- **Contracts & Documents** has two tabs: **Contracts** (unchanged) and **Project documents**.
  - **Documents:** permits, drawings, surveys, approvals, reports, certificates, correspondence and other records. Each has a title, category, reference, date, Drive link and notes, plus its own secure files.
  - **All project files:** a read-only register of every file in the project, with its source module (budget item, payment milestone or transfer, contract, consultant or site visit, prerequisite, material line). Each file shows a link to the original record, plus preview and download.
- **Register permissions:** the register lists only record types the user's role may open. Each download is re-authorised against the original record, so payment slips never reach a role without payment access.
- **A prerequisite is a requirement; a document is the evidence.**
  - From a prerequisite's details, authorised users can: upload new evidence, which creates one project document holding the file (stored once); link an existing project document; unlink one; or open it in Contracts & Documents.
  - Uploading or linking **never changes a prerequisite's status**. Status is still recorded explicitly, with who decided and when.
- **Existing prerequisites:** their files stay attached as they were, shown as "Files attached directly (earlier)" and listed in the register. Their document links, contracts, statuses and audit history are unchanged. No file migration is needed or performed.

## 2. Dashboard
- **Order:**
  1. Project overview.
  2. Financial overview.
  3. Next 14 days, next to Needs attention.
  4. Construction phases.
  5. Project setup and Construction prerequisites, collapsed by default and remembered per user and project.
- **Finance:**
  - **Items vs budget** shows the total incl. miscellaneous minus the confirmed control budget, as +above, −below or "—" when the budget isn't confirmed. It says when items are not yet finalized.
  - **The spending bar** shows paid (solid) and scheduled unpaid (light) against the budget, with a legend. It flags paid + scheduled beyond the budget.
  - The figures are the existing ones; nothing is recalculated and the saved budget never changes.
- **Next 14 days:** consultant and site visits are labelled *planned* or *completed*. A completed visit uses its actual visit date and is listed once. Cancelled visits are not listed. A directory-linked visit shows the company and contact.
- **Construction phases:** a wrapping grid of compact cards (two columns on phones), with no sideways scrolling. Long timelines show eight phases around the current work, with "Show all".
- **Construction prerequisites** explains that evidence lives in Project documents. Its evidence chip has an accessible description, e.g. "1 linked project document, 1 earlier file, a document link".

## 3. Budget item attachments
- **Every budget line** (fixed costs such as contractor, consultant and Kahramaa; finishing; other) has a paperclip button with a count and an accessible label, e.g. "Attachments for Contractor Cost, 1 file". All roles that can read the budget see it.
- **The modal supports:** upload, preview, download, rename (display name), document type (Quotation, BOQ, Specification, Invoice, Supporting document, Other), description, uploader and date, and archive. Upload, rename and archive need budget write access. A Drive folder link is set in the item form.
- **Related documents** are listed separately, never copied: linked contracts and their files, and payment milestones and transfer slips, each with a link to its original record. These follow contract and payment permissions.
- Uploading or archiving a file changes no amount or payment (covered by tests).

## 4. Consultant visit workflow
- **Schedule visit** (one button) collects:
  - company and a contact filtered by company (from the shared directory), or a free-text consultant name;
  - date and time;
  - purpose;
  - related task;
  - assigned internal user (admin or PM);
  - related payment milestone (only with payment access);
  - notes.
- **After saving, the visit opens as a panel** with:
  - consultant and contact details, with call, WhatsApp and email;
  - schedule and actual visit date;
  - visit and report badges;
  - **Reschedule / Mark completed / Cancel visit**;
  - reports and files;
  - follow-up actions with a responsible user and due date;
  - comments with author and time;
  - activity history from the audit log.
- **Visit state vs report state:** visit state is Scheduled, Completed or Cancelled; report state is Report pending or Report uploaded. Stored statuses are kept and only *mapped*: Planned, Rescheduled and In Progress all show as Scheduled. Report status comes from consultant-report files.
  - Uploading a report does not complete the visit or pay anything.
  - Completing records `actual_visit_at`, which cannot be in the future.
- **Main view:** filters for upcoming, reports pending, completed, cancelled and all, with counts; search; and **List / Calendar** (month grid).

## 5. Shared contacts
- **New company form:** has a **Contact people** section with **Add another contact person**. Each person has name, position, phone, an optional WhatsApp number, email, notes and a primary flag. Individuals keep the simpler form.
- **Contact people** have an optional WhatsApp number, which the WhatsApp button uses when set.
- **Project assignments** have an **Assignment status** (Active, On hold, Completed) and a **Preferred contact person for this project**. It can differ per project, and the server checks that the person belongs to the company.
- Unchanged: the All contacts / This project views, server-side permissions, duplicate warnings, legacy names and archiving behaviour. Assigning still grants no login or access.

## 6. Arabic and mixed-language file names
- **Root cause:** multipart file names were decoded as Latin-1, the multer/busboy default, so UTF-8 names became mojibake. Uploads now decode as UTF-8 (`defParamCharset: 'utf8'`).
- **Stored files** keep generated IDs. Original names are sanitised (NFC; path, control and bidi-override characters removed; Windows-reserved characters replaced) without touching Arabic letters, and are never used as paths or HTML.
- **Display:** names use `dir="auto"` with `<bdi>`, so Arabic names read right to left inside the English interface.
- **Downloads** send `filename="ASCII fallback"; filename*=UTF-8''…` (RFC 6266/5987). Verified in Chromium with a UTF-8 locale.
- **Rename display name** stores `display_name` only. The original name, stored file, ID, checksum and links never change, and the download name uses the display name.
- **Garbled older names:** when a stored name is reliably detectable as UTF-8 misread as Latin-1, the file list shows "This name looks garbled. Likely original: …" with **Use it**. Clicking it sets the display name; the original metadata is kept and the change is audited. Nothing is changed automatically.

## Deployment notes
- **Run the migration** with `node dist-server/migrate.js`. It is transactional and repeatable; a second run reports "up to date".
- **Rollback:** deploying the previous code is safe while 008 stays applied. Older code ignores the new tables and columns. The only visible effect is that files attached to project documents or budget items would not be listed by the older code until 008-aware code is redeployed.
- **Backup & Restore** discovers the new tables automatically and includes their files.
