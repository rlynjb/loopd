# Chapter 2 — Frontend Engineering

## Opening — what you're looking at

`expo-router` is the routing layer; the file tree under `app/` is the route tree. Five tabs (`Home`, `Record`, `Journal`, `Todos`, `More`) live in `src/components/nav/GlobalBottomNav.tsx`, hidden on `/editor/*` and `/settings/*`. Components are functional, hooks-first, no class components. The styling discipline is rigid: `StyleSheet.create()` at the bottom of each file, no inline styles for repeated patterns, `Pressable` over `TouchableOpacity`. These conventions are recorded in `.aipe/project/rules.md` and enforced by review, not lint.

The frontend's job is unusual for a "normal" mobile app: it is essentially a text editor that has to be perfectly durable under Android's process-kill behavior, plus a video editor that runs FFmpeg. The journal screen (`app/journal/[date].tsx`) holds most of the durability complexity. The dashboard (`app/index.tsx`) holds most of the read-side aggregation work. The editor (`app/editor/[date].tsx`) holds the FFmpeg state machine, which I'll cover separately in Chapter 6.

State management is deliberately boring. There is no Redux, no Zustand, no Context-as-store. Each screen owns its hooks: `useEntries` for journal data, `useHabits` for habits, `useProject` for editor state, `useDayTitle` for the per-day rename. The single source of truth is SQLite — refetched into local state on focus or after writes. This works because the writes are durable independently of state (DB-first autosave) and because there is no cross-screen state that needs to live longer than a route mount.

### ASCII diagram — component tree (journal screen)

```
JournalScreen  app/journal/[date].tsx
│
├─ HomeHeader            (sticky top — sync icon, settings cog)
│
├─ EntryList
│   │
│   ├─ Entry  (one per row in entries WHERE date=?)
│   │   ├─ TextInput        ◀── liveTextRef anchor
│   │   │   │  onChangeText → handleSilentNewText
│   │   │   │  onBlur       → useEntries.editEntry (commit)
│   │   │
│   │   ├─ HabitChipsRow    (toggles entries.habits_json)
│   │   ├─ ClipStrip        (clips_json, opens preview)
│   │   └─ TodoChecklist    (round-trip toggles → rewrites prose)
│   │
│   └─ NewEntryButton       (creates a fresh row at the bottom)
│
├─ KeyboardToolbar          (floats above keyboard)
│   ├─ TodoQuickAction      (inserts "[] " at cursor)
│   ├─ ClipQuickAction      (camera roll picker)
│   └─ HabitQuickAction
│
├─ NutritionAutocomplete    (sibling to toolbar; chips when "** " is typed)
└─ TagAutocomplete          (sibling; chips when "#xyz" is typed)

GlobalBottomNav             (anchored bottom, hidden on /editor/*, /settings/*)
```

The two autocompletes are **sibling components**, not nested in the toolbar. They share the same Z-order rules and animate independently. This is deliberate — they have different focus triggers (cursor-after-`** `, cursor-after-`#`) and shouldn't share state through a parent.

---

## Concepts (four-part structure)

### 1. The keystroke contract on the journal `TextInput`

**Shape.** Three things hold the typed character at any moment: the `TextInput`'s internal value (controlled by React), the `liveTextRef` which captures the latest `onChangeText` argument synchronously, and the `entries` SQLite row updated by `handleSilentNewText`.

**Rule.** `onChangeText` writes the ref and schedules the SQLite update synchronously, before any state setter that would re-render. The state setter for the `TextInput` runs eventually (debounced or on blur) only to keep React's view in sync. The DB write is the canonical commit.

**Failure mode.** If `setState` precedes the ref-and-DB write, an Android process kill in the gap loses the character. Past experience: a `useFocusEffect` cleanup function that cleared `liveTextRef` raced with the auto-commit timer and dropped a half-typed sentence. Rule #5 in `.aipe/project/rules.md` exists because of that bug: never clear live refs in focus cleanup.

**Contrast.** The vlog editor's `TextOverlaySheet` updates state immediately and does not write to SQLite per keystroke; it commits when the sheet closes. The constraint that distinguishes them: the editor's text overlays are bounded (typically <100 chars, one per clip), the user explicitly opens and closes the sheet, and a process kill mid-edit losing the change is acceptable because there's a clear redo path (re-tap the overlay). The journal has no redo path for "I lost the paragraph I just typed."

### 2. Round-trip writes — dashboard ↔ prose

**Shape.** A todo lives in three places: as `[] call mom` in `entries.text`, as a row in `entries.todos_json`, and as a paired row in `todo_meta`. The dashboard's `SmartTodoList` renders from the rank function; toggling its checkbox calls `updateTodo` in `src/services/todos/crud.ts`, which calls `rewriteTodoLine` to flip `[]` to `[x]` in the source prose.

**Rule.** Any UI affordance that changes a typed record's state must also rewrite the source prose to match. The prose stays the canonical truth; toggling a todo done from the dashboard rewrites the matching `[]` line to `[x]`. The next time the scanner runs over that prose, the result is consistent.

**Failure mode.** If the dashboard wrote only to `todos_json`, opening the journal would show `[]` (unchecked) for a todo the dashboard shows as done. The next scanner run over that prose would *unmark* the todo because the prose says it's not done. Without round-trip rewrite, the prose-canonical invariant breaks the moment any non-prose UI mutates state.

**Contrast.** The thread "manual touch today" toggle on the dashboard does *not* rewrite prose. `toggleThreadTouchToday` in `src/services/threads/touch.ts` writes a `thread_mentions` row with NULL `entry_id` and NULL `todo_id`. This is the one documented deviation from the prose-canonical rule (Principle 11 in `docs/spec.md` §10). The constraint that distinguishes them: a todo toggle conceptually means "I finished the task I wrote in prose," which is reversible to a prose edit; a manual thread touch means "I worked on this project today without writing about it," which has no prose equivalent.

### 3. Autocomplete sibling components and Z-order

**Shape.** Three components stack at the bottom of the journal screen above the keyboard: `KeyboardToolbar` (always visible), `NutritionAutocomplete` (when cursor is after `** `), `TagAutocomplete` (when cursor is after `#xyz`). They are siblings under the screen root, not nested.

**Rule.** Only one autocomplete renders at a time. Trigger detection runs on every text-change event over the active line; the cursor position determines which (if any) autocomplete shows. The toolbar always renders below them (lower Z), and the keyboard renders below that.

**Failure mode.** Nesting the autocompletes in the toolbar would force them to share its layout. Past attempt: nesting caused the chip bar to inherit toolbar padding and resulted in mis-alignment when the keyboard's height changed mid-scroll. The sibling layout decouples geometry — each component owns its own absolute positioning.

**Contrast.** The classifier toast on the `/todos` screen is also absolutely positioned and floats above the list, but it is not a sibling of the input — it is a sibling of the page root. The constraint that distinguishes them: the autocompletes are anchored to the keyboard (they need to track the keyboard height), the toast is anchored to the screen top (it has to be visible regardless of keyboard state).

---

## Interview questions

### [mid] How does the dashboard decide which 5 todos to show?

**Model answer.**

The function is `rankTodos` in `src/services/todos/rank.ts`. It flattens every entry's todos into one list, tags each with a source (`'carried'` if the todo is from a previous date and not done; `'ai'` if AI-generated; `'journal'` otherwise), and sorts by source priority (carried < ai < journal). Within each priority bucket it sorts by `effectiveCreatedAt` ascending — oldest first — because that matches the journal's append-only feel. Done todos go to the bottom of their group with a 2-second grace window so the user sees the strikethrough briefly before the row drops off.

The dashboard takes the top 5 results. It runs on the entries currently in React state, which is loaded by `useEntries` from SQLite on focus. Toggling a checkbox calls `updateTodo`, which round-trips through `rewriteTodoLine` to flip `[]` to `[x]` in the source prose, then re-runs the scanner so the `todos_json` and `todo_meta` rows stay consistent. After the write, the dashboard refetches and re-ranks. The whole path is local; there is no network call to render the dashboard.

### [senior] Why is there no global state store (Redux, Zustand) — what would force you to introduce one?

**Model answer.**

Because the canonical state is SQLite and there is no cross-screen shared state with lifetime longer than a route mount. Each screen's hook (`useEntries`, `useHabits`, `useProject`) reads its own slice of the DB, refetches on focus, and refetches after a write. The cost of cache staleness is one DB query — milliseconds — and the duplication of "load the same entries on multiple screens" is acceptable because the `entries(date)` index makes it cheap.

What would force a store: any state that has to live longer than a route mount AND can't tolerate a refetch latency on focus. The candidate is the export pipeline progress in the editor. Right now it lives in the editor screen's component state, which means navigating away from the editor mid-export loses the progress UI. A global store keyed by `date` would survive the navigation. The other candidate is the classifier in-flight counter — but it's already module-level state in `src/services/todos/classify.ts` exposed via `CLASSIFY_PROGRESS_EVENT`, which is the lighter pattern. I'd reach for a real store only when the second cross-screen-persistent state appears; one outlier doesn't justify the dependency.

### [arch] At 10× journal entries (say 10,000 entries × 50 todos each), what breaks in the frontend?

**Model answer.**

The dashboard's `rankTodos` flattens all entries into a single in-memory list. At 10K × 50 = 500K todos, the sort is O(n log n) on the device — about 8 million comparisons — and that's before render. The fix is two-tiered: first, the sort can be replaced by a SQL `ORDER BY` against a `todo_meta` view that pre-computes the source priority; this turns the work into an indexed query against `todo_meta(type)` and a join on `entries(date)`. Second, the dashboard only needs the top 5 results — `LIMIT 5` against the indexed query is constant time.

The `/todos` page is the harder case. It's a flat list with three filter chips (status, type, thread) and renders one row per `todo_meta`. At 500K rows, even an indexed `SELECT … LIMIT 100` is fast, but `FlatList` rendering 100 rows with `TypeBadge`, `StageBadge`, and a `TagAutocomplete` on each is not free. The fix is `getItemLayout` with a fixed row height (it's already fixed in CSS), virtualization tuning (windowSize=5), and moving the per-row badge color lookups out of render — they currently hit `typeMeta.ts` per row, which is fine at 500 rows but should be hoisted to a memoized lookup at 50K.

The journal screen scales differently. Each daily entry list is bounded by the day's prose, so the per-day cost stays constant. The cross-day cost is just navigation, and `expo-router` lazy-loads each route. The thing that would actually break first is SQLite startup time on cold boot — opening a 200 MB `loopd.db` and running 11 schema migrations adds visible latency. The fix is migration squashing (one big bootstrap migration replaces the 11) and `PRAGMA journal_mode = WAL`, which is already on but worth re-checking under load.

---

## The hard question

### "There's no automated test suite. How do you stop yourself from breaking something every time you ship?"

**Model answer (≥200 words).**

I rely on three things in place of unit tests, and I'm clear-eyed about the gap. First, TypeScript strict mode catches the largest class of bugs I'd otherwise write — wrong field types, missing properties, `null` not handled. `npx tsc --noEmit` runs before every commit and is non-negotiable. Strict types in `src/types/` (the `Entry`, `TodoMeta`, `Thread` shapes) are the rails the rest of the codebase runs on. Second, the architectural rules in `.aipe/project/rules.md` and `docs/spec.md` §10 are the test contract: rule 3 says writes happen before render, rule 7 says scanners are two-pass, rule 9 says user override is permanent. When I touch code in those areas, I read the relevant rule first. The "test" is whether the change still satisfies the rule.

Third, manual end-to-end testing on a connected Android device after every meaningful change. I have a fixed set of paths I always exercise: type a sentence with `[]`, `**`, and `#tag` in it; toggle the resulting todo from the dashboard; open the editor and export a vlog. If those three flow without obvious regressions, the change ships.

What I don't have: regression coverage. A bug in `scanTodos` two-pass matching that doesn't break the happy path could ship and only surface when a user edits a specific kind of line. The fix I'd write first is property-based tests for the three scanners — they are pure functions over text and existing rows, which is the easiest possible test surface. I haven't written them because they aren't on the critical path for shipping the next feature, and because the cost of a regression in this app (single-user, on-device data, no cloud-write-through) is bounded by the next sync push. That's a conscious tradeoff; in a multi-tenant production system the answer would be different.
