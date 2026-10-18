# Update 14: Historical task progress, clearer phase status, in-app PDF preview

This update adds **one migration: `010_historical_progress.sql`**. It is additive and repeatable.

## Migration 010
- **New setting:** `projects.allow_historical_progress`, off by default.
  - It is switched on only for the existing project **PIN 70153699** (Umm Garn), and only when exactly one project has that code.
  - This is recorded in the audit log as "system (migration 010)". Every other project, and every new project, stays off.
- **New task columns, empty for existing rows:**
  - `completion_date_unknown`;
  - `completion_note`;
  - `completion_recorded_at` and `completion_recorded_by` (when and by whom the completion was entered — not when the work happened);
  - `completion_historical`.
  - A check keeps "date unknown" consistent: the task must be Completed and have no actual completion date.
- **Nothing is marked completed.** No status, date, note, dependency or file changes.

## 1. Phase work status (all projects)
- **Derived only from active tasks:**
  - all completed → **Completed**;
  - any completed, in progress, blocked or on hold → **In progress**;
  - otherwise **Not started**;
  - a phase without tasks shows **No tasks** (never Completed).
- **Where it shows:** the timeline phase header has the status badge, a progress bar and the completed/total count. Blocked / on-hold counts stay visible.
- **"Schedule approved"** and "Template schedule" are secondary text and never mean work is done.
- **The same rule drives** the dashboard phase cards, phase details, current phases and task completion.
- **Counts:** completed tasks never count as "unscheduled" work. "Schedule not set" looks at open tasks only.

## 2. Recording completed work
- **Mark completed** on each open task (timeline write permission) asks for:
  - the actual completion date: earlier dates are accepted, future dates are not, and today is never filled in automatically;
  - an optional actual start date: it must not be after completion or in the future;
  - a completion note.
- **Optional supporting file:** afterwards, a photo or document can be added. It is kept as a work update linked to the task, reusing the existing work-update attachments.
- **Projects with historical progress entry also get:**
  - **"Exact completion date unknown":** the date stays empty and the task shows "Completed · date not recorded";
  - the suggested note "Completed before the project was entered into the application."
- **Needs a written reason, kept in the audit history:**
  - open predecessors;
  - inspection hold points;
  - blocked / on-hold tasks.
- **Nothing is approved automatically:** no inspection, permit, prerequisite or predecessor.
- **Reopen** (on completed tasks) corrects an accidental completion. It needs a reason and a new status, clears the completion date and note, and keeps the previous values in the audit history.
- **The existing Edit task form still works:**
  - a task completed with an unknown date stays valid when other fields are edited;
  - entering a date later clears "unknown";
  - future actual dates are refused.

## 3. Completing several tasks of a phase (historical progress entry only)
- **"Complete remaining tasks"** on a phase opens a review dialog. It shows:
  - every task and its current status, with select-all;
  - which tasks will change;
  - per-task warnings: predecessors, hold points, blocked.
- **One date or "Exact date unknown"** applies to every selected task, along with a historical note.
- **Predecessors inside the selection** don't need a reason; ones outside it do.
- **Only selected incomplete tasks change.** Already completed tasks keep their dates and notes, and unselected tasks are unchanged.
- **One database transaction.** Each task gets its own audit entry with a shared batch id, plus one phase summary entry.
- **Submitting twice changes nothing more:** tasks that are already completed are skipped.

## 4. Dates, Gantt, reminders
- **Dates:** project start dates, planned dates and approved schedules are never changed.
- **Gantt:** completed tasks without planned dates are listed under **"Completed without planned dates"**. They are never placed on the chart with an invented date, and never shown as "Not scheduled".
- **Reminders and lists:** completed tasks drop out of upcoming / overdue lists and due-date reminders. Recording past work sends no notifications.

## 5. Settings
- **Where:** Project settings → **Timeline progress** → "Allow historical progress entry".
- **Who:** admins only (`projects.manage`), checked on the server: `PATCH /api/projects/:id/historical-progress`.
- **Turning it off later** keeps everything recorded.
- **Templates and new projects:** templates contain structure only, and new projects start with the setting off.

## 6. In-app file preview (all projects)
- **View** opens a preview inside the app instead of a new tab. It is used in every attachment list:
  - payments, contracts, project documents and the file register;
  - budget items, consultant and site visits;
  - prerequisites, materials, work updates;
  - company documents in Contacts.
- **Header:** the readable file name (Arabic and mixed names right to left), Download, Open in new tab, Close.
- **PDFs are drawn by PDF.js inside the page.** There is no browser plugin and no frame, so desktop and phones behave the same. You get continuous scrolling, page *n / N* with previous / next, zoom in / out and fit to width.
  - The library loads only when a PDF is opened.
  - The PDF's own scripts never run (`isEvalSupported: false`, no XFA).
- **Images** show in the same viewer.
- **Behaviour:**
  - large on desktop, full screen on phones;
  - loading and clear error states (signed out, no access, missing file, unreadable PDF), always with Download and Open in new tab;
  - Escape, a focus trap and focus restore;
  - the page, filters, scroll position and open forms underneath are preserved;
  - previews opened from another dialog close on their own.
- **All dialogs now trap Tab inside and return focus** to the button that opened them.
- **Security is unchanged:** the authorised download URL with the session cookie, no token in URLs, no public files, and file headers exactly as before (including `frame-ancestors 'none'`). The service worker never caches `/api/`.
- **New build-time dependency:** `pdfjs-dist@4.10.38`. It is bundled into the client, and the server image is unchanged.
