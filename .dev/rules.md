---
title: rules
---

## Data Rules

- **Database is the single source of truth.** The UI must display data exactly as stored in the database — no frontend filtering, hiding, or transforming records unless explicitly requested.
- **Do not filter in frontend/UI.** If data should not be displayed, delete it from the database. Do not use `.filter()` or conditional rendering to hide database records from the user.
- **Only implement frontend filters when explicitly asked.** If the user requests a filter (search, sort, visibility toggle), implement it. Otherwise, assume all DB records should be shown.
- **Clean data at the source.** If records should not exist (empty entries, orphaned data), delete them from the database — not hide them in the UI layer.

## Autosave & Inline Editing Rules

- **Always read from DB before deleting.** Auto-commit timers, cleanup effects, and idle handlers must read the latest entry from the database before deciding to delete. In-memory refs (`liveTextRef`, `editingEntryRef`) can be stale after navigation or focus changes — the DB is the only reliable source.
- **Never clear live refs in focus cleanup.** The `useFocusEffect` cleanup runs on navigation but idle timers may still fire afterward. Clearing `liveTextRef` in cleanup causes the timer to see empty text and delete the entry. Let the auto-commit handler clear refs after it's done.
- **Save to DB on every keystroke.** Use silent/DB-only saves (no React state update) on each keystroke so the database always has the latest text. This prevents data loss on app kill, navigation, or timer races.
- **Don't auto-delete during sync.** Automatic empty-entry cleanup must not run inside sync operations — it can race with in-progress edits. Run cleanup only on explicit user-initiated page loads, not background processes.
- **Prefer saving over deleting.** When in doubt, save the entry rather than delete it. An entry with stale or empty text is recoverable; a deleted entry is not.


# Sync Rules

Rules for syncing a local database with a remote data store.

## Rule 1: Single Source of Truth for Reference Data

Reference data has ONE source of truth — the remote store.
Every sync replaces all local reference data with the remote copy.

- Delete local → re-insert from remote (full replace, not merge)
- Local never pushes reference data upstream
- Local may cache for offline use but never modifies

## Rule 2: Bidirectional Sync for User-Generated Data

User-generated data syncs both ways.
Conflict resolution: last-edit-wins with a remote bias window.

- Local creates → push to remote on next sync
- Remote creates → pull to local on next sync
- Both edited → remote wins if edits are within the bias window, otherwise latest timestamp wins
- Deletions sync both ways: remote deletion removes local; local deletion archives remote

## Rule 3: Derived State is Computed, Not Synced

State that can be derived from synced data is never synced directly.
It is recomputed from source data on load.

- On reinstall: pull source data from remote, then reconstruct derived state
- Derived state lives only in local storage as a cache
- If derived state is missing or corrupt, recompute — never prompt the user

## Rule 4: IDs Must Be Globally Unique

Use the remote system's native ID as the primary key for remote-sourced records.
Never generate IDs from mutable fields — they cause collisions on rename or duplication.

- Remote-sourced records: use the remote ID directly
- Locally-created records: generate a unique ID, then associate with a remote ID after first push

## Rule 5: Sync Order

1. Pull reference data (full replace)
2. Pull user-generated data (merge with conflict resolution)
3. Push local user-generated data
4. Process deletions
5. Update sync timestamp
