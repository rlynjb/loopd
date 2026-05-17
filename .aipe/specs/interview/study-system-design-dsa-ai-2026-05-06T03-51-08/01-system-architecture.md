# Chapter 1 — System architecture

## Explaining Concepts

Architectural concepts in this guide follow a consistent explanation structure so each one can stand on its own and be understood without prior context.

### Structure

Every concept is introduced in four parts:

**1. The shape.** Name the parts and give each one a single job. One sentence per part is enough — the goal is to establish the vocabulary before reasoning about it. If a part needs a paragraph to define, it's probably two parts.

**2. The rule.** State the ordering, constraint, or invariant that holds the parts together. This is the load-bearing sentence. Most architectural mistakes are violations of a rule that was never stated explicitly, so naming it makes the design reviewable.

**3. The failure mode.** Describe what goes wrong when the rule is violated. Use a concrete scenario, not an abstract risk — "if X happens between step 2 and step 3, Y is lost" beats "this could lead to inconsistency." The failure mode is what justifies the rule; without it, the rule looks arbitrary.

**4. The contrast.** Show where the same problem is solved differently elsewhere in the system, and why. Two patterns that look contradictory usually aren't — they're responses to different constraints. Naming the constraint that distinguishes them turns "we did it two ways" into "we did it the right way twice."

### Why This Structure

Each part answers a question an informed reader will ask:

- *What are the pieces?* → the shape
- *How do they fit?* → the rule
- *What happens if they don't?* → the failure mode
- *Why not do it the other way?* → the contrast

Skipping any of the four leaves a gap the reader has to fill in themselves, and they'll fill it in wrong. Skipping the failure mode is the most common mistake — it makes the design read like preference rather than necessity.

### Voice

State decisions, not hopes. "Writes happen before render" reads stronger than "we try to write before render where possible." Hedging language ("ideally," "in most cases," "we believe") signals to the reader that the rule isn't actually enforced, which means it isn't actually a rule.

Use concrete nouns over abstract ones. "The cursor position" is reviewable; "user interaction state" is not. If a noun in the spec couldn't be pointed at in the running code, it's probably too abstract.

Keep sentences short. Architectural prose earns its weight from specificity, not sentence length.

### Worked Example

Drawn from this codebase rather than a generic one. The journal editor's autosave is a good fit:

> **Shape.** Three layers carry an entry's text. The `TextInput`'s controlled value (renders the cursor), `entries.text` in SQLite (canonical), and the in-memory `Entry` returned by `useEntries` (re-renders consumers).
>
> **Rule.** On every keystroke, SQLite writes before the React state setter fires. The DB is the single source of truth; the screen displays exactly what's in the DB.
>
> **Failure mode.** The naive order updates the React tree first and persists in a `useEffect`. If the user kills the app between the keystroke and the effect, the keystroke is lost. Worse: the dropped keystroke might be the `]` that closes a `[]` checkbox, so the next render shows a half-formed line that the scanner won't materialize as a todo.
>
> **Contrast.** The vlog editor *does* defer persistence — clip trims and overlays buffer in a `Project` row that only flushes when the user taps "compose." The constraint that distinguishes them is the gesture: the journal has no explicit save button, so persistence has to be eager; the editor has a compose button, so persistence can wait.

Four short paragraphs, one per part. A reader who's never seen the system can follow it; a reader who has can review it.

---

## What buffr actually is

buffr is an Android-only, single-user, offline-first daily-vlogging journal with an AI compose pass and a Supabase sync mirror. The "vlog" half is a 9-second-cap clip recorder + an FFmpeg-backed editor that exports a portrait MP4. The "journal" half is a single full-day textbox where the user types prose and the prose is mined for typed records. The two halves meet in the AI summarize pipeline, which reads prose and entries and produces a structured `AISummary` (clip order, mood, caption, four tonal variant captions) that the editor pre-fills.

The runtime is React Native 0.83.2 + Expo SDK 55 with `expo-router` 55 for file-based routing. There is no backend in the traditional sense. Persistence is `expo-sqlite` 55 in WAL mode at `buffr.db`; the cloud is `@supabase/supabase-js` v2 hitting a Postgres mirror with composite `(user_id, id)` PKs on every table. The boot sequence opens the DB, runs SecureStore-gated backfills (todos, nutrition, todo_meta, threads, habits cadence, clip migration), hydrates fonts, and triggers the cloud sync orchestrator. There is no test suite — verification is `npx tsc --noEmit` plus manual end-to-end on the connected device.

The thing to understand before opening a single file: **the architecture optimizes for "user-types-and-the-app-extracts-everything-else."** Every piece of the system either records prose, projects derived state from prose, or composes the day from those projections. There is no other use case the app serves.

```
User keystroke (TextInput in journal editor)
        │
        ▼
┌───────────────────────────────────────────────────────┐
│  database.ts — single SQLite write site              │
│  updateEntry(id, { text }) bumps updated_at,         │
│  clears synced_at, fires schedulePush() (5s debounce) │
└───────────────────────────────────────────────────────┘
        │
        ▼
   SQLite (buffr.db, WAL mode) ← canonical
        │
        ├──► UI re-renders from DB (useEntries hook)
        │
        ▼ (only at commit: focus blur or screen leave)
┌───────────────────────────────────────────────────────┐
│  Scanners — pure functions, prose → derived rows     │
│   • scanTodosFromText   → entries.todos_json         │
│   • reconcileTodoMeta   → todo_meta (1:1 with todos)  │
│   • scanNutritionFromText → nutrition rows            │
│   • scanThreadsFromText  → thread_mentions rows       │
└───────────────────────────────────────────────────────┘
        │
        ▼ (5s after last write)
┌───────────────────────────────────────────────────────┐
│  Cloud sync orchestrator — pushAll() / pullAll()     │
│   walks REGISTRY[] in sync/orchestrator.ts            │
│   each table: localQueryDirty → upsert → stamp       │
└───────────────────────────────────────────────────────┘
        │
        ▼
   Supabase Postgres (mirror, never canonical)
```

Note what this diagram does *not* show. There is no API gateway. There is no message bus. There is no background worker process — every "background" job is a `setTimeout` or a fire-and-forget Promise from the same React Native runtime. There is no second device pulling at the same time, because the app is solo-use in Phase A. Every layer that doesn't exist is a layer I deliberately didn't build.

## Concept 1 — The "prose is canonical" rule

**Shape.** Each derived feature has three pieces: (1) a *marker syntax* in `entries.text` (`[]`, `** food N kcal`, `#tag`), (2) a *scanner* (a pure function in `src/services/<domain>/scan*.ts` that reads prose and emits typed records), (3) a *commit point* (focus blur or `useFocusEffect` cleanup on screen leave) that runs the scanner and persists the diff via `database.ts`.

**Rule.** Derived state is rebuilt from prose at commit time. Direct edits to derived state — toggling a todo's `done` flag from the dashboard, for instance — are round-tripped back into the source line by `rewriteTodoLine` in `services/todos/scanTodos.ts:139` so prose stays the canonical record.

**Failure mode.** If the user toggles a todo from the dashboard and the round-trip skipped, then on next visit to the journal the line still reads `[] write the README` instead of `[x] write the README`. The scanner runs, sees the original `[]`, regenerates the todo as not-done, and silently overwrites the dashboard's toggle. The user thinks they checked it; the prose says they didn't; the prose wins. The fix is not "remember the dashboard's intent" — that creates two canonical stores. The fix is "the dashboard rewrites the prose on every edit" so the next scan re-reads the user's intent verbatim.

**Contrast.** Habits don't follow this rule. A habit check-in is recorded by writing `entries.habits_json` directly — no marker in prose. The constraint that distinguishes them is *granularity vs ergonomics*. Drops (`[]`, `**`, `#tag`) sit naturally in prose because they coexist with sentences the user is already writing. Habits are a separate gesture (tapping a row in the schedule grid) and have no natural prose form, so threading them through `entries.text` would force the user to type `++ workout` or similar — friction the design refuses to take. The rule is "prose is canonical *for things the user already writes inline*," not "prose is canonical for everything."

## Concept 2 — DB-first autosave

**Shape.** The autosave loop has three actors: the `TextInput` (controlled component), the `useEntries` hook (subscribes to DB changes via `useFocusEffect`), and `database.ts:updateEntry` (the only write site for the `entries` table). The flow is `onChangeText` → `updateEntry({ text })` → SQLite UPDATE → React state setter → `TextInput` re-renders with the new value.

**Rule.** The SQLite UPDATE happens *before* the React state setter fires, on every keystroke. `updateEntry` is awaited; nothing renders from intermediate in-memory state.

**Failure mode.** The naive React-first version writes to a `useState` hook on `onChangeText` and persists in a `useEffect([text])`. If the OS reaps the app between the React render and the effect, the most recent N keystrokes vanish. On Android, an OOM on a 2GB device during clip transcode triggers exactly this. Worse, partial loss eats the closing `]` of a `[]` line, the scanner doesn't fire (no marker), and on next session the user finds no todo where they thought they made one.

**Contrast.** The vlog editor's `Project` row defers persistence until "compose" is tapped. Why is that allowed? Because the editor has an explicit gesture that means "I am done editing this draft" — `onPress={composeAndExport}` calls `updateProject` and only then does the row hit SQLite. The journal has no equivalent gesture. The constraint is the same in both cases — *don't lose user intent* — but the resolution differs because the user's signal differs.

## Concept 3 — Two-pass scanner matching

**Shape.** Every prose-derived feature has a scanner with two passes: (1) *exact text match* — find existing typed records whose canonical text matches the line case-insensitively; (2) *line-index fallback* — for unmatched lines, find existing records whose `sourceLine` points at that index. Anything still unmatched is a new record. Anything not claimed at the end is carryover.

**Rule.** Identity is preserved across edits. A todo whose text changes (`[] call mom` → `[] call dad`) keeps its `id`, `createdAt`, `done`, and any AI-classified type — because the line-index fallback claims it before a fresh todo is generated.

**Failure mode.** If the scanner only does pass 1, then editing the text of a todo line generates a *new* todo (no match in pass 1) and the old todo carries over with no `sourceLine` (it's now an orphan). The user sees their list double, with a stale copy of every todo they've ever edited. Conversely, if the scanner only does pass 2, then *reordering* lines breaks identity — moving `[] call mom` from line 4 to line 2 makes it look like a brand new todo at line 2 and the original at line 4 becomes a carryover.

**Contrast.** `thread_mentions` doesn't use the two-pass scanner because the mapping is simpler: a thread mention is keyed on `(entry_id, slug, line_number)` and can be wholesale replaced on each scan — there's no per-mention identity worth preserving. The constraint is *whether the user has a long-lived relationship with the row*. Todos do (they get classified, expanded, pinned, completed). Mentions don't.

## Concept 4 — Cloud as a sync mirror, never the canonical source

**Shape.** Three pieces: SQLite (canonical, every read goes here), Supabase Postgres (the mirror, structurally identical schema with composite PKs), and the orchestrator in `src/services/sync/orchestrator.ts` that walks a `REGISTRY[]` of `SyncableTable<TLocal, TCloud>` definitions in order. Each table's module in `src/services/sync/tables/<name>.ts` provides the local-dirty query, the local→cloud mapper, the cloud→local mapper, and the conflict columns.

**Rule.** Reads always hit local SQLite. Writes commit local first; the cloud trails by 5 seconds via a debounced `schedulePush()` from `database.ts`. Conflicts on pull are resolved by `chooseWinner(local, cloud)` in `sync/conflict.ts` — last-write-wins by `updated_at`.

**Failure mode.** The mirror-flips-canonical version reads from Supabase whenever the network is up and falls back to SQLite when offline. The user opens the app on a flight, the network is "available" at 200ms latency through inflight wifi, the cloud query is slow but not failing, the entries screen blocks for 1.5s, the user hits back, the screen unmounts mid-fetch, the loaded list never renders, and the user thinks the data is gone. Worse: if the cloud has stale data because the previous push timed out, you display yesterday's truth on top of today's keystrokes. SQLite is always milliseconds; the cloud is never.

**Contrast.** The AI compose pipeline does hit the network synchronously — `summarize(date)` blocks on a Claude call. The constraint that allows it: AI compose is *user-initiated* (a "compose" button) and the user already understands "this is the AI thinking." Network-dependent operations are fine when the user expects the spinner. They're a bug when the user expects an instant read.

## Three interview questions

### `[mid]` — "Walk me through what happens when the user types a `[]` line in the journal."

I'll trace the keystroke from the `TextInput` to the dashboard's todo list. The journal screen at `app/journal/[date].tsx` renders a `TextInput` whose value is bound to the current entry's `text`. On every `onChangeText`, the screen calls `updateEntry(entry.id, { text: nextText })` from `src/services/database.ts`, which fires a SQLite UPDATE that bumps `updated_at`, clears `synced_at`, and writes the new prose. The DB is now canonical for that keystroke. Crucially, the `[]` scanner does *not* run on every keystroke — only at *commit*, which means focus blur or the `useFocusEffect` cleanup on screen leave. The reason is a real bug we shipped early on: running the scanner on every keystroke meant a half-typed `[ ]` (with a space mid-bracket) would briefly create a todo, then delete it on the next keystroke, leaving an orphaned `todo_meta` row.

When commit fires, `scanTodosFromText` in `src/services/todos/scanTodos.ts` reads the entry's prose, emits a fresh `TodoItem[]`, and `database.ts:updateEntry` persists it as `todos_json`. Then `reconcileTodoMetaForEntry` in `src/services/todos/reconcileMeta.ts` walks the diff: any new todo gets a `todo_meta` row (heuristic-classified inline; ambiguous ones fire the Claude Haiku 4.5 classifier asynchronously); any disappeared todo has its meta deleted; everything else is preserved including its `type` and `pinned` flag. Finally `schedulePush()` queues a 5-second debounced cloud push. The dashboard re-renders via `useFocusEffect` next time the user navigates back, and the new todo shows in `SmartTodoList` ranked among the other open todos.

The tradeoff named explicitly: scan-at-commit means the user can't see derived state update mid-keystroke. They have to leave the screen for the dashboard to update. I traded immediacy for correctness — incomplete syntax shouldn't materialize partial records, and the only honest signal of "the user is done with this line" is "they navigated away."

### `[senior]` — "How does buffr guarantee that an entry's `todos_json` and the `todo_meta` table never drift?"

There is no foreign key. SQLite doesn't let you FK from a table column to a row inside a JSON array of another table, and even if it did, I'd still need application-level reconciliation because the `todo_id` is generated by the scanner from prose, not by the user clicking "new todo." So the invariant is enforced *by code*, not *by schema*, and the code is `reconcileTodoMetaForEntry` in `src/services/todos/reconcileMeta.ts`. After every entry write that could change the todos array, the reconciler runs: it loads the current `todo_meta` rows for that `entry_id`, diffs them against the IDs in `todos_json`, inserts a meta for each new todo, deletes a meta for each disappeared todo, and leaves matched ones untouched.

The reconciler is *self-healing*. If a previous run failed mid-way and left an orphaned meta row, the next reconcile sees the orphan in the diff and deletes it. If a previous run failed before inserting a meta, the next reconcile sees the missing entry and inserts it. The function is wrapped in a try/catch that logs and swallows; a failed reconcile never throws into the journal screen, because that would block the user's typing. Best-effort with eventual consistency, where the next commit is the consistency point.

The tradeoff: this is brittler than a real foreign key. If `entries.todos_json` gets corrupted (malformed JSON), every reconcile sees zero todos and silently deletes every meta for that entry. That's why `database.ts:getEntryById` defensively parses with a fallback to `[]` rather than throwing — corruption gets visible as missing todos in the UI rather than as a crash. At 10× scale (thousands of todos per user per year) the reconciler walks O(todos in entry) per write, which stays cheap because the unit of work is one entry. If I had to scale to multi-day batched reconciliation, I'd switch to a single SQL diff using JSON1 functions.

### `[arch]` — "If buffr had to support 100K users with shared multi-device sync, what changes?"

Three things change immediately. First, **last-write-wins by `updated_at` stops being acceptable.** `chooseWinner` in `src/services/sync/conflict.ts` resolves a same-second tie deterministically by biasing toward cloud, which is fine for solo use across devices owned by the same human. With 100K users editing concurrently from web + mobile, a same-second tie can mean device A's edit overwrites device B's edit on the same field. The fix is field-level merge or vector clocks. Practically I'd start with field-level — store the last-modifier timestamp per field on the server and merge incoming writes per-field — because text-prose entries don't have natural CRDT semantics, but per-field structured fields like `habits_json` do.

Second, **the prose-is-canonical rule has to be revisited for collaboration.** Two users editing the same entry's text concurrently is the case where last-write-wins is genuinely wrong: one of them loses their words. At 100K users, *some* of them will share entries (couples journaling together, teams logging dailies). I'd ship a Yjs- or Automerge-style CRDT for `entries.text` specifically, leaving the simpler structured tables on field-level merge. The cost is significant — every entry now carries an opaque CRDT document, scanners run on the materialized text rather than the prose blob, and the sync protocol grows a delta-encoding layer. But it's the only honest answer to "two cursors in the same paragraph."

Third, **RLS goes from "scaffolded but disabled" to load-bearing.** `supabase/migrations/0002_rls.sql` exists but is a no-op in Phase A — the schema gate is the composite `(user_id, id)` PK on every table, which guarantees a user *can't accidentally write to another user's row* but doesn't prevent a malicious client from *reading* one if RLS is off. At 100K users, RLS is enforced and tested, the per-table sync mappers all set `auth.uid()` correctly, and the `PHASE_A_USER_ID` constant in `src/services/sync/client.ts` is replaced by Supabase Auth tokens. The boot sequence in `app/_layout.tsx` would gain a sign-in gate before `bootstrapCloudSync()` could run.

Two things stay the same. The orchestrator's `REGISTRY[]` walk doesn't change — it's already O(tables) per sync cycle, push and pull paginate at 50 and 200 rows respectively, and the per-table `SyncableTable` interface absorbs new fields without touching the orchestrator. And the local-first read model stays: even with collaboration, every read on the device hits SQLite first. The cloud is still the mirror.

## The hard question — "buffr has no test suite. Why should I trust this code in production?"

I'll be straightforward. There is no Jest, no Vitest, no Detox, no automated test in the repo. The only verification gates are `npx tsc --noEmit` (must pass before commit, `.aipe/project/rules.md`) and manual end-to-end on the connected Android device (`adb install -r` then walk the screens). That's a real gap. I won't argue it isn't.

What I'll argue instead is that *the project's design optimizes for safety in a way that compensates for the missing tests, and I knew the gap was there when I shipped it.* Three concrete ways:

First, **the scanners and the conflict resolver are pure functions over plain inputs.** `scanTodosFromText(text, existing)`, `chooseWinner(local, cloud)`, `computeStaleness(thread, lastMentionAt)`, `cellStateFor(habit, date, today, checkedDates)` — none of them touch the DB, none of them have side effects, and every one of them was easy to verify by hand-running edge cases against the implementation in my head. They are the riskiest functions in the codebase precisely because they're behaviorally subtle, and they were designed to be unit-testable in 30 minutes if I ever add a runner. The TypeScript signatures are tight enough that the compiler catches most regressions.

Second, **the soft-delete / `synced_at` model is auditable.** Any sync bug leaves a trail: the dirty-row query (`updated_at > synced_at OR synced_at IS NULL`) is a SQL one-liner I can run from the dev menu (`src/services/sync/devActions.ts`). If a row didn't sync, I see exactly which row, which timestamp, and whether the cloud has it. I've debugged real cloud-sync bugs in 5 minutes using this. Compared to a typical "the API call failed silently somewhere in a service" bug, the cost-to-diagnose is much lower.

Third, **the manual test set is short and I run it consistently.** After every meaningful change I create an entry with all four marker types (`[]`, `** food`, `#tag`, habit toggle), navigate away to commit, navigate back to confirm derived state, then open settings → cloud sync → "force push" + "force pull" + "diff" to confirm the round-trip. It takes 90 seconds. It's not as good as a test suite. It is much better than nothing, and for solo phase-A usage it has caught every regression I was going to catch anyway.

What I'd do differently if I were shipping to a team: add Vitest, set up a fixture-based test for `scanTodosFromText` covering reorder + edit + delete, add a sync round-trip test with a Supabase test project, and gate the merge on both. The work is on the deferred backlog (`docs/buffr-deferred-backlog.md`); it isn't done because I am the only person editing the codebase and the cost-of-bug today is "I notice on the next commit and revert." That math changes the moment a second engineer joins.
