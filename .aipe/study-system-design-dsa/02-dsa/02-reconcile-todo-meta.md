# todo_meta reconciliation: 1:1 invariant

**Industry name(s):** Reconciler pattern, application-side referential integrity
**Type:** Industry standard

> Map + Set diff: build `Map<todoId, meta>` and `Set<todoId>`, then insert missing and delete orphans in O(n+m).

**See also:** → [01-two-pass-scan-todos](./01-two-pass-scan-todos.md) · → [10-heuristic-first-classifier](./10-heuristic-first-classifier.md) · → [01-system-design/06-one-to-one-invariant](../01-system-design/06-one-to-one-invariant.md)

---

## Why care

Kubernetes runs a reconciler on every tick. It reads the Deployment spec (what should exist), it reads the current Pods (what does exist), it computes the diff, and it emits the minimum set of operations to close the gap. No foreign key ties a Deployment row to its Pod rows — the reconciler IS the integrity gate. It pre-indexes both sides into hash structures, walks each side once asking "is your counterpart on the other side?", and applies inserts and deletes only where the answer is no. The same shape shows up in React's renderer diffing virtual DOM trees, in `rsync` matching files between filesystems, in Postgres logical replication keeping a subscriber in step with a publisher.

That is the question this operation answers when one side is a JSON-array column and the other is a SQL table that's supposed to mirror it: how do we keep two parallel lists in 1:1 agreement using the minimum writes, when neither side can be enforced by a foreign-key constraint? Not a full rebuild, not a slow nested scan — just the *reconciler pattern* with two hash structures driving two linear walks.

**What depends on getting this right:** the durability of every classifier result and every user override stored against a todo. In this codebase `entries.todos_json` is the canonical id list (driven by `scanTodos`), and `todo_meta` rows hang off those ids 1:1 — they hold `type`, `priority`, the LLM `confidence` value, and any user-applied corrections. SQLite cannot foreign-key into a JSON-array element, so the reconciler IS the integrity gate. If it skips an insert, the new todo renders with no classification metadata in the UI. If it skips a delete, an orphan meta row lingers, takes up space, and pollutes any future query that joins `todo_meta` without an existence check on `todos_json`. The 1:1 invariant is what makes `todo_meta` a sidecar you can trust.

Without the reconciler (per-write integrity checks):
- New todo `t-C` is born from `scanTodos` and pushed to `entries.todos_json`
- No process notices the gap; `todo_meta` has no row for `t-C`
- UI joins `entries.todos` × `todo_meta` → `t-C` renders with `type=undefined`
- Classifier never fires because nothing watches for "todo without meta"
- Six months later, half the todos have no metadata and nobody can say why

With the reconciler:
- After every commit, `reconcileTodoMetaForEntry(entryId)` runs
- It builds `byTodoId: Map<id, meta>` from existing rows and `current: Set<id>` from `todos_json`
- Inserts a meta row for any todo not in `byTodoId` (fires `heuristicClassify` synchronously, `scheduleClassify` async for the residue)
- Soft-deletes any meta whose `todoId` is not in `current`
- The 1:1 invariant is restored in O(n+m) and the function reads like the invariant it enforces

Build the index once, walk both sides linearly, write only the diff.

---

## How it works

React's reconciler diffs two virtual DOM trees and emits the minimum mount/unmount operations to make the live tree match the next render. The shape generalises: whenever two parallel collections are supposed to mirror each other but no FK enforces the relationship, you pre-index both sides, walk each side once asking "is your counterpart on the other side?", and apply only the diff. If you're coming from React, this is exactly how the keyed-list reconciler decides what to mount and unmount — except here the "trees" are flat arrays of ids and the operations are SQL inserts and soft-deletes instead of DOM mutations.

**Real operation:** `reconcileTodoMetaForEntry` in `src/services/todos/reconcileMeta.ts`. Runs after `scanTodos` produces final `todos_json`.

---

## The data

```
  entry.todos:                          todo_meta (rows in DB):
    [{id: "t-A", text: ...},              [{ todoId: "t-A", type: "todo", ...},
     {id: "t-B", text: ...},               { todoId: "t-X", type: "idea", ...}]   ← stale
     {id: "t-C", text: ...}]            ← t-C missing
```

**The problem:** insert any TodoItem missing a meta row, delete any meta whose `todoId` isn't in `todos_json` anymore, leave matched rows untouched (preserves user-overridden type).

---

── Brute force ──────────────────────────────────

Pseudocode:

```
  // For every todo, scan all metas (O(n × m))
  for each todo in entry.todos:
    found = existing.find(m => m.todoId == todo.id)
    if not found: insertTodoMeta(todo)

  for each meta in existing:
    found = entry.todos.find(t => t.id == meta.todoId)
    if not found: deleteTodoMeta(meta.todoId)
```

Execution trace (`existing = [t-A meta, t-X meta]`, `entry.todos = [t-A, t-B, t-C]`):

```
  Insert phase (walk entry.todos, .find over existing):
    t-A: existing.find(m => m.todoId=='t-A') → metaA ✓     skip
    t-B: existing.find(m => m.todoId=='t-B') → undef       insertTodoMeta(t-B)
    t-C: existing.find(m => m.todoId=='t-C') → undef       insertTodoMeta(t-C)
    cost = 3 × O(m) scans = 3 × 2 = 6 ops

  Delete phase (walk existing, .find over entry.todos):
    metaA: todos.find(t => t.id=='t-A') → t-A ✓            skip
    metaX: todos.find(t => t.id=='t-X') → undef            deleteTodoMeta(t-X)
    cost = 2 × O(n) scans = 2 × 3 = 6 ops

  Total: 12 ops vs the optimal 5 ops. Same result.
```

Complexity: O(n × m) time · O(1) extra space.

What goes wrong at scale: at the project's 20-todo-per-entry scale, brute force runs in 400 ops vs optimal's 40 — both sub-millisecond. The real problem isn't speed; it's that every read inside the loop hides an O(m) scan, so reading the code you can't *tell* it's O(n × m). With 10,000 todos × 10,000 metas, brute force would run ~100M ops — still under a second but a maintenance trap.

── Optimal ──────────────────────────────────────

The insight: build two index structures — a `Map<todoId, meta>` for O(1) "do I already have a meta?" and a `Set<todoId>` for O(1) "is this meta still valid?".

```
  existing = getTodoMetasByEntry(entry.id)
  byTodoId = Map( existing.map(m => [m.todoId, m]) )
  current  = Set( entry.todos.map(t => t.id) )

  // Insert missing
  for each todo in entry.todos:
    if byTodoId has todo.id: continue
    heur = heuristicClassify(todo.text)
    insertTodoMeta(buildMeta(todo, heur))
    if heur == null AND not todo.done:
      scheduleClassify(todo.id, todo.text)        // fire LLM async (non-blocking)

  // Delete orphans
  for each meta in existing:
    if current has meta.todoId: continue
    deleteTodoMeta(meta.todoId)
```

**Execution trace** (`existing = [t-A meta, t-X meta]`, `entry.todos = [t-A, t-B, t-C]`):

```
  build:
    byTodoId = { "t-A" → metaA, "t-X" → metaX }
    current  = { "t-A", "t-B", "t-C" }

  insert phase:
    t-A: byTodoId has it       → skip
    t-B: not in byTodoId       → heuristic("write spec") = null
                                 insertTodoMeta(t-B, type='todo', confidence=null)
                                 scheduleClassify(t-B, "write spec")  ← async LLM
    t-C: not in byTodoId       → heuristic("book dentist") = 'todo'
                                 insertTodoMeta(t-C, type='todo', confidence='heuristic')
                                 (no LLM — heuristic was confident)

  delete phase:
    metaA (t-A): current has it → skip
    metaX (t-X): current lacks  → deleteTodoMeta(t-X)

  Final: t-A unchanged, t-B inserted (LLM upgrades type later),
         t-C inserted with heuristic, t-X deleted.
```

**Complexity:** O(n + m) time · O(n + m) space.

**Why it's faster:** Map + Set lookups are O(1). Each row is visited at most twice. The async LLM scheduling doesn't block the write — `reconcileTodoMetaForEntry` returns as soon as the synchronous inserts are done.

---

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n × m)       │ O(n + m)         │
  │ Space           │ O(1)           │ O(n + m)         │
  │ At 1,000 items  │ 1,000,000 ops  │ 2,000 ops        │
  │ At 10,000 items │ 100,000,000 ops│ 20,000 ops       │
  │ Readable?       │ yes            │ yes (clearer)    │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: at the 20-todo scale of a typical entry, both run in under a millisecond. The reason the optimal version is in the codebase isn't speed — it's clarity (`byTodoId.has(...)` reads like the invariant).

This is what people mean by "reconcile two sources of truth in linear time." The pattern is everywhere because the problem is everywhere — Kubernetes controllers reconcile desired against actual state on every tick, Git's index reconciles tracked vs working-tree files, React's reconciler diffs `next` against `current`. The trick is always the same: pay O(n+m) up-front to build a hash, then scan both sides linearly. When you can't have a foreign-key constraint do the work for you, this is the second-cheapest enforcement mechanism available.

---

## In this codebase

**Algorithm:**       `src/services/todos/reconcileMeta.ts` → `reconcileTodoMetaForEntry()` L48–L92
**Async LLM hook:**  `src/services/todos/reconcileMeta.ts` → `scheduleClassify()` L13–L46 — fire-and-forget Haiku call
**Heuristic gate:**  `src/services/todos/heuristicClassify.ts` → `heuristicClassify()` L71–L102 — consulted synchronously on insert
**LLM fallback:**    `src/services/todos/classify.ts` → `classifyTodo()` (the function `scheduleClassify` invokes when `heuristicClassify` returns `null`)

---

## Elaborate

### Where this pattern comes from
The "build both index structures, then walk both sides" diff pattern is the same shape used in shadow DOM reconciliation (React's keyed-list reconciler), file-system rsync, and Postgres logical replication. The principle: indices for O(1) membership turn quadratic diffs into linear ones.

### The deeper principle
**Build the index once; query it many times.** Whenever the same predicate (`is X in this set?`) is asked in a loop, a Map/Set lifts the loop's complexity by an order of magnitude.

### Where this breaks down
- Streaming inputs where you can't afford to materialise the index — but reconcile here is bounded per entry (10-30 todos), so the index fits.
- Cases where membership *changes during* the loop. Reconcile avoids this by building the index once before mutating.

### What to explore next
- [10-heuristic-first-classifier](./10-heuristic-first-classifier.md) → the `heuristicClassify` call inside reconcile.
- React's keyed-list reconciler → the same pattern at UI scale.

---

## Tradeoffs

We traded transactional rigour and a small memory overhead for a reconciler that reads like the invariant it enforces and never blocks the journaling write path.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (Map+Set, async)    │ Alternative (nested-loop + tx) │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Time complexity  │ O(n + m) — two linear walks    │ O(n × m) — `.find()` per row   │
│                  │ with O(1) Map/Set lookups      │                                │
│ Latency at N=20  │ <1ms synchronous; LLM async    │ <1ms synchronous; same if      │
│                  │                                │ LLM also async                 │
│ Latency at 10×N  │ ~2ms synchronous               │ ~20ms — `.find()` × 200 todos  │
│ Memory churn     │ allocates Map(m) + Set(n)      │ no allocations, but GC noise   │
│                  │ ~1KB per scan at N=20          │ from per-iteration closures    │
│ Code complexity  │ ~90 LOC: build, insert, delete │ ~60 LOC: two nested .find loops │
│ Cognitive load   │ `byTodoId.has(todo.id)` reads  │ `existing.find(m => ...)` reads │
│                  │ as the invariant itself        │ as "scan the array"            │
│ Transactionality │ each insert/delete is its own  │ wrapped in db.transaction →    │
│                  │ statement — drift on crash;    │ all-or-nothing; no eventual    │
│                  │ next reconcile heals it        │ window                         │
│ Failure mode     │ stuck LLM call → row stays at  │ stuck LLM call → reconcile     │
│                  │ type='todo' forever; silent     │ blocks; whole journal write   │
│                  │ (no sweep job yet)             │ stalls the UI                  │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The reconciler builds a `Map<todoId, meta>` and a `Set<todoId>` on every call — ~1KB of allocation per scan at N=20, GC-collected before the next commit. The two structures cost ~30 LOC of building boilerplate before the actual diff loops begin (`reconcileMeta.ts` L48–L92). At the project's scale a single `.find()` per row would also be sub-millisecond, so this isn't a speed win — it's a code-shape win. The function reads `byTodoId.has(todo.id)` and you can see "is this todo already represented in meta?" without translating from a `.find` predicate. That clarity is what we're paying for.

Inserts and deletes aren't wrapped in `db.transaction(() => ...)`. If the app dies between the insert phase and the delete phase, the next reconcile sees orphans and patches them — eventually 1:1, not transactionally 1:1. The user-visible cost of drift is zero because the JS join that produces `TodoItem[]` ignores orphan metas, but the invariant is technically violated between phases.

`scheduleClassify` is fire-and-forget. A stuck LLM call leaves the row at `type='todo', confidence=null` indefinitely because `byTodoId.has(todo.id)` is true on the next reconcile and the insert phase skips it. There's no sweep job that retries stale `confidence=null` rows yet. At single-user scale this is invisible; at multi-user scale it would be a metric.

### What the alternative would have cost

A nested-loop reconciler with `existing.find(m => m.todoId === todo.id)` would have dropped ~30 LOC of index-building. At N=20 it would also be sub-millisecond. The visible cost is that the code stops reading like the invariant — a reader sees `existing.find(...)` and parses "linear scan" before parsing "membership check." Onboarding a contributor takes longer to land the insight that this function IS the 1:1 enforcement gate.

Wrapping reconcile in `db.transaction(() => ...)` would close the drift window. It's a one-line change. The reason we haven't is that the consequence of drift is invisible (orphan metas are read-only) and adding a transaction means every scheduled LLM call inside the loop has to be hoisted *out* of the transaction (LLM calls can't be inside a SQLite transaction or the connection holds open for 800ms). That hoisting is ~15 LOC of reorder for a benefit nobody sees.

Awaiting the LLM call inside reconcile would block typing bursts that produce new todos by ~300-800ms per row. Every focus-blur with a new todo would stutter. The fire-and-forget model trades "eventually correct `type`" for "writes never block on the network," which is the right trade for a journaling app.

### The breakpoint

Fine until `confidence=null` rows accumulate from repeated LLM failures and no sweep job exists to retry them. At a single user with reliable network, this never trips. The actual breakpoint is multi-user with intermittent connectivity: at ~5% LLM failure rate sustained over a week, a measurable fraction of todos get stuck at `type='todo'` and the heuristic-vs-LLM split breaks down. The fix is a periodic sweep that re-enqueues `confidence IS NULL AND created_at < now - 24h` — a separate cron-like job, not a change to reconcile.

### What wasn't actually a tradeoff

Choosing Map+Set over two `.find()` calls wasn't a tradeoff on speed — at N=20 both are sub-millisecond. It was a tradeoff on clarity: the index name (`byTodoId`) is the invariant name. The bullet-form readability is the only reason the optimal version is in the codebase.

---

## Tech reference (industry pairing)

### TypeScript Map + Set (no ORM, no FK)

- **Codebase uses:** `Map<todoId, TodoMetaRow>` and `Set<todoId>` inside `src/services/todos/reconcileMeta.ts → reconcileTodoMetaForEntry()`. Raw SQL via `database.ts` for inserts and soft-deletes.
- **Why it's here:** SQLite can't FK to a JSON-array element (`entries.todos_json` holds the canonical id list); the reconciler IS the integrity gate. Map+Set is the cheapest expression of "do I have this id?" at this scale.
- **Leading today:** application-side reconciler with native collections — `adoption-leading` when the relationship can't be expressed as a foreign-key constraint, 2026.
- **Why it leads:** runtime-builtin, O(1) lookups, no library overhead; the reconciler reads like the invariant it enforces.
- **Runner-up:** Drizzle / Prisma with typed schemas — `innovation-leading` once the relationship CAN be expressed in the schema; here it can't (JSON-array element child), so the application reconciler wins.

### expo-sqlite (WAL)

- **Codebase uses:** `expo-sqlite` against `buffr.db`. The reconciler inserts new `todo_meta` rows and stamps `deleted_at` on orphans through the `database.ts` connection.
- **Why it's here:** the inserts and soft-deletes must hit SQLite atomically per row so the next focus-blur scan sees consistent state.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** ships with the Expo SDK; WAL mode lets the next read see a consistent snapshot while the reconciler commits.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding with no bridge cost; the perf tier for bare React Native projects.

---

## Summary

The reconciler pattern is the standard remedy whenever two lists are supposed to mirror each other but no foreign-key constraint enforces the relationship — walk both sides once, decide what's missing where, apply the minimum writes to make them match. In this codebase `reconcileTodoMetaForEntry` keeps `todo_meta` rows 1:1 with `entries.todos_json` after `scanTodos` produces final ids: it builds a `Map<todoId, meta>` for "do I already have a meta?" and a `Set<todoId>` for "is this meta still valid?", then inserts missing rows and deletes orphans in O(n+m). The constraint is that SQLite can't FK to a JSON-array element, so the reconciler IS the integrity gate. The cost is that a partial run between insert phase and delete phase can leave momentary drift — the invariant is eventually 1:1, not transactionally 1:1 — but the next commit's diff sees the gap and patches it. At the project's 20-todo-per-entry scale, brute force would also be sub-millisecond; the Map+Set version is chosen for clarity (`byTodoId.has(...)` reads like the invariant), not raw speed.

Key points to remember:
- Two index structures, two walks — `byTodoId` answers "does this todo have a meta?" for the insert phase; `current` answers "does this meta still have a todo?" for the delete phase.
- The heuristic classifier runs synchronously on insert; the LLM call is fired async via `scheduleClassify` so reconcile never blocks the journaling write path.
- O(n + m) time and space — Map/Set lookups are O(1) and each row is touched at most twice.
- Self-healing means eventually 1:1, not transactionally 1:1 — a crash between phases leaves orphans that the next reconcile cleans up.
- The function reads like the invariant; at 20 todos that's why the optimal version is in the codebase, not speed.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand the difference between an O(n+m) algorithm chosen for speed and one chosen for *clarity*. At 20 todos per entry, brute force runs in 400 ops; the optimal version in 40. Both are sub-millisecond. The Map+Set version is in the codebase because `byTodoId.has(todo.id)` literally reads like the invariant — "is this todo already represented in meta?". The interviewer wants to know if I can articulate that complexity choice on a hot path is a code-readability decision when n is bounded.

### Likely questions

[mid] Q: Why does `reconcileTodoMetaForEntry` build `current` as a Set when the insert phase only iterates `entry.todos` once?
      A: The `current` Set isn't for the insert phase — it's for the delete phase. The delete phase walks `existing` and asks "is this meta's todoId still in the current todos?" That's an O(1) Set lookup per row instead of an O(n) `.find` over `entry.todos`. The two index structures serve the two different walks: `byTodoId` answers "does this todo already have a meta?" and `current` answers "does this meta still have a todo?".

```
[two index structures, two walks]

  build phase
        │
        ├── byTodoId : Map(existing → meta)   ◀── used by INSERT walk
        └── current  : Set(entry.todos.id)    ◀── used by DELETE walk
                 │
                 ▼
  INSERT walk over entry.todos
        for each todo:
          byTodoId.has(todo.id) ? skip : insert
                 │
                 ▼
  DELETE walk over existing
        for each meta:
          current.has(meta.todoId) ? skip : delete
```

[senior] Q: Why is the LLM call fired async rather than awaited inside reconcile?
         A: Reconcile runs on the journaling write path. If I awaited the Haiku call, every typing burst that produces a new todo would block the local write by ~300-800ms. Instead I call `heuristicClassify` synchronously — it's a regex pass that catches 60-70% of cases — and only fall through to `scheduleClassify` for the ambiguous ones. The local row gets `type='todo', confidence=null` immediately, the LLM upgrades it later. The cost I accept is a brief window where the UI shows `type='todo'` before it might flip to `'idea'`.

```
                  Path taken (fire-and-forget LLM)     Alternative (await LLM in reconcile)
                  ─────────────────────────────────    ──────────────────────────────────
new-todo write    insert meta now ; LLM later          insert meta after LLM responds
write latency     ~5ms — disk only                     300-800ms — disk + Haiku round-trip
focus-blur UX     instant return ; no UI stall         visible UI stutter on every new todo
LLM failure cost  row stays at type='todo' silently    write fails ; user types again
                  (read-only orphan if no sweep)       (worse — destructive)
heuristic gate    catches 60-70% before LLM ever fires same gate, but LLM is on hot path
correctness       type may briefly be stale            type is correct immediately on insert
```

[arch] Q: What happens if `scheduleClassify` keeps failing for a particular row?
       A: The row stays at `type='todo', confidence=null` indefinitely. Reconcile won't re-fire because `byTodoId.has(todo.id)` is true on the next run. To recover I'd need a separate sweep — find rows where `confidence IS NULL AND created < now - threshold` and re-enqueue. I haven't built that sweep; right now a stuck classifier failure is silent. At single-user scale that's fine; at multi-user scale it'd be a metric to alert on.

```
[scale curve — what breaks first at 10× / 100× input]

  scenario                 stuck rows accumulate?       breaks?
  ──────────────────────   ──────────────────────       ─────────────────────────
  1 user, reliable net      no — Haiku rarely fails     fine
  1 user, flaky net (10×)   handful per week            tolerable; user can retype
  100 users (10×)           dozens per day              metric worth alerting on
  10,000 users (100×)       thousands daily             needs sweep job; no choice
                            no recovery path exists     reconcile invariant degrades
  fix                       periodic re-enqueue of
                            confidence=null rows
                            older than 24h
```

### The question candidates always dodge
Q: You said reconcile is "self-healing on next commit." What if the user closes the app between the insert phase and the delete phase — is the DB consistent?

A: It's consistent in the sense that nothing is half-written, because each insert/delete is its own SQLite statement and they're not in a transaction. So if the app dies after the inserts but before the deletes, you'd have all the new metas plus the orphans that should have been deleted. Both `byTodoId` and `current` rebuild fresh on the next run, so the orphan gets caught next time the entry is touched. The invariant is *eventually* 1:1, not transactionally 1:1. The honest fix would be to wrap the whole reconcile in a transaction so it's all-or-nothing — that's a one-line change with `db.transaction(() => ...)` and I should probably do it. The reason I haven't is laziness plus the observation that orphan metas are read-only (the JS join ignores them) so the user-visible consequence of drift is zero.

```
                  Path taken (no transaction)          Suggested (db.transaction wrap)
                  ─────────────────────────────        ──────────────────────────────────
crash mid-loop    orphan metas survive ; next          all-or-nothing ; no orphans ever
                  reconcile cleans them
window of drift   between phases (~1ms typically,      zero
                  but unbounded if process dies)
user-visible cost zero — JS join ignores orphans       zero — same user-visible behaviour
LLM call site     fire-and-forget OK anywhere          must be hoisted OUT of transaction
                                                        (SQLite holds connection during tx)
extra LOC         0                                     +15 LOC to hoist scheduleClassify
                                                        and re-stitch the flow
verdict           cheap ; invariant is eventually 1:1  cleaner ; pays 15 LOC for an
                                                        invariant the user can't see
```

### One-line anchors
- "Two index structures, two walks — `byTodoId` for inserts, `current` for deletes."
- "Heuristic synchronously, LLM async — typing never waits on Haiku."
- "Self-healing means eventually 1:1, not transactionally 1:1."
- "The function reads like the invariant; that's why it's optimal."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain todo_meta reconciliation to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/reconcileMeta.ts:reconcileTodoMetaForEntry`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

`scanTodosFromText` returns 5 todo ids `[t-1..t-5]`. The existing `todo_meta` for that entry has rows for `[t-1, t-2, t-3]` (matching) plus `[t-X, t-Y]` (stale — they got removed from the prose two commits ago). After `reconcileTodoMetaForEntry` runs, how many `insertTodoMeta` calls fire, how many `deleteTodoMeta` calls fire, how many rows are touched, and how many heuristic-vs-LLM classifications happen if the texts of `t-4` and `t-5` are "call mom" and "is this still broken?"

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/reconcileMeta.ts` L48–L92 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/reconcileMeta.ts` to support what exists
→ Point to `src/services/database.ts` (where you'd wrap the inserts/deletes in a transaction) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.
