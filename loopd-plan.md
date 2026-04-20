# loopd — Implementation Plan

> Structured for Claude Code. Read this file at the start of every session and continue from the next unchecked step. Complete all checkboxes in the current phase before moving to the next. Notify the user when a phase is complete before proceeding.

---

## Session startup prompt

```
Read loopd-plan.md from the project root and continue from
the next unchecked step in the current active phase.
Do not modify any files not explicitly mentioned in that phase.
When a phase is fully complete, stop and notify the user before
starting the next phase.
```

---

## Notification rule

> **After completing every phase, stop and output this message before doing anything else:**
>
> ```
> ✓ Phase [N] complete — [phase name]
>
> Summary of what was done:
> - [bullet list of completed steps]
>
> Next up: Phase [N+1] — [name]
> [one sentence describing what it involves]
>
> Ready to continue? Type "yes" to start Phase [N+1].
> ```
>
> Do not begin the next phase until the user confirms.

---

## Context

loopd is a single-user mobile vlog journal app for Android that combines daily journaling, video clips, habit tracking, todo lists, and a lightweight NLE video editor — all synced bidirectionally with Notion.

This plan covers five features in sequence:

1. **Dashboard redesign** — redesigned home screen with AI summary hero, 28-day habit heatmaps, and smart todos

Phases 1–3 (minimal editor, TikTok timeline, AI summary) are complete. This plan covers the remaining work: redesigning the dashboard around the AI summary as a hero card.

**Stack:** React Native 0.83 · Expo SDK 55 · TypeScript (strict) · Expo Router · expo-sqlite · react-native-video · ffmpeg-kit-react-native · react-native-reanimated · react-native-gesture-handler · lucide-react-native · Anthropic SDK (new) · Android only

---

## Portability rules

Follow these throughout all phases:

1. **Database is the single source of truth** — UI displays what's stored, no frontend filtering unless explicitly requested
2. **Auto-save on every keystroke** — silent, no re-render
3. **Always read from DB before auto-deleting** entries
4. **Don't auto-delete during sync operations**
5. **Prefer saving over deleting** — empty entry cleanup uses `deleteEntry()` to track deletions for sync
6. **Schema changes go through `migrate()` in `src/services/database.ts`** — additive only (new tables/columns via `CREATE TABLE IF NOT EXISTS` and `addColumn()`); Notion sync is the durable backup if a destructive change is ever needed
7. **Secure storage for all credentials** — Anthropic API key, Google Photos refresh token, OAuth state all in `expo-secure-store`
8. **Graceful AI degradation** — every AI feature has a rule-based fallback when the key is missing or the call fails

---

## Target file structure (new/changed)

Schema lives inline in `src/services/database.ts`; there is no `db/migrations/`
directory. Notion is the durable backup — the SQLite DB can be rebuilt from
sync at any time.

```
src/
  services/
    ai/
      summarize.ts        ← done
      prompt.ts           ← done
      validate.ts         ← done
      compose.ts          ← done
      config.ts           ← done
    todos/
      rank.ts             ← Phase 1
      crud.ts             ← Phase 1
  components/
    editor/               (already shipped — not touched in Phase 1)
      ClipTimeline.tsx    ← done
      EditorTimeline.tsx  ← done
      PreviewPlayer.tsx   ← done
      ClipEditor.tsx      ← done
      TextEditor.tsx      ← done
      TextOverlaySheet.tsx ← done
      FilterPills.tsx     ← done
      FilterEditor.tsx    ← done
      ExportModal.tsx     ← done
    home/
      AISummaryCard.tsx   ← Phase 1
      HabitHeatmapRow.tsx ← Phase 1
      SmartTodoList.tsx   ← Phase 1

app/
  index.tsx               ← Phase 1 (home screen; restructured)
  todos.tsx               ← Phase 1
```

---

## Phase overview

| Phase | Description | Depends on | Est. |
|-------|-------------|------------|------|
| **1** | Dashboard redesign | — | 6–8h |

---

## Phase 1 — Dashboard redesign

**Status: Active**

**Goal:** Redesign the home screen around the AI summary (already shipping) as a hero card. Replace the weekly habit row with 28-day heatmaps per habit. Add smart-ranked todos with full CRUD.

**Depends on:** —

---

### Target layout

```
┌─────────────────────────────┐
│  ⚡ Good morning, Rein       │   editable day title
│  Tuesday · Apr 15           │
├─────────────────────────────┤
│  🔥 Streak 5   71%   12d    │   stats strip
├─────────────────────────────┤
│  ✦ Today's summary          │   AI summary card (hero)
│  "Shipped the editor…"      │
│  [  🎬 Open vlog  ]         │
├─────────────────────────────┤
│  Habits                     │
│  🏃 Morning run   5🔥  ●●●○●●●   100%
│  📖 Read 20 mins  3🔥  ●●○●●●●   72%
│  📵 No phone      ·    ○●○○●●○   45%
├─────────────────────────────┤
│  Smart todos (3)            │
│  ○ Fix the drawer CSS       │
│  ○ Add retry logic  🔁      │
│  ○ Schedule rest  ✦         │
│  [ See all ]                │
└─────────────────────────────┘
```

---

### Steps

- [ ] **1.1** Restructure `app/index.tsx` with the new top-to-bottom layout
  - Placeholder cards for each section
  - Scrolls smoothly on Android
  - Editable day title at the top

- [ ] **1.2** Create `src/components/home/AISummaryCard.tsx`:
  - Reads latest `ai_summaries` row for today's date (table populated by the
    AI summary engine, already complete). The row stores a single
    `summary_json` blob; parse it to get `headline`, `summary`, and any
    other fields the prompt produces.
  - Shows `headline` + `summary` text + "🎬 Open vlog" button → `app/editor/[date].tsx`
  - Empty state when no summary exists yet for today: "Tap to generate today's summary" — calls `summarize()` from `src/services/ai/summarize.ts`
  - Loading state while generation is in progress
  - Error state if AI key is missing — directs user to Settings

- [ ] **1.3** Create `src/components/home/HabitHeatmapRow.tsx`:
  - 28-day heatmap from habit check-in history
  - Shows emoji + name + current streak + heatmap cells + completion %
  - Tap anywhere on row to quick-check today's habit (toggles check-in)
  - Heatmap updates immediately on check-in
  - Long-streak-missed-yesterday nudge: shows "save it" label on the row

- [ ] **1.4** Replace weekly habit grid in `app/index.tsx` with a list of `HabitHeatmapRow` components (one per habit, ordered by `sort_order`)

- [ ] **1.5** Create `src/services/todos/rank.ts`:
  - `rankTodos(todos, entries, habits, aiSummary) → RankedTodo[]`
  - Each `RankedTodo` includes: `id`, `text`, `done`, `completedAt`, `createdAt`, `entryId` (source journal entry), `entryDate`, `source` badge
  - Ranking signals:
    - Age (todos created today bubble up)
    - Context (yesterday's incomplete todos carry forward)
    - Habit-linked (todos tied to a habit)
    - AI-proposed (new todos suggested by `AISummary`)
    - Explicit priority (pinned todos)
  - Returns sorted array with `source` field for badge display

- [ ] **1.6** Create `src/services/todos/crud.ts`:
  - `addTodo(text, entryId?) → TodoItem` — if `entryId` is provided, appends to that entry's `todos_json`; if not, creates a new entry for today with a single todo. Sets `createdAt` timestamp on the todo.
  - `updateTodo(entryId, todoId, updates) → void` — updates `text`, `done`, `completedAt` fields on the todo inside the source entry's `todos_json`. Writes back to the entry row in SQLite. Sets `completedAt` to ISO timestamp when `done` flips to true, clears it when flipped back.
  - `deleteTodo(entryId, todoId) → void` — removes the todo from the source entry's `todos_json`. If the entry has no remaining content (no text, no clips, no habits, no other todos), delete the entry via `deleteEntry()` so Notion sync tracks the deletion.
  - All three functions update `entries.updated_at` on the source entry so Notion sync picks up the change.

- [ ] **1.7** Create `src/components/home/SmartTodoList.tsx`:
  - Reads all todos across all entries (query `entries.todos_json`) via `rankTodos()`
  - Shows top 3–5 with check circle + text + source badge + timestamp:
    - 📓 from journal
    - ✦ AI-proposed
    - ⭐ pinned
    - 🔁 carried from yesterday
  - Timestamp shown as relative: "2m ago", "3h ago", "yesterday"
  - Tap checkbox → marks done via `updateTodo()`, strikethrough + auto-hide after 2s
  - Swipe left on a todo → delete button, calls `deleteTodo()`, removes from list immediately
  - Tap todo text → inline edit mode, save on blur via `updateTodo()`
  - "⊕ Add" button at top of the list → inline text input, save on submit via `addTodo()` (creates in today's journal entry)
  - "See all" link navigates to `app/todos.tsx`
  - All changes reflect immediately in the source journal entry — no separate todo store

- [ ] **1.8** Create `app/todos.tsx`:
  - Full list of all todos across all entries
  - Filters: All / Open / Pinned / Done
  - "⊕ Add todo" button at top — inline input, calls `addTodo()` (creates in today's journal entry)
  - Each todo shows: check circle, text (tappable to inline edit), source badge, timestamp, entry date
  - Tap a todo's date label → jump to the source entry in journal
  - Swipe left → delete via `deleteTodo()`, reflects in source entry
  - Tap checkbox → toggle via `updateTodo()`, `completedAt` timestamp set/cleared
  - Pin/unpin action per todo (long-press or dedicated icon)
  - Reuses `src/services/todos/rank.ts` for ordering
  - All CRUD operations write through to the source journal entry in SQLite — the todo list is a view over journal data, not a separate data source

- [ ] **1.9** Update stats strip at top of home screen:
  - Streak (from longest active habit streak)
  - Completion % (habits completed today / total habits)
  - Days logged (count of `entries` with non-null text, grouped by date)

- [ ] **1.10** Run test suite — all existing tests pass

---

### Constraints
- Do not build todo recurrence or scheduling in this phase
- Do not build cross-integration logic (e.g., "skip workout if reflection mentions injury")

### Rollback plan
Revert `app/index.tsx` to the previous layout. New components (`AISummaryCard`, `HabitHeatmapRow`, `SmartTodoList`, etc.) can be deleted without data changes.

### ✓ Done when
- [ ] New dashboard layout renders correctly
- [ ] AI summary card shows data from the AI summary engine and navigates to vlog editor
- [ ] Habit heatmaps render 28 days per habit
- [ ] Tap-to-check updates streak and heatmap immediately
- [ ] Smart todos rank correctly and show source badges
- [ ] Smart todos show relative timestamps
- [ ] Adding a todo from the dashboard creates it in today's journal entry
- [ ] Editing a todo from the dashboard or full screen updates the source journal entry
- [ ] Deleting a todo from the dashboard or full screen removes it from the source journal entry
- [ ] Completing a todo sets `completedAt` timestamp, uncompleting clears it
- [ ] Deleting the last todo from an otherwise-empty entry deletes the entry via `deleteEntry()`
- [ ] Full todos screen filters and navigation work
- [ ] All tests pass

**→ Notify user: all phases complete. loopd feature plan done.**

---

## Cross-phase constraints

These apply to every phase:

- **Notify the user after every phase completes** — summarise what was done, state the next phase, wait for confirmation before starting
- **One phase per Claude Code session** — do not begin the next phase until all checkboxes are ticked
- **Do not modify unrelated files** — if a file is not mentioned in the current phase steps, leave it alone
- **Run tests after every phase** — no phase is done until tests pass
- **Deploy to device after every phase** — validate real behaviour on Android before building further
- **All credentials in secure storage** — never in env files, shared prefs, or the main SQLite DB
- **Auto-save is sacred** — never break the existing auto-save-on-keystroke behaviour
- **Database migrations are additive only** — new schema goes into `migrate()` in `src/services/database.ts` as `CREATE TABLE IF NOT EXISTS` / `addColumn()` calls; never destructive

---

## File location

Save as `loopd-plan.md` in the loopd repo root.
