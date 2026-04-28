# 02 — System architecture

> **Read second.** Get the request flow straight before you talk about anything else. If you can sketch the diagram below from memory, you can survive any system-design question on this codebase.

When a new engineer clones loopd and opens the project, the first thing they should look at is `src/services/` — that's where the work happens. The UI in `app/` is mostly file-routed Expo screens that call into hooks in `src/hooks/`, which call into services. This is layered architecture done deliberately: each layer only depends on the ones below it, and the boundaries are obvious from the import graph alone.

The interesting part isn't the layering. The interesting part is the *commit-time split* — the design decision that everything else falls out of. When the user types in the journal, every keystroke writes to SQLite immediately, no React state involved. The bytes are durable from keystroke one. When the user blurs the input or navigates away, *that's* when the parsers run and the AI fires and the Notion sync queues. The save path and the derive-state path are separate by design. Past data-loss bugs came from React state being out of sync with what the user typed when navigation interrupted, and the keystroke-to-DB write fixed that whole class of bug.

The other interesting part is what's *not* there. There's no backend in the conventional sense. There's no server, no auth layer, no API gateway. The only network dependency is the Notion REST API, and even that is treated as additive — if Notion goes away, the app keeps working with locally-canonical data. This shapes everything: there's no auth code to discuss, but there's also a lot of merge logic I had to write by hand because I didn't get a sync engine for free.

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
            └──► scheduleTodoMetaReconcile (fire-and-forget)
                        │
                        ├─► insert paired todo_meta row
                        ├─► run heuristicClassify (free, sync)
                        │
                        └─► if heuristic null AND !todo.done:
                                    │
                                    ▼
                            scheduleClassify (LLM, async)
                                    │
                                    ▼
                            updateTodoMeta(type, confidence)
                                    │
                                    ▼
                            emit('classify-progress')
                                    │
                                    ▼
                            /todos toast updates

  Separately, on next user-initiated sync or auto-sync timer:
            │
            ▼
   syncAll (entries) → syncAllTodos → drainSyncDeletions
            │                  │
            ▼                  ▼
        Notion API        Notion API
       (rate-limited      (rate-limited
        350ms gap)         350ms gap)
```

The diagram looks busy because it is. Three things are happening simultaneously when a user just types a todo: durability (SQLite write), structure derivation (scanner + meta reconcile), and AI classification (async LLM call when heuristic abstains). The point of the architecture is that these three concerns don't block each other. The save is fast because it doesn't wait for anything. The scan is fast because it's pure. The LLM call is async because it's the only one that's actually slow, and its result trickles into the UI via the events bus when it returns.

## Interview questions

### Q1 [mid] Walk me through what happens when I type `[] call mom` and tap somewhere else.

I'll trace it in order. Inside [`InlineTextInput.tsx:54-61`](../../src/components/journal/InlineTextInput.tsx#L54-L61), the keystroke fires `onSilentSave` which writes the raw text to SQLite via [`updateEntry`](../../src/services/database.ts) — no React state update, no scanner, just a direct DB write. The entry's text is durable from that moment.

When I tap somewhere else, the `useFocusEffect` cleanup in [`app/journal/[date].tsx:81-87`](../../app/journal/[date].tsx#L81-L87) calls `editEntry` from the [`useEntries`](../../src/hooks/useEntries.ts) hook. That hook does three things in order: it runs `applyTodoScan` (a pure parser that extracts `[]` lines from the text and merges them into `todos_json`), then it fires `scheduleNutritionScan` and `scheduleTodoMetaReconcile` as fire-and-forget. The journal save itself completes here.

The reconcile inserts a paired `todo_meta` row with the heuristic-classified type — for `call mom`, "call" is in the imperative verb list at [`heuristicClassify.ts`](../../src/services/todos/heuristicClassify.ts), so it's classified as `'todo'` immediately. No LLM call. The reconcile finishes; the dashboard's `SmartTodoList` re-renders and the todo appears.

The whole thing took maybe 5ms of user-blocking work. Everything else was async.

### Q2 [senior] Why prose-canonical instead of structured fields?

Two reasons: capture friction, and what I called the *capture-is-filing* thesis. A structured editor forces the user to mode-switch — "is this a note or a todo?" — at the moment of writing, when they often don't know yet. Prose-first lets them write naturally; the markers (`[]`, `**`) are punctuation-like syntactic sugar.

The cost was real. I had to build [`scanTodos.ts`](../../src/services/todos/scanTodos.ts) with two-pass identity matching so todos survive text edits. I had to build [`rewriteTodoLine`](../../src/services/todos/scanTodos.ts#L139-L181) so dashboard mutations round-trip into prose and the next scan doesn't clobber them. I had to enforce a 1:1 invariant between `todos_json` and `todo_meta` in [`reconcileMeta.ts`](../../src/services/todos/reconcileMeta.ts) without a real foreign key, since the FK target is a JSON-array element. None of that exists in a structured-editor design.

What I'd do differently at much larger scale: push the parsing into a CRDT-aware pipeline (Yjs or Automerge) so collaborative editing doesn't break the prose-canonical invariant. The two-pass matching I built is already a building block toward this, but it's not sufficient on its own.

### Q3 [arch] If this needed to support 100k users with multi-device sync, what changes?

Three things break first. **First**, the Notion API as a sync backbone caps at ~3 req/s per integration. The module-level rate limiter at [`notion/api.ts:7`](../../src/services/notion/api.ts#L7) is the right shape but only sufficient for one client. At scale I'd put a server-side sync gateway in front of Notion, fanning out per user with per-user backpressure and a token-bucket rate model.

**Second**, SQLite-first means no multi-device. Two devices editing the same entry will diverge. I'd move to a CRDT layer for `entries.text` and `todos_json` so concurrent edits converge. The two-pass matching is a sane substrate for this, but the actual merge would be CRDT-driven, not hand-rolled.

**Third**, the LLM cost path needs metering and quotas per user. `MAX_CONCURRENT=3` at [`expand.ts:25`](../../src/services/todos/expand.ts#L25) is a per-device cap; at scale it becomes a per-user-per-window quota with billing integration. Cost-tiered model selection (cheap classifier, primary expansion) is the principle that doesn't change. That principle scales fine.

The pattern that scales least well is the JS-side flatten + sort on `/todos`. At 5k+ todos per user that becomes a render cliff. Solution is virtualized lists (`FlashList`) plus pushing the sort to SQL with computed indexes on `todo_meta(stage, position)`.

## The hard question

> "What's the riskiest dependency in this system?"

The Notion API contract. It's a third-party REST API I don't control, and the schema-gap tolerance I built in [`detectMissingTodoProperties`](../../src/services/notion/todosMapper.ts) is defensive *for users on older schemas* — it doesn't protect against *Notion* changing their API shape. If they change the rich-text response format, my parser at [`todosMapper.ts`](../../src/services/notion/todosMapper.ts) breaks.

The mitigation is the architectural principle that the local SQLite is canonical: even if Notion sync stops working entirely, every existing piece of data is intact locally, deletions are already queued in `sync_deletions`, and the user keeps using the app. The sync layer is *additive*, not load-bearing.

I'm proud of this decision specifically because it cost me real work. A "cloud-first" version of this app would have been faster to build but would die the day Notion changed an API. By making SQLite primary, I bought independence — at the cost of having to write all the merge logic by hand. That tradeoff is the kind of thing I want any future architecture I work on to make explicitly, not by accident.

→ [03 — Frontend engineering](./03-frontend.md)
