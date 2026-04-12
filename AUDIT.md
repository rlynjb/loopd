# loopd — Stability Audit

Last updated: 2026-04-11

---

## What's Complete

Features that are stable and tested:

- **Journal page core flow**: create entry, edit text inline, save on keystroke, auto-commit after 20s idle
- **Clip import**: pick from library, record from camera, copy to local storage, thumbnail generation
- **Clip management**: add multiple clips per entry, delete individual clips, display in 3-column grid
- **Habit system**: toggle habits from keyboard toolbar, add/remove per entry, weekly streak grid on home
- **Todo lists**: add items, check/uncheck with completion timestamps, persist to DB and Notion
- **Video editor**: timeline with clip/text/filter tracks, trim handles, pinch-to-zoom (reanimated), playhead drag, split clips
- **Export pipeline**: FFmpeg trim → concat → filter → text overlay → MP4 output, cancel support
- **Notion sync**: bidirectional entry push/pull, habit schema sync, clip URI preservation, last-edit-wins conflict resolution, deletion tracking via sync_deletions
- **Bottom nav**: Home, Record, Vlog, Journal — route-aware active state, visible on editor
- **Keyboard toolbar**: Todo/Clip/Habit actions above keyboard, habit sub-view with back button
- **Auto-save**: silent DB save on every keystroke, focus cleanup on navigation, auto-commit timer
- **Settings**: Notion config, export/import database, OTA updates
- **Error boundary**: root-level catch with error message and "Try Again" recovery
- **Database schema**: clean schema with no dead columns, migrations for existing installs
- **Sync-safe deletion**: `deleteEmptyEntries` uses `deleteEntry()` to track deletions for Notion sync
- **Notion upsert**: `upsertEntryFromNotion` includes todos_json in INSERT

---

## What's Incomplete

Exists but has gaps — missing states, unhappy paths deferred, known edge cases:

### Journal Page — Save Race Conditions
- **Silent save race**: rapid keystrokes can fire multiple `insertEntry`/`updateEntryDB` calls before `newEntryIdRef` is set. Second call might fail or duplicate.
- **Focus cleanup stale refs**: if user switches entries rapidly, cleanup might read `liveTextRef` from the wrong entry and save incorrect text.
- **No error handling on DB writes**: `editEntry`, `addEntry`, `removeEntry` have no try-catch. Silent failures give no user feedback.

### Journal Page — Auto-Commit Edge Cases
- **Auto-commit on unmount**: `handleAutoCommitNewText` calls `reload()` then `getEntryById()` — if DB write hasn't flushed, entry won't load and commit silently fails.
- **Stale `editingEntryRef` in auto-commit**: if entry was modified by habit toggle or clip add between typing and auto-commit, the ref has old data. Auto-commit reads from DB to mitigate, but the fallback logic is complex.

### InlineTextInput — Timer Behavior
- **Mount timer fires even with no text**: on mount, a 20s timer starts. If user opens input and navigates away immediately, auto-commit fires on empty state.
- **Silent save errors swallowed**: `onSilentSaveRef.current()` called on every keystroke without try-catch. DB failure is invisible.

### Notion Sync — Partial Failures
- **Last sync timestamp updated after errors**: if sync has errors, the timestamp still advances. Next sync skips entries that failed, so they never re-sync.
- **Title conflict too lenient**: if local title is empty AND Notion has a title, Notion wins — even if user intentionally cleared it.
- **Ghost cleanup before pull**: entries with `notion-` prefix are deleted before checking if they exist in Notion. Legitimate entries from a previous install could be lost.

### Video Editor
- **No file validation after FFmpeg**: output file not checked for existence or reasonable size. A silent FFmpeg failure could produce empty MP4.
- **Temp file cleanup at end only**: if export crashes mid-way, temp files persist. Should also clean at start.
- **PanResponder + GestureDetector conflict**: pinching during playhead drag has undefined behavior.

### PreviewPlayer
- **File existence race**: file check runs in effect, but file could be deleted before Video component mounts.
- **Error state with no recovery**: error shows URI but no retry button.
- **Split clip seek**: switching between split clips (same URI) doesn't always seek correctly.

### Home Screen
- **No error handling on load**: all DB queries in `useFocusEffect` have no try-catch. DB failure → blank screen.
- **Weekly habits loaded serially**: 7 sequential DB queries on every focus. No parallel loading or caching.

---

## What's Blocking Next Phase

Must be resolved before building anything new:

No blocking issues at this time. All previously blocking items have been resolved:
- ~~Database schema debt~~ — dead columns removed, migrations added
- ~~`upsertEntryFromNotion` missing `todos_json`~~ — added to INSERT and VALUES
- ~~`deleteEmptyEntries` bypasses sync tracking~~ — now uses `deleteEntry()`
- ~~No error boundaries~~ — root-level ErrorBoundary added

---

## What's Explicitly Deferred

Choosing not to fix now — documented so you don't build on top of it unknowingly:

### Save Architecture Complexity
The journal page has 5+ save mechanisms: `handleSilentNewText`, `handleEditTextSilent`, focus cleanup, auto-commit (new), auto-commit (edit), `dismissAll`, `handleTapEmptySpace`, `handleTapToEdit`. Each has subtle ref-reading timing. This works but is fragile.
- **Known risk**: adding a new save trigger or entry action could introduce a data loss regression.
- **Deferred because**: refactoring the save architecture would touch every interaction flow. Current approach works for the single-user use case.

### FFmpeg Loaded in Debug Build
FFmpeg native libraries (~234MB) are always bundled in the APK. Lazy-loading defers heap allocation to export time, but the APK size is still large.
- **Deferred because**: switching to MediaCodec would require a full export rewrite. `largeHeap` and lazy loading mitigate the OOM for now.

### Old Components Still in Codebase
`TimelineList`, `TimelineEntry`, `CaptureSheet`, `EditEntrySheet` are no longer imported but still exist in `src/components/`. They reference removed fields (`entry.type`, `MOODS`, `CATEGORIES`).
- **Deferred because**: they don't affect the app (not imported). Can be cleaned up in a dedicated pass.

### Notion Sync Without Transactions
Sync does multiple DB operations without a transaction. A crash mid-sync can leave the DB in an inconsistent state (some entries updated, some not, sync timestamp advanced).
- **Deferred because**: SQLite WAL mode provides some crash safety. Full transactional sync would require significant refactoring.

### No Offline Queue for Sync
If sync fails due to network error, failed entries are not queued for retry. The next sync might skip them if the timestamp has advanced.
- **Deferred because**: the current last-edit-wins approach handles most cases. A proper offline queue would require an outbox pattern.

### Clip URI Fragility
Clip URIs are full filesystem paths stored in the DB. If the app's data directory changes (reinstall, OS update), all clip URIs break. The `repairBareClipUris` function patches Notion-sync issues but doesn't handle path changes.
- **Deferred because**: the `clipMatcher` auto-reimport from camera roll provides a fallback. A proper solution would store relative paths.

### No Undo/Redo
Entry edits, deletions, habit toggles, and clip removals are immediate and irreversible. No undo stack.
- **Deferred because**: the save-on-keystroke architecture makes undo complex. Would need a separate change history.

### Single Device Only
The app assumes single-device usage. If two devices sync with the same Notion DB, last-edit-wins can cause data loss without the user knowing.
- **Deferred because**: multi-device sync requires CRDT or conflict UI. Out of scope for solo dev tool.
