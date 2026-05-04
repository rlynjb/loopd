# Chapter 1 — System Architecture

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

A concept written in this structure looks like:

> **Shape.** loopd has three persistence layers: `liveTextRef` holds the latest typed character, React state holds what is rendered, SQLite holds what survives a process kill.
>
> **Rule.** On every keystroke, `liveTextRef` and SQLite update before React state.
>
> **Failure mode.** A naive order updates React state first and persists to SQLite in an effect. If the user backgrounds the app between the two — Android can kill the process at any time — the typed text is lost. Inverting the order makes durability independent of the React lifecycle.
>
> **Contrast.** The vlog editor commits text overlays only on explicit save. That works because the editor has a clear "done" gesture (the export button); the journal does not. The constraint that distinguishes them is "is there an explicit commit point," and the answer drives the persistence policy.

Four short paragraphs, one per part. A reader who has never seen the system can follow it; a reader who has can review it.

---

## Opening — what you're looking at

Start at `app/_layout.tsx`. That file is the only thing the OS hands control to. It initializes SQLite via `useDatabase`, registers fonts, wraps the tree in an error boundary and a gesture root, then runs a sequence of cold-start jobs: OTA check, cloud-sync bootstrap, six SecureStore-gated backfills, classifier catch-up, yesterday-summary auto-trigger, and clip migration. Everything below `_layout.tsx` is an `expo-router` file route — `app/journal/[date].tsx`, `app/todos.tsx`, `app/editor/[date].tsx` — driven by the file system, not a hand-written router config.

The system has three planes: the journal plane (prose in, scanners out), the dashboard plane (rank + project derived rows), and the editor plane (entries → AI summary → FFmpeg export). They share one database, eleven tables, one cloud-sync mirror. The journal plane is where the architectural decisions live; the editor plane is where the FFmpeg complexity lives; the dashboard plane is where the read-side performance work lives.

The system is optimized for one thing: the user's typed character must be durable before they look away. Everything else — sync, AI, vlog export — runs at lower priority and tolerates failure. The cloud is a sync mirror, not a source. The AI is a fallback for ambiguous cases, not a hot path. The export is a batch job. None of those layers can lose a typed character.

### ASCII diagram — request flow on a journal keystroke

```
 Android view
     │
     │  onChangeText("today I [] call mom")
     ▼
┌────────────────────────────┐
│  liveTextRef.current = ... │  (a)  ref, not state — no render
└────────────────────────────┘
     │
     ▼
┌────────────────────────────┐
│  handleSilentNewText()     │  (b)  DB-first autosave
│   updateEntry(id, { text })│       — bypasses scanners
└────────────────────────────┘
     │
     ▼
┌────────────────────────────┐
│  SQLite UPDATE entries     │  (c)  durable. line 1 done.
│  + schedulePush() debounce │       cloud lags 5s
└────────────────────────────┘

         …commit point (focus blur, screen leave)…

┌────────────────────────────┐
│  useEntries.editEntry()    │  (d)  fires three scanners
└────────────┬───────────────┘
             │
   ┌─────────┼─────────┐
   ▼         ▼         ▼
┌──────┐ ┌──────┐ ┌──────┐
│scan  │ │scan  │ │scan  │
│Todos │ │Nutr. │ │Threads│  fire-and-forget;
└──┬───┘ └──┬───┘ └──┬───┘  threads waits on todos
   │        │        │
   ▼        ▼        ▼
todos_json  nutrition  thread_mentions
+todo_meta  table      table
   │        │        │
   ▼        ▼        ▼
┌──────────────────────┐
│ schedulePush()       │  one debounced push covers all writes
│  → 5s → pushAll()    │
│  → Supabase upsert   │
└──────────────────────┘
```

Two distinct moments. The keystroke lane is synchronous DB write + render. The commit lane is asynchronous scanner fan-out. They share a debounced push to the cloud. This separation is what makes "type fast" and "scan thoroughly" coexist without one starving the other.

---

## Concepts (four-part structure)

### 1. DB-first autosave

**Shape.** Three layers handle a typed character: `liveTextRef` (a React ref) holds the last value entered; `updateEntry()` in `src/services/database.ts` writes it to SQLite; React state in `app/journal/[date].tsx` only updates when the screen actually needs to re-render.

**Rule.** On every keystroke, the ref updates and SQLite writes before React state. The scanners do not run on keystroke — only at commit time (focus blur, screen leave, explicit save). The path is `onChangeText` → ref → DB → eventually state, never `onChangeText` → state → effect → DB.

**Failure mode.** The naive ordering puts text in component state first and persists to SQLite from a `useEffect`. Android may kill the process when the user backgrounds the app — and there is no `pagehide`-equivalent guarantee that the effect runs first. Past versions lost mid-sentence text this way; the fix was to invert the order so durability never depends on the component lifecycle. This is rule #3 in `.aipe/project/rules.md`.

**Contrast.** The vlog editor in `app/editor/[date].tsx` does not autosave per keystroke. Text overlays commit only when the user taps the export button or explicitly closes the sheet. The constraint that distinguishes the two: the journal has no "done" gesture (typing is the activity), the editor does (the export button). When there is an explicit commit, you do not need eager persistence; when there isn't, eager persistence is mandatory.

### 2. Two-pass commit-time scanners

**Shape.** Three scanner modules — `src/services/todos/scanTodos.ts`, `src/services/nutrition/scanNutrition.ts`, `src/services/threads/scanThreads.ts` — each takes the entry's prose, parses lines that match a marker pattern, and reconciles those lines against existing typed rows in their target table.

**Rule.** Reconciliation is two-pass. Pass 1 matches by the canonical key (todo text, `(name, kcal)` tuple, `(thread_id, source_line)`). Pass 2 matches by `sourceLine` — same line index, possibly different content. Anything matched in either pass keeps its existing row identity (and `id`, `createdAt`, `done`). Anything left over on the parsed side becomes new; anything left over on the existing side either dangles (todos) or is deleted (nutrition).

**Failure mode.** Without two-pass matching, a user editing `[] call mom` to `[] call dad` produces a delete-then-insert: the original todo is destroyed, a new todo is created, and any `todo_meta` row attached to the original (its type, expansion, classifier confidence) is orphaned. The user would lose the AI-generated decision tree they spent a Sonnet 4.6 call producing. Pass 2's line-index fallback identifies this case and keeps the row identity stable through the edit.

**Contrast.** Habits don't use two-pass scanning — they're not derived from prose. A habit row in the `habits` table is a first-class object the user creates explicitly in `/more/habits`. The `entries.habits_json` column is a per-day log of which habits were checked; it doesn't have to track identity across edits because the canonical key is `habit.id`, which doesn't change. The constraint that distinguishes the two: scanned drops are projections of mutable text; habits are entities with their own primary key.

### 3. Cloud as sync mirror, never canonical

**Shape.** Local SQLite is the canonical store. `src/services/database.ts` exposes the read API (every `SELECT` filters `WHERE deleted_at IS NULL`). Every write to a synced table calls `schedulePush()` from `src/services/sync/schedulePush.ts`, which fires a 5-second debounced `pushAll()` against Supabase. `pullAll()` runs on cold boot, paginated by `updated_at ASC`, with `last_pull_at` set from a `get_server_time()` Postgres RPC to defeat clock skew.

**Rule.** Read paths never hit the network. Write paths always commit local first; cloud lags by 5 seconds. Conflict resolution is per-row last-write-wins by `updated_at` (`src/services/sync/conflict.ts`). On first cold start, `bootstrapCloudSync()` decides initial-push vs first-pull vs no-op based on `cloud_initial_push_done` SecureStore flag and table populations.

**Failure mode.** Treating the cloud as canonical creates a hard dependency on connectivity for every read. On Android in a tunnel, the journal would freeze waiting for network — and the user would lose their place. With local canonical, the user types into a 12 ms SQLite write and the network handles itself in the background. The cloud-down case becomes invisible: writes queue (debounced push retries), reads succeed, sync resumes when Wi-Fi returns.

**Contrast.** The AI summary call (`src/services/ai/summarize.ts`) is the opposite — it has *no* local cache layer for new days; the function calls the LLM provider synchronously and returns a result. That's acceptable because vlog composition is an explicit user gesture (tap to enter the editor) and because the result is then cached in the `ai_summaries` table for re-mounts. The constraint that distinguishes them: journal writes happen continuously and have no acceptable network-dependent path; AI composition happens once per day on user demand and the user is already waiting.

### 4. Heuristic-before-LLM classifier

**Shape.** Two modules cooperate to classify a todo's type. `src/services/todos/heuristicClassify.ts` is a pure function over text that returns `'todo' | null` based on roughly 50 imperative verbs, modal phrases, and deadline patterns. `src/services/todos/classify.ts` calls Haiku 4.5 (or `gpt-4o-mini`) with a single-pass JSON prompt and returns `{type, confidence}`.

**Rule.** The heuristic runs first. If it returns `'todo'`, the LLM is never called. If it returns `null` and the todo isn't done, the LLM fires asynchronously (with a module-level in-flight counter exposed via `CLASSIFY_PROGRESS_EVENT` for the toast UI). The user can override the result by tapping the type badge; once overridden, `user_overridden_type=1` locks the row from future re-classification.

**Failure mode.** Calling the LLM on every todo without a heuristic gate would cost roughly an order of magnitude more tokens (most todos are obvious — "call mom", "buy milk") and would noticeably delay the first paint of the dashboard while the classifier toast spins. With the heuristic gate, ~80% of new todos resolve free and instant; only ambiguous ones ("the deck still feels off") pay the LLM cost. Without the override lock, an ambiguous todo the user re-typed as `'idea'` would flip back to `'question'` on the next entry edit when the classifier re-fires.

**Contrast.** The vlog summary call has no heuristic layer. The summary's job — choosing clip order, generating overlay copy, picking a filter preset — has no cheap deterministic approximation, so the LLM is the floor, not the fallback. The constraint that distinguishes the two: classification is a labeling problem with a strong prior (verb shape predicts type); summarization is a generation problem with no prior. Heuristic-first only helps when the heuristic has signal.

---

## Interview questions

### [mid] How does a typed character become a row in three different tables?

**Model answer (≥150 words).**

The user types `[] call #mom 320 kcal` into `app/journal/[date].tsx`. `onChangeText` fires `handleSilentNewText`, which writes the new text into `liveTextRef` and calls `updateEntry(id, { text })` in `src/services/database.ts`. SQLite is updated, `schedulePush` queues a 5-second debounced cloud push. Nothing else runs yet — no scanner, no React state update for the input, no LLM call. This is the keystroke path and it has to be cheap, because it runs on every character.

When the user blurs the input (focus leaves, screen navigates away, or explicit save), `useEntries.editEntry` runs three scanners. `scanTodosFromText` parses `[] call …` and merges it into `todos_json` via two-pass matching. `reconcileTodoMetaForEntry` (fire-and-forget) inserts the paired `todo_meta` row, runs the heuristic, fires the LLM if needed. `scanNutritionForEntry` parses the `320 kcal` suffix and writes a `nutrition` row. `scanThreadsForEntry` (waits on todos because it needs the todo IDs for `[]`-line tag attribution) parses `#mom` and writes a `thread_mentions` row pointing at both the entry and the todo. One typed line, three derived rows, all from the same prose source.

### [senior] Why is the cloud sync layer 5-second debounced and not write-through?

**Model answer (≥150 words).**

Write-through sync would mean every keystroke triggers a network call, and that's wrong for two reasons. The first is throughput: a fast typist hits 5 characters per second and the journal has no debounce of its own — write-through would generate 5 Supabase upserts per second per device. The second is coupling: a network failure (Android tunnel, weak Wi-Fi, sleeping radio) would either block the keystroke path or generate per-character error handling, neither of which is acceptable. The debounce in `src/services/sync/schedulePush.ts` collapses bursts of writes into one push at the next quiet point.

Five seconds is the chosen window because it's longer than any human typing burst (so a paragraph syncs as one batch) but shorter than the typical attention shift between activities (so the user almost always sees their data on a second device by the time they pick it up). The local SQLite write is the durability point — the cloud is a backup mirror, not a write-through cache. If the device dies before the debounce fires, the data is on disk; the next boot's `pushAll()` ships it. The risk window is the 5 seconds between local commit and cloud arrival, and the failure mode is "this device dies unrecoverably in the next 5 seconds," which is acceptable for a personal journaling app.

### [arch] What changes at 10× scale?

**Model answer (≥150 words).**

Phase A is single-user with `user_id = '00000000-0000-0000-0000-000000000001'` hardcoded in `src/services/sync/client.ts` and RLS disabled. At 10× device count for one user (still single user, more devices) almost nothing changes: writes still last-write-wins on `updated_at`, the `(user_id, id)` upsert key already exists, and the read path is local. The interesting case is 10× users (Phase B), which forces three changes.

First, RLS turns on and `auth.uid()` replaces the hardcoded user ID; every table needs a policy. Second, the `last-write-wins` strategy for cross-device editing of the *same row* gets weaker as the user's device count grows — at 10× you start seeing meaningful concurrent-edit cases that LWW resolves arbitrarily. The fix is a vector clock or per-field merge, but the simpler answer is to not store edits as full-row replacements; the journal entry's `text` column is the worst offender because it's a free-form blob. Per-line CRDT or operational transform on `entries.text` is the long form; in the short term, conflict UI on the cloud-sync screen is enough.

Third, the `ai_summaries` cache and `expand` orchestrator both call provider APIs from the device. At 10× users with active vlog days, the per-key rate limit dominates; the architectural fix is to move LLM calls behind a server (Cloudflare Worker or Supabase Edge Function) where API key rotation, rate limit pooling, and cost tracking can live. That moves the AI provider from a client SDK (`@anthropic-ai/sdk`) into a single backend service, which also means the keys stop living in `expo-secure-store`. None of this is on the v1 critical path because the math doesn't break until you have paying users; it's all a Phase B problem.

---

## The hard question

### "If the journal is just text and the typed records are derived, why bother with three scanners — why not just regex over the prose every time you need to render the dashboard?"

**Model answer (≥200 words).**

Because the typed records carry state that is *not* derivable from prose. A `todo_meta` row carries the LLM-classified type, the user's manual override flag, the `expanded_md` blob from a Sonnet 4.6 expansion, the `stage` enum, the `position` integer for manual reorder. None of those exist in the user's typed `[] call mom` line. If I regenerated typed rows from prose on every render, all of that derived state would be ephemeral or would have to be rederived — every dashboard render would have to re-classify, re-expand, re-stage. That's both slow and wrong: the user *manually overriding* a classifier result has to survive prose edits, and re-deriving from prose alone destroys the override.

The two-pass scanner pattern is what makes this coexist: prose stays canonical (the user can edit `call mom` to `call dad` and the line is still authoritative), but the typed row stays stable across the edit (its `user_overridden_type`, its `expanded_md`, its `stage` carry forward). This is the same problem CRDT designs solve for collaborative text — keeping derived structure attached to mutable content. I'm not running a real CRDT; I'm running a single-writer two-pass diff at commit time. That's enough because there's no concurrent editing within a single device, and cloud sync resolves cross-device with per-row LWW.

The other reason is rendering cost. The dashboard's `SmartTodoList` ranks todos across all entries; the `/todos` page filters and sorts thousands of rows. SQL on indexed columns (`todo_meta(type)`, `todo_meta(stage)`, `entries(date)`) scales; "regex every entry's text on every render" does not. The scanner runs once per commit, not once per render. That's the production cost difference between `O(N entries)` and `O(N entries × R renders)`, and the project will hit the latter ceiling on day one.
