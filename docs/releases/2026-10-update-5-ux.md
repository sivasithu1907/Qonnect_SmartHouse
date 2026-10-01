# Update 5: dashboard guidance, project search and keyboard focus

- **Needs attention (Dashboard).** A short list of actionable items, most urgent first:
  - overdue deliveries and overdue payments, each linked to its record (up to 4 each, then a link to the full list);
  - blocked or on-hold timeline tasks;
  - material lines awaiting confirmation;
  - timeline tasks without planned dates.

  Each item carries a text label (Overdue delivery, Awaiting confirmation, …) as well as a colour. When nothing is waiting, it says so in one line.
- **Project setup checklist (Dashboard).** Shown only to users who can complete the steps, and hidden once all steps are complete or the project is archived. The steps:
  - confirm the control budget (admin);
  - enter approved amounts (admin);
  - assign supply responsibility;
  - enter material dates;
  - schedule timeline tasks;
  - add the Drive and Sheet links.

  Completion and the "x of y" counts come only from saved records: an entered but unconfirmed control budget is not complete, and an empty list is never complete. The "Control budget needs confirmation" notice is not repeated when the checklist already shows that step.
- **Project search.** With 6 or more projects, the project menu shows a search box (name, code or location). Archived projects are listed separately under "Archived (read-only)". Escape closes the project and account menus.
- **Keyboard focus.** Links, buttons, checkboxes and selects show a clear blue focus ring when reached with the keyboard.
- **API.** The dashboard response adds read-only counts: `materials.responsibilityNeedsConfirmation`, `materials.withDate`, `timeline.scheduled`, `project.hasDriveLink` and `project.hasSheetLink`. No new dependency, no migration, no data changes.
