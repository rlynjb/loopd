# loopd — Interview defense prep

A category-by-category preparation guide for defending this project at the senior / AI-engineer level. Every answer references specific files, line numbers, or design decisions in the loopd codebase. Tradeoffs are named explicitly. Weaknesses are owned, not hidden.

**Pitch this project in one breath, before you walk in:**

> loopd is a native Android journaling and AI-assisted vlog editor I built solo in React Native + Expo. The interesting parts are the architecture: prose is the canonical source of truth, structured records (todos, nutrition) are *derived* from inline markers via a two-pass scanner, and three cost-tiered LLM integrations (Haiku for classification, Sonnet for expansion, primary for vlog summary) are gated by heuristics-first cost discipline. SQLite is local-first; Notion is an optional bidirectional sync target with field-level merge rules and schema-gap tolerance. Roughly 11k lines of TS, 9 SQLite tables, 4-phase ship plan for the latest feature.

## Table of contents

1. [System design](#system-design)
2. [Frontend engineering](#frontend-engineering)
3. [Backend / API](#backend-api)
4. [AI engineering](#ai-engineering)
5. [Data modelling](#data-modelling)
6. [Reliability](#reliability)
7. [Developer process](#developer-process)
8. [Ownership + judgment](#ownership-judgment)
9. [Weaknesses + objections](#weaknesses)
10. [Refactoring + improvement areas](#refactoring)
11. [The AI-assisted development angle](#ai-assisted)
12. [DSA — Three coding problems](#dsa)

---

<a id="system-design"></a>
## 1. System design

### Q1.1 [senior] Walk me through the data flow when a user types `[] call mom` in the journal.

**Model answer.** Three layers cooperate. The user types in [InlineTextInput.tsx:54-61](../src/components/journal/InlineTextInput.tsx#L54-L61) — every keystroke fires `onSilentSave`, which writes the raw text directly to SQLite via [`updateEntry`](../src/services/database.ts) without going through React state. The text is durable from keystroke one. On focus blur or screen leave, the [useEntries hook](../src/hooks/useEntries.ts) calls `editEntry`, which runs `applyTodoScan` (pure parser) to extract `[]` lines into `entries.todos_json`, then fires-and-forgets `reconcileTodoMetaForEntry` and `scanNutritionForEntry`. The reconcile inserts a paired `todo_meta` row, runs the heuristic classifier inline (free), and if the heuristic returns null fires the LLM classifier asynchronously. The journal save itself never blocks on LLM. **The key insight is the split between commit-time work (parsers, mutations) and keystroke-time work (durability only).** I made that split because past data-loss bugs came from React state being out of sync with what the user typed when navigation interrupted.

### Q1.2 [arch] Why prose-canonical instead of a structured editor with separate todo / note fields?

**Model answer.** Two reasons: capture friction, and the "capture is filing" thesis. A structured editor forces a mode switch — "is this a note or a todo?" — at write time, when the user often doesn't know. Prose-first lets the user write naturally; the markers (`[]`, `**`) are punctuation-like syntactic sugar that doubles as visual cues. The cost is real: I need a two-pass scanner ([scanTodos.ts:53-125](../src/services/todos/scanTodos.ts#L53-L125)) that survives text edits, and I need round-trip semantics ([rewriteTodoLine](../src/services/todos/scanTodos.ts#L139-L181)) so dashboard mutations land back in prose. At larger scale I'd worry about parser ambiguity in long documents — but for personal-journaling-sized prose with ≤200 lines per entry, the parser is cheap and predictable. **What I'd do differently at scale:** push the parsing into a CRDT-aware pipeline (think Yjs) so collaborative editing doesn't break the prose-canonical invariant.

### Q1.3 [arch] If this needed to support 100k users with multi-device sync, what changes?

**Model answer.** Three things break first. (1) **The Notion API as a sync backbone caps at ~3 req/s per integration** — at scale I'd put a server-side sync service in front, fanning out per user with proper backpressure. The existing module-level rate-limiter ([notion/api.ts:7](../src/services/notion/api.ts#L7)) is the right shape but only sufficient for one client. (2) **SQLite-first means no multi-device.** I'd move to a CRDT or operational-transform layer for entries.text and todos_json so multiple devices can edit concurrently and converge. The two-pass matching I built is a building block toward this but not sufficient on its own. (3) **The LLM cost path needs metering and quotas per user.** Right now `MAX_CONCURRENT=3` ([expand.ts:25](../src/services/todos/expand.ts#L25)) is a per-device cap; at scale it becomes a per-user-per-window quota with billing integration. The architectural pattern that doesn't change: cost-tiered model selection (cheap classifier, primary expansion). That principle scales.

### Diagram — request flow on entry save

```
  User types in InlineTextInput
            │
            ▼
   onSilentSave (every keystroke)
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
            ├──► applyTodoScan (pure parser, in-memory)
            │           └─► todos_json updated
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
```

---

<a id="frontend-engineering"></a>
## 2. Frontend engineering

### Q2.1 [mid] How is state managed in the journal editor?

**Model answer.** The editor uses a deliberate three-tier state strategy: refs for ephemeral (cursor, selection, "did the user just type"), React state for what needs to render, SQLite for what needs to be durable. The most subtle piece is `liveTextRef` — a `useRef` that mirrors the TextInput value on every keystroke without triggering re-renders. The pattern is documented in [CLAUDE.md](../CLAUDE.md): "Save to DB on every keystroke. Refs hold pending values for focus logic only." I learned the hard way that putting input value in `useState` causes re-renders on every keystroke that can interleave with focus-cleanup effects, leading to lost characters. The current pattern keeps the React tree stable while the underlying bytes are durable from keystroke one.

### Q2.2 [senior] Walk me through how the autocomplete works without a third-party dep.

**Model answer.** `InlineTextInput` exposes a typed imperative handle via `forwardRef` + `useImperativeHandle` ([InlineTextInput.tsx:23-26](../src/components/journal/InlineTextInput.tsx#L23-L26)) — `appendText(str)` and `replaceRange(start, end, replacement)`. The journal screen owns a `useRef<InlineTextInputHandle>(null)` and watches `onSelectionChange` on the input. When the cursor sits after `** `, the journal screen detects it, opens [NutritionAutocomplete](../src/components/journal/NutritionAutocomplete.tsx) with the partial query, and on chip-tap calls `inputRef.current?.replaceRange(...)` to insert the canonical `<food> 320 kcal ` string at the right position. **The reason I went with imperative handles instead of lifting state up:** the parent has no business knowing the cursor position or the textarea's internal selection — those are owner-private. The imperative handle is a typed, deliberate escape hatch that exposes exactly two operations rather than leaking everything.

### Q2.3 [arch] How do you keep this performant when an entry has hundreds of `[]` lines?

**Model answer.** Honest answer: I haven't optimized for that scale and probably need to. The current scanner is `O(lines + existing_todos)` per pass, which is fine. But the *render* path on `/todos` flattens every todo across every entry on every focus change, sorts in JavaScript, and renders a non-virtualized `ScrollView`. For ≤500 todos this is invisible; at 5,000 it would jank. **What I'd do:** (1) replace `ScrollView` with `FlashList` from Shopify (the React Native virtualized-list-of-record); (2) move the sort + filter to a `useMemo` keyed by `entries.length + metas.size + status + category` so it doesn't re-run on unrelated state changes; (3) do incremental scans — track `entries.updated_at` and only re-scan changed entries. The principle here: I should profile before I optimize. Right now my data set is small enough that I'd be optimizing speculatively.

### Diagram — three-tier state on every keystroke

```
                  User types one character
                            │
                            ▼
                ┌────  TextInput onChangeText  ────┐
                │                                  │
        ┌───────┴──────┐                  ┌────────┴──────┐
        ▼              ▼                  ▼               ▼
  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐
  │  React   │  │ liveTextRef  │  │   SQLite     │  │  scanner   │
  │  state   │  │    (ref)     │  │ (silentSave) │  │  triggers? │
  │          │  │              │  │              │  │            │
  └──────────┘  └──────────────┘  └──────────────┘  └────────────┘
       │              │                  │                │
       ▼              ▼                  ▼                ▼
   triggers       pending value      bytes safe        NO  — scanners
   re-render      for blur logic     even if React     only fire on
   of <Text>      (cleanup safe)     unmounts mid-     commit (blur,
                                     word               navigate)

  Refs and SQLite write *before* React state.
  Past data-loss bugs were races between focus cleanup
  and idle timers — both writing through React state
  out-of-order. DB-first writes ended that class of bug.
```

---

<a id="backend-api"></a>
## 3. Backend / API

### Q3.1 [senior] Walk me through how Notion sync handles a network failure mid-write.

**Model answer.** The Notion API is the only "backend" in the system, and writes go through [notion/api.ts](../src/services/notion/api.ts) which has three reliability layers: (1) **Rate limiter** — module-level singleton enforces 350ms between requests so we don't trip the API's 429 ourselves. (2) **429 retry with exponential backoff** — when Notion does return 429, the client respects the `Retry-After` header. (3) **Sync-deletion queue** — local deletions of synced rows enqueue into the `sync_deletions` table ([database.ts:121-129](../src/services/database.ts#L121-L129)), keyed by `entity_type` so multiple entity kinds share one queue cleanly. If the network dies mid-push, the local DB is already authoritative; the next sync drains the deletion queue and the dirty-row push picks up where it left off (dirty detection via `updated_at > lastSync`). **What I haven't built yet:** a write queue for *creates*. If the network dies mid-create, the local row is fine but it'll be re-pushed on next sync — duplicates aren't possible because we use loopd-side `loopd ID` as the dedup key. So we're idempotent by accident on creates, intentional on deletes.

### Q3.2 [senior] Why is there a sync-deletion queue but not a sync-creation queue?

**Model answer.** Asymmetry of recoverability. A locally-deleted row that was synced has *no body left* — only its Notion page id. If I don't capture that ID at delete time, the Notion page becomes an orphan I can't reach. So the queue is required. A locally-created row, by contrast, *is* its body — the row exists in SQLite with a `notionPageId IS NULL`, and on the next sync the dirty detection picks it up and creates the Notion page. The distinction is the one I make in interview-prep style: queues exist for ops that lose information without them. Captures, edits, and deletions of synced rows lose information; pure creates don't.

### Q3.3 [arch] How would you design this to support webhooks pushing into loopd from Notion?

**Model answer.** Today loopd polls — it pulls Notion on app open and on manual sync. To go push-driven, I'd insert a thin server in front: a webhook receiver that Notion posts to, and loopd connects to via WebSocket/SSE for "your data changed, pull now" notifications. The receiver doesn't store body — it just dispatches. The body still pulls through the existing `pullEntries` / `pullTodos` paths. **The architectural insight:** the cleanest reactive system makes pull idempotent and uses push only as a wakeup signal, not a data delivery mechanism. That way a missed webhook is recoverable on next poll. I'd also need to think about ordering — Notion might fire a webhook while pull is mid-flight; the existing `last_edited_time` per-field merge ([sync.ts pullTodos](../src/services/notion/sync.ts)) gives us a natural conflict resolution.

### Diagram — Notion sync push/pull with rate limit + deletion queue

```
  Local SQLite                                  api.notion.com
       │                                              │
       │   ┌──────────────────────────────┐           │
       │   │  rate-limit() — 350ms gap    │           │
       │   │  module-level lastRequestTime│           │
       │   └──────────────┬───────────────┘           │
       │                  │                           │
       │  PUSH: dirty rows (updated_at > lastSync)   │
       ├──► entries ──┐                              │
       │              ├─► HTTPS PATCH ──────────────►│
       ├──► todos ────┤                               │
       │              │                               │
       ├──► nutrition ┘                               │
       │                                              │
       │  PUSH: deletions (FIFO drain of queue)       │
       │   ┌─────────────────────────┐                │
       └──►│ sync_deletions          │── archivePage ►│
           │ entity_type discriminator│                │
           │ ('entry'|'todo'|'habit'  │                │
           │  |'nutrition')           │                │
           └─────────────────────────┘                │
                                                      │
                                                      │
                                                      │
       PULL ────────────────────────────────────────  │
       │                                              │
       │ queryDatabase (last 14 days)                 │
       │◄────────────────── pages[] ──────────────────┤
       │                                              │
       │ field-level merge per spec §11.2:           │
       │   text     → prose-canonical (drop)          │
       │   done     → bidirectional (last-edit-wins)  │
       │   type     → pull AND set userOverridden=1   │
       │   expanded → pull only when local empty      │
       │                                              │
       ▼
  Update todos_json + todo_meta in single tx

  On 429: Retry-After header → exponential backoff
  On schema gap: detectMissingTodoProperties skips
                 absent fields silently (tolerant reader)
```

---

<a id="ai-engineering"></a>
## 4. AI engineering

### Q4.1 [senior] You have three different LLM integrations. Walk me through why each uses a different model.

**Model answer.** Three jobs, three cost tiers. **Classification** ([classify.ts:9-10](../src/services/todos/classify.ts#L9-L10)) — Haiku 4.5 / GPT-4o-mini, ~$0.0001 per call. The prompt is ~250 tokens out, ~50 tokens in, just `{type, confidence}` JSON. Haiku is fine; Sonnet would be 30x the cost for indistinguishable accuracy on this shape of task. **Expansion** ([expand.ts:20-21](../src/services/todos/expand.ts#L20-L21)) — Sonnet 4.6 / GPT-4o, ~$0.04 per call. Per-type prompts have a chain-of-thought reasoning preamble; the output is structured JSON with 4-6 fields plus arrays. The reasoning quality difference between Haiku and Sonnet *does* matter here — I tested both. **Vlog summary** ([summarize.ts:7-8](../src/services/ai/summarize.ts#L7-L8)) — same primary tier as expansion. Day-summary is also reasoning-heavy. **The principle I named in [docs/concepts.md § 20](./concepts.md#20-cost-tiered-model-selection):** pick the tier per workload shape, not per brand. I budget by tier; classifier costs are ~$0.01/month, expansion costs are ~$1-2/month.

### Q4.2 [arch] Why heuristic-first instead of just calling the LLM?

**Model answer.** Two reasons: cost discipline and latency. The heuristic ([heuristicClassify.ts:71-102](../src/services/todos/heuristicClassify.ts#L71-L102)) is ~50 imperative verbs + modal phrases + deadline patterns. It catches roughly 70-80% of captures with zero LLM calls. I deliberately tuned it to over-fire on `null` (return ambiguous) rather than over-fire on `'todo'` — the cost asymmetry is interesting: a false-null sends to a cheap LLM call (~$0.0001), but a false-`todo` requires the user to manually correct it. I optimized for accuracy over the marginal LLM cost. **The architectural pattern beyond this app:** AI is expensive and slow. Build the cheap deterministic path first; use the LLM only where the heuristic *abstains*. This is also CLAUDE.md principle 10 ("Heuristic before LLM") which I promoted from a tactical decision into a project-wide rule.

### Q4.3 [arch] How do you handle LLM JSON output that's malformed or wrong?

**Model answer.** Three layers. **(1) Schema validation** — [`validateExpansion`](../src/services/todos/expand.ts#L77-L142) checks the parsed JSON against a per-type shape, returns `null` on mismatch rather than letting bad data into the DB. **(2) One-shot retry** — if the first call returns null, [`callOnce`](../src/services/todos/expand.ts#L228-L247) is invoked again with an additional system instruction: *"Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema."* This catches ~95% of fence-wrapped or preamble-laden outputs. **(3) Discriminated-union result type** — [`ExpandResult`](../src/services/todos/expand.ts#L201-L203) is `{ ok: true, ... } | { ok: false, reason: 'no-ai' | 'in-flight-cap' | 'wrong-type' | 'malformed' | 'network' | 'not-found' }` so the caller can map each failure to a precise UI message. **What I deliberately didn't do:** retry more than once. More retries would burn budget on cases where the model is fundamentally confused; better to surface "AI returned an invalid response" and let the user re-trigger with the explicit `[try again]` button. **Tradeoff named:** I trade a small percentage of total failures for predictable bounded cost. At scale, I'd layer in tool-use / function-calling mode (OpenAI's `response_format: 'json_object'` is already in [classify.ts:51](../src/services/todos/classify.ts#L51); Anthropic's tool-use would replace the JSON-parsing for expansion) to push malformed-output rates to near-zero.

### Diagram — cost-tiered LLM dispatch

```
                        New todo committed
                              │
                              ▼
                  ┌─────────────────────────┐
                  │ heuristicClassify(text) │
                  │ ~50 verbs + modal +     │
                  │ deadline patterns       │
                  │ ~0.1ms, FREE            │
                  └────────────┬────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
          returns 'todo'                 returns null
          (~70-80% of cases)             (the ambiguous 20%)
                │                             │
                │                             │  (skip if todo.done — never
                │                             │   burn tokens on completed)
                │                             ▼
                │              ┌────────────────────────────────┐
                │              │ scheduleClassify (async)       │
                │              │ Tier 1: Haiku 4.5 / 4o-mini    │
                │              │ ~$0.0001 per call              │
                │              │ ~50 tokens out, JSON validated │
                │              └──────────┬─────────────────────┘
                │                         │
                ▼                         ▼
          stop here                  type assigned
          confidence='heuristic'     classifier_confidence='high|medium|low'
                                          │
                                          │
                                          │
                              ──── user taps [expand] ────
                                          │
                                          ▼
                              ┌────────────────────────────────┐
                              │ expandTodo                     │
                              │ Tier 2: Sonnet 4.6 / GPT-4o    │
                              │ ~$0.04 per call                │
                              │ MAX_CONCURRENT=3 cap           │
                              │ Auto-retry once on bad JSON    │
                              └──────────┬─────────────────────┘
                                         │
                              ┌──────────┴──────────┐
                              ▼                     ▼
                       valid JSON            malformed
                              │                     │
                              ▼                     ▼
                       serialize MD         retry with stricter
                       write to DB          system instruction
                                                    │
                                                    ▼
                                     if STILL bad → ExpandResult.malformed
                                                    → modal shows [try again]

  Three tiers, three cost points, three failure modes.
  Heuristic abstains → cheap LLM picks. Cheap LLM is wrong → user
  override locks the row. Expensive LLM is wrong → bounded retry,
  user-visible error. Manual-only on the expensive path so the user
  always knows when they're spending money.
```

---

<a id="data-modelling"></a>
## 5. Data modelling

### Q5.1 [mid] Walk me through the schema. Why nine tables instead of fewer?

**Model answer.** Each table represents a distinct *concept* with its own lifecycle, not a normalization choice. **`entries`** is the canonical source — prose, habits-by-id, clip references, todos as JSON. **`todo_meta`** is 1:1 with each TodoItem in `todos_json` and holds the AI-derived fields (type, classifier_confidence, expanded_md, stage, position). I split it from `todos_json` so the JSON column stays small and so the meta CRUD doesn't fight with the entry's text autosave. **`nutrition`** is a row-per-line derived table for `** food N kcal` lines — separate from `entries` because it's queryable independently and indexed on `name COLLATE NOCASE`. **`vlogs`** is the export archive; **`projects`** is editor scratch state; **`sync_deletions`** is an outbox queue with `entity_type` discriminator; **`ai_summaries`** caches LLM output keyed by date; **`day_meta`** is per-day user-rename. **The non-obvious decision** is `todo_meta` as a separate table instead of a JSON field on the TodoItem. I chose that because (a) thinking-mode fields are queryable (filter by type), (b) the `position` column is indexable for sort, and (c) classifier writes can happen async without colliding with the entry's text-save path. The cost is the 1:1 invariant I have to enforce in [reconcileMeta.ts](../src/services/todos/reconcileMeta.ts).

### Q5.2 [senior] Explain the 1:1 invariant between `todos_json` and `todo_meta`. Why isn't there a foreign key?

**Model answer.** SQLite would let me declare a foreign key on `todo_meta.todo_id`, but the *target* of that FK is a JSON-array element inside `entries.todos_json` — not a relational row. So an FK can't be expressed; the 1:1 invariant is enforced by application logic in [reconcileMeta.ts:48-90](../src/services/todos/reconcileMeta.ts#L48-L90). The reconciler walks the join: for each TodoItem with no meta, INSERT meta with heuristic classification; for each meta with no TodoItem, DELETE meta. It's idempotent — re-running on the same input is a no-op. **The honest tradeoff:** I lose DB-enforced integrity in exchange for keeping the editing surface fast (todos_json is one column write per entry update). A normalized `todos` table with a true FK would give integrity for free, but every text edit would mean parsing the prose, reconciling against the table, and the autosave path would fight a relational lock. **At scale**, I'd consider migrating to a proper `todos` table once the entry-edit path stops being the hot loop — likely when collaborative editing forces a CRDT layer anyway.

### Q5.3 [arch] How do you guarantee an enum value at the database layer?

**Model answer.** SQLite CHECK constraints. [database.ts:155-179](../src/services/database.ts#L155-L179) shows three on `todo_meta`: `type IN ('todo','idea','bug',...)`, `stage IN ('todo','in_progress','backlog')`, and a nullable check on `classifier_confidence`. These are kept in lockstep with the TS literal-union types in [todoMeta.ts](../src/types/todoMeta.ts). **The principle I chose to follow:** push validation as close to storage as possible. A typo like `'in-progress'` (with a dash) won't pass typecheck *and* won't pass the INSERT — which means a new contributor or a future-me bug fails in dev, not at render time when a badge mysteriously doesn't appear. **What I didn't do:** I don't enforce CHECK constraints on Notion-side enum values (Type, Confidence selects). Notion doesn't expose a way to constrain select options programmatically, so I do best-effort validation in the [todosMapper](../src/services/notion/todosMapper.ts) — `parseTodoType` and `parseConfidence` reject unknown values. That's the "tolerant reader" pattern: accept what we know, ignore the rest, never crash.

### Diagram — 9-table schema with the 1:1 invariant

```
        ┌────────────┐                            ┌──────────────────┐
        │  habits    │◄── habits_json (id refs)──│     entries      │
        │  (vocab)   │                            │  CANONICAL:      │
        └────────────┘                            │  text + json     │
                                                  └────────┬─────────┘
        ┌────────────┐                                     │
        │ day_meta   │◄── date PK ────────────────────────►│
        │ (per-day   │                                     │
        │  title)    │                                     │
        └────────────┘                                     │
                                                           │
   ┌────────────┬───────────────┬─────────────┬────────────┤
   ▼            ▼               ▼             ▼            ▼
┌─────────┐ ┌──────────┐ ┌─────────────┐ ┌──────────┐ ┌─────────┐
│todo_meta│ │nutrition │ │  projects   │ │  vlogs   │ │ai_summa-│
│         │ │ (1 row   │ │ (editor     │ │ (export  │ │ ries    │
│ 1:1 w/  │ │  per "** │ │  state per  │ │  archive)│ │ (LLM    │
│ each    │ │  N kcal" │ │  date)      │ │          │ │  cache, │
│ TodoItem│ │  line)   │ │             │ │          │ │  date PK│
│ in      │ │          │ │             │ │          │ │         │
│ todos_  │ │          │ │             │ │          │ │         │
│ json    │ │          │ │             │ │          │ │         │
│         │ │          │ │             │ │          │ │         │
│ type,   │ │ name,    │ │             │ │          │ │         │
│ stage,  │ │ kcal,    │ │             │ │          │ │         │
│ position│ │ source_  │ │             │ │          │ │         │
│ classi- │ │ line     │ │             │ │          │ │         │
│ fier_*, │ │          │ │             │ │          │ │         │
│ user_   │ │          │ │             │ │          │ │         │
│ over-   │ │          │ │             │ │          │ │         │
│ ridden  │ │          │ │             │ │          │ │         │
└─────────┘ └──────────┘ └─────────────┘ └──────────┘ └─────────┘
   │             │
   │             │
   └──────┬──────┘
          ▼
  ┌─────────────────────────┐
  │  sync_deletions         │
  │  (FIFO outbox queue)    │
  │                         │
  │  entity_type ←──────────│ discriminator: many producers,
  │  entity_id              │              one queue
  │  notion_page_id         │
  │  deleted_at             │
  └─────────────────────────┘

  Invariants:
  • prose in entries.text is canonical for todos / nutrition
  • todo_meta is 1:1 with each TodoItem (enforced by reconcileMeta)
  • CHECK constraints validate enums at INSERT time
  • notion_page_id lives on TodoItem only — todo_meta has no
    duplicate field; sync code joins TodoItem ↔ TodoMeta and
    uses the single id (avoids drift)
```

---

<a id="reliability"></a>
## 6. Reliability

### Q6.1 [senior] What happens if a backfill migration crashes halfway through?

**Model answer.** Two layers protect against that. (1) **The flag is set *after* the work completes** — see [migrate.ts:27](../src/services/todos/migrate.ts#L27) for the todos backfill: `await SecureStore.setItemAsync(BACKFILL_KEY, ...)` is the *last* line. If the loop crashes mid-way, the flag was never set, so on next boot the backfill runs again from scratch. (2) **Each per-entry operation is itself idempotent** — `reconcileTodoMetaForEntry` either finds the meta row already exists (no-op for that entry) or inserts it. So re-running across the full set on next boot just no-ops everything that succeeded last time and continues with what didn't. **The pattern beyond this app:** mark-after-success + per-item idempotency. You get crash recovery with no transaction logic, no rollback, no partial state to clean up. The cost: you pay full work-set on retry, but for a one-time backfill that's fine.

### Q6.2 [senior] What's your strategy when two writes race?

**Model answer.** I rely on three patterns rather than locking. (1) **DB-first writes**: every keystroke writes durably to SQLite before any React state update. Even if React renders a stale UI, the bytes are safe ([InlineTextInput.tsx:54-61](../src/components/journal/InlineTextInput.tsx#L54-L61)). (2) **Self-healing reconcile**: instead of locking `todos_json` and `todo_meta` together, I let them drift slightly and patch the diff on the next commit ([reconcileMeta.ts:48-90](../src/services/todos/reconcileMeta.ts#L48-L90)). The invariant is "eventually consistent, idempotent." (3) **Module-level rate limiting** for external API ordering ([notion/api.ts:9-16](../src/services/notion/api.ts#L9-L16)) — every Notion call serializes through one 350ms window, so concurrent calls from the entries-sync and the todos-sync don't blow rate limits. **Where I haven't implemented locking and probably should:** the on-commit scanner runs from `editEntry`, but the backfill runs from boot. If the user lands on the journal during backfill, both could hit the same entry. Today this works because reconcile is idempotent — but it's not *deliberate* concurrency control. At scale I'd add per-entry mutexes.

### Q6.3 [arch] What's the riskiest dependency in this system?

**Model answer.** **The Notion API contract.** It's a third-party REST API I don't control, and the schema-gap tolerance I built ([detectMissingTodoProperties](../src/services/notion/todosMapper.ts)) is defensive *for users on older schemas* — it doesn't protect against *Notion* changing their API. If they change the rich-text response shape, my parser breaks. The mitigation is the principle that the local SQLite is canonical: even if Notion sync stops working, every existing piece of data is intact locally, deletions are queued, and the user keeps using the app. **The architectural decision I'm proudest of here:** I deliberately treat sync as additive, not as the source of truth. A "cloud-first" version of this app would have been faster to build but would die the day Notion changed an API. By making SQLite primary, I bought independence — at the cost of having to write all the merge logic by hand.

### Diagram — backfill crash recovery

```
  App boot
     │
     ▼
  Read SecureStore: 'todo_meta_backfill_v1_done'
     │
     ├──► flag set ──► skip backfill, return early
     │
     └──► flag unset
              │
              ▼
        ┌───────────────────────────────┐
        │ for each entry in DB:         │
        │   reconcileTodoMetaForEntry   │ ◄── idempotent per-entry
        │   - INSERT missing meta rows  │     (re-run is no-op)
        │   - DELETE orphaned meta rows │
        └────────────────┬──────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
      crash mid-loop          loop completes
              │                     │
              │                     ▼
        flag NEVER set        SecureStore.setItemAsync(KEY)
              │                     │
              ▼                     ▼
        next boot:              next boot:
        runs full pass          flag set → skip
        again                   (no double-work)
              │
              ▼
        per-entry idempotency
        means already-done
        entries no-op; only
        the unfinished tail
        actually does work

  Pattern: mark-after-success + per-item idempotency.
  Cost on retry: full re-walk (cheap because per-entry is no-op).
  Win: zero rollback logic, zero partial-state cleanup.
```

---

<a id="developer-process"></a>
## 7. Developer process

### Q7.1 [mid] How do you test this code?

**Model answer.** Honestly, mostly by hand. I install the release APK on a physical Android device after every change and verify the user-facing behavior. There's no automated test suite. **What I do have:** strict TypeScript catches a class of bugs at compile time; CHECK constraints catch enum violations at insert time; the discriminated unions force exhaustive case handling. **What's missing and I'd prioritize:** (1) unit tests for [scanTodos.ts](../src/services/todos/scanTodos.ts) and [scanNutrition.ts](../src/services/nutrition/scanNutrition.ts) — they're pure functions with clear input/output contracts, perfect for testing. (2) Snapshot tests for the merge logic in [pullTodos](../src/services/notion/sync.ts) — the field-level merge rules are exactly the kind of logic that breaks subtly when you refactor. (3) A fixture-based eval for the heuristic classifier — accuracy on a real corpus of `[]` lines I've captured. **The honest answer to "why no tests"**: I prioritized shipping the feature surface fast, and I'm the only user. At a job I'd treat the parser tests as a Day-1 invariant, not a Day-30 cleanup.

### Q7.2 [senior] Walk me through your build → install → debug loop.

**Model answer.** I run `cd android && ./gradlew :app:assembleRelease` (gradle release build in the background, ~25-50s incremental, ~3-5min cold), then `adb install -r android/app/build/outputs/apk/release/app-release.apk` to deploy to my physical Samsung. I install release builds rather than dev builds because I want to test what users would actually run, and I don't need React Native's Metro bundler for this workflow — JS is bundled into the APK. **The deliberate tradeoff:** I lose hot reload, so every change is a full rebuild + install (~30s end-to-end). I keep iteration tight by *batching* changes between builds — usually 2-5 related edits before I install. For UI tweaks I sometimes use Metro for live reload, but for anything touching the DB schema or native code, release builds are the only honest test. **What I'd add at a job:** a CI pipeline that builds and runs an emulator-based smoke test on every PR. Right now the only "CI" is `npx tsc --noEmit` which I run before every install.

### Q7.3 [arch] How do you make architectural decisions on a solo project?

**Model answer.** I write specs before code, and I phase big features. [docs/spec.md](./spec.md) is the living architectural reference; major features get a separate plan document — the thinking-modes feature shipped via a 4-phase plan (foundation → classifier → expansion → Notion sync) where each phase was independently shippable, documented in [docs/loopd-thinking-modes-spec.md](./loopd-thinking-modes-spec.md). When I disagreed with a spec the AI assistant produced — like the original drops spec assuming a Next.js / Netlify stack instead of RN/Expo — I rewrote the plan from scratch with the right substrate before any code. **The principle:** big features die in long branches. Slice by *value-delivery*, not by *layer*. Phase A of thinking-modes gave me categorized todos with no LLM at all (heuristic + manual override + new UI); Phase B added the classifier; Phase C added expansion; Phase D added Notion sync. Each phase shipped a complete feature. **The thing I'd improve:** I don't have post-ship retros documented anywhere. The "what surprised me" loop happens in my head; at a job I'd write it down.

### Diagram — build/install loop

```
  edit source code
       │
       ▼
  ┌──────────────────────────────────┐
  │  npx tsc --noEmit                │  ~3-5s
  │  (catch type errors before       │  (every change)
  │   any rebuild)                   │
  └──────────────────┬───────────────┘
                     │
                     ▼
  ┌──────────────────────────────────┐
  │  cd android && ./gradlew         │  ~25-50s incremental
  │    :app:assembleRelease          │  ~3-5min cold build
  │                                  │
  │  release builds, not dev —       │
  │  matches what users actually run │
  └──────────────────┬───────────────┘
                     │
                     ▼
  ┌──────────────────────────────────┐
  │  adb install -r                  │  ~10s
  │    app/build/outputs/apk/...     │
  └──────────────────┬───────────────┘
                     │
                     ▼
  ┌──────────────────────────────────┐
  │  Manual smoke-test on physical   │
  │  Samsung device — actual user    │
  │  flow, end-to-end                │
  └──────────────────────────────────┘

  Round trip: ~30s for incremental builds.
  Tradeoff: lose hot reload, gain "what users actually run."
  Mitigation: batch 2-5 related edits per cycle.

  No CI today. At a job, npx tsc + emulator smoke test
  would gate every PR.
```

---

<a id="ownership-judgment"></a>
## 8. Ownership + judgment

### Q8.1 [senior] What's a decision you made that you'd defend even though it goes against common practice?

**Model answer.** I deliberately removed the `pinned` feature from the todos system and replaced it with the more general thinking-modes + stage architecture. Common practice for todo apps is to keep the pin/star primitive forever because users expect it. I removed it because the new architecture (`type`, `stage`, AI-classifier-with-user-override) made `pinned` redundant — a pinned todo was effectively a manually-prioritized one, and the new `position` column does that better with explicit reorder. **The deeper thing this shows:** I'm willing to delete features when they're subsumed, even if some users (me) had them. The cost was a destructive-ish migration; the benefit was one fewer dimension of state to reason about. I documented the rule that fell out of this in CLAUDE.md principle 9: "Classifier output is editable; user override is permanent" — a more general formulation than `pinned`.

### Q8.2 [senior] What's the worst tradeoff in this codebase?

**Model answer.** The lack of automated tests for the scanner-and-reconcile pipeline. It's the *highest-risk code* in the project — bugs would silently corrupt user data — and it's the *most testable* code (pure functions, clear input/output). I've shipped it and iterated on it, but I'm one refactor away from breaking the two-pass matching subtly and not noticing until the user reports orphaned todos. **The reason I haven't fixed it:** at solo-app scale, my "test" is dogfooding on my own data, and bugs surface within a day. At any larger scale, this is the first thing I'd build. I'd write fixture-based tests for [scanTodos.ts](../src/services/todos/scanTodos.ts) covering: edit-in-place, delete-line, insert-line, reorder-lines, identical-text-twice, empty-content. Maybe 30-50 cases, all derived from real edits I've seen. **Owning the tradeoff:** I made it deliberately because the cost of a bug at solo-scale is bounded (I'm the only user; I can fix forward). At a job, this is non-negotiable.

### Q8.3 [arch] If you started over today, what would you change?

**Model answer.** Three things. (1) **Test fixtures from day one** — see Q8.2. The cost would have been one day; the benefit would be confidence on every scanner change. (2) **A tighter type-state coupling** — I have `TodoType`, `TodoStage`, `ClassifierConfidence` as TS string-literal unions, and CHECK constraints in SQLite that mirror them, but the link is *manual*. If I added a new value I'd need to update both. I'd extract a single source of truth (e.g. a `types.ts` file that exports both the TS union and the SQL CHECK string) and codegen the rest. (3) **A queue worker for Notion writes** — right now `syncAllTodos` is a synchronous loop that pushes everything dirty in one call. At any meaningful scale, that's a cliff; I'd refactor to a `drop_write_queue` pattern (which I outlined in the original drops plan but didn't ship) where each Notion write is a queued op processed asynchronously. **What I wouldn't change:** the prose-canonical drops idiom and the heuristic-first classifier. Those are the two non-obvious decisions that make this app feel different from a normal todo tracker, and I'd defend them at any scale.

---

<a id="weaknesses"></a>
## 9. Weaknesses + objections

| Likely objection | How to respond |
|---|---|
| **"There are no automated tests."** | Own it. "I prioritized feature surface for solo-use; the pure functions in `scanTodos.ts` and `scanNutrition.ts` are the first thing I'd test at a job, and the fixture set is obvious — about 30 cases from real edit patterns I've seen. I'm fluent in Vitest/Jest; I just hadn't established the loop here." |
| **"Module-level singletons aren't testable."** | "True — `lastRequestTime` in `notion/api.ts` and `_inFlight` in `classify.ts` are module-private state. At test-time I'd refactor them behind a small class with a constructor parameter, or use Vitest's `vi.useFakeTimers()` to control the rate-limiter without touching the real one. The pattern is a deliberate choice for *solo runtime simplicity*; it's a cheap refactor when tests demand it." |
| **"What if SQLite gets corrupted?"** | "There's no backup story today beyond Notion sync — if SQLite goes, anything not synced is gone. At larger scale I'd add periodic exports to a backup blob, plus a 'restore from Notion' path that reverses the sync. The current model assumes the user's Notion DB *is* the long-term backup, which is true for entries and todos but not for nutrition or projects." |
| **"Why React Native and not native?"** | "Speed of iteration. I'm a frontend specialist and the productivity delta of staying in TS + React patterns mattered more than native performance. The video-export pipeline (FFmpeg via `@wokcito/ffmpeg-kit-react-native`) is the only piece where native would matter, and the wrapper is good enough. If I needed iOS too, RN makes that trivial; native would mean writing the app twice." |
| **"Your sort is JS-side, not SQL-side."** | "True — `/todos` flattens all entries' todos in JS, joins with metas via a Map, and sorts. The reason: the sort criteria mix `todo_meta.position`, `todo_meta.created_at`, and *filtered* visibility (status + category chips). Doing this in SQL would need a complex query rewrite per filter combination. At solo-user scale (≤500 todos) the JS sort is invisible; at 5000+ I'd push to SQL with computed indexes." |
| **"How do you know the LLM classifier is accurate?"** | "I don't measure it formally. I've eyeballed it on my own ~100 captures and corrected the wrong ones via the manual override. Fixing this is straightforward: build a labeled fixture set of 100-200 lines I categorize manually, run the classifier, compute precision/recall per type. I haven't done it because at this scale the cost of a wrong classification is one user tap to override; at scale it'd matter." |
| **"What if Notion changes their API?"** | "The local SQLite is canonical; nothing breaks. Sync would stop working until I update the parser, but every captured entry is intact. The schema-gap tolerance (`detectMissingTodoProperties`) protects against *user-side* schema drift; an *API-side* breaking change would need a parser update. The architectural insulation is deliberate — I rejected the option of making Notion the source of truth precisely to avoid this dependency risk." |
| **"What's the security model?"** | "Solo-user, local-first. API keys live in `expo-secure-store` (Android Keystore / iOS Keychain). Notion tokens never leave the device except in HTTPS calls to `api.notion.com`. There's no auth layer because there are no other users. At any multi-user scale I'd need: per-user encryption-at-rest on the SQLite store, OAuth flow for Notion (currently it's user-pasted integration tokens), and an audit log for sync operations." |
| **"This is just a personal note app with extras."** | "It's a personal note app with three architectural decisions that aren't in personal note apps: (1) prose-canonical drops with two-pass identity preservation, (2) heuristic-first cost-tiered LLM integration, (3) bidirectional Notion sync with field-level merge rules and schema-gap tolerance. The journal surface is the *delivery vehicle* for those patterns. The patterns are the point." |

---

<a id="refactoring"></a>
## 10. Refactoring + improvement areas

| Improvement | Cost | Worth it now? | How to articulate it |
|---|---|---|---|
| **Test fixtures for pure parsers** | 1 day | At a job, yes; solo, no. | "Day-1 priority at any larger scale. Solo, my dogfood loop catches regressions within a day." |
| **`drop_write_queue` for Notion writes** | 1-2 days | Not yet — current sync is synchronous and works for ≤500 rows. | "I'd ship it once I see real lag during sync. The original drops plan outlined the pattern; the foundation (`sync_deletions` queue) is already there." |
| **Single source for type ↔ schema enums** | 2-3 hours | Yes if I add another type. | "It's manual maintenance today; one file with `TodoType` + a `TODO_TYPE_CHECK_CLAUSE` export, generate the rest. I'd ship it before adding the next category." |
| **Virtualized list on `/todos`** | Half day with FlashList | Not yet — `≤200 todos` performs fine. | "Profile-driven. The moment I see jank on scroll, I swap `ScrollView` for `FlashList`." |
| **Streaming LLM responses** | 1 day per integration | Yes for expansion (currently a 5-15s wait with no progress). | "The expansion modal would feel much better with token-by-token streaming. The auto-retry logic gets harder; not yet a blocker but on the list." |
| **Tool-use / function-calling for structured output** | 1 day | Likely — would reduce malformed JSON to near-zero. | "The retry-on-malformed pattern works at 95% but the 5% is user-visible. Tool-use mode would push it to 99%+. I haven't done it because it's provider-specific code (Anthropic and OpenAI both support it but with different shapes)." |
| **Eval harness for the classifier** | 1 day | At a job, yes; solo, no. | "Without it I'm guessing at accuracy. Fixture set of 100-200 hand-labeled lines + a runner; I'd track precision/recall per type and gate prompt changes on it." |
| **Multi-device sync via CRDT** | 2-4 weeks | No, single-user app. | "Would unblock a real product trajectory. Current Notion-as-sync is a per-device backup, not real sync. At product-scale I'd evaluate Yjs or Automerge before custom merge logic." |
| **Telemetry / observability** | 1-2 days | Yes for any AI cost tracking. | "I have no visibility into LLM cost per call beyond what I see in Anthropic's billing dashboard. A simple `events` table logging `{type, model, input_tokens, output_tokens, latency, cost}` would give per-feature cost analytics." |
| **Per-user concurrency / quota for LLM calls** | 1 week if multi-user | Not yet — single user. | "MAX_CONCURRENT=3 is per-device. At multi-user it becomes per-user-per-window with billing integration." |

---

<a id="ai-assisted"></a>
## 11. The AI-assisted development angle

The hardest interview tightrope. The goal is to demonstrate that **you architected, judged, debugged, and owned** the product, while being honest that AI wrote a lot of the code.

### "How much did you actually write vs the AI?"

**Model answer.** Honest split: I'd estimate the AI wrote 60-70% of the lines, I wrote 100% of the architecture and spec decisions. The way to think about it: every file in this codebase exists because I decided what it should do, where it should live, what it should not do. The AI is a fluent code generator; I'm the engineer who knows when to keep it on the rails. Concrete examples: I rewrote the original drops spec from scratch when the AI proposed a Next.js stack that didn't fit the actual app — see [docs/loopd-thinking-modes-spec.md](./loopd-thinking-modes-spec.md) and the four-phase plan I overlaid on it. I rejected the "flatten the dashboard" recommendation in the implementation plan and kept ranking on the dashboard while flattening only `/todos`. I named four pushbacks on the original AI-proposed architecture before any code was written. The LOC count is the wrong metric; the metric is "who decided." The decider was me.

### "How do you know the code is correct if AI wrote it?"

**Model answer.** Three layers. (1) **Strict TypeScript** — every file passes `npx tsc --noEmit`; the type system catches the class of bugs that AI commonly introduces (wrong arity, mistyped fields, null vs undefined). (2) **Schema-level enforcement** — CHECK constraints in SQLite catch enum violations at insert time, not at render time, so a typo in a literal-union type fails fast. (3) **Manual end-to-end testing** on a physical Android device after every meaningful change. I install the release APK and run the actual user flow; this catches integration bugs that unit tests would miss. **Where I'm honest about gaps:** I don't have automated tests, and the AI sometimes generates plausible-looking code that has subtle off-by-one errors. The only protection against that is my reading of every diff before I commit. I read every line. If I don't understand what a function does, it doesn't ship — and I push back on the AI to simplify until I do.

### "What would you do if the AI got something wrong?"

**Model answer.** I have a real example to point at. The AI initially proposed a *bottom-sheet modal* for the expansion view; I shipped that, then realized on the device that it overlapped the Android system gesture bar. I converted it to a full-page route at `app/todos/[id].tsx` — that's a deliberate architectural change, not a tweak. I made the call by recognizing the UX problem on the device, deciding the modal was the wrong primitive, and directing the AI to refactor to a route. The AI wrote the refactor faster than I would have, but the *judgment* was mine. **The general pattern:** if the AI produces code that compiles but feels wrong, I trust the feeling. The discomfort usually traces to a missing constraint I hadn't articulated. My job is to articulate the constraint, not to debug the AI's output line-by-line.

### "What did you learn from building this?"

**Model answer.** Three things, ranked. (1) **The cost of ambiguity in specs is much higher than I thought.** The AI follows the spec; if the spec is wrong, the code is wrong, but it ships fast and the wrongness compounds. I'm now much more rigorous about spec-then-build, and I've started writing rejection sections in plans ("we are NOT building X because Y") because the AI will otherwise infer things into existence. (2) **Heuristic-first is a real product decision, not just an optimization.** The cost of an LLM call adds up; the deterministic path lets you ship features that wouldn't survive on AI alone. (3) **AI is best at the things I'm fluent in, worst at the things I'm not.** I'm fluent in TS + React, so the AI was leverage there. I'm not fluent in FFmpeg or RN reanimated; the AI's output there needed much more verification. The takeaway: AI amplifies your existing skills more than it expands them. The skills still have to be there.

### "How is this different from just using a template?"

**Model answer.** A template gives you starter code; this codebase has *decisions*. Concretely: prose-canonical drops with two-pass matching is a non-obvious architectural choice — no template would do that. The cost-tiered LLM strategy with heuristic-first fallback is a non-obvious AI-engineering choice. The 1:1 invariant between `todos_json` and `todo_meta` is a deliberate normalization tradeoff. The `sync_deletions` queue with `entity_type` discriminator is a pattern I learned from CQRS literature and applied here. None of these are template defaults; they're decisions I documented in [docs/spec.md](./spec.md) and [docs/concepts.md](./concepts.md), with the reasoning behind each. **The simplest test:** ask me about any decision in this codebase, and I'll tell you (a) what I chose, (b) what I rejected, (c) what I'd do at scale. A template-user can't do that.

---

<a id="dsa"></a>
## 12. DSA — Three coding problems derived from this codebase

### Problem 1 (array / list): Sparse-position reorder

**Problem statement.** You have a list of items, each with an optional `position: number | null`. The visible sort order is: items with `position != null` in ASC order, then items with `null` position in `createdAt` DESC order. The user requests a `moveUp(items, id)` operation: the item with the given `id` should swap visible-sort positions with the row immediately above it. After the operation, return the new sorted list (and the items array with their updated positions). When all positions start as `null`, you need to assign them on the first reorder.

**Brute force.** Iterate the list, compute the visual sort, find the target's index, find the index above, swap their positions in the array. If positions are null, assign integers from 0 to N-1 first. Time: `O(n log n)` for the sort (unavoidable). Space: `O(n)`.

**Optimal.** Same `O(n log n)` time — the sort is the dominant cost. The interesting optimization is *minimizing writes*: if all positions are already integers, you only need to write *two* updates (the swapped pair). Track which items had `null` positions and which already had integers; only assign positions to the visible block being reordered.

```ts
type Item = { id: string; position: number | null; createdAt: string };

function moveUp(items: Item[], id: string): Item[] {
  // Sort
  const sorted = [...items].sort((a, b) => {
    if (a.position == null && b.position == null) {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
    if (a.position == null) return -1;  // null first per loopd's choice
    if (b.position == null) return 1;
    return a.position - b.position;
  });

  // Find target
  const idx = sorted.findIndex(it => it.id === id);
  if (idx <= 0) return sorted;  // already at top or not found
  const target = sorted[idx];
  const above = sorted[idx - 1];

  // Ensure both have integer positions; densify if needed
  const allHavePositions = items.every(it => it.position != null);
  if (!allHavePositions) {
    // Densify based on the current visual order
    sorted.forEach((it, i) => { it.position = i; });
  }

  // Swap
  const tmp = target.position!;
  target.position = above.position!;
  above.position = tmp;

  // Re-sort
  return sorted.sort((a, b) => a.position! - b.position!);
}
```

**Why the optimal works (the insight).** The `null`-position case is the trap. If you naively swap `null` ↔ `integer`, you've half-densified the list and the next reorder will see inconsistent state. The fix is to make the densification step a *prerequisite* of any reorder: if any position is null, assign all of them in current visual order *first*, then swap. This corresponds to [reorder.ts:21-58](../src/services/todos/reorder.ts#L21-L58)'s `ensureAllTodoPositions`. The principle: when you have a sparse derived field, idempotently densify before mutating.

---

### Problem 2 (tree / nested): Flatten nested entries with priority sort

**Problem statement.** You have a list of `Entry { id, date, createdAt, todos: TodoItem[] }`. Each `TodoItem { id, text, done, completedAt: string | null, createdAt?: string }`. Implement `rankTodos(entries, today)` that returns a flat list of `RankedTodo = TodoItem & { entryId, entryDate, source }`, where `source` is computed:

- `'carried'` if `!todo.done && entry.date < today`
- `'ai'` if some marker (assume a `todo.aiGenerated === true` flag)
- `'journal'` otherwise

Sort by source priority `carried < ai < journal`, then by `effectiveCreatedAt` ASC (todo's createdAt or entry's). Skip done todos completed more than 2 seconds ago.

**Brute force.** Two nested loops to flatten. Sort with a comparator. Time: `O(n log n)` where `n` = total todos across all entries. Space: `O(n)`.

**Optimal.** Same `O(n log n)`. The interesting move is making the comparator *stable* and *cheap*. Pre-compute `effectiveCreatedAt` once during flattening (so the sort doesn't re-parse dates).

```ts
type Source = 'carried' | 'ai' | 'journal';
const PRIORITY: Record<Source, number> = { carried: 0, ai: 1, journal: 2 };

function rankTodos(entries: Entry[], today: string, now: number = Date.now()): RankedTodo[] {
  const KEEP_DONE_MS = 2000;
  const flat: RankedTodo[] = [];

  for (const entry of entries) {
    for (const todo of entry.todos ?? []) {
      // Skip recently-completed dones
      if (todo.done && todo.completedAt) {
        const completed = new Date(todo.completedAt).getTime();
        if (now - completed > KEEP_DONE_MS) continue;
      }
      let source: Source = 'journal';
      if (!todo.done && entry.date < today) source = 'carried';
      else if (todo.aiGenerated) source = 'ai';

      const effective = todo.createdAt ?? entry.createdAt;
      flat.push({
        ...todo,
        entryId: entry.id,
        entryDate: entry.date,
        source,
        // pre-computed once for sort efficiency
        _sortKey: new Date(effective).getTime(),
      });
    }
  }

  flat.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (PRIORITY[a.source] !== PRIORITY[b.source]) {
      return PRIORITY[a.source] - PRIORITY[b.source];
    }
    return a._sortKey - b._sortKey;
  });

  return flat;
}
```

**Why the optimal works (the insight).** Two things: (a) **flatten and compute keys in one pass** so the sort comparator is `O(1)` per comparison instead of re-parsing dates each time; (b) **lexicographic comparator with priority maps** lets you compose multiple sort criteria cleanly. The pattern is the same as [rank.ts:24-75](../src/services/todos/rank.ts#L24-L75). At scale, you'd push this to SQL with a `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)` window function, but JS-side is fine for ≤1000 rows.

---

### Problem 3 (real app op): Two-pass identity-preserving record matching

**Problem statement.** A user types prose containing lines like `[] foo` (todo) or `[x] bar` (done todo). Each line, in order, has a *line index* in the prose. You have a list of *existing* todos (from a previous parse) and the *new* parsed result. For each line, decide whether it matches an existing todo (and which) or creates a new one. Match rules in priority order:

1. **Pass 1**: line content (case-insensitive, trimmed) matches an existing todo's `text` exactly.
2. **Pass 2**: line index matches an existing todo's `sourceLine`.
3. Otherwise, this is a new todo.

After both passes, any existing todos that weren't claimed are "orphans" (their content was deleted from the prose). Return `{ matched: [{ existingId, lineIndex }], orphans: existingId[] }`.

**Brute force.** For each new line, scan all existing todos for content match (Pass 1). Then for each unmatched line, scan all existing for sourceLine match (Pass 2). Time: `O(n × m)` where `n = new lines`, `m = existing todos`. For typical entries (~30 todos), this is fine; at 1000+ it's slow.

**Optimal.** Use two hash maps: one keyed by normalized content, one keyed by sourceLine. `O(n + m)` time, `O(n + m)` space.

```ts
type Existing = { id: string; text: string; sourceLine: number };
type NewLine = { content: string; lineIndex: number };

function twoPassMatch(
  existing: Existing[],
  newLines: NewLine[],
): { matched: { lineIdx: number; existingId: string }[]; orphans: string[] } {
  const matched: { lineIdx: number; existingId: string }[] = [];
  const claimed = new Set<string>();
  const byText = new Map<string, Existing[]>();
  const byLine = new Map<number, Existing[]>();

  for (const e of existing) {
    const key = e.text.trim().toLowerCase();
    (byText.get(key) ?? byText.set(key, []).get(key)!).push(e);
    (byLine.get(e.sourceLine) ?? byLine.set(e.sourceLine, []).get(e.sourceLine)!).push(e);
  }

  // Pass 1: exact text match
  const unmatched: NewLine[] = [];
  for (const line of newLines) {
    const key = line.content.trim().toLowerCase();
    const candidates = byText.get(key);
    const pick = candidates?.find(e => !claimed.has(e.id));
    if (pick) {
      claimed.add(pick.id);
      matched.push({ lineIdx: line.lineIndex, existingId: pick.id });
    } else {
      unmatched.push(line);
    }
  }

  // Pass 2: sourceLine fallback for what's left
  for (const line of unmatched) {
    const candidates = byLine.get(line.lineIndex);
    const pick = candidates?.find(e => !claimed.has(e.id));
    if (pick) {
      claimed.add(pick.id);
      matched.push({ lineIdx: line.lineIndex, existingId: pick.id });
    }
    // else: this is a brand-new todo (caller creates it)
  }

  const orphans = existing.filter(e => !claimed.has(e.id)).map(e => e.id);
  return { matched, orphans };
}
```

**Why the optimal works (the insight).** Three pieces.

1. **Two passes are non-negotiable.** A single-pass algorithm can't preserve identity through edits. Imagine the user changes line 3 from `[] foo` to `[] bar` and adds a new `[] foo` at line 5 — a content-only matcher would link new-line-5 to old-line-3 (wrong). A line-index-only matcher would link new-line-3 (text=bar) to old-line-3 (text=foo) but lose the new-line-5 → null match. Two-pass with claim tracking is the minimum correct algorithm.

2. **Hash maps turn the inner loop into `O(1)` lookup.** Without them you're at `O(n × m)`. With them you're at `O(n + m)` and the constant factor is small.

3. **Claimed-set is the trick.** When two new lines have the same content (`[] foo` written twice), you don't want both to claim the same existing todo. The `Set` ensures one-to-one mapping; the second occurrence falls through to Pass 2 or becomes a new row.

This is the actual pattern in [scanTodos.ts:63-88](../src/services/todos/scanTodos.ts#L63-L88) and [scanNutrition.ts:66-94](../src/services/nutrition/scanNutrition.ts#L66-L94). The connection to classical algorithms: it's a degenerate case of bipartite matching, where the two passes are a heuristic instead of running Hungarian. For loopd's scale, the heuristic is correct often enough that we never need the full algorithm; at much larger scale (thousands of edits per second across collaborative documents), I'd revisit.

---

## How to use this doc

Read it once cold to understand the shape. Read it again the morning of the interview to lock in the specific code references. Pick three answers per category as your "go-to" responses; the rest are coverage.

Two-line cheat sheet for the hardest moment:

> "I made *this* tradeoff because *X*. At scale I'd address it by *Y* when *Z* condition is met."

That's the senior-engineer signature: named tradeoffs + a future plan with a triggering condition.
