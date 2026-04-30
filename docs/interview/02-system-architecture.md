# 02 — System architecture

> **Read second.** Get the request flow straight before you talk about anything else. If you can sketch the diagram below from memory, you can survive any system-design question on this codebase.

When a new engineer clones loopd and opens the project, the first thing they should look at is `src/services/` — that's where the work happens. The UI in `app/` is mostly file-routed Expo screens that call into hooks in `src/hooks/`, which call into services. This is layered architecture done deliberately: each layer only depends on the ones below it, and the boundaries are obvious from the import graph alone.

The interesting part isn't the layering. The interesting part is the *commit-time split* — the design decision that everything else falls out of. When the user types in the journal, every keystroke writes to SQLite immediately, no React state involved. The bytes are durable from keystroke one. When the user blurs the input or navigates away, *that's* when the parsers run and the AI fires and the Notion sync queues. The save path and the derive-state path are separate by design. Past data-loss bugs came from React state being out of sync with what the user typed when navigation interrupted, and the keystroke-to-DB write fixed that whole class of bug.

The commit-time split is also what made it cheap to add a *third* drop type. The original two were `[]` (todos → `todos_json` + `todo_meta`) and `** food N kcal` (nutrition → `nutrition` table). On 2026-04-29 I shipped `#tag` (threads → `thread_mentions`) using exactly the same shape: prose-canonical, two-pass reconciler, fire-and-forget on commit. The scanner runs *after* the todo scan because `#tag` lines inside `[]` todos need the final todo IDs for attribution — that ordering constraint is the only new wrinkle in the journal commit path.

The other interesting part is what's *not* there. There's no backend in the conventional sense. There's no server, no auth layer, no API gateway. The only network dependency is the Notion REST API, and even that is treated as additive — if Notion goes away, the app keeps working with locally-canonical data. This shapes everything: there's no auth code to discuss, but there's also a lot of merge logic I had to write by hand because I didn't get a sync engine for free.

The bottom nav is five tabs (Home / Record / Journal / Todos / More). I prototyped a sixth — a dedicated **Today** tab for the daily-schedule tracker — and folded it back into the Home dashboard once it was clear the tracker wanted to live next to the greeting and `SmartTodoList`. The dashboard's **DAILY SCHEDULE** section now combines habits + threads, bucketed by `time_of_day`, and the More tab is the management hub for nutrition / habits / threads CRUD.

```
              Request flow on a journal save

  User types in InlineTextInput.tsx
            │
            ▼
   onSilentSave fires (every keystroke)
            │
            ▼
   updateEntryDB → SQLite
            │
   ────  bytes are durable here  ────
            │
            ▼
   ┌────  user blurs / navigates  ────┐
   │                                  │
   ▼                                  ▼
  useEntries.editEntry          (no other side effects
            │                    on keystroke path)
            │
            ├──► applyTodoScan (pure parser, in-memory)
            │           └─► todos_json updated in entry write
            │
            ├──► scheduleNutritionScan (fire-and-forget)
            │           └─► nutrition table reconciled
            │
            ├──► scheduleTodoMetaReconcile (fire-and-forget)
            │           │
            │           ├─► insert paired todo_meta row
            │           ├─► run heuristicClassify (free, sync)
            │           └─► if heuristic null AND !todo.done:
            │                       ▼
            │                scheduleClassify (LLM, async)
            │                       ▼
            │                updateTodoMeta(type, confidence)
            │                       ▼
            │                emit('classify-progress')
            │                       ▼
            │                /todos toast updates
            │
            └──► scheduleThreadScan (fire-and-forget; runs AFTER
                        todo scan — needs final todo IDs for
                        []-line tag attribution)
                        │
                        ├─► parse #tag mentions in entry prose
                        ├─► parse #tag mentions inside each todo
                        ├─► auto-create unknown slugs (threads row)
                        └─► two-pass reconcile thread_mentions
                                (entry_id pass + todo_id pass)

  Separately, on next user-initiated sync or boot auto-sync:
            │
            ▼
   syncAll → syncAllTodos → syncAllHabits → syncAllThreads
            │         │             │             │
            ▼         ▼             ▼             ▼
        Notion    Notion        Notion        Notion
       (entries) (todos)       (habits,      (threads,
                              opt-in DB)    opt-in DB)
       — all share the same module-level 350ms rate limiter —

       Dashboard composition (Home / DAILY SCHEDULE):
            getThreadCards.ts ─┐
            habits + cadence ──┼──► bucketed by time_of_day
                               │     (morning → midday →
                                       evening → anytime)
                                     habit rows + thread rows
                                     (mini-headers when 2+
                                      buckets populated)
```

The diagram looks busy because it is. Four things now happen simultaneously when a user just types a todo with a tag: durability (SQLite write), structure derivation (todo + nutrition + thread scanners), AI classification (async LLM call when heuristic abstains), and thread auto-create + mention reconcile. The point of the architecture is that none of these block each other. The save is fast because it doesn't wait. The scans are fast because they're pure. The LLM call is async because it's the only one that's actually slow, and its result trickles into the UI via the events bus when it returns.

## Interview questions

### Q1 [mid] Walk me through what happens when I type `[] call mom #family` and tap somewhere else.

I'll trace it in order. Inside [`InlineTextInput.tsx:54-61`](../../src/components/journal/InlineTextInput.tsx#L54-L61), the keystroke fires `onSilentSave` which writes the raw text to SQLite via [`updateEntry`](../../src/services/database.ts) — no React state update, no scanner, just a direct DB write. The entry's text is durable from that moment.

When I tap somewhere else, the `useFocusEffect` cleanup in [`app/journal/[date].tsx:81-87`](../../app/journal/[date].tsx#L81-L87) calls `editEntry` from the [`useEntries`](../../src/hooks/useEntries.ts) hook. That hook does four things in order: it runs `applyTodoScan` (pure parser that extracts `[]` lines into `todos_json`), then it fires `scheduleNutritionScan`, `scheduleTodoMetaReconcile`, and `scheduleThreadScan` as fire-and-forget. The journal save itself completes here.

The reconcile inserts a paired `todo_meta` row with the heuristic-classified type — for `call mom`, "call" is in the imperative verb list at [`heuristicClassify.ts`](../../src/services/todos/heuristicClassify.ts), so it's classified as `'todo'` immediately. No LLM call.

The thread scan runs *after* the todo scan because it needs the final todo IDs to attribute `#tag`s sitting inside `[]` lines. It walks [`scanThreads.ts`](../../src/services/threads/scanThreads.ts), masks code spans, finds `#family`, looks up the slug in `threads`, auto-creates the thread row if it doesn't exist (deliberate ergonomic deviation from the original "explicit-only" model), then writes a `thread_mentions` row with `todo_id` set to the freshly-paired todo. The dashboard's `SmartTodoList` re-renders, the todo appears, and the **DAILY SCHEDULE** thread row's open-todos count ticks up.

The whole thing took maybe 5ms of user-blocking work. Everything else was async.

### Q2 [senior] Why does the dashboard tracker bucket by `time_of_day` instead of giving it its own tab?

I prototyped a fourth nav slot — a dedicated **Today** tab — and the second I had it on screen the cost was obvious: the user had to leave the dashboard (greeting + Today's Vlog + `SmartTodoList`) to see what they were trying to *do* today. Two surfaces, both claiming "this is your day," and the user has to context-switch between them.

Folding it into the dashboard as a single **DAILY SCHEDULE** section solved that — one screen, one mental model. Habits and threads share the same row layout (80px name + 14-cell flex strip + 36px right-side count or `→` arrow) so the grid reads uniformly even though the underlying tables (`habits`, `threads` + `thread_mentions`) are completely different. The bucketing is what lets two heterogeneous record types coexist: `time_of_day` is a column on both `habits` and `threads`, and the renderer just sorts morning → midday → evening → anytime, dropping in mini-headers once 2+ buckets are populated by either type.

The tradeoff was a small one I deliberately accepted: the 14-cell strip on thread rows is driven *only* by manual touches (`toggleThreadTouchToday` in [`threads/touch.ts`](../../src/services/threads/touch.ts), which writes a `thread_mentions` row with NULL `entry_id` and NULL `todo_id`). Prose `#tag` mentions don't paint the strip. They show up on the per-thread detail page at `/threads/[id]` where mentions *are* the point, but on the dashboard the strip needs to mean "did I do this today?" not "did I mention it?" Different question, different signal.

That decision is the one documented deviation from Principle 11 ("mentions are derived; metadata is stored"). I'm comfortable with it because the schema permits it cleanly — the staleness and 14-day-strip math compose uniformly across all three mention shapes (entry-prose, todo-text, manual-touch).

### Q3 [arch] If this needed to support 100k users with multi-device sync, what changes?

Three things break first. **First**, the Notion API as a sync backbone caps at ~3 req/s per integration, and the boot chain just got longer — `syncAll → syncAllTodos → syncAllHabits → syncAllThreads`. The module-level rate limiter at [`notion/api.ts:7`](../../src/services/notion/api.ts#L7) is the right shape but only sufficient for one client. At scale I'd put a server-side sync gateway in front of Notion, fanning out per user with per-user backpressure and a token-bucket rate model.

**Second**, SQLite-first means no multi-device. Two devices editing the same entry will diverge, and the `#tag` system makes this worse because thread auto-creation on save means two devices typing `#family` in the same minute will mint two `threads` rows with the same slug and racing UNIQUE-constraint failures on the second one. I'd move to a CRDT layer for `entries.text`, `todos_json`, and the thread/mention tables so concurrent edits converge. The two-pass matching is a sane substrate for this; the actual merge would be CRDT-driven, not hand-rolled.

**Third**, the LLM cost path needs metering and quotas per user. `MAX_CONCURRENT=3` at [`expand.ts:25`](../../src/services/todos/expand.ts#L25) is a per-device cap; at scale it becomes a per-user-per-window quota with billing integration. Cost-tiered model selection (cheap classifier, primary expansion) is the principle that doesn't change. That principle scales fine.

The pattern that scales least well is the JS-side flatten + sort on `/todos`, now with a third filter axis (Threads). At 5k+ todos per user and a few dozen threads, the three-way AND filter becomes a render cliff. Solution is virtualized lists (`FlashList`) plus pushing the filter to SQL with computed indexes on `todo_meta(stage, position)` joined against `thread_mentions(thread_id)`.

## The hard question

> "What's the riskiest dependency in this system?"

The Notion API contract. It's a third-party REST API I don't control, and the schema-gap tolerance I built in [`detectMissingTodoProperties`](../../src/services/notion/todosMapper.ts) (and now `detectMissingHabitProperties` / `detectMissingThreadProperties` for the two new opt-in DBs) is defensive *for users on older schemas* — it doesn't protect against *Notion* changing their API shape. If they change the rich-text response format, my parsers at [`todosMapper.ts`](../../src/services/notion/todosMapper.ts), `habitsMapper.ts`, and `threadsMapper.ts` all break at once.

The mitigation is the architectural principle that the local SQLite is canonical: even if Notion sync stops working entirely, every existing piece of data is intact locally, deletions are already queued in `sync_deletions` (now with `'thread'` joining `entry`/`todo`/`habit`/`nutrition`), and the user keeps using the app. The sync layer is *additive*, not load-bearing. Mentions specifically are *not* synced to Notion at all — they're derived from entries/todos which already sync, so a Notion outage doesn't even cost me a sync surface there.

I'm proud of this decision specifically because it cost me real work. A "cloud-first" version of this app would have been faster to build but would die the day Notion changed an API. By making SQLite primary, I bought independence — at the cost of having to write all the merge logic by hand. That tradeoff is the kind of thing I want any future architecture I work on to make explicitly, not by accident.

→ [03 — Frontend engineering](./03-frontend.md)
