# Update 15: Desktop sidebar navigation and profile pictures

This update adds **one migration: `011_user_avatars.sql`**. It adds four nullable columns to `users`:
`avatar_file`, `avatar_sha256`, `avatar_size_bytes`, `avatar_updated_at`, plus a CHECK that `avatar_file` is a
generated `<uuid>.webp` name. No existing value, role, password, session or project membership is changed, and
no seed runs.

It also adds one production dependency, **`sharp` 0.34.4**, which decodes, crops, resizes and re-encodes
pictures. It ships prebuilt binaries for Linux x64/arm64 (glibc and musl), so the existing Docker image builds
without extra system packages.

## Desktop navigation (windows 1024px wide and wider)
- **Persistent left sidebar** with:
  - the Qonnect logo (opens All Projects);
  - the project selector (name, code, archived badge; same search, Portfolio, Project settings and Create project options as before);
  - the selected project's Drive shortcut. It shows the same three states as before: open, add (link editors), or not linked.
- **Modules:** All Projects, then the existing modules in their usual order. Each module is still shown only to roles that can open it. The active module is highlighted with a tinted background and a bar.
- **Expanded / collapsed:** collapsed shows icons only, and each icon:
  - has an accessible name;
  - shows a tooltip on hover or keyboard focus (Escape hides it).

  The project selector stays available as an icon that opens the same project menu beside the sidebar. The choice is remembered in this browser (`localStorage` key `qonnect.sidebar.collapsed`). If storage is unavailable, the sidebar simply opens expanded.
- **Short windows:** the module list scrolls on its own. The logo, project selector and collapse button stay in place.
- **Compact top bar:** the page title (plus project name and code on wide windows), notifications, and the account menu with the user's avatar.
- **Page width:** the page uses the remaining width; existing tables, Gantt and dialogs keep their own scrolling and width limits.
- **Phones and tablets (narrower than 1024px):** the existing header, tab row and mobile menu are used unchanged.
- **Resizing across 1024px** swaps only the navigation. The open page, its dialogs and unsaved form input stay as they are, and no menu, overlay or scroll lock is left behind.
- **Motion:** sidebar animations run only when the device does not ask for reduced motion.

## Profile pictures
- **Where to manage:**
  - your own picture: Account menu → **Profile picture**;
  - someone else's picture (administrators): Users & access → edit a user.
- **Editing:**
  - upload JPEG, PNG or WebP (up to 5 MB, shown before upload);
  - drag or use the arrow keys to reposition; zoom with the slider, +/−, or the mouse wheel;
  - a circular guide shows the final look.
- **Saving:** the current picture stays until the new one has been saved. Remove asks for confirmation.
- **Initials** are shown whenever there is no picture or it cannot be loaded.
- **Shown in:**
  - the top-bar account menu;
  - the users list and user editor;
  - visit comment authors;
  - timeline task assignees (list and task details);
  - site and consultant visit assignees (details).
- **Refresh:** a picture change updates immediately, without signing out.

### Processing and storage (server)
- **Content check:** the server decides by the file's actual content, not its name or browser type. Anything that is not a decodable JPEG, PNG or WebP is rejected (400), and files over 5 MB are rejected (413).
- **Processing:**
  - camera orientation is applied;
  - the chosen square is cropped (a centred square if the crop is missing or invalid);
  - the picture is resized to 256×256 and re-encoded as WebP;
  - all metadata (EXIF, GPS, ICC, XMP) is dropped.
- **Storage:** a generated name `<uuid>.webp` in **`<UPLOAD_DIR>/_avatars/`**. In Docker this is `/data/uploads/_avatars` on the existing persistent uploads volume. It is never stored in the repository or the public build, and no third-party avatar service is used.
- **Saving a replacement:**
  1. The new file is written first (temp file + rename).
  2. The database row is updated in a transaction.
  3. Only then is the old file deleted.

  On any error the new file is removed and the old picture remains.
- **Audit:** "Changed own profile picture", "Changed the profile picture of <email>", and "Removed …".

### Permissions and privacy
- **Changing a picture:**
  - users change only their own picture;
  - administrators (`users.manage`) can change anyone's;
  - everyone else gets 403.

  Only the four picture columns are written. Name, role, password, sessions and project access are never touched, even if extra form fields are sent.
- **Viewing a picture** (`GET /api/users/:id/avatar`) requires sign-in and is allowed for:
  - the person themself;
  - administrators;
  - people who share a project with them;
  - for an administrator's picture, anyone with project access.

  Anyone else gets the same 404 as an unknown user, so the endpoint cannot be used as a user directory. There is no listing endpoint.
- **Caching:**
  - `Cache-Control: private, max-age=3600`;
  - the URL carries a version that changes with each picture, so a new picture is fetched at once;
  - the service worker never caches `/api/`, so pictures are not stored indefinitely by the installed app.

## Backup & Restore
- **Backups:** include every picture as `files/_avatars/<uuid>.webp`, with a manifest section `avatars: { rows, filesIncluded, missing }`.
- **Validation and restore:** accept `_avatars` and write the files back with the other files.
- **A missing picture file is only a warning:** that user shows initials, and the backup still counts as complete.
- **Older backups** (made before this update) restore as before; the migration adds the empty columns.

## Rollback
- **Code-only rollback** to the previous version is safe. The old version ignores the new columns, and pictures fall back to the previous initial circle.
- **Keep migration 011 in place.** Do not drop the columns, so pictures return if the update is re-applied.
- **Picture files** in `/data/uploads/_avatars` are harmless to leave.
