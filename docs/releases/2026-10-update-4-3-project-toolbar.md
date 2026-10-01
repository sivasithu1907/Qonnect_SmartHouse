# Update 4.3: project toolbar (header option A)

- **The project selector and the Google Drive action are now one connected control** next to the Qonnect logo. The selector shows the project name with the project code (for example "Umm Garn · PIN 70153699") and opens the same project menu as before. The Drive part changes with the project's link:
  - **Link set:** "Open Drive folder", with a folder icon and a new-tab marker. It opens the link in a new tab.
  - **No link, user can edit links** (admin, project manager): "Add Drive folder" on a muted grey fill. It opens Project settings & links.
  - **No link, everyone else:** a disabled "Drive not linked", with a tooltip asking an admin or project manager to add it. It never looks like a working link.
  - **No project selected:** no Drive action.
- **Notifications and the account menu stay on the right**, separated from the project controls by a divider.
- **Main navigation** is a tab row below the toolbar, with the active section underlined. On smaller screens it scrolls sideways and keeps the active tab in view. The phone menu button still opens the full section grid.
- **Phones:** the logo, notifications, account and menu share the top row, and the project control goes full width below it. Long project names cut off with "…" while the code and Drive action stay visible.
- No data, permission or workflow changes, and no migration.

Changed: `src/components/Header.tsx`. New: `tests/header.test.tsx`, this file.
