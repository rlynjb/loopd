# todo_meta reconciliation: 1:1 invariant

> Map + Set diff: build `Map<todoId, meta>` and `Set<todoId>`, then insert missing and delete orphans in O(n+m).

**See also:** → [01-two-pass-scan-todos](./01-two-pass-scan-todos.md) · → [10-heuristic-first-classifier](./10-heuristic-first-classifier.md) · → [01-system-design/06-one-to-one-invariant](../01-system-design/06-one-to-one-invariant.md)

---

## Quick summary
- **What:** `reconcileTodoMetaForEntry` keeps `todo_meta` 1:1 with `entries.todos_json`. Inserts missing, deletes orphans, leaves matched rows alone.
- **Why here:** SQLite can't FK to a JSON-array element, so the reconciler is the integrity gate.
- **Tradeoff:** a partial run leaves drift until next commit, but the next commit's diff sees the gap and patches it.

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

## Brute force

```
  // For every todo, scan all metas (O(n*m))
  for each todo in entry.todos:
    found = existing.find(m => m.todoId == todo.id)
    if not found: insertTodoMeta(todo)

  for each meta in existing:
    found = entry.todos.find(t => t.id == meta.todoId)
    if not found: deleteTodoMeta(meta.todoId)
```

**Complexity:** O(n × m) time · O(1) extra space.

---

## Optimal

**The insight:** build two index structures — a `Map<todoId, meta>` for O(1) "do I already have a meta?" and a `Set<todoId>` for O(1) "is this meta still valid?".

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

## Comparison

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n × m)       │ O(n + m)         │
  │ Space           │ O(1)           │ O(n + m)         │
  │ At 20 todos     │ 400 ops        │ 40 ops           │
  │ Self-healing    │ ✓              │ ✓                │
  └─────────────────┴────────────────┴──────────────────┘
```

**When brute force is fine:** at the 20-todo scale of a typical entry, both run in under a millisecond. The reason the optimal version is in the codebase isn't speed — it's clarity (`byTodoId.has(...)` reads like the invariant).

---

## In this codebase

- `src/services/todos/reconcileMeta.ts` → `reconcileTodoMetaForEntry()`.
- `src/services/todos/heuristicClassify.ts` → consulted on insert.
- `src/services/todos/classify.ts` → fired async via `scheduleClassify`.

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

- **Index both sides** — gives: O(n+m) and clear code. Costs: O(n+m) memory upfront.
- **Async classify on insert** — gives: reconcile returns fast. Costs: a brief window where the row shows `type='todo'` before the LLM upgrades it.
- **Self-healing on next commit** — gives: a missed insert/delete isn't catastrophic. Costs: between runs, the invariant can be momentarily violated.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand the difference between an O(n+m) algorithm chosen for speed and one chosen for *clarity*. At 20 todos per entry, brute force runs in 400 ops; the optimal version in 40. Both are sub-millisecond. The Map+Set version is in the codebase because `byTodoId.has(todo.id)` literally reads like the invariant — "is this todo already represented in meta?". The interviewer wants to know if I can articulate that complexity choice on a hot path is a code-readability decision when n is bounded.

### Likely questions

[mid] Q: Why does `reconcileTodoMetaForEntry` build `current` as a Set when the insert phase only iterates `entry.todos` once?
      A: The `current` Set isn't for the insert phase — it's for the delete phase. The delete phase walks `existing` and asks "is this meta's todoId still in the current todos?" That's an O(1) Set lookup per row instead of an O(n) `.find` over `entry.todos`. The two index structures serve the two different walks: `byTodoId` answers "does this todo already have a meta?" and `current` answers "does this meta still have a todo?".

[senior] Q: Why is the LLM call fired async rather than awaited inside reconcile?
         A: Reconcile runs on the journaling write path. If I awaited the Haiku call, every typing burst that produces a new todo would block the local write by ~300-800ms. Instead I call `heuristicClassify` synchronously — it's a regex pass that catches 60-70% of cases — and only fall through to `scheduleClassify` for the ambiguous ones. The local row gets `type='todo', confidence=null` immediately, the LLM upgrades it later. The cost I accept is a brief window where the UI shows `type='todo'` before it might flip to `'idea'`.

[arch] Q: What happens if `scheduleClassify` keeps failing for a particular row?
       A: The row stays at `type='todo', confidence=null` indefinitely. Reconcile won't re-fire because `byTodoId.has(todo.id)` is true on the next run. To recover I'd need a separate sweep — find rows where `confidence IS NULL AND created < now - threshold` and re-enqueue. I haven't built that sweep; right now a stuck classifier failure is silent. At single-user scale that's fine; at multi-user scale it'd be a metric to alert on.

### The question candidates always dodge
Q: You said reconcile is "self-healing on next commit." What if the user closes the app between the insert phase and the delete phase — is the DB consistent?

A: It's consistent in the sense that nothing is half-written, because each insert/delete is its own SQLite statement and they're not in a transaction. So if the app dies after the inserts but before the deletes, you'd have all the new metas plus the orphans that should have been deleted. Both `byTodoId` and `current` rebuild fresh on the next run, so the orphan gets caught next time the entry is touched. The invariant is *eventually* 1:1, not transactionally 1:1. The honest fix would be to wrap the whole reconcile in a transaction so it's all-or-nothing — that's a one-line change with `db.transaction(() => ...)` and I should probably do it. The reason I haven't is laziness plus the observation that orphan metas are read-only (the JS join ignores them) so the user-visible consequence of drift is zero.

### One-line anchors
- "Two index structures, two walks — `byTodoId` for inserts, `current` for deletes."
- "Heuristic synchronously, LLM async — typing never waits on Haiku."
- "Self-healing means eventually 1:1, not transactionally 1:1."
- "The function reads like the invariant; that's why it's optimal."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
