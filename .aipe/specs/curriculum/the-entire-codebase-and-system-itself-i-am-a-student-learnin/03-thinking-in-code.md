# 03 — Thinking in code

This chapter is about how the code is *written*, not what it *does*. The patterns here are the small-scale habits that distinguish "code that compiles" from "code you can extend in 18 months without re-learning everything."

loopd is in strict TypeScript with no test suite — that combination puts a lot of weight on **the type system as the verification layer**. Many of the patterns below exist because TypeScript catches a class of bugs at compile time that tests would otherwise have to catch at runtime.

---

## 3.1 Type-driven design (let the types tell you what's possible)

**Difficulty:** foundational

**What it is.** A discipline where you design the **types first**, then write the implementation that satisfies them. The types become a contract — if the compiler accepts the implementation, you've ruled out a whole class of mistakes structurally.

**Where it lives.** Look at the shape of `src/types/`:
- `entry.ts` — `Entry`, `Habit`, `Vlog`, `TodoItem`.
- `todoMeta.ts` — `TodoMeta`, `TodoType` (closed enum), `TodoStage`, `ClassifierConfidence`, six per-type expansion shapes, plus a discriminated `TodoExpansion` union.
- `thread.ts` — `Thread`, `ThreadMention`, `Staleness`, `ThreadCard` (a computed view shape).
- `ai.ts` — `AISummary`, `CaptionInput`, `CaptionOutput`, `CaptionTheme`.
- `nutrition.ts`, `project.ts`, `notion.ts` — table-shaped domain types.

These types are **not** auto-generated from the DB. They're hand-written and load-bearing — every CRUD function returns one, every UI component receives one, every AI call validates against one.

**Why it exists.** When `TodoType` is the closed enum `'todo' | 'idea' | 'bug' | 'question' | 'decision' | 'knowledge' | 'content'`, the compiler refuses to let you add an eighth value without updating every `switch` over `TodoType`. The exhaustiveness check **catches the missing case before runtime** — see `validateExpansion()` at `src/services/todos/expand.ts:83-141`, where the `switch (type)` covers all six expandable types.

**General rule.** Make illegal states **unrepresentable** in your types. Closed enums beat strings; discriminated unions beat optional fields; required fields beat defaults. Every constraint you push into the type system is a constraint you don't have to remember to enforce in code.

---

## 3.2 Discriminated unions (the `TodoExpansion` shape)

**Difficulty:** intermediate

**What it is.** A pattern where a sum type carries a tag (the *discriminant*) telling you which variant it is. The compiler narrows the type based on the tag, so each branch of a `switch` sees only the fields that variant has.

**Where it lives.** `src/types/todoMeta.ts`:

```ts
type TodoExpansion =
  | { type: 'idea';      data: IdeaExpansion }
  | { type: 'bug';       data: BugExpansion }
  | { type: 'question';  data: QuestionExpansion }
  | { type: 'decision';  data: DecisionExpansion }
  | { type: 'knowledge'; data: KnowledgeExpansion }
  | { type: 'content';   data: ContentExpansion };
```

The consumer is `serializeExpansion()` in `src/services/todos/expandSerialize.ts`, which switches on `expansion.type` and accesses the type-narrowed `data` for each branch. The producer is `validateExpansion()` in `src/services/todos/expand.ts:83-141`, which builds the right variant based on the input type.

**Why it exists.** The alternative — a single `Expansion` type with all six variants' fields as optionals — would make every consumer guess which fields are populated, and the compiler would help with none of it. Discriminated unions move that knowledge into the type system: the compiler **requires** the consumer to handle each variant, and **forbids** the consumer from accessing a field that doesn't belong to the active variant.

**General rule.** Whenever you have "several closely-related shapes that need to be processed together," reach for a discriminated union with a `type` (or `kind`, or `tag`) field. The exhaustiveness check at the call site is the payoff. If a future variant gets added, the compiler tells you exactly which switches to update.

---

## 3.3 Schema-first development (DB schema → TS types → runtime validators)

**Difficulty:** intermediate

**What it is.** A flow where the database schema is treated as the canonical shape, TypeScript types mirror it, and runtime validators enforce that data flowing in (from LLMs, from cloud sync, from JSON columns) actually matches.

**Where it lives.**
- **DB schema:** `src/services/database.ts:53-120` (and the rest of `migrate`) — the local SQLite truth. The Postgres schema lives in `supabase/migrations/0001_initial_schema.sql`.
- **TS types:** `src/types/*.ts` — hand-written to match the schema, with case conversion (snake_case columns → camelCase fields) handled by mappers in `database.ts`.
- **Runtime validators:**
  - `validateSummary()` in `src/services/ai/validate.ts` clamps clip ranges, drops unknown clip IDs, slots missing IDs at the end.
  - `validateExpansion()` in `src/services/todos/expand.ts:77-141` checks each expandable type's required fields.
  - `parseAndValidate()` in `src/services/ai/caption.ts:117-137` validates the caption JSON, clamps line counts, falls back to `'clarity'` for unknown themes.
  - The CHECK constraints on `todo_meta` (enums on `type`, `stage`, `classifier_confidence`) — DB-level validators, the strictest enforcement.

The CHECK constraints are the most interesting part: they make it **impossible** to insert a `todo_meta` row with an invalid type, even if a bug in the TS layer tried to. The DB is the last line of defense.

**Why it exists.** Three layers of validation isn't redundancy — it's defense in depth. The compiler catches the obvious mistakes; the runtime validators catch external-data mistakes (LLM output, network input); the DB CHECKs catch programmer mistakes that bypass both. Each layer fails fast and loudly, so the bug never reaches the place where it would corrupt data.

**General rule.** When data crosses a trust boundary (network, AI, user input, file format), validate at the boundary. When data is stored, enforce shape at the storage layer. When you can express a constraint in types, do — but don't *only* express it in types when something else (DB, validator) can also enforce it.

---

## 3.4 Pure functions for testability (cadence, staleness, ranking)

**Difficulty:** foundational

**What it is.** A discipline of factoring core logic into pure functions: no I/O, no side effects, no hidden state. Same input → same output, every time.

**Where it lives.** Three good examples:

- **Cadence engine** at `src/services/habits/cadence.ts:46-77` — `isDueOn(habit, date)` is a 17-line `switch` over `cadenceType`. No DB calls. Easy to test by passing a fake habit and a known date. The whole file is pure (with one ISO-week helper).

- **Staleness engine** at `src/services/threads/staleness.ts` — `computeStaleness(daysSinceLast, targetCadenceDays?)` is a pure function over numbers. Returns one of `'fresh' | 'aging' | 'stale' | 'cold'`.

- **Conflict resolver** at `src/services/sync/conflict.ts:20-31` — `chooseWinner(local, cloud)` parses two timestamps and returns the winner. No I/O. Used everywhere; trivially correct.

- **Ranker** at `src/services/todos/rank.ts:24-70` — `rankTodos(entries, options)` flattens, classifies sources, sorts. Pure.

Notice the **scanner** functions (`scanTodosFromText` at `src/services/todos/scanTodos.ts:53-125`) are **also pure** — they take text + existing array and return the new array, no DB writes inside. The DB write happens at the call site.

**Why it exists.** Loopd has no automated test suite. That makes purity even more important — pure functions can be reasoned about without running them. The cadence engine is correct because you can read 17 lines and convince yourself; the conflict resolver is correct because you can enumerate the four cases (newer-local / newer-cloud / equal-timestamps / parse-failure) and check each.

**General rule.** Push side effects outward; pull pure logic inward. Every function that doesn't need to do I/O shouldn't. The result is a set of pure islands you can reason about independently, surrounded by a thin shell of effectful glue code.

---

## 3.5 Orchestration via custom hooks (`useEntries`, `useDatabase`)

**Difficulty:** intermediate

**What it is.** Custom React hooks that encapsulate the orchestration of effects + state + DB calls for a particular domain, exposing a narrow API to components.

**Where it lives.** `src/hooks/useEntries.ts` (referenced from `app/journal/[date].tsx`):
- Owns the entry editor's state.
- Calls `scanTodosFromText`, `reconcileTodoMetaForEntry`, `scanNutritionForEntry`, `scanThreadsForEntry` at commit time.
- Exposes `editEntry(id, text)` to the component.

The component **doesn't know** which scanners exist. It calls `editEntry`, gets fresh data back, renders. New scanners can be added by editing the hook; the component stays unchanged.

**Why it exists.** A React component should describe what it renders, not orchestrate the back-end of an entry commit. Hooking encapsulates the orchestration so the component stays simple and the orchestration becomes its own testable unit (or, in loopd's case, its own debuggable unit). This also makes the **commit lifecycle** a single place to read — adding a new scanner means updating one function, not auditing every screen that edits text.

**General rule.** Components should consume data and submit user intent. They should not orchestrate. Push orchestration into hooks (or services, depending on the framework). When in doubt: if a component imports more than three services, suspect it's doing orchestration that belongs elsewhere.

---

## 3.6 Fire-and-forget for non-blocking side effects

**Difficulty:** intermediate

**What it is.** A pattern where a side-effectful call is intentionally **not** awaited at the call site, so the foreground operation completes immediately while the side effect runs in the background.

**Where it lives.** Three places in the entry-commit flow (per `docs/spec.md` §4):

```ts
// In useEntries.editEntry (paraphrased):
await saveEntry(id, text);              // canonical write — must complete
reconcileTodoMetaForEntry(entry);       // fire-and-forget
scanNutritionForEntry(entry);           // fire-and-forget
scanThreadsForEntry(entry);             // fire-and-forget
```

The reconciler at `src/services/todos/reconcileMeta.ts:48-91` swallows its own errors with a `console.warn` so a fire-and-forget caller can't be hurt.

The classifier-on-commit pattern at `reconcileMeta.ts:13-28` is the same idea one layer down: `classifyTodo()` is **not** awaited; the caller schedules it and returns.

**Why it exists.** The user types a `[]` line. The DB write must complete before the editor confirms the save. But the LLM classifier is going to take 500–2000ms and the user shouldn't have to wait. Fire-and-forget keeps the foreground latency tight; the side effect updates the row when it lands.

**The discipline:** fire-and-forget functions must (a) handle their own errors (no unhandled rejections), (b) be idempotent (the next commit re-runs them safely), and (c) write to a place the UI can observe (the DB) so the user sees the result when it arrives.

**General rule.** Foreground latency matters more than completeness. If a side effect can converge later without breaking anything, fire-and-forget. Just be sure you've handled errors and made it idempotent — otherwise you're shipping a silent footgun.

---

## 3.7 Optimistic updates (round-trip via prose rewrite)

**Difficulty:** intermediate

**What it is.** A pattern where the UI updates immediately (assuming the operation will succeed), and the underlying data eventually catches up. If the operation fails, the UI rolls back.

**Where it lives.** Toggling a todo's done state on the dashboard:

1. User taps the checkbox in `SmartTodoList`.
2. `updateTodo()` in `src/services/todos/crud.ts` runs `rewriteTodoLine()` (`scanTodos.ts:139-181`) on the entry's prose, flipping `[]` → `[x]`.
3. The new prose is saved to the DB.
4. The UI re-reads (or receives the updated entry as a prop) and shows the new state.

The "optimism" here is that the prose rewrite always works on a well-formed entry. The fallback (text-match scan when `sourceLine` is unset) at `scanTodos.ts:155-165` handles pre-migration entries gracefully — if the line can't be found, the original text is returned unchanged, and the toggle silently fails. That's a deliberate trade: **the worst case is a no-op, never a corruption**.

**Why it exists.** Without optimistic updates, the UI would have to wait for the DB write (cheap, ~5ms on SQLite) before showing the new state. That's fast enough that the optimism barely matters here — but the discipline of "compute the new state in code, write it once, render from the write" is the same. In a cloud-first app where the round-trip could be 200ms, optimistic updates are the only way to feel responsive.

**General rule.** When you can compute the new state locally, do — and render from the local computation, not from the round-trip. Just be sure the failure mode is a no-op (or a visible error), not silent corruption.

---

## 3.8 Lazy loading + module-scope singletons

**Difficulty:** intermediate

**What it is.** A pattern where an expensive resource (a DB connection, an API client) is created once and reused. Lazy: created only on first access, not at import time.

**Where it lives.**
- `getDatabase()` at `src/services/database.ts:8-16` — a module-level `db: SQLite.SQLiteDatabase | null = null` that's opened on first call and reused thereafter. `migrate(db)` runs only once.
- `getSupabase()` (in `src/services/sync/client.ts`) — same pattern for the Supabase client. Returns `null` if cloud isn't configured (env vars missing), so callers can short-circuit.

**Why it exists.** Three reasons:
1. **Speed.** Opening a SQLite database is cheap but not free. Doing it once at first access is cheaper than at every call.
2. **Concurrency.** Multiple `getDatabase()` callers all get the *same* instance — there's no chance of two parallel migrations or two open connections fighting.
3. **Safe initialization order.** If you opened the DB at module-import time, you'd run before React Native's filesystem APIs are ready. Lazy-on-first-access defers initialization to a safe moment.

**General rule.** For module-scope singletons (DB connections, HTTP clients, ML model loaders), use the lazy-init pattern: a module-level `let instance: T | null = null`, with a `get()` function that returns or creates. Cheap to write, structurally race-safe inside a single thread, easy to reason about.

---

## 3.9 Discriminated result types (`{ ok: true, ... } | { ok: false, reason: ... }`)

**Difficulty:** intermediate

**What it is.** A pattern where a function that can fail in multiple ways returns a typed result with a tag. Callers `switch` on the tag and handle each failure mode explicitly. No exceptions for expected failures.

**Where it lives.**
- `expandTodo()` returns `ExpandResult` at `src/services/todos/expand.ts:201-203`:
  ```ts
  type ExpandResult =
    | { ok: true; expandedMd: string; model: string }
    | { ok: false; reason: 'no-ai' | 'in-flight-cap' | 'wrong-type' | 'malformed' | 'network' | 'not-found'; message?: string };
  ```
- `createThread()` returns `CreateResult` (in `src/services/threads/crud.ts`) with `'slug-taken' | 'empty-name'` as named failure modes.
- `bootstrapCloudSync()` returns `BootstrapDecision` (`src/services/sync/bootstrap.ts:20-25`) — five distinct cases with attached data.
- `chooseWinner()` returns `'local' | 'cloud' | 'tie'` — even simple tag-only results follow the pattern.

**Why it exists.** Exceptions are great for *unexpected* failures (network died mid-call) and bad for *expected* ones (the slug is taken; the user has no AI configured). When failure is a normal branch of the program, the type system should know about it — and the call site should handle each branch. Result types enforce that discipline.

You see the consequence at the call sites: the UI for the expand button can show a different message for each `reason` because the type narrows it. With exceptions, the UI would have to string-match error messages or guess.

**General rule.** Throw for unexpected; return for expected. When a function has more than one way to fail and the caller cares which, return a discriminated union and let the compiler enforce that the caller handles every case.

---

## 3.10 Event bus for cross-component progress signals

**Difficulty:** intermediate

**What it is.** A tiny pub/sub layer that lets non-UI code (a service in the middle of a long-running async task) signal UI code (a banner that wants to show progress) without either side knowing the other exists.

**Where it lives.** `src/utils/events.ts` (the `emit` function imported in `src/services/todos/classify.ts:2`). Used by:
- `CLASSIFY_PROGRESS_EVENT` — bumped/decremented around `classifyTodo()` calls (`classify.ts:97, 118`). Subscribed by the `/todos` toast.
- `EXPAND_PROGRESS_EVENT` — same pattern around `expandTodo()` (`expand.ts:225, 264`). Subscribed by `app/todos/[id].tsx` so cross-screen completions surface.

**Why it exists.** Without an event bus, the UI would have to either (a) poll a shared module-level counter on a timer, or (b) thread a callback through every layer of the call. The bus removes that coupling — services emit, components subscribe, neither knows about the other.

It's a tiny abstraction (likely 30 lines of `EventEmitter`-like code), and it scales naturally: a fourth event needs a new constant and that's it.

**General rule.** When you need to broadcast a "something happened" signal across the app, use a bus. Don't pass callbacks through five layers; don't poll module-level counters. The bus is the right shape: emit-side stays small, subscribe-side stays small, neither side imports the other.

---

## 3.11 Stable sort orders + tiebreakers

**Difficulty:** intermediate

**What it is.** A discipline of always specifying a complete, deterministic sort order — including tiebreakers — so the UI never re-orders items between renders for no reason.

**Where it lives.**
- `rankTodos()` at `src/services/todos/rank.ts:55-67` — sorts by `done` (false first), then `source` priority, then `effectiveCreatedAt` (oldest first). Three keys, in order. Always converges.
- The sync orchestrator at `src/services/sync/orchestrator.ts:43, 66` — sorts the registry by `pushOrder` and `pullOrder` independently. Each table specifies its own integer; the comparator is stable.
- The `position`-based reorder pattern at `src/services/todos/reorder.ts` — once any todo is reordered, every row gets a dense integer, and the sort flips from `createdAt`-DESC to `position`-ASC.

**Why it exists.** Sort instability is a common bug source — items shifting between renders feel buggy and break user mental models. A complete sort with tiebreakers makes the order **deterministic**: same data → same order, every time.

The `position` flip is particularly clever: it lets the system stay simple (`createdAt`-DESC by default) until the user expresses a preference, at which point the schema gains a new ordering signal. **Lazy schema enrichment** — the field exists from day one, but it's `NULL` until needed.

**General rule.** Specify a full sort order. If your primary key has ties, name a tiebreaker. If your tiebreaker has ties, name another one. Stop only when the sort is fully deterministic. UIs that re-order items between renders feel broken; UIs that respect a stable order feel solid.

---

## 3.12 Defensive parsing of JSON columns

**Difficulty:** intermediate

**What it is.** SQLite has no JSON type — `habits_json`, `clips_json`, `todos_json` are stored as TEXT. The DB layer parses on read and stringifies on write, with try/catch on the parse to handle corruption gracefully.

**Where it lives.**
- `safeJson()` in `src/services/sync/tables/entries.ts:45-52`:
  ```ts
  function safeJson(s: string | null): unknown {
    if (s == null || s === '') return null;
    try { return JSON.parse(s); }
    catch { return null; }
  }
  ```
- `repairBareClipUris()` at `src/services/database.ts:21-51` — a recovery routine for an old data-corruption bug where Notion sync overwrote full clip paths with bare filenames. Re-resolves them against the canonical clips dir on every DB open.

**Why it exists.** JSON-in-TEXT is fragile. A corrupted column (from a bug, an interrupted write, a migration mistake) shouldn't crash the whole app. Returning `null` on parse failure lets the caller treat it as "no data" rather than throwing — the worst case is a one-off blank cell, not a crashed render.

The repair routine is the next level: when a known corruption pattern is detected, fix it on the spot. It runs once on every DB open, is cheap (only scans entries with non-empty `clips_json`), and only writes when changes are needed.

**General rule.** Treat JSON-in-TEXT as untrusted input even when you're the only writer. Wrap parses in try/catch; return safe defaults on failure; if you've ever had a corruption bug, write a one-time repair pass that runs on boot. The repair pass is cheap insurance.

---

## 3.13 What the type system isn't doing yet (and why)

This codebase is in **strict TypeScript** with `npx tsc --noEmit` as the only automated check (per `.aipe/project/rules.md`). It does **not** use:

- **Branded types / nominal types.** A `string` that's actually a "todoId" is just a `string`. There's no `type TodoId = string & { __brand: 'TodoId' }`. This means the compiler won't catch passing a `userId` where a `todoId` is expected. The codebase compensates with naming conventions; in a higher-stakes domain you'd want branded types.
- **Runtime validators like Zod.** Validation is hand-written (`validateExpansion`, `validateSummary`, `parseAndValidate`). For a small set of well-known shapes, this is fine. For a larger surface (a public API, many external integrations), Zod or io-ts would pay for itself.
- **Generated types from the DB schema.** Types are hand-maintained against the schema. Drift is possible (and has happened — the `notion_page_id` column on `todo_meta` was added then removed). For Postgres-only projects, tools like `supabase gen types` would help; for SQLite, the manual route is reasonable.

**The lesson.** Every type-system upgrade has a cost (build complexity, learning curve, maintenance) that has to pay for itself in catches. loopd is small enough that hand-written types + runtime validators + DB CHECKs cover the high-value cases. A larger codebase, or one with more external surfaces, would justify more.

**General rule.** Pick the lightest type-system mechanism that catches the mistakes you actually make. Don't adopt every type pattern you read about; adopt the ones that align to your actual bug history.
