# 02 — System architecture

> **Read second.** Get the request flow straight before you talk about anything else. If you can sketch the diagram below from memory, you can survive any system-design question on this codebase.

When a new engineer clones buffr and opens the project, the first thing they should look at is `src/services/` — that's where the work happens. The UI in `app/` is mostly file-routed Expo screens that call into hooks in `src/hooks/`, which call into services. This is layered architecture done deliberately: each layer only depends on the ones below it, and the boundaries are obvious from the import graph alone.

The interesting part isn't the layering. The interesting part is the *commit-time split* — the design decision that everything else falls out of. When the user types in the journal, every keystroke writes to SQLite immediately, no React state involved. The bytes are durable from keystroke one. When the user blurs the input or navigates away, *that's* when the parsers run and the AI fires and the cloud-sync push gets debounced. The save path and the derive-state path are separate by design. Past data-loss bugs came from React state being out of sync with what the user typed when navigation interrupted, and the keystroke-to-DB write fixed that whole class of bug.

The commit-time split is also what made it cheap to add a *third* drop type. The original two were `[]` (todos → `todos_json` + `todo_meta`) and `** food N kcal` (nutrition → `nutrition` table). On 2026-04-29 I shipped `#tag` (threads → `thread_mentions`) using exactly the same shape: prose-canonical, two-pass reconciler, fire-and-forget on commit. The scanner runs *after* the todo scan because `#tag` lines inside `[]` todos need the final todo IDs for attribution — that ordering constraint is the only new wrinkle in the journal commit path.

The other interesting part is what's *not* there. There's no backend in the conventional sense — no auth layer, no API gateway. The cloud is Supabase Postgres acting as a sync mirror. Local SQLite stays canonical (Architectural Principle 12: "cloud is a sync mirror, never the canonical source"); reads always hit local, writes always commit local first, and the cloud lags by 5s via debounced push. The previous version of this app synced to Notion as a backup; that whole layer was deleted in commit `dc8483a` once Supabase was stable — about 2,200 lines of mapper/rate-limiter/queue code that just went away.

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

  Cloud sync (Supabase Postgres) — runs on boot AND on a 5s
  debounced push after every write. Both sides paginated.
            │
            ├─► boot:    bootstrap.detect → pullAll → pushAll
            │            (initial-push vs first-pull vs no-op
            │             gated by SecureStore flag once)
            │
            └─► writes:  schedulePush() (5s debounce coalesces
                         bursts of edits into one push)

       pushAll(): every synced table in dependency order
                  (entries → projects → day_meta → vlogs →
                   ai_summaries → todo_meta → nutrition →
                   habits → threads → thread_mentions)
                  · query rows where updated_at > synced_at
                  · ON CONFLICT (user_id, id) DO UPDATE
                  · stamp synced_at on success

       pullAll(): same registry, different pull order
                  · get_server_time() RPC for clock-skew-safe
                    last_pull_at
                  · paginate by updated_at ASC (page 200)
                  · chooseWinner(local, cloud) by updated_at
                  · cloud row wins → upsert local + stamp synced_at

       Soft delete: every CRUD delete stamps deleted_at +
                    bumps updated_at; reads filter
                    WHERE deleted_at IS NULL; deletion
                    propagates as a normal sync event.

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

I'll trace it in order. Inside [`InlineTextInput.tsx:54-61`](../../../src/components/journal/InlineTextInput.tsx#L54-L61), the keystroke fires `onSilentSave` which writes the raw text to SQLite via [`updateEntry`](../../../src/services/database.ts) — no React state update, no scanner, just a direct DB write. The entry's text is durable from that moment.

When I tap somewhere else, the `useFocusEffect` cleanup in [`app/journal/[date].tsx:81-87`](../../../app/journal/[date].tsx#L81-L87) calls `editEntry` from the [`useEntries`](../../../src/hooks/useEntries.ts) hook. That hook does four things in order: it runs `applyTodoScan` (pure parser that extracts `[]` lines into `todos_json`), then it fires `scheduleNutritionScan`, `scheduleTodoMetaReconcile`, and `scheduleThreadScan` as fire-and-forget. The journal save itself completes here.

The reconcile inserts a paired `todo_meta` row with the heuristic-classified type — for `call mom`, "call" is in the imperative verb list at [`heuristicClassify.ts`](../../../src/services/todos/heuristicClassify.ts), so it's classified as `'todo'` immediately. No LLM call.

The thread scan runs *after* the todo scan because it needs the final todo IDs to attribute `#tag`s sitting inside `[]` lines. It walks [`scanThreads.ts`](../../../src/services/threads/scanThreads.ts), masks code spans, finds `#family`, looks up the slug in `threads`, auto-creates the thread row if it doesn't exist (deliberate ergonomic deviation from the original "explicit-only" model), then writes a `thread_mentions` row with `todo_id` set to the freshly-paired todo. The dashboard's `SmartTodoList` re-renders, the todo appears, and the **DAILY SCHEDULE** thread row's open-todos count ticks up.

The whole thing took maybe 5ms of user-blocking work. Everything else was async.

### Q2 [senior] Why does the dashboard tracker bucket by `time_of_day` instead of giving it its own tab?

I prototyped a fourth nav slot — a dedicated **Today** tab — and the second I had it on screen the cost was obvious: the user had to leave the dashboard (greeting + Today's Vlog + `SmartTodoList`) to see what they were trying to *do* today. Two surfaces, both claiming "this is your day," and the user has to context-switch between them.

Folding it into the dashboard as a single **DAILY SCHEDULE** section solved that — one screen, one mental model. Habits and threads share the same row layout (80px name + 14-cell flex strip + 36px right-side count or `→` arrow) so the grid reads uniformly even though the underlying tables (`habits`, `threads` + `thread_mentions`) are completely different. The bucketing is what lets two heterogeneous record types coexist: `time_of_day` is a column on both `habits` and `threads`, and the renderer just sorts morning → midday → evening → anytime, dropping in mini-headers once 2+ buckets are populated by either type.

The tradeoff was a small one I deliberately accepted: the 14-cell strip on thread rows is driven *only* by manual touches (`toggleThreadTouchToday` in [`threads/touch.ts`](../../../src/services/threads/touch.ts), which writes a `thread_mentions` row with NULL `entry_id` and NULL `todo_id`). Prose `#tag` mentions don't paint the strip. They show up on the per-thread detail page at `/threads/[id]` where mentions *are* the point, but on the dashboard the strip needs to mean "did I do this today?" not "did I mention it?" Different question, different signal.

That decision is the one documented deviation from Principle 11 ("mentions are derived; metadata is stored"). I'm comfortable with it because the schema permits it cleanly — the staleness and 14-day-strip math compose uniformly across all three mention shapes (entry-prose, todo-text, manual-touch).

### Q3 [arch] If this needed to support 100k users with multi-device sync, what changes?

Three things break first. **First**, auth. Phase A hardcodes a single `user_id = '00000000-0000-0000-0000-000000000001'` in [`sync/client.ts`](../../../src/services/sync/client.ts). At scale, real auth via Supabase Auth + flipping `ENABLE ROW LEVEL SECURITY` on every table — the policies are already authored in [`supabase/migrations/0002_rls_policies.sql`](../../../supabase/migrations/0002_rls_policies.sql) but disabled. Cost: ~80% UX work (auth screens, signup, payment), 20% data-layer (`user_id = auth.uid()` instead of the dummy).

**Second**, conflict resolution. Today's last-write-wins by `updated_at` is honest about its limits — concurrent edits to the same entry on two devices lose one of them. Solo use doesn't hit this; multi-user does. I'd move to a CRDT layer for `entries.text` and `todos_json` so concurrent prose edits converge. The two-pass matching pattern (exact match → line-index fallback) is a sane substrate for this; the actual merge becomes CRDT-driven instead of hand-rolled. Plus the `#tag` system has a related issue: two devices typing `#family` in the same minute auto-create two `threads` rows. The `UNIQUE (user_id, LOWER(slug))` index in Postgres catches the race on push, but the second device's local copy is now orphaned. CRDT-level slug coordination fixes it.

**Third**, the LLM cost path needs metering and quotas per user. `MAX_CONCURRENT=3` at [`expand.ts:25`](../../../src/services/todos/expand.ts#L25) is a per-device cap; at scale it becomes a per-user-per-window quota with billing integration. Cost-tiered model selection (cheap classifier, primary expansion) is the principle that doesn't change. That principle scales fine.

The pattern that scales least well is the JS-side flatten + sort on `/todos`, now with a third filter axis (Threads). At 5k+ todos per user and a few dozen threads, the three-way AND filter becomes a render cliff. Solution is virtualized lists (`FlashList`) plus pushing the filter to SQL with computed indexes on `todo_meta(stage, position)` joined against `thread_mentions(thread_id)` — both already exist locally, would replicate cleanly to Postgres.

## The hard question

> "What's the riskiest dependency in this system?"

Supabase. Notion was the answer until commit `dc8483a` deleted that integration; today it's the cloud sync provider. If Supabase has an outage, raises pricing, or changes the JS SDK in a breaking way, my push/pull layer at [`sync/push.ts`](../../../src/services/sync/push.ts) and [`sync/pull.ts`](../../../src/services/sync/pull.ts) is exposed.

The mitigation is the same architectural principle as before — local SQLite is canonical (Principle 12). If Supabase disappears entirely, every existing piece of data is intact locally, every read path filters `WHERE deleted_at IS NULL` against local, and the user keeps using the app offline-first. The cloud sync layer is the safety net you opt into; it isn't on the read path. Edits durably hit SQLite from keystroke one (the commit-time split discussed above); Supabase lags by 5s via the debounced push.

What I'd lose if Supabase went away: the cross-device replication path (Phase B's reason to exist), and any data that was created on a device that subsequently dies before pulling locally. The clip files (`Documents/buffr/clips/<date>/*.mp4`) aren't in Supabase Storage anyway — they're a known gap (see [docs/backlog.md](../../../docs/backlog.md)) — so Supabase's outage doesn't make that worse.

I'm proud of the local-canonical decision because it survived a backend swap. The same architecture that previously protected against Notion changing their API now protects against Supabase changing theirs. The cost is the same: I write all the merge logic by hand. The benefit is the same: every cloud is replaceable. That tradeoff is the kind of thing I want any future architecture I work on to make explicitly, not by accident.

→ [03 — Frontend engineering](./03-frontend.md)
