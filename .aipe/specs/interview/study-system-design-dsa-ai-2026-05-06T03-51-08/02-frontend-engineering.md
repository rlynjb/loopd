# Chapter 2 — Frontend engineering

The frontend is React Native 0.83.2 + Expo SDK 55 with `expo-router` 55 doing file-based routing out of the `app/` directory. The boot path is `app/_layout.tsx`, which mounts `<GestureHandlerRootView>` at the root, wraps everything in an `ErrorBoundary`, gates rendering on `useDatabase().ready`, and renders the `<Stack>` plus the persistent `<GlobalBottomNav>`. There are 11 screens, all of them functional components. There are zero class components, zero higher-order components, and exactly one Context provider — the gesture-handler root. State is colocated to the screen that owns it.

The frontend's architectural personality is: **the dashboard recomputes; the screens recompose.** The dashboard at `app/index.tsx` is a thin assembler — it fetches entries, todos, todo_metas, habits, and threads on focus, then hands them to display components (`SmartTodoList`, `DailyScheduleGrid`, `AISummaryCard`, `PastVlogCard`, `HomeHeader`). None of those display components own data. They render exactly what's passed. Mutations route through services (`updateTodo`, `toggleHabitToday`, `toggleThreadTouchToday`) which write to SQLite and notify the parent via an `onChanged` callback that triggers a fresh fetch. The pattern is "props down, mutations up," strict.

```
app/_layout.tsx (boot sequence)
  ├── useDatabase()        ← gate: SQLite open + WAL + migrations
  ├── useFonts() x2        ← UI fonts + overlay fonts
  ├── 7 backfill effects   ← SecureStore-gated, fire-and-forget
  ├── cloud sync bootstrap ← bootstrapCloudSync() | pullAll → pushAll
  ├── AI auto-summarize    ← yesterday's date if no summary cached
  └── <Stack>              ← expo-router screen registry
       ├── index.tsx           (dashboard)
       │     ├── HomeHeader
       │     ├── PastVlogCard            (yesterday's exported vlog)
       │     ├── AISummaryCard           (today's compose preview)
       │     ├── DailyScheduleGrid       (7-col weekly habits + threads)
       │     ├── DailyScheduleHeader
       │     ├── DailyScheduleLegend
       │     ├── OffDayToggle
       │     └── SmartTodoList           (top-5 ranked open todos)
       ├── journal/[date].tsx  (full-day textbox + drops)
       ├── editor/[date].tsx   (clip timeline + caption variants)
       ├── todos.tsx           (list + 3 filter axes + swipe-delete + pin)
       ├── todos/[id].tsx      (expanded markdown for typed todos)
       ├── threads/[id].tsx    (thread detail + recent mentions)
       ├── more/{habits,threads,nutrition,index}.tsx
       └── settings/{ai,cloud-sync,index,updates}.tsx
       └── <GlobalBottomNav>   (5-icon bottom nav, Record button removed)
```

The dashboard recently dropped two pieces (`HabitHeatmapRow` and the now-orphan streaks math, commit `c9f7d38`) and the navbar dropped the Record button (`b10a97e`) — the recording UX moved to a long-press on the journal entry, simplifying the nav. What's left on the dashboard is the *full week* view: a weekly schedule grid that renders habits and threads as rows, days as columns, today highlighted, mixed by time-of-day buckets.

## Concept 1 — Dashboard fetch on focus

**Shape.** Three actors carry the dashboard's data flow: `useFocusEffect` (re-runs when the user returns to the screen), the dashboard's `loadAll()` callback (fires `Promise.all` over `getAllEntries`, `getAllTodoMetas`, `getHabits`, `getThreadCards`, etc.), and the display components which receive arrays as props.

**Rule.** The dashboard re-queries on every focus. There is no global store, no optimistic mutation cache, no React Query. The DB is the cache.

**Failure mode.** A real-time / pub-sub model would have the dashboard subscribe to DB change events and patch in-memory state. The failure mode is *desync between components*: if `SmartTodoList` patches its local state when a todo is toggled, but the underlying `entries` array isn't patched, the next time `useFocusEffect` fires it pulls stale-fresh data and the component "rolls back" to a stale view briefly. With "re-query on focus," there's exactly one source of truth at every render — what SQLite says right now.

**Contrast.** The journal screen *does* hold local state — the `TextInput`'s value lives in `useState` between keystrokes — because the user is actively typing and a re-fetch would drop their unsaved chars. The constraint is *who owns the cursor*. The journal owns it (it has a focused `TextInput`); the dashboard never does. So the dashboard re-queries freely; the journal queries once on focus and writes through.

## Concept 2 — Daily Schedule Grid: cell-state derivation

**Shape.** The grid in `src/components/home/DailyScheduleGrid.tsx` has three layers: (1) row data — habits + threads from props; (2) cell-state computation — `cellStateFor(habit, date, today, checkedDates)` and `cellStateForThread(touched, date, today)` in `src/components/home/cellState.ts`; (3) cell rendering — a `<View>` with `cellPending`/`cellDone`/`cellMissed`/`cellOffDayFaded` styles selected from a switch on the state.

**Rule.** Cell state is *derived*, never stored. The cell knows nothing except "given habit X, date Y, today is Z, and these are the dates it was checked, what should I look like?" The function is pure; the cell is dumb.

**Failure mode.** The denormalized version stores cell-state strings in a `habit_cells` table — one row per (habit, date). The failure mode is the off-day rule changing: if I decide "Sundays are off-days for everyone," every cell in every past week needs updating. With the derived model, the rule lives in `cellStateFor` and changes propagate on next render. With the stored model, you ship a migration. Worse, the stored model can disagree with the underlying check-in: a row in `habit_cells` says "done" but no row in `entries.habits_json` for that date proves it. Two sources of truth.

**Contrast.** Thread staleness *is* computed once and cached on the `ThreadCard` row returned by `getThreadCards`. The constraint that distinguishes them is *data volume per render*. The grid renders ~20 cells (2-7 rows × 7 days); recomputing every render is free. Thread cards render ~10 staleness labels but each requires a max-aggregate over all that thread's mentions, so caching the materialized value at fetch time pays for itself.

## Concept 3 — Tag autocomplete in the todos list

**Shape.** The `/todos` screen (`app/todos.tsx`) has a tag autocomplete strip that surfaces above the keyboard whenever the user types `#` followed by an optional alphanumeric prefix. Three pieces: a regex (`/(?:^|[^\w#-])#([a-zA-Z][a-zA-Z0-9-]*)?$/`) that detects an in-progress tag *immediately before the cursor on the current line*, a state variable `tagAutocomplete` carrying the query and the range (`{ query, rangeStart, rangeEnd }`), and the `<TagAutocomplete>` component that renders existing-thread chips and an "add new" pill.

**Rule.** The autocomplete reads the *cursor-relative substring of the current line*, not the full text. This is what makes it work mid-paragraph: typing `... thanks for the lift #trav` should detect `trav` as the in-progress tag, not the whole "the lift #trav" string.

**Failure mode.** The naive regex `/#([a-zA-Z][a-zA-Z0-9-]*)?$/` against `text.slice(0, cursor)` matches `#trav` correctly but also matches `something#trav` (false positive — a `#` inside a word, like a hex color). The actual regex `(?:^|[^\w#-])#...` requires the `#` to be at line-start or after a non-word, non-`#`, non-`-` character. The line-start case is handled by computing `lineStart = text.lastIndexOf('\n', cursor - 1) + 1` and slicing from there — without that, multi-line journal entries would let an old `#tag` from line 1 trigger autocomplete on line 5.

**Contrast.** The journal editor uses the *exact same* tag detection pattern. The two use sites import the regex from the same source-of-truth file (well — they currently duplicate it; that's a deliberate small duplication kept for readability, with the canonical version in the journal editor). The constraint that distinguishes is *which input's selection is live*. The todos page has two competing inputs (the new-todo input and the inline-edit input); the autocomplete dispatches based on `editingId` to the right pair of handlers (`handleEditTagSelectExisting` vs `handleTagSelectExisting`). The journal has one input.

## Concept 4 — Swipe-to-delete with explicit height

**Shape.** Each todo row in `/todos` is wrapped in `<Swipeable>` from `react-native-gesture-handler`. The right-action panel reveals a coral delete button. Three pieces: `renderRightActions` (returns the panel JSX), `rightThreshold={40}` (drag distance to commit), `friction={1.5}` (gesture resistance).

**Rule.** The action panel must have explicit `height: '100%'` and `elevation: 4` on Android. Without both, the panel auto-sizes to its content and short-rows look fine but tall multi-line rows show the row's text bleeding past the shorter coral panel.

**Failure mode.** The naive version omits `height` (auto-fit) and `elevation` (no z-stacking). On a row with a 3-line wrapped todo, the coral panel is ~50dp tall and the row is ~80dp; the bottom 30dp of the row's text is visible *next to* the coral panel during the swipe. On Android, even with correct height, the row's text z-renders above the panel without `elevation` because of native view ordering. Both fixes are commented in `app/todos.tsx:594-605`.

**Contrast.** The dashboard's `SmartTodoList` doesn't have swipe-to-delete — it uses an inline `×` button instead. The constraint that distinguishes them: the dashboard renders a hard cap of 5 rows (`MAX_ROWS = 5`), and the inline `×` is faster than gesture overhead at that scale. The full `/todos` page with N rows benefits from gesture economy — fewer accidental deletes.

## Three interview questions

### `[mid]` — "What's your state management strategy and why didn't you use Redux / Zustand / React Query?"

I don't have a global store. State is colocated to the screen that owns it, and the DB is the cache. The dashboard at `app/index.tsx` does a `Promise.all` of five DB queries on `useFocusEffect` and passes the arrays down to display components. The journal screen owns its own `TextInput` value in `useState` and writes through to SQLite on each keystroke. The todos screen owns its filter state (`status`, `category`, `threadFilter`), which is irrelevant to any other screen.

The reason I skipped Redux is that the app is 11 screens and there's no shared mutable state between them that doesn't already live in SQLite. If `SmartTodoList` mutates a todo and the user navigates to `/todos`, the focus effect on `/todos` re-queries the DB and sees the change. There's no scenario where two screens disagree about a row, because they both read from the same place at the same point in time. Redux would be solving a problem I don't have.

I considered React Query specifically. It would buy me background refetch, cache invalidation by key, and optimistic updates. The cost is a dependency, a `QueryClient` provider in `_layout.tsx`, and a `useQuery` wrapper around every fetch. The benefit at this scale is small: my queries are fast (SQLite, ms not seconds), focus-based refetch is what I want, and optimistic updates are correctness-risky for a derived-state system where the projection of `entries.text` into `todos_json` happens server-side (well, in services). I'd rather re-query on focus and be correct than fake-update and be wrong on the next render. If the app grew a real-time feature — say, push notifications inserting rows from outside the app — I'd reach for React Query then.

### `[senior]` — "Why does the dashboard re-query on every focus instead of subscribing to DB changes?"

Two reasons, one tactical and one strategic. Tactical: SQLite via `expo-sqlite` doesn't expose change events out of the box. I'd have to instrument every write site in `database.ts` to emit an event and have screens subscribe — that's about 40 emit-points and a custom event bus. The strategic reason is more interesting: subscriptions are *imperative*; the dashboard's data flow is *declarative*. Re-query on focus says "show me what's true right now." Subscribe + patch says "track every delta and stay synced." Both are correct; the imperative version has more surface for bugs.

The specific bug class subscriptions invite is *patch desync*. If `SmartTodoList` subscribes to `entries.todos_json` changes and patches its sorted view in-place, but the parent dashboard's `entries` array isn't patched, then on the next focus event the parent re-queries, hands a different `entries` array down, and `SmartTodoList`'s memoized `sorted` array re-derives from scratch — possibly with a different sort order than the user just saw. The user watches the list shuffle. With re-query-on-focus, every component derives from the same canonical fetch in the same render pass.

The cost is small over-fetch. On the dashboard, that's 5 SQL reads on every focus event — about 8ms total on my Pixel 6. The dashboard focuses maybe 10 times per session. 80ms total. Not worth optimizing. If I had a screen that focused 100 times per minute (a chat?), the math would flip.

The thing this approach forces is: every mutation goes through `database.ts` and bumps `updated_at`, which incidentally is also what `schedulePush()` needs for the cloud sync's dirty-row query. The architecture doesn't have two parallel notification paths.

### `[arch]` — "How does the frontend's performance model change when there are 5,000 todos in the system?"

The honest answer: the dashboard would still be fine, the `/todos` page would not. Let me walk both.

Dashboard. `SmartTodoList` does `getAllEntries` (loads everything to memo `entries`), then flattens to a `DashboardTodo[]`, filters by `done && completedAt > now - 2s`, sorts by `(pinned, position, createdAt DESC)`, slices to 5. With 5K todos that's 5K rows in memory, each ~200 bytes parsed JSON, so ~1MB of `Entry` data. The flatten is O(todos), the sort is O(todos log todos), the slice is O(1). On a Pixel 6 that's roughly 30ms — acceptable for a once-per-focus operation. What I'd change: switch `getAllEntries` to a SQL projection that pulls just the fields the dashboard reads (`id, date, todos_json, created_at` — drop `text`, `clips_json`, etc.) to halve the parse cost.

`/todos` page. This one is `getAllEntries` + `getAllTodoMetas` + `countAmbiguousNotDone` + `getThreads` + `getTodoThreadLinks`. With 5K todos, the in-memory join (`metas: Map<todoId, TodoMeta>`) is 5K entries; the rendered `<ScrollView>` is *all* matching rows. The killer is the `<ScrollView>` — it renders every row eagerly. I'd swap to `<FlatList>` with `windowSize={5}` and `removeClippedSubviews={true}`, and that cuts memory pressure to a constant ~30 rows on screen at any time. The 3-axis filter (status × category × thread) currently re-derives `filtered` on every state change with `useMemo` keyed on those three plus `allRows` and `todoThreadLinks`. With 5K rows, the worst case is changing a thread filter — full O(n) walk plus a `Set.has` per row. Still milliseconds, not blocking.

The two real changes at 5K. First, the AI classifier catch-up at app boot (`classifyAmbiguousMeta` from `src/services/todos/migrateMeta.ts`) becomes painful: it walks ambiguous rows in batches and calls Claude Haiku for each. With 1K ambiguous todos at $0.0001 per classify, the boot pass is $0.10 — non-zero. I'd cap the catch-up at 100 per boot and let the rest backfill across sessions. Second, the dashboard's `getThreadCards` aggregates last-mention-at across all `thread_mentions` rows — at 5K todos with ~30% tagged, that's 1.5K mention rows, still trivial as a single SQL aggregate. Beyond 50K I'd move that aggregate into a materialized `thread_summary` row updated on each thread mention insert.

The architectural conclusion: the frontend doesn't need a virtualization rewrite at 5K. It needs `FlatList` on `/todos` and a bounded classifier catch-up. Both are 1-day changes.

## The hard question — "Why is there no test for any of this UI?"

There isn't one. The repo has no Jest, no React Native Testing Library, no Detox, no Playwright. The closest thing to a test is the manual end-to-end I run on the connected device after each meaningful change.

The honest reason is *cost-vs-confidence calculus for a solo project*. A unit test for `SmartTodoList`'s sort behavior is 30 lines and catches one regression class — bad sort. The same coverage from manual testing is "open the dashboard, see the todos in the right order" — 5 seconds, catches the same regression class plus styling regressions plus state-leak regressions plus crash regressions. For a one-person team where I am the only person changing this code, manual is more cost-effective. I do not believe that scales past two engineers.

The classes of regression I knowingly under-test:

1. **Race conditions during transitions** — what happens if the user toggles a todo *while* the focus refetch is mid-flight? Manual testing rarely surfaces this; a deterministic test could. I haven't seen this regression in practice but I'd be surprised if it isn't lurking.
2. **Multi-line text edge cases in scanners** — `scanTodosFromText` has reorder + edit + delete cases that interact. I've manually walked them; I haven't proven all six combinations.
3. **Animation cleanup on unmount** — the toast animation in `app/todos.tsx` clears its hide timer on unmount. If the cleanup didn't run (it does), there'd be a setState-after-unmount warning. I've never seen one. It would take a unit test to *prove* I won't.

What I'd do differently with a team: Vitest + a fixture suite for `scanTodosFromText` (the highest-value pure function in the codebase), React Native Testing Library smoke tests on each top-level screen ("renders without crash given an empty DB"), and a single Detox journey test ("create entry, type `[]`, leave screen, return, see todo on dashboard"). The first one I'd add is the scanner suite — it's where bugs would be most expensive and fixture-based tests would be most natural.
