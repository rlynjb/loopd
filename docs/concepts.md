# buffr — Concepts you can learn from this codebase

A self-study guide that uses your own code as the curriculum. Every concept points at a specific file/line so you can see the pattern in context, with a transferable rule at the end so you can use it in other stacks.

Categories follow the four-quadrant framing:

- **Sys** — systems thinking (data flow, idempotency, migrations, races)
- **Code** — thinking in code (types, errors, abstractions, rollbacks)
- **AI** — agentic AI patterns (orchestration, prompts, tool/structured output)
- **AIProd** — AI product engineering (cost, context, evaluation, spec)
- **Universal** — language- and stack-agnostic principles

---

## Concept Index

| # | Concept | Category | Difficulty |
|---|---|---|---|
| 1 | Single source of truth | Sys / Universal | Foundational |
| 2 | Layered architecture | Sys | Foundational |
| 3 | Service-module pattern | Sys | Foundational |
| 4 | Type-driven design with strict TS | Code | Foundational |
| 5 | Pure parsers vs side-effect orchestrators | Code | Foundational |
| 6 | Schema migrations + CHECK constraints | Sys | Foundational |
| 7 | SecureStore-gated one-time backfills | Sys / Universal | Foundational |
| 8 | DB-first autosave (silent saves) | Sys | Foundational |
| 9 | Two-pass matching for derived records | Sys | Intermediate |
| 10 | Round-trip / write-back-to-source | Sys | Intermediate |
| 11 | Self-healing reconcile | Sys / Universal | Intermediate |
| 12 | Module-level singletons | Sys / Code | Intermediate |
| 13 | Lightweight event bus | Sys / Code | Intermediate |
| 14 | ForwardRef + imperative handles | Code | Intermediate |
| 15 | Discriminated unions for results | Code | Intermediate |
| 16 | Sync-deletion queue with `entity_type` | Sys | Intermediate |
| 17 | Fire-and-forget with logged failures | Code / Universal | Intermediate |
| 18 | Multi-provider LLM abstraction | AI | Advanced |
| 19 | Heuristic-first, LLM fallback | AI / AIProd | Advanced |
| 20 | Cost-tiered model selection | AIProd | Advanced |
| 21 | JSON-out validation + one-shot retry | AI / AIProd | Advanced |
| 22 | Chain-of-thought reasoning preambles | AI | Advanced |
| 23 | Context window management | AIProd | Advanced |
| 24 | User-override locks the AI | AIProd | Advanced |
| 25 | Concurrency cap on expensive LLM calls | AIProd | Advanced |
| 26 | Manual-only AI mutation (no silent writes) | AIProd / Universal | Advanced |
| 27 | Memory-bank caching of LLM output | AIProd | Advanced |
| 28 | Schema-gap tolerance (backwards-compat mapper) | Sys / Code | Advanced |
| 29 | Last-edit-wins with field-level merge rules | Sys | Advanced |
| 30 | Drops idiom — DSL embedded in prose | Code / AIProd | Advanced |
| 31 | Spec-driven dev with phased plans | AIProd / Universal | Advanced |

---

## Foundational

### 1. Single source of truth

**What.** Every piece of derivable state has exactly one writer; everything else reads or syncs from it. In buffr, two layered "sources" coexist: SQLite is the source of truth for app state; *prose inside `entries.text`* is the source of truth for derived drops (todos, nutrition).

**Where.** [CLAUDE.md](../CLAUDE.md) Data Rules + Autosave Rules sections codify both. The shape shows up in [src/services/todos/scanTodos.ts:139-181](../src/services/todos/scanTodos.ts#L139-L181) (`rewriteTodoLine` writes back into prose so prose stays canonical when the dashboard mutates a todo).

**Why.** Two writers + one shared field = drift. Buffr had real data-loss bugs from races between focus cleanup and idle timers (CLAUDE.md called these out post-mortem). Picking a canonical source ends the argument: dashboard toggles round-trip into prose, never into a separate "todos table" of record.

**Rule (Universal).** Pick one canonical writer per concept. Every other surface is a cache or a mirror. When state diverges, the canonical source wins.

**Go deeper.** *Designing Data-Intensive Applications* (Kleppmann), Ch. 5 "Replication" — the whole "leader / follower" framing is the same idea at scale.

---

### 2. Layered architecture

**What.** Code is sliced into horizontal layers — UI screens (`app/`), React hooks (`src/hooks/`), services (`src/services/`), data (`src/services/database.ts`). Each layer only depends on the ones below it.

**Where.** [src/hooks/useEntries.ts](../src/hooks/useEntries.ts) sits between [app/journal/[date].tsx](../app/journal/[date].tsx) and [src/services/database.ts](../src/services/database.ts). The hook owns React state + concurrency; the service does pure SQLite I/O.

**Why.** When the autosave logic needed to fire scanners on commit, the change was a 5-line hook edit (`scheduleNutritionScan`, `scheduleTodoMetaReconcile`). The DB layer didn't change at all. The screens didn't change at all.

**Rule (Universal).** When a feature touches multiple layers, ask which layer *owns* the new responsibility. If the answer is "all of them," your layers are leaky.

**Go deeper.** *A Philosophy of Software Design* (Ousterhout), Ch. 4 "Modules Should Be Deep."

---

### 3. Service-module pattern

**What.** Each service folder under `src/services/` owns one concern with a tight public surface and free internal structure. `notion/`, `todos/`, `nutrition/`, `ai/` each follow the same shape: small files split by what-not-by-when.

**Where.** [src/services/todos/](../src/services/todos/) is the most evolved: `scanTodos.ts` (parser), `reconcileMeta.ts` (orchestrator), `classify.ts` (LLM), `expand.ts` (LLM), `expandPrompts.ts` (prompts), `expandSerialize.ts` (templates), `crud.ts` (mutations), `migrate.ts` + `migrateMeta.ts` (one-time backfills).

**Why.** A new contributor can read `scanTodos.ts` standalone without learning what reconcile or expand does. When the heuristic verb list grows, only `heuristicClassify.ts` changes.

**Rule.** Files should split by *responsibility*, not by *layer*. "Parsers in one folder, mutations in another" is a smell — keep the cohesive parts of one feature together.

**Go deeper.** Read `feature-folders` discussions; compare buffr's `services/todos/*` to a "model/controller/repository" split for the same logic.

---

### 4. Type-driven design with strict TS

**What.** TypeScript is in strict mode and types do real work — discriminated unions, narrowing, optional fields modeled deliberately rather than as `T | undefined` wallpaper.

**Where.** [src/types/todoMeta.ts:5-13](../src/types/todoMeta.ts#L5-L13) declares `TodoType` as a string-literal union; the SQLite CHECK constraint at [src/services/database.ts:175](../src/services/database.ts#L175) enforces the same enum at the DB. Type and schema are deliberately kept in lockstep.

**Why.** "If the type compiles, the SQL accepts it" — when you add a new type, both must change together; either alone won't pass typecheck or insert.

**Rule (Universal).** Treat the type system as a design tool, not a comment system. Make invalid states unrepresentable, then the runtime can stop apologizing for them.

**Go deeper.** *Type-Driven Development with Idris* (Brady) is the deep cut even if you stay in TS. Search "make illegal states unrepresentable" (Yaron Minsky / OCaml community).

---

### 5. Pure parsers vs side-effect orchestrators

**What.** The functions that *interpret* prose are pure (in → out, no I/O); the functions that *commit* the result do I/O. This separation makes parsers easy to reason about and orchestrators easy to retry.

**Where.** [src/services/todos/scanTodos.ts:53-125](../src/services/todos/scanTodos.ts#L53-L125) — `scanTodosFromText(text, existing)` is pure. [src/services/todos/reconcileMeta.ts:48-90](../src/services/todos/reconcileMeta.ts#L48-L90) — `reconcileTodoMetaForEntry(entry)` does the inserts/deletes and fires the LLM.

**Why.** The parser can be unit-tested with no DB. The orchestrator can be retried by the caller with no parsing cost. A failed reconcile leaves a *deterministic* gap that the next commit closes.

**Rule.** Push side effects to the boundary. The middle of your code should be pure.

**Go deeper.** "Functional core, imperative shell" (Gary Bernhardt's Boundaries talk). Think in terms of "where does I/O happen" as a layer concern.

---

### 6. Schema migrations + CHECK constraints

**What.** SQLite tables are created with `CREATE TABLE IF NOT EXISTS` (safe on every boot) and modified via `ALTER TABLE ... ADD COLUMN` (also idempotent, gated by try/catch). Domain enums get DB-level CHECK constraints so invalid values fail at insert time, not at render time.

**Where.** [src/services/database.ts:155-179](../src/services/database.ts#L155-L179) — the `todo_meta` create includes three CHECK constraints (`type`, `stage`, `classifier_confidence`). The `addColumn` helper at [database.ts:104-107](../src/services/database.ts#L104-L107) wraps `ALTER` in try/catch so re-runs are no-ops.

**Why.** The "stage" column was added later (2026-04-26) without breaking existing installs — fresh installs get it from CREATE TABLE; existing installs get it from `addColumn`. CHECK constraints turn a typo bug into a constraint violation visible in dev rather than a "hmm, why is the badge missing" mystery in prod.

**Rule.** Idempotent forward-only migrations. Move enum validation as close to storage as possible.

**Go deeper.** Read about Rails-style numbered migrations vs. SQLite's "CREATE IF NOT EXISTS + ALTER" approach. Learn why "down migrations" usually aren't worth writing.

---

### 7. SecureStore-gated one-time backfills

**What.** Some operations need to run *exactly once* per install (or once per a feature's lifetime). The pattern: stash a flag in `expo-secure-store` keyed by `<feature>_<version>_done`; the operation checks-then-sets. Bumping the version forces a re-run.

**Where.** [src/services/todos/migrate.ts:7](../src/services/todos/migrate.ts#L7) (`drops_backfill_v1_done`), [src/services/todos/migrateMeta.ts:11](../src/services/todos/migrateMeta.ts#L11) (`todo_meta_backfill_v1_done`), [src/services/nutrition/migrate.ts](../src/services/nutrition/migrate.ts).

**Why.** When the `[]` checkbox-drop scanner shipped, the user already had hundreds of `[]` lines in old entries that pre-dated the scanner. The backfill walks every entry once on first boot, scans, persists. If we ever rewrite the parser, bumping the key (`v1` → `v2`) re-triggers it.

**Rule (Universal).** Idempotent migrations gated by a versioned flag. Skip on the second boot; allow forced re-run by version bump.

**Go deeper.** Read about "migration markers" in any DB-backed framework. The Stripe API "version pinning" model is the same idea on a network protocol.

---

### 8. DB-first autosave (silent saves)

**What.** Every keystroke writes to SQLite immediately, with no React state update. The TextInput's local state drives display; the DB write is fire-and-forget through a `silentSave` callback. State commits and scanners only fire on focus blur / explicit commit.

**Where.** [src/components/journal/InlineTextInput.tsx:54-61](../src/components/journal/InlineTextInput.tsx#L54-L61) — `handleChange` calls `onSilentSaveRef.current?.(next.trim())` per keystroke. [app/journal/[date].tsx](../app/journal/[date].tsx) has separate `handleSilentNewText` and `handleSaveNewText` — silent goes straight to `updateEntryDB`, explicit goes through `editEntry` (which fires scanners).

**Why.** Past data-loss bugs came from React state being out of sync with what the user typed when navigation interrupted. DB-first means the bytes are durable from keystroke 1, even if the React tree unmounts mid-word.

**Rule.** When you have a long-lived editor surface, treat the DB as the buffer. State is only a render cache.

**Go deeper.** Read the Linear sync engine post; their CRDT-via-mutation-log is the same separation taken further.

---

## Intermediate

### 9. Two-pass matching for derived records

**What.** When a record is derived from a position in some larger document (a `[]` line in prose, a `** food N kcal` line, etc.), edits to the document need to map to *updates* of the same record, not delete+create. Two passes: (1) match by *content*, (2) match by *position*. Edits at the same position with new content reuse the original record id.

**Where.** [src/services/todos/scanTodos.ts:63-88](../src/services/todos/scanTodos.ts#L63-L88) (Pass 1 = exact text, Pass 2 = `sourceLine` index). [src/services/nutrition/scanNutrition.ts:66-94](../src/services/nutrition/scanNutrition.ts#L66-L94) (Pass 1 = exact `(name, kcal)` tuple, Pass 2 = `sourceLine`).

**Why.** A user types `[] call mom` then edits to `[] call dad`. Without two-pass matching, this looks like "delete one todo, create another" and you lose `done` state, `createdAt`, the Notion page id. Two-pass matching: pass 1 finds nothing (text changed), pass 2 finds the same `sourceLine`, reuses the row. Identity preserved.

**Rule.** When derived records have user-visible identity that should outlive content edits, store a *positional* fallback alongside content matching.

**Go deeper.** Operational Transform and CRDTs both formalize this for collaborative editing. Read the *Yjs* docs to see a more rigorous version of the same idea.

---

### 10. Round-trip / write-back-to-source

**What.** When derived state is mutable from a UI other than the source (e.g. dashboard toggles a todo's done state), the mutation rewrites the source so prose stays canonical.

**Where.** [src/services/todos/scanTodos.ts:139-181](../src/services/todos/scanTodos.ts#L139-L181) (`rewriteTodoLine` finds the matching `[]`/`[x]` line via `sourceLine` first, falls back to text match, rewrites the bracket). [src/services/todos/crud.ts:92-98](../src/services/todos/crud.ts#L92-L98) calls it from `updateTodo`.

**Why.** Without round-trip, the next scanner pass would re-derive `done=false` from the unchanged `[]` in prose and clobber the user's dashboard click. With round-trip, the prose says `[x]` and the next scan agrees.

**Rule.** Every mutation on a derived view must round-trip into the source, or the next sync pass will erase it.

**Go deeper.** Read about "write amplification" in distributed systems and bidirectional ETL. The principle generalizes far beyond UI.

---

### 11. Self-healing reconcile

**What.** Instead of trying to keep two stores transactionally synchronized, the reconcile pattern compares them periodically and patches the diff. A failed reconcile leaves a deterministic gap that the next reconcile closes — no special "retry on failure" logic.

**Where.** [src/services/todos/reconcileMeta.ts:48-90](../src/services/todos/reconcileMeta.ts#L48-L90) — walks `todos_json` and `todo_meta` for one entry. New todos → INSERT meta. Orphan metas → DELETE. Idempotent: re-running on the same input is a no-op.

**Why.** Trying to keep `todos_json` and `todo_meta` transactionally consistent across async paths (scanner, classifier, sync) would mean a global mutex. Reconcile makes them eventually consistent: any divergence repairs itself on next call.

**Rule (Universal).** Prefer eventual consistency + reconciliation over distributed transactions. Make the operation idempotent; failure is just "we'll do it next time."

**Go deeper.** Read Heroku's "Idempotency Keys" post. Read about Kubernetes controllers — every controller is a self-healing reconcile loop.

---

### 12. Module-level singletons

**What.** Module-scope `let`/`const` variables hold app-wide state without a DI container or React context: rate limiters, in-flight counters, caches.

**Where.** [src/services/notion/api.ts:7](../src/services/notion/api.ts#L7) — `lastRequestTime` enforces 350ms between Notion calls. [src/services/todos/classify.ts:36-38](../src/services/todos/classify.ts#L36-L38) — `_inFlight` counter exposed via `getClassifyInFlight()`. [src/services/todos/expand.ts:25-28](../src/services/todos/expand.ts#L25-L28) — `_inFlight: Set<string>` of expanding todoIds, capped at `MAX_CONCURRENT=3`.

**Why.** A rate limiter has to be process-wide or it doesn't work. Forcing every caller to thread a `RateLimiter` instance is line noise that adds nothing.

**Rule.** When state is naturally process-global (rate limits, counters, file caches), use module scope. Don't reach for a container.

**Go deeper.** Read about the "pure module" pattern in Node.js. Compare to Java's enum-singleton or Python's "module is a singleton."

---

### 13. Lightweight event bus

**What.** A 12-line publish/subscribe primitive: `on(event, fn)` registers a listener and returns an unsubscribe; `emit(event)` fires all listeners. Used for loose coupling between services that produce progress and UIs that display it.

**Where.** [src/utils/events.ts](../src/utils/events.ts) (full source is ~12 lines). Producers: `classify.ts` emits `classify-progress`, `expand.ts` emits `expand-progress`. Consumer: [app/todos.tsx](../app/todos.tsx) subscribes via `useEffect` to drive the in-flight toast.

**Why.** The classifier service has no idea what UI exists. The toast UI has no idea what calls the classifier. The bus is their only contract: a string event name.

**Rule.** When producer and consumer have no shared lifecycle, an event bus is cleaner than threading callbacks. Pay attention to "what cleans up the listener" — return an unsub function from `on()` so consumers can drop it.

**Go deeper.** Read about RxJS Subjects and the "EventEmitter" pattern. Then look at React Native's `DeviceEventEmitter` / iOS `NotificationCenter` — same idea at platform level.

---

### 14. ForwardRef + imperative handles

**What.** A React component normally hides its internals from parents — but sometimes the parent legitimately needs to *do* something to the child (focus, scroll, insert text). `forwardRef` + `useImperativeHandle` exposes a typed public API while keeping internals private.

**Where.** [src/components/journal/InlineTextInput.tsx:23-26](../src/components/journal/InlineTextInput.tsx#L23-L26) defines `InlineTextInputHandle` with `appendText` and `replaceRange`. The journal toolbar calls `inputRef.current?.appendText('[] ')`; the nutrition autocomplete calls `inputRef.current?.replaceRange(start, end, '<food> 320 kcal ')`.

**Why.** Both the toolbar and the autocomplete need to *modify* the editor's text without becoming the editor's parent component. The handle is a typed contract: "you can ask me to insert here; I'll handle the cursor."

**Rule (Code).** When the parent needs imperative access to a child, expose it deliberately via a typed handle, not by leaking internal state.

**Go deeper.** Read the React docs on `useImperativeHandle`. Then read about "render props" and how they compare for non-imperative cases.

---

### 15. Discriminated unions for results

**What.** Functions that can succeed-with-a-payload OR fail-for-various-reasons return a tagged union. Callers `switch` on the tag and TypeScript narrows to the right shape.

**Where.** [src/services/todos/expand.ts:201-203](../src/services/todos/expand.ts#L201-L203) — `ExpandResult = { ok: true; expandedMd; model } | { ok: false; reason: 'no-ai' | 'in-flight-cap' | 'wrong-type' | 'malformed' | 'network' | 'not-found' }`. [src/types/todoMeta.ts:93-99](../src/types/todoMeta.ts#L93-L99) — `TodoExpansion` discriminated union over six per-type shapes.

**Why.** `try/catch` with `Error` instances loses type information. With a tagged result, the caller knows at compile time exactly which failure modes exist, and the modal in `ExpansionModal` can map each `reason` to a precise user message.

**Rule.** For domain-significant failures, return a discriminated union; reserve exceptions for *unexpected* errors. Failure modes you've thought about deserve types.

**Go deeper.** Read about Rust's `Result<T, E>` + `?` operator. The pattern transfers cleanly to TS — tagged unions are just `Result` you write yourself.

---

### 16. Sync-deletion queue with `entity_type`

**What.** When a row is deleted locally that was previously synced to Notion, you can't push the delete immediately (might be offline). A separate `sync_deletions` table holds the pending archive op. The `entity_type` column lets one queue serve multiple kinds of records.

**Where.** [src/services/database.ts:121-129](../src/services/database.ts#L121-L129) — table schema. [src/services/database.ts:781-791](../src/services/database.ts#L781-L791) — `enqueueSyncDeletion` helper. Drained per type in [src/services/notion/sync.ts](../src/services/notion/sync.ts) `processDeletions(token, 'todo')` etc.

**Why.** A todo deleted while offline must still archive its Notion page on the next sync. Storing only the `notion_page_id` + `entity_type` is enough — the local row is already gone, and we don't need the body anymore.

**Rule.** Deferred operations need a queue. Queues with multiple producers benefit from a discriminator column so consumers can filter cheaply.

**Go deeper.** Read about outbox patterns in distributed systems (Microsoft Azure docs are good). The "Transactional Outbox" pattern formalizes this.

---

### 17. Fire-and-forget with logged failures

**What.** Functions that *should* run but whose failure shouldn't break the caller's flow are launched with `.catch(err => console.warn(...))`. The error is logged, not thrown. The user-facing operation succeeds.

**Where.** [src/hooks/useEntries.ts](../src/hooks/useEntries.ts) — `scheduleNutritionScan(scanned)` and `scheduleTodoMetaReconcile(scanned)` after `editEntry`. [src/services/todos/reconcileMeta.ts:23-32](../src/services/todos/reconcileMeta.ts#L23-L32) — `scheduleClassify` similarly.

**Why.** A scanner glitch shouldn't make the journal save fail. CLAUDE.md's principle: "journal save must not fail due to drop errors." Logging gives us visibility; not throwing gives us reliability.

**Rule (Universal).** Distinguish between operations whose failure must propagate and operations whose failure must not. Choose throw vs. log per call site, not per service.

**Go deeper.** Read about "error budgets" in SRE practice. The instinct of "everything must succeed" is often wrong; non-critical paths should degrade.

---

## Advanced

### 18. Multi-provider LLM abstraction

**What.** Code calls "an LLM," not "Claude" or "OpenAI." Provider selection is a runtime decision based on which API key the user has configured. Both providers go through identical input/output shapes; provider-specific quirks (fetch shape, response format) are encapsulated in helper functions.

**Where.** [src/services/ai/config.ts](../src/services/ai/config.ts) holds keys + provider flag. Three different services consume that abstraction at *three cost tiers*: [src/services/ai/summarize.ts](../src/services/ai/summarize.ts) for daily summaries (Sonnet 4.6 / GPT-4o), [src/services/todos/expand.ts:31-60](../src/services/todos/expand.ts#L31-L60) for expansions (same primary), [src/services/todos/classify.ts:40-69](../src/services/todos/classify.ts#L40-L69) for classification (Haiku 4.5 / GPT-4o-mini).

**Why.** Users with only one key don't get blocked. The `expand.ts` orchestrator picks `useOpenAI = provider === 'openai'` once and the rest is callsites: `useOpenAI ? callOpenAI(...) : callClaude(...)`.

**Rule (AI).** Wrap LLM calls in your own narrow abstraction from day one. SDKs change shape; your domain shouldn't.

**Go deeper.** Read about LangChain's `BaseChatModel` and Vercel AI SDK's provider plugins. They formalize this; you can build a thin version yourself in 50 lines.

---

### 19. Heuristic-first, LLM fallback

**What.** When you need to classify, score, or route, try a deterministic heuristic *first*. Only call the LLM when the heuristic is uncertain. The LLM becomes an escape hatch, not the primary path.

**Where.** [src/services/todos/heuristicClassify.ts:71-102](../src/services/todos/heuristicClassify.ts#L71-L102) — pure-function classifier returns `'todo' | null`. [src/services/todos/reconcileMeta.ts:57-80](../src/services/todos/reconcileMeta.ts#L57-L80) — heuristic runs inline; if it returns null AND the todo isn't done, `scheduleClassify()` fires the LLM async.

**Why.** Most todos are obvious — `"reply to design review thread"`, `"call mom"`. A regex with ~50 imperative verbs catches those for free. The LLM only sees the genuinely ambiguous ones — maybe 20% of captures. Cost drops by 5x; latency drops to zero on the common path.

**Rule (AIProd).** AI is expensive and slow. Build the cheap heuristic first. Use the LLM where the heuristic *abstains*, not where it *might be wrong*.

**Go deeper.** Read Eugene Yan's posts on "patterns for ML-powered products" — heuristic baselines are the recurring theme.

---

### 20. Cost-tiered model selection

**What.** Three different LLM tiers serve three different jobs. The cheap tier (Haiku / GPT-4o-mini) handles classification (~$0.0001/call). The primary tier (Sonnet 4.6 / GPT-4o) handles reasoning-heavy tasks like daily summary and per-type expansion (~$0.04-0.05/call). The choice is per-task, not per-app.

**Where.** [src/services/todos/classify.ts:9-10](../src/services/todos/classify.ts#L9-L10) — cheap classifier models. [src/services/todos/expand.ts:20-21](../src/services/todos/expand.ts#L20-L21) — primary expansion models. [src/services/ai/summarize.ts:7-8](../src/services/ai/summarize.ts#L7-L8) — same primary tier for summaries.

**Why.** Classifying 100 ambiguous todos with Haiku costs ≈ $0.01. Doing the same with Sonnet would be ≈ $1. Conversely, asking Haiku to do a chain-of-thought expansion of an idea produces visibly worse results. Pick the tier per *workload shape*, not per *brand*.

**Rule (AIProd).** Map jobs onto a cost ladder: triage (cheap) → reasoning (primary) → frontier (rare). Profile each. Budget by tier.

**Go deeper.** Anthropic and OpenAI both publish per-model pricing pages. Build a 1-pager mapping each LLM call site to its tier; track monthly cost per tier.

---

### 21. JSON-out validation + one-shot retry

**What.** When the LLM is supposed to return structured JSON, you parse-and-validate against a schema. On malformed output, you call *once more* with a stricter instruction ("re-emit ONLY a single JSON object that exactly matches the schema") before giving up.

**Where.** [src/services/todos/expand.ts:77-142](../src/services/todos/expand.ts#L77-L142) — `validateExpansion` shape-checks parsed JSON per type. [src/services/todos/expand.ts:228-247](../src/services/todos/expand.ts#L228-L247) — `callOnce()` invoked twice, second time with appended hardener.

**Why.** Models sometimes wrap JSON in fences, add a preamble, or hallucinate fields. One retry catches ~95% of those without the user seeing it. More retries would burn money for diminishing returns.

**Rule (AI).** Trust LLM JSON the same way you'd trust raw user input — validate and retry exactly once.

**Go deeper.** Read about Pydantic / Zod for schema validation. Look at OpenAI's `response_format: 'json_object'` and Anthropic's tool-use mode — both reduce malformed-JSON rates dramatically.

---

### 22. Chain-of-thought reasoning preambles

**What.** Per-type system prompts include a "before answering, think about…" block that explicitly walks the model through the reasoning steps you want it to take. Folded into the system prompt, not the user message.

**Where.** [src/services/todos/expandPrompts.ts:7-14](../src/services/todos/expandPrompts.ts#L7-L14) — `PREAMBLES` map: idea preamble asks "Is this solving a real problem or just interesting? What's the simplest version of this? What existing patterns relate to it?" Six per-type preambles, each shaped to the kind of thinking that *type* needs.

**Why.** Without the preamble, expansion outputs feel generic. With it, the model considers the right axes for the type — bug reports get repro steps, ideas get tradeoffs, decisions get revisit conditions.

**Rule (AI).** Tell the model *how to think* before *what to write*. Reasoning preambles are cheap (a few hundred tokens) and dramatically improve output quality.

**Go deeper.** Read the original Chain-of-Thought paper (Wei et al., 2022). Read Anthropic's "Constitutional AI" post — same idea applied to alignment.

---

### 23. Context window management

**What.** When you build context blocks for an LLM, *cap each piece*. Heavy users will blow your token budget otherwise. Per-piece caps with a truncation marker preserve recency without unbounded growth.

**Where.** [src/services/todos/expandPrompts.ts:104,121](../src/services/todos/expandPrompts.ts#L104) — `capText(ctx.entryText, 1000)` and `capText(r.text, 1000)` per recent entry. [src/services/todos/expandPrompts.ts:128-131](../src/services/todos/expandPrompts.ts#L128-L131) — `capText` itself: `if (s.length <= max) return s; return s.slice(0, max) + '… (truncated)';`.

**Why.** Recent entries (last 3 days) included in expansion context. A heavy journaling day could be 10k chars per day — three days × 10k + system prompt + reasoning preamble could push past Sonnet's 200k window or, more practically, blow the cost budget. 1000-char cap puts a hard ceiling on the expansion call (~$0.05).

**Rule (AIProd).** Every dynamic-content slot in a prompt needs a cap. Caps + recency = bounded cost + good UX.

**Go deeper.** Read about "lost in the middle" research on long-context LLMs. Tighter context often outperforms longer context.

---

### 24. User-override locks the AI

**What.** Once the user manually corrects an AI-assigned attribute, set a flag that locks the row from future AI mutation. The override is permanent until the user explicitly resets it.

**Where.** Schema: [src/services/database.ts:172](../src/services/database.ts#L172) — `user_overridden_type INTEGER`. [src/services/todos/migrateMeta.ts:69](../src/services/todos/migrateMeta.ts#L69) — catch-up classifier skips rows where `meta.userOverriddenType === true`. [app/todos.tsx](../app/todos.tsx) — `TypeChangePicker` `handleTypePick` sets `userOverriddenType: true`.

**Why.** Without the lock, the user manually fixes an AI mis-categorization, and on the next boot the classifier "fixes" it back. CLAUDE.md principle 9 (Classifier output is editable; user override is permanent) was added in response.

**Rule (AIProd / Universal).** Any AI-derived attribute the user can edit needs a "I meant this" flag that protects the user's edit from future re-classification.

**Go deeper.** Search "human-in-the-loop ML" for the formal framing. The principle generalizes to any automated mutation that competes with manual edits (autoformatter respecting `// prettier-ignore`, etc.).

---

### 25. Concurrency cap on expensive LLM calls

**What.** Cap how many in-flight LLM calls a single client can have at once. Prevents both runaway cost and the "10 spinners at once" UI.

**Where.** [src/services/todos/expand.ts:25](../src/services/todos/expand.ts#L25) — `MAX_CONCURRENT = 3`. [src/services/todos/expand.ts:212-214](../src/services/todos/expand.ts#L212-L214) — `if (_inFlight.size >= MAX_CONCURRENT) return { ok: false, reason: 'in-flight-cap' }`.

**Why.** Each expansion costs ~$0.04-0.05 and takes 5-15s. Without a cap, a user could tap 20 `[expand]` buttons and stack $1+ of pending work.

**Rule (AIProd).** Always cap concurrency on metered API calls. Surface the cap in the UI (`ExpandResult.reason: 'in-flight-cap'` translates to a clear message).

**Go deeper.** Read about "bulkhead" pattern and "circuit breakers" (Hystrix, etc.). The same impulse at API-gateway scale.

---

### 26. Manual-only AI mutation (no silent writes)

**What.** Expensive or destructive AI operations are *never* triggered by a save or a refresh. They require an explicit user tap. The cheap classifier *can* run on save (it's cheap and additive); the expensive expander *cannot*.

**Where.** [src/services/todos/expand.ts](../src/services/todos/expand.ts) — only called from a user-visible button on `/todos/[id]` or via `re-expand` confirm Alert. Contrast with [src/services/todos/classify.ts](../src/services/todos/classify.ts) which runs on commit and on boot catch-up.

**Why.** A save path that silently calls the LLM is a save path that silently spends money and adds latency. Worse, it's hard to audit. Manual triggers make every expansion an event the user *chose*.

**Rule (AIProd / Universal).** Reserve "automatic" AI behavior for cheap, additive operations. Make destructive or expensive operations explicit user actions.

**Go deeper.** Look at how GitHub Copilot vs. Claude Code differ on automatic vs. user-confirmed code changes. Both are valid; the choice signals what kind of product you're building.

---

### 27. Memory-bank caching of LLM output

**What.** LLM responses are cached in dedicated tables (`ai_summaries`, `expanded_md`) keyed to their inputs. The next time the same input is requested, you hit the cache, not the API.

**Where.** [src/services/database.ts:136-143](../src/services/database.ts#L136-L143) — `ai_summaries` table (date PK + summary_json). [src/services/ai/summarize.ts](../src/services/ai/summarize.ts) — checks cache before calling. `todo_meta.expanded_md` serves the same role for per-todo expansions.

**Why.** The vlog editor used to regenerate the daily summary every time a clip changed. Caching makes the LLM call a one-time event per day; subsequent calls just read SQLite.

**Rule (AIProd).** Cache LLM outputs aggressively. Key by *input shape* (date, hash of prompt, etc.). Invalidate explicitly on user action ("regenerate" button), not on every UI render.

**Go deeper.** Read about "LangChain cache" and "Anthropic prompt caching" — same concept at different layers (your-cache vs. their-cache).

---

### 28. Schema-gap tolerance (backwards-compat mapper)

**What.** A mapper between local data and an external schema (Notion DB) that *gracefully degrades* when the external schema is missing properties. Callers pass a Set of available property names; the mapper skips writes for absent ones and treats absent reads as nulls.

**Where.** [src/services/notion/todosMapper.ts](../src/services/notion/todosMapper.ts) — `detectMissingTodoProperties()` (line ~100) inspects schema; `todoToNotionProperties()` accepts an `availableProperties: Set<string>` parameter and `has(name)` guards each write.

**Why.** When buffr added the five Phase-D properties (Type / Expanded / Model / Confidence / User Overridden), existing users had Notion DBs without them. Sync still works — the new fields are simply skipped, and `result.debug` lists them so the UI can prompt for the schema upgrade.

**Rule (Code).** When you depend on an external schema you don't fully control, design for the version skew. "Missing column" should be a non-fatal degraded mode, not a crash.

**Go deeper.** Read about "tolerant reader" pattern (Postel's law applied to data formats). Look at how protobuf handles unknown fields.

---

### 29. Last-edit-wins with field-level merge rules

**What.** When two systems can both edit the same record (buffr ↔ Notion), conflict resolution can't be a single rule. Each field gets its own policy: prose-canonical (Notion edits dropped), bidirectional (last-edited-time wins), pull-down (Notion is read-canonical when local is empty), etc.

**Where.** [src/services/notion/sync.ts](../src/services/notion/sync.ts) `pullTodos` — the matched-row merge has explicit per-field rules. `text` is prose-canonical (skipped). `done` and `done_at` use last-edited-time. `type` pull-down sets `userOverriddenType=1`. `expanded_md` only pulls when local is empty.

**Why.** A blanket "Notion wins" or "local wins" rule destroys data on the other side. Different fields have different semantics — title comes from prose (canonical local), but checkbox toggles can come from either side.

**Rule (Sys).** When two systems share a record, write the merge policy down per-field. The total policy is rarely uniform.

**Go deeper.** Read about CRDTs (Yjs, Automerge). Read about "Conflict-Free Replicated Data Types" — each data type has its own merge function. Same intuition.

---

### 30. Drops idiom — DSL embedded in prose

**What.** A small set of inline markers (`[]`, `**`, etc.) in free-form text gets parsed at commit time into typed records. The text stays valid prose; the markers are syntactic sugar that double as visual cues.

**Where.** Whole feature: [src/services/todos/scanTodos.ts](../src/services/todos/scanTodos.ts) for `[]`, [src/services/nutrition/scanNutrition.ts](../src/services/nutrition/scanNutrition.ts) for `**`. UI side: [src/components/journal/InlineTextInput.tsx](../src/components/journal/InlineTextInput.tsx) just displays raw text — the parsing is invisible.

**Why.** The journal stays prose-first; the user writes naturally. But a `[]` line is also a structured todo. Capture is filing — no separate "log this" UI step.

**Rule.** A tiny DSL embedded in a richer surface can give you structured data without forcing the user into a structured editor. The trick is making the markers feel like punctuation, not syntax.

**Go deeper.** Look at Roam Research's `[[backlinks]]`, Obsidian's `#tags`, Notion's `/slash commands`. Each is a different point on the prose↔structure spectrum. Read [buffr-drops-summary.md](../buffr-drops-summary.md) — the user-facing pitch for this feature.

---

### 31. Spec-driven dev with phased plans

**What.** Before building, write the spec (what does it do?) and a plan (how do we ship it?). The plan slices the spec into phases that ship independently. Each phase has its own scope estimate, success criteria, and explicit non-goals.

**Where.** [docs/spec.md](./spec.md) is the living spec; [docs/drops-plan.md](./drops-plan.md) and [docs/thinking-modes-plan.md](./thinking-modes-plan.md) are phased plans. The thinking-modes feature shipped in 4 phases (foundation → classifier → expansion → Notion sync), each independently shippable.

**Why.** The thinking-modes spec was 33-50h estimated as a monolith. Phased: ~12-15h Phase A, then optionally Phase B, etc. After Phase A you have a real feature, not a sandbox.

**Rule (Universal).** Big features die in long branches. Split by *value-delivery slice*, not by *layer*. Phase A should be useful on its own.

**Go deeper.** Read Joel Spolsky's "Painless Functional Specifications." Then read about "vertical slicing" in agile literature.

---

## Curriculum — ordered learning path

Read or build through these in order. Each block depends on the prior; difficulty rises gradually.

### Week 1 — Foundations (concepts 1-8)

You're learning *how the codebase is shaped*. Read every concept in the order listed. Implement (or trace) one of these in a side project to internalize:

- A SQLite-backed todo list with `CREATE TABLE IF NOT EXISTS` + `addColumn` migration helper (concept 6)
- A two-layer service with pure parsers and async orchestrators (concept 5)
- Strict TS with at least one discriminated union (concept 4)

**Prerequisites:** familiarity with TypeScript, async/await, basic SQL.

### Week 2 — Stateful sync (concepts 9-17)

You're learning *how to keep two stores aligned*. The mental shift here: prefer eventual consistency + idempotency over global locks. Build:

- A markdown editor where headings auto-extract into a sidebar TOC (concept 9 — two-pass matching by heading text + position)
- A "favorites" feature where favoriting from a card view round-trips into a "starred" prefix in the source markdown (concept 10)
- A reconcile loop for an external API (concept 11)

**Prerequisites:** Week 1.

### Week 3 — AI integration (concepts 18-23)

You're learning *how to make LLMs into reliable building blocks*. The mental shift: LLMs are unreliable APIs that need wrapping (validation, retry, caps, cost tiers). Build:

- A multi-provider chat wrapper that picks Haiku/Sonnet by per-call config (concept 18, 20)
- A heuristic-first sentiment classifier with LLM fallback (concept 19)
- A JSON-output extractor with Zod validation + one-shot retry (concept 21)

**Prerequisites:** Week 2 + an Anthropic and/or OpenAI API key.

### Week 4 — AI product polish (concepts 24-27, 30)

You're learning *how to ship an AI product, not a demo*. The mental shift: cost, latency, and user trust are first-class concerns. Build:

- An "expand this" feature that requires explicit user confirmation, caches output, and respects user overrides (concepts 24, 26, 27)
- A small DSL embedded in a textarea that compiles to structured records (concept 30)

**Prerequisites:** Week 3.

### Week 5 — Sync & spec discipline (concepts 28, 29, 31)

You're learning *how to handle the messy real world*. Two systems that share state, missing schemas, and feature plans that span weeks. Build:

- A two-way sync with another note app (Notion, Linear, Things) that handles missing fields (concept 28) and field-level merge rules (concept 29)
- Write a spec + 4-phase plan for any new feature you've been putting off; ship Phase A first (concept 31)

**Prerequisites:** Week 4.

---

## What buffr doesn't yet teach you

Concepts that are *partially* implemented or deliberately deferred — completing them in your own learning would deepen the picture:

- **Tool use / function calling.** buffr uses LLMs for classification and structured generation, but never lets the LLM call back into the app's APIs. Building a feature where the LLM invokes a tool ("schedule this todo for next Monday") would teach you the agentic pattern at the next level.
- **Streaming responses.** All LLM calls are awaited as full responses. Streaming would teach you how to handle partial JSON, surface progress in the UI, and cancel mid-flight.
- **Evaluation harnesses.** There's no automated eval suite for the heuristic classifier or the expansion outputs. Building a fixture-based evaluator with a "golden dataset" would teach you how to track LLM regressions.
- **Multi-agent orchestration.** Each LLM call is a single round trip. A "research → outline → draft → review" multi-step agent flow would teach you state machines and `ReAct` loops.
- **Migrations with downtime.** All schema migrations here are forward-compatible. Building a rename-a-column-with-zero-downtime migration in any DB would teach you the trickier real-world cases.

Each of these is a natural extension. Pick one when you're ready.
