# Chapter 03 — Thinking in code

This is the **DSA chapter in disguise**. Most "data structures and algorithms" content lives here — not as textbook problems but as the algorithms a real codebase actually contains. Multi-key sorts, hash joins, bucketed range compute, sparse-then-dense indexing, sliding windows, sequence alignment. Read this chapter with a notepad next to you — every concept maps to a Big-O question you might be asked.

---

## 3.1 Multi-key comparator with priority enum (todo ranking) · `foundational`

**What it is.** A sort with a defined precedence: first by `done` (false before true), then by `source` (carried > ai > journal), then by `createdAt` ascending. Each tier is a tiebreaker for the previous. Implemented as a `Record<TodoSource, number>` priority map plus a comparator function.

**Where it lives.** `src/services/todos/rank.ts:55-67`:

```ts
flat.sort((a, b) => {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (priority[a.source] !== priority[b.source]) {
    return priority[a.source] - priority[b.source];
  }
  const aTime = new Date(...).getTime();
  const bTime = new Date(...).getTime();
  return aTime - bTime;
});
```

**Why it exists.** The dashboard's "what should I attend to?" list has *three* answers depending on what's most recent: yesterday's leftovers, AI-suggested items, journal-origin todos. Folding all three into one rank gives users a single ordered list without UI clutter. The comparator's structure (early-return on each tier) is the cleanest way to express precedence.

**General rule.** Multi-key sorts are tier-by-tier early-return comparators. The priority enum (numeric `Record`) makes the precedence explicit and changeable in one place. Big-O: `O(n log n)`, same as any sort. Memorize this shape — interviewers ask for it weekly under names like "sort by department, then by salary, then by name."

---

## 3.2 Two-pass sequence alignment (the scanner) · `intermediate`

**What it is.** A reconcile algorithm structurally identical to a degenerate sequence-alignment problem. Pass 1: match by content key (text). Pass 2: match by position key (line index). Anything unmatched on either side becomes an insert or a carryover. Big-O: `O(n × m)` where n is the parsed-line count and m is the existing-record count — the inner `existing.find` is linear. For the typical journaling-day n,m < 50, this is fine; on a worst-case 1000-line entry it would warrant a hash-map index.

**Where it lives.**
- Todos: `src/services/todos/scanTodos.ts:62-89`. The two passes are explicit (loops at lines 64 and 76).
- Threads: `src/services/threads/scanThreads.ts:179-206`. Same shape; pass 2 has the additional ±3 line tolerance.

**Why it exists.** Naive reconcile (delete-all-and-re-insert) loses identity. LCS-based diff (true sequence alignment) is `O(n × m)` time and complex to implement. The two-pass version sits in the sweet spot: quadratic worst-case but with two cheap passes that each terminate early on a match, and zero dependency cost. It's covered in detail in chapter 02 (§2.3) from the system-design angle; here it lives as an algorithm.

**General rule.** When you need stable record identity through edits and the inputs are small (< a few hundred items), two-pass linear search is the right tool. Reach for hash maps when n × m > 10,000. Reach for true diff (Myers, Patience) when you also need *minimal edit script* output.

> **Go deeper.** Profile-and-improve exercise: convert pass 1's `existing.find` to a `Map<key, TodoItem>` lookup. The change touches ~5 lines and brings worst-case to `O(n + m)`. Ask yourself: is the optimization worth doing here? (Answer: probably not — n is bounded by the screen, and the simple loop is clearer to read. But knowing *when* it would matter is the skill.)

---

## 3.3 Sparse-then-dense integer ordering for manual reorder · `intermediate`

**What it is.** A two-mode position field: `NULL` by default (sort falls back to `createdAt DESC`); the first time the user reorders any row, every meta gets a dense integer. New rows added later get `position=NULL` and sort to the *front* via NULLS-FIRST tiebreak so they don't get lost behind the pre-ordered block.

**Where it lives.** `src/services/todos/reorder.ts:21-52` (`ensureAllTodoPositions`) and `:58-67` (`swapTodoPositions`). The strategy is documented at the top:

```
- Position is NULL by default; sort falls back to createdAt DESC.
- On the first reorder action ever, ensureAllTodoPositions() walks the
  user's current visual order and assigns dense integers to every meta row.
- New todos captured later get position=NULL again; sort tiebreak puts
  them ahead of the user-positioned block (NULLS FIRST equivalent in
  JS-side sorting) so fresh captures don't get lost behind a long
  pre-ordered list.
```

**Why it exists.** Pure `position INTEGER` requires backfilling every existing row (50 writes for 50 todos) on a feature that most users won't touch. Pure `createdAt` order can't represent user intent. The hybrid — null until first interaction, dense thereafter — is the lazy-initialization variant that pays the backfill cost only when needed.

**General rule.** When a feature is opt-in but needs persistent state for the rows that opted in, model the field as nullable and lazy-initialize on first use. Avoid eagerly stamping defaults across the entire table for a feature most rows won't use. The cost of the migration is real; the value of "feature works with no migration" is huge.

> **Go deeper.** The position field is *integer* and *dense*, so swapping two rows is two writes (line 65–66). Compare to a fractional-position scheme (a la Notion's blocks): each insert writes one row but the position values can degenerate over many inserts and require a periodic re-balance. Both are valid; the right pick depends on insert vs swap frequency.

---

## 3.4 Hash-join + group-by aggregator (dashboard threads) · `intermediate`

**What it is.** The dashboard threads section runs ~5 SQL queries (each a `GROUP BY thread_id` aggregation), then joins the results in JS by building hash maps keyed on `thread_id` and merging into the result rows. Classic relational hash-join, written by hand because SQLite + the result-shape mismatch makes it cleaner than one giant SQL query.

**Where it lives.** `src/services/threads/getThreadCards.ts:38-92`. Walk the structure:
- 14-day activity rows → `Map<thread_id, Set<entry_date>>` (lines 47–52).
- Week rows → `Map<thread_id, count>` (line 64).
- Todo-link rows → `Map<thread_id, Set<todo_id>>` (lines 71–76).
- Per-thread merge happens in the `.map(thread => ...)` at line 93–129.

**Why it exists.** N+1 query disaster is the main alternative (one `SELECT ... WHERE thread_id = ?` per thread per metric × per dashboard render). The aggregator pattern collapses that to one query per metric. The "join in JS" decision (vs one big SQL query) is a readability call — debugging four small queries is easier than debugging one query with four joins and three subqueries.

**General rule.** Per-row dashboards need per-metric queries, not per-row queries. Build one hash map per metric, then iterate the rows and look up. Big-O: `O(n + m)` per metric instead of `O(n × m)` for N+1. Same Big-O as a SQL hash-join — you've just written it in TypeScript.

---

## 3.5 Sliding-window compute (14-day heatmap strip) · `intermediate`

**What it is.** A fixed-size window over the most recent 14 calendar days. Each cell renders as one of four states (completed, missed, today-pending, neutral). Computed as a single pass over a date range, using a `Set<YYYY-MM-DD>` of completed days for `O(1)` lookup per cell.

**Where it lives.**
- The cutoff math: `src/services/threads/getThreadCards.ts:32-36`:

```ts
const activityCutoff = (() => {
  const d = new Date(now);
  d.setDate(d.getDate() - 14);
  return d.toISOString().slice(0, 10);
})();
```

- The lookup-by-set: lines 47–52, then line 127 (`activeDates: activeDatesByThread.get(thread.id) ?? new Set<string>()`).
- The habit version: `src/services/habits/streaks.ts` (cell state computation per day — `completed` / `missed` / `today-pending` / `neutral`).

**Why it exists.** Heatmaps want O(1) per-cell render. Without the set, each cell would search the mention list — `O(n)` per cell × 14 cells × N threads = visibly slow. With the set, each cell is one hash lookup.

**General rule.** Sliding windows on dates collapse beautifully into "compute the boundaries once, build a set, lookup per cell." If your cells need *more* than membership (e.g., a count or a state code), use a map instead of a set. The Big-O argument is the same: linear in the data, constant per cell.

---

## 3.6 Cadence engine: enum dispatch over schedule types · `foundational`

**What it is.** A `switch` over a discriminated string union (`'daily' | 'weekdays' | 'weekly' | 'specific_days' | 'n_per_week'`). Each branch is a closed-form predicate. The schedule layer is intentionally history-blind — it answers "is this *potentially* due?" The history-aware decision is composed by a separate function that takes both.

**Where it lives.** `src/services/habits/cadence.ts:46-63` (`isDueOn`):

```ts
switch (habit.cadenceType ?? 'daily') {
  case 'daily': return true;
  case 'weekdays': return day >= 1 && day <= 5;
  case 'weekly': return habit.cadenceDays?.[0] === day;
  case 'specific_days': return habit.cadenceDays?.includes(day) ?? false;
  case 'n_per_week': return true; // schedule defers to history
  // ...
}
```

Then `needsMoreThisWeek()` (line 71–77) handles the `n_per_week` history check, and `isDueToday()` (line 84–94) composes both.

**Why it exists.** Mixing schedule logic with history logic in one function makes both untestable. Splitting them keeps `isDueOn` a pure function (no DB reads, no side effects — see the file header comment) and lets the dashboard combine schedule + history at the use site.

**General rule.** When a "should I do X?" decision has both static (schedule) and dynamic (history) components, model them as two separate pure functions and compose them at the call site. Pure schedule functions are testable with synthetic dates; mixed functions need fixture data.

---

## 3.7 ISO week boundary computation · `intermediate`

**What it is.** Given any date, return the YYYY-MM-DD of the Monday of its ISO week. Uses `Date.getDay()` (Sunday=0..Saturday=6) and a `day === 0 ? -6 : 1 - day` offset to handle Sunday's wraparound.

**Where it lives.** `src/services/habits/cadence.ts:14-22`:

```ts
export function startOfISOWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
```

Note the `setHours(12, ...)` trick at line 16 — pinning to noon avoids DST-boundary edge cases that would otherwise shift the date by one when adding an offset across spring-forward/fall-back.

**Why it exists.** Week boundaries appear in every "this week" feature: streaks, n_per_week cadence, dashboard week counts. Wrong week math = silently wrong streaks = users lose trust. The noon-pin and the `if Sunday then -6 else 1-day` formula together handle the two classic Date bugs (DST, weekend wraparound).

**General rule.** Date math has two famous gotchas: timezones / DST, and weekday numbering conventions (Sun=0 vs Mon=0). Pin to noon to skip DST. Pick a numbering convention and stick to it (this codebase: Sun=0, matches `Date.prototype.getDay`). A standalone helper file means every consumer agrees.

---

## 3.8 Bucketed threshold function (staleness compute) · `foundational`

**What it is.** A pure function mapping `(thread, lastMentionAt, now) → 'fresh' | 'aging' | 'stale' | 'cold'`. If the thread has a `targetCadenceDays`, the buckets scale (1× / 2× / 4×); otherwise default to fixed thresholds (1d / 3d / 7d).

**Where it lives.** `src/services/threads/staleness.ts:8-28`:

```ts
if (target && target > 0) {
  if (days <= target) return 'fresh';
  if (days <= target * 2) return 'aging';
  if (days <= target * 4) return 'stale';
  return 'cold';
}
if (days <= 1) return 'fresh';
if (days <= 3) return 'aging';
if (days <= 7) return 'stale';
return 'cold';
```

**Why it exists.** Bucketed thresholds are the simplest possible "rate the freshness" UI. The dual-mode (custom cadence vs default) lets a high-frequency thread (daily) and a low-frequency one (weekly) both produce useful staleness signals from the same compute function.

**General rule.** When you map a continuous variable to a small discrete set of UI states, bucketed thresholds are usually the right tool. Make the function pure (no I/O, no Date.now() default arg unless captured), unit-test it with synthetic dates, and avoid spreading the threshold constants across the codebase — keep them in the function.

---

## 3.9 De-duplication via composite key set · `foundational`

**What it is.** When parsing tags from text, the same `#loopd` mention appearing twice on one line should collapse to one record. Implemented as a `Set<string>` keyed on `${lineIndex}::${slug}` so duplicates within a line are dropped while duplicates across lines are kept.

**Where it lives.** `src/services/threads/scanThreads.ts:42-54`:

```ts
const seenPerLine = new Set<string>();
// ...
for each match:
  const key = `${i}::${slug}`;
  if (seenPerLine.has(key)) continue;
  seenPerLine.add(key);
```

Same idiom in `src/services/todos/scanTodos.ts:27-30` for de-duping identical todo text within an entry.

**General rule.** Composite-key dedup with a string `Set` is the cheapest way to enforce "unique within scope X but not across scope Y." It's `O(n)` time, `O(n)` space, no library required. The trick is picking the key — too narrow and you over-dedup; too wide and you under-dedup.

---

## 3.10 Code-span masking before regex (length-preserving) · `intermediate`

**What it is.** Before running a regex over text that may contain backticked code spans, replace the inside of each code span with spaces — preserving length so downstream line-index math still works. Two replacements: triple-backtick fenced blocks first (multi-line), then single-backtick spans.

**Where it lives.** `src/services/threads/scanThreads.ts:25-33`:

```ts
function maskCode(text: string): string {
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '));
  out = out.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
  return out;
}
```

**Why it exists.** Without masking, `` `git #branch` `` would register `#branch` as a thread mention. Masking spaces-out the inside but keeps newlines and overall length, so the line index of every subsequent character is unchanged.

**General rule.** When you transform text before parsing but downstream code depends on positions in the *original* text, your transform must be **length-preserving and line-preserving**. Replacing characters with spaces is the cheapest valid transform.

---

## 3.11 Module-level semaphore via `Set` · `intermediate`

**What it is.** A simple in-memory cap on concurrent expensive operations. A `Set<string>` tracks in-flight IDs; new operations check the size and bail out if the cap is reached. No async library, no queue — just a module-scoped variable.

**Where it lives.** `src/services/todos/expand.ts:25-29` and `:212-214`. The classifier in `src/services/todos/classify.ts` uses the same idiom for the toast UI counter.

**General rule.** When you need concurrency limits within a single process and persistence across restarts isn't required, a module-scoped `Set` (or simple counter) is the minimal viable semaphore. Reach for a queue (BullMQ, P-queue) when you need backpressure, retries, or fairness.

---

## 3.12 Discriminated unions for domain modeling · `foundational`

**What it is.** TypeScript's type system used to encode mutually exclusive states with payload-bearing tags. `TodoExpansion` is `{ type: 'idea', data: IdeaExpansion } | { type: 'bug', data: BugExpansion } | ...` — six variants in one union, exhaustive `switch` checked by the compiler.

**Where it lives.**
- The unions: `src/types/todoMeta.ts` (`TodoType`, `TodoStage`, `TodoExpansion`).
- The exhaustive switch: `src/services/todos/expand.ts:83-141` (`validateExpansion`) — adding a 7th type would compile-fail until a new `case` is added.
- Other examples: `Staleness` (`'fresh' | 'aging' | 'stale' | 'cold'`), `TimeOfDay`, `CadenceType`, `ClassifierConfidence`.

**Why it exists.** The compiler enforces "every type has its own data shape." If you change `IdeaExpansion`, the validator and serializer fail to compile until you handle the new shape. This is type-driven refactoring: the type system is your test suite for shape correctness.

**General rule.** When you have a "this OR that OR the other" with different payloads, model as a discriminated union. The discriminant field name should be `type` or `kind` (convention) and exhaustiveness should be enforced via `case _: never`. This pattern is the closest TypeScript gets to algebraic data types.

---

## 3.13 Dynamic import to break circular dependencies · `intermediate`

**What it is.** Instead of `import { pushAll } from './orchestrator'` at the top of the file, the function is loaded lazily inside the call site via `await import('./orchestrator')`. The import only resolves when the function fires, by which time the rest of the module graph is already initialized.

**Where it lives.** `src/services/sync/schedulePush.ts:31`:

```ts
const { pushAll } = await import('./orchestrator');
```

The comment at lines 5–7 explains: *"Dynamic-imports the orchestrator to avoid a circular dependency (database.ts → schedulePush → orchestrator → tables/*.ts → database.ts). The import only resolves on fire, by which time everything else is up."*

**Why it exists.** The static import graph has a real cycle: `database.ts` calls `schedulePush()` after every write; `schedulePush` would import `orchestrator`; `orchestrator` imports the table adapters; the adapters import from `database.ts`. Static cycles cause TDZ errors or undefined exports at boot. Dynamic import sidesteps this by resolving the import at runtime, after all modules have loaded.

**General rule.** Circular imports are usually a design smell, but sometimes (especially in callback-style code) they're unavoidable. Dynamic `await import()` is the surgical fix. Don't reach for it preemptively — only when you've identified the cycle and there's no clean restructure.

---

## 3.14 Pure function as the unit of testability · `foundational`

**What it is.** A function that takes inputs, returns outputs, has no I/O, no globals, no side effects. The codebase deliberately concentrates important business logic into pure functions so the I/O code (database, network) becomes a thin shell.

**Where it lives.**
- `src/services/sync/conflict.ts` — `chooseWinner` is pure (header comment line 4 calls it out: *"Pure function — easily testable."*)
- `src/services/threads/staleness.ts` — `computeStaleness`, `differenceInDays`, `formatStalenessLabel` all pure.
- `src/services/habits/cadence.ts` — entire file is pure (header line 3: *"Pure cadence engine. No DB reads, no side effects."*).
- `src/services/todos/heuristicClassify.ts` — pure.
- `src/services/todos/scanTodos.ts:53-181` — pure parser/rewriter; the I/O layer is in `crud.ts`.

**Why it exists.** The codebase has no automated test suite (per `.aipe/project/rules.md:17`). Pure functions are the closest thing to testable code — even without a test runner, you can manually verify by calling them with synthetic inputs in the dev shell. When a test suite is added later, pure functions are the lowest-friction targets.

**General rule.** Push business logic into pure functions; isolate I/O at the edges. This is "functional core, imperative shell" (Gary Bernhardt's phrase). It pays off in three ways: easier reasoning, easier testing, and easier reuse (you can call the pure function from a different I/O path tomorrow without rewriting it).

---

## 3.15 Generic interface as table-pluggability contract · `advanced`

**What it is.** `SyncableTable<TLocal, TCloud>` is a generic interface every synced table implements. The orchestrator code is written against the interface, not against any specific table — adding a new synced table is a matter of writing a thin adapter and adding it to the registry.

**Where it lives.** `src/services/sync/types.ts:11-59`. The orchestrator usage: `src/services/sync/orchestrator.ts:25-36` (the `REGISTRY` array).

**Why it exists.** Without the interface, the push and pull functions would have to know about every table. Adding a table would touch the orchestrator. With the interface, the orchestrator iterates a registry of opaque adapters; each table is a self-contained unit. This is the strategy pattern at language level.

**General rule.** When you have N implementations of the same shape (10 sync tables here), define the shape as an interface and write the orchestration code against the interface. The cost is some upfront type ceremony; the payoff is that adding implementation N+1 is local.
