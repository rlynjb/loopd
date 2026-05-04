# Chapter 05 — Language-agnostic patterns

The patterns in this chapter are not about TypeScript, React Native, SQLite, or Anthropic's API. They are mental models that show up in this codebase but transfer to any language and any stack. Read this chapter as the **interview-portable** distillation — the principles you can defend on a whiteboard without naming a single library.

---

## 5.1 Functional core, imperative shell · `foundational`

**What it is.** Push business logic into pure functions that take inputs and return outputs. Concentrate I/O (database, network, files, time) at the edges. Result: most of the code is testable by inspection; only the thin shell needs integration tests.

**Where it lives in this codebase.**
- Pure cores: `src/services/sync/conflict.ts`, `src/services/threads/staleness.ts`, `src/services/habits/cadence.ts`, `src/services/todos/heuristicClassify.ts`, `src/services/todos/scanTodos.ts`, `src/services/todos/rank.ts`.
- Imperative shells: `src/services/database.ts`, the table adapters in `src/services/sync/tables/`, the I/O paths in `src/services/todos/crud.ts`.
- Each pure file has a header comment naming its purity (e.g., `cadence.ts:3` — *"Pure cadence engine. No DB reads, no side effects."*).

**Why it transfers.** Independent of language. Gary Bernhardt named the pattern; it's been the canonical Haskell guidance for decades, and it works equally well in Python, Go, Rust, Ruby, C#. The same code looks the same everywhere because the *shape* is what matters, not the syntax.

**General rule.** When you write a new feature, ask: "what's the pure compute?" and put it in its own file. Then ask: "what's the I/O?" and put it in the shell. The pure compute is reusable, swappable, and testable; the shell is the part you tolerate.

---

## 5.2 Source of truth + derived projections · `foundational`

**What it is.** One place owns the truth; every other surface is a deterministic projection of it. Mutations always go to the source. Projections are rebuilt as needed.

**Where it lives in this codebase.** Prose owns todos / nutrition / mentions; `todos_json` / `nutrition` table / `thread_mentions` are projections. The dashboard's todo toggle round-trips back into prose so the source-of-truth invariant survives interaction.

**Why it transfers.** Identical pattern in: Redux (state is SoT, components are projections), database denormalization (tables are SoT, materialized views are projections), build systems (source files are SoT, build artifacts are projections), git (commits are SoT, the working tree is a projection). When you can name the SoT in one sentence, you have the design right.

**General rule.** Pick one SoT per fact. Write down what it is. Make every other surface a projection. Whenever a user action mutates a derived value, mutate the source instead.

---

## 5.3 Two-pass alignment for record identity through edits · `intermediate`

**What it is.** Reconcile parsed records against existing records in two passes: content-key first (catches reorderings), position-key second (catches in-place edits). Identity (IDs, timestamps, downstream metadata) survives.

**Where it lives in this codebase.** `src/services/todos/scanTodos.ts:62-89`, `src/services/threads/scanThreads.ts:179-206`.

**Why it transfers.** Any system that derives records from a free-form document needs this. Examples beyond this codebase:
- Markdown-to-JSON converters that need to track block IDs across edits (Notion, Obsidian).
- DOM diffing in virtual-DOM libraries (React's reconciliation is a sophisticated cousin).
- Source-map generation in compilers.
- Spreadsheet cell renames preserving formula references.

**General rule.** The two-pass pattern is the cheap, dependency-free version of true diff. When n is small (< a few hundred), it's the right tool. When n is large or you need a minimal edit script, reach for Myers diff or LCS algorithms.

---

## 5.4 Last-write-wins as default conflict resolution · `intermediate`

**What it is.** When two writes collide, the one with the larger timestamp wins. Pure function, no I/O, no library required. Honest about its limits (same-second ties degenerate; collaborative edits need stronger semantics).

**Where it lives in this codebase.** `src/services/sync/conflict.ts:13-31`.

**Why it transfers.** LWW is the default in: DynamoDB (last-write-wins by default), Cassandra (timestamps decide), CRDTs use LWW for register types, most caching systems. The 18-line implementation here is *the* canonical reference shape — you'll see it again everywhere.

**General rule.** Pick the simplest conflict resolution your data model can tolerate, document its limits, and design upgrades only when the limits bite. LWW is the floor; most apps live there happily.

---

## 5.5 Soft delete with tombstones · `intermediate`

**What it is.** Deletes don't remove rows; they stamp `deleted_at`. Reads filter on `deleted_at IS NULL`. Tombstones propagate through the system as ordinary updates so other replicas can converge.

**Where it lives in this codebase.** `docs/spec.md:343` and across all sync code.

**Why it transfers.** Required for any sync layer with LWW (the previous concept). Used in: every distributed database (Cassandra calls them tombstones explicitly), Linear / Notion (undo stack relies on it), event-sourced systems. The vacuum policy is a separate, deferred decision.

**General rule.** If you sync, you soft-delete. Without tombstones, deletes get "lost in time" against concurrent edits.

---

## 5.6 Idempotent operations as a safety property · `foundational`

**What it is.** An operation that can be safely run more than once with the same effect as running it once. Migrations use SecureStore flags to enforce idempotency at the operation level. Sync push uses upserts (`ON CONFLICT … DO UPDATE`) to enforce it at the row level.

**Where it lives in this codebase.**
- Migration idempotency: `docs/spec.md:74-79` (the SecureStore flag list).
- Upsert idempotency: `src/services/sync/push.ts:31-35` (`upsert(..., { onConflict: ... })`).
- Bootstrap idempotency: `src/services/sync/bootstrap.ts:18-34`.

**Why it transfers.** Idempotency is a universal safety property. It shows up in: HTTP semantics (PUT/DELETE are idempotent, POST isn't), retry logic (idempotent operations are safe to retry), cron jobs, deployment pipelines, queue consumers (at-least-once delivery requires idempotent handlers).

**General rule.** Operations safe to retry are easier to reason about, debug, and recover from. When you write a job, a migration, a sync operation — ask "what if this runs twice?" and design for it.

---

## 5.7 Provider abstraction (abstract what changes) · `foundational`

**What it is.** Identify the moving parts of a system (here: which AI provider) and wrap them behind a stable interface. Code outside the wrapper doesn't know which provider is in use.

**Where it lives in this codebase.** `src/services/ai/config.ts` + the per-provider call functions in each AI service file. Also `src/services/sync/types.ts:11-59` (the `SyncableTable` interface abstracts what differs across the 10 synced tables).

**Why it transfers.** This is the strategy pattern, the dependency-injection pattern, the gang-of-four "program to an interface, not an implementation" rule. It shows up in every codebase ever written. The discipline of *where* to put the seam is the skill — too granular and you have a maze of interfaces; too coarse and you can't swap.

**General rule.** Abstract what changes; stabilize what doesn't. The right test: imagine the third provider arriving. If the abstraction holds with one new file and zero changes elsewhere, the seam is in the right place.

---

## 5.8 Heuristic-before-LLM (cheap path before expensive path) · `foundational`

**What it is.** Try the deterministic / cheap solution first. Fall through to the expensive solution only when the cheap one is uncertain. Generalizes beyond AI: cache before DB, in-memory before network, regex before parser.

**Where it lives in this codebase.** `src/services/todos/heuristicClassify.ts` + `classify.ts`.

**Why it transfers.** Universal optimization pattern. Examples: CDN edge caching, branch prediction in CPUs, memoization, the `if cached return cached` pattern, lazy loading. The framing for AI specifically — "deterministic prefilter before model call" — is becoming a named pattern in the LLM-eng community.

**General rule.** When you have multiple solutions with different cost/quality tradeoffs, run them in cost order and short-circuit on confidence. The cheap path catches the easy cases for free; the expensive path handles only the residual.

---

## 5.9 Debounce as the default for write-heavy interactivity · `intermediate`

**What it is.** Don't fire side effects on every event; coalesce a burst of events into one delayed call. Reset the timer on each new event so the call fires `N` ms after the *last* event in the burst.

**Where it lives in this codebase.** `src/services/sync/schedulePush.ts:14-20` (5-second push debounce). The DB autosave is the *opposite* — write immediately on every keystroke (per principle 3, `docs/spec.md:454`) — because the local-first invariant requires it. Debounce is for *fan-out* (network, expensive compute), not for the local primary store.

**Why it transfers.** Every UI library has it (`lodash.debounce`, `useDebouncedCallback`, RxJS `debounceTime`). Every backend system has it (job queues, push notification batching, log flushing). The asymmetry — local writes immediate, remote writes debounced — is the model worth carrying.

**General rule.** Debounce *outbound* side effects. Don't debounce *inbound* state — that introduces user-visible lag. The 5-second value here is a tunable; pick by measuring how often the user would re-edit within the window.

---

## 5.10 Discriminated unions for closed-world modeling · `foundational`

**What it is.** When a value can be one of N variants with different payloads, model it as a tagged union with exhaustive handling. The compiler refuses to compile when a new variant is added until all handlers are updated.

**Where it lives in this codebase.** `TodoExpansion`, `ExpandResult`, `BootstrapDecision`, `Staleness`, `CadenceType`, `ClassifierConfidence`, `TodoType`, `TimeOfDay`.

**Why it transfers.** Algebraic data types in functional languages (Haskell, OCaml, F#, Rust enums, Swift enums, Scala sealed traits). TypeScript discriminated unions are the JavaScript-flavored version. Exhaustiveness-checking is the killer feature — adding a variant becomes a refactoring conversation with the compiler instead of a hunt for missed call sites.

**General rule.** When you find yourself reaching for a string field with a comment listing valid values, reach for a discriminated union instead. The compiler will pay you back tenfold over the lifetime of the code.

---

## 5.11 N+1 collapse via per-metric aggregation · `intermediate`

**What it is.** Replace per-row queries with per-metric queries (one `GROUP BY` per metric), then join in code. Big-O drops from `O(n × m)` to `O(n + m)`.

**Where it lives in this codebase.** `src/services/threads/getThreadCards.ts`.

**Why it transfers.** N+1 is the most common database performance bug, period. Every ORM has docs about it. The aggregator pattern is the manual fix; ORMs offer their own (`includes`, `eager_load`, `prefetch_related`). Either way, the principle is "push aggregation as close to the data as you can" and "avoid issuing one query per row."

**General rule.** When a list view needs N metrics per row, write N queries (each grouped) instead of N×M queries. Build hash maps on the client and merge.

---

## 5.12 Sliding window over time-bucketed data · `intermediate`

**What it is.** A fixed-size window over the most recent K time units. Compute boundaries once, build a lookup structure (set or map) keyed on the bucket (date), then iterate cells with `O(1)` lookup per cell.

**Where it lives in this codebase.** The 14-day activity strip in `src/services/threads/getThreadCards.ts:32-52`. The habit heatmap follows the same shape.

**Why it transfers.** Every analytics system has this: 7-day rolling average, 30-day active users, heatmaps in commit graphs (GitHub, GitLab), Apple Health activity rings. The pattern generalizes: pre-compute the lookup structure outside the loop; render cells in `O(1)`.

**General rule.** Heatmaps and time-series UIs need pre-computed lookup structures. Don't search per cell. Build a `Map<date, value>` once, render N cells in linear time.

---

## 5.13 Spec-driven development · `intermediate`

**What it is.** Write the spec before the code. The spec captures behavior (forbidden patterns, edge cases, fallback) in plain language; the code implements it. The spec stays canonical when the code drifts.

**Where it lives in this codebase.** Every feature has a spec in `docs/`. The relatable-caption feature is the cleanest example: `docs/relatable-caption-spec.md` → `src/services/ai/caption.ts`. The architectural principles (`docs/spec.md:451-465`) are themselves a kind of meta-spec.

**Why it transfers.** RFCs at IETF. Design docs at Google. ADRs (architecture decision records). The principle is older than software: write down what you mean before you build it. For AI features specifically, a spec lets you tune the prompt without losing track of what "correct" means.

**General rule.** For any feature with non-obvious behavior, write a one-page spec before the first line of code. Refer back to it when reviewing PRs. Update it when behavior changes — drift between spec and code is a bug.

---

## 5.14 Documented deviation as a first-class artifact · `intermediate`

**What it is.** When a feature breaks one of the architectural rules, the deviation is documented at every layer (spec, principle, code comment). Pretending the rule is universal would force someone to discover the exception by surprise.

**Where it lives in this codebase.** The manual-touch toggle for threads (`src/services/threads/touch.ts:7-16`, `docs/spec.md:302`, `docs/spec.md:462`).

**Why it transfers.** Every system has exceptions. Every codebase has a "this looks wrong but here's why it's right" that future-you will misread. The fix is to write it down at multiple layers so future-you can't avoid seeing it.

**General rule.** When you bend a rule, write it down at the rule and at the code site. Deviation comments are an asset; missing ones are landmines.

---

## 5.15 Read DB before destructive action · `foundational`

**What it is.** Destructive operations re-read state instead of trusting an in-memory snapshot. Closures and refs go stale; the DB is the truth at the moment of action.

**Where it lives in this codebase.** Principle 4 in `docs/spec.md:455`. Lives in every cleanup effect that decides to delete an entry — checking the latest text from the DB instead of the captured `state.text`.

**Why it transfers.** This is the read-modify-write pattern from concurrency primitives. SQL `SELECT ... FOR UPDATE`. Compare-and-swap. Optimistic locking. The principle is "destructive operations close the read-decide gap by re-reading at decide-time."

**General rule.** Destructive code always re-reads. Reads-that-don't-matter-if-stale can use closures. Reads-that-are-the-basis-for-deletion cannot.

---

## 5.16 One prompt, one job (chain instead of cram) · `intermediate`

**What it is.** Break complex AI workflows into multiple single-purpose calls. Each prompt focuses on one objective, has one output schema, and can be evaluated in isolation.

**Where it lives in this codebase.** Summarize → caption (`src/services/ai/summarize.ts:42-104`). Classify → expand (`src/services/todos/classify.ts` → `expand.ts`).

**Why it transfers.** This is the Unix philosophy applied to LLM calls. Same reason `grep` does one thing well and you pipe it to `wc -l`: composition beats omnibus. The cost (multiple model calls) is usually less than the cost of one giant prompt that has to balance multiple objectives.

**General rule.** When a prompt starts juggling multiple objectives, split it into two prompts and chain them. Easier to debug, easier to evaluate, easier to swap one half independently.
