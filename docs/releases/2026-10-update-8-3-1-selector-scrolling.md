# Update 8.3.1: dropdown scrolling fix

A behaviour-only fix in the shared searchable dropdown (`SearchSelect`). Appearance, width, labels, ordering, search, saved IDs and permissions are unchanged. There is no migration and no data change.

## Cause
While the list was open, the dropdown listened for scroll events on the whole page in the capture phase, so it could reposition itself when the dialog scrolled. That listener also fired for the list's **own** scrolling. Each scroll step then caused a loop:

1. The listener recalculated the position.
2. It stored a new position object, which re-rendered the dropdown.
3. An effect that depended on that position scrolled the highlighted option back into view.

The list jumped back to the highlighted option after every scroll step, so it seemed stuck.

**Measured on the old build:**
- 5 wheel steps gave 10 scroll events and 10 `scrollIntoView` calls, and the list stayed at 4 px.
- 12 wheel steps reached 4 px of 477 px.
- Touch swipes reached 4 px of 565 px.

The dialog's scroll lock (body `overflow: hidden`) and `overscroll-behavior` were not involved. No wheel or touch handler cancelled scrolling.

## Fix (`src/components/ui.tsx`)
- **Ignore the list's own scrolling:** scroll events from inside the dropdown no longer reposition it. Page and dialog scrolling still do, so the list follows the field.
- **No needless re-renders:** the position is only updated when it actually changes.
- **Reveal the highlighted option only when needed:** after opening, after a new search, or after an arrow / Home / End key press. Manual scrolling, hovering and repositioning never move the list.
- **Only the list scrolls:** revealing an option sets the list's own `scrollTop` instead of calling `scrollIntoView`, so the dialog and page are never scrolled.

## Files
Changed:
- `src/components/ui.tsx`

New:
- this file
