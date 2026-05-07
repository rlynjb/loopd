# The 1:1 invariant (and why it's not a foreign key)

> Every `TodoItem` in `entries.todos_json` has exactly one matching `todo_meta` row. SQLite can't FK to a JSON-array element, so the application reconciler is the enforcement.

**See also:** → [03-single-source-of-truth](./03-single-source-of-truth.md) · → [04-two-pass-matching](./04-two-pass-matching.md) · → [02-dsa/02-reconcile-todo-meta](../02-dsa/02-reconcile-todo-meta.md)

---

## Quick summary
- **What:** `entries.todos_json` is a JSON array of TodoItems; `todo_meta` is a separate table keyed on `todoId`. After every prose scan, the reconciler inserts missing meta rows, deletes orphans, leaves matched rows alone.
- **Why here:** SQLite can't enforce FKs to elements of a JSON column, so the app code is the integrity gate.
- **Tradeoff:** a partial reconcile leaves orphans/missing meta rows until the next commit. Acceptable — the next commit's diff sees the gap and patches it (self-healing).

---

## 1:1 invariant — diagram

```
  entries.todos_json:  [ {id: "t-abc", text: "..."}, {id: "t-def", text: "..."} ]
                              ▲                              ▲
                              │                              │
                              │  todoId pointer              │  todoId pointer
                              │                              │
  todo_meta rows:       ┌─ id=t-abc ─┐                ┌─ id=t-def ─┐
                        │ entry_id    │                │ entry_id    │
                        │ type=idea   │                │ type=todo   │
                        │ pinned=0    │                │ pinned=1    │
                        │ ...         │                │ ...         │
                        └─────────────┘                └─────────────┘

  Why not a real FK?
  ────────────────────────────────────────────────────────────────────
  todos_json is a JSON array on a single entries row.
  SQLite cannot foreign-key to an element of a JSON column.
  So the application reconciler IS the enforcement.
```

---

## How it works

The reconciler runs after every `scanTodos`. Its inputs are the freshly-scanned `todos[]` and the existing `todo_meta` rows for that entry. Its output is a series of inserts and deletes that bring `todo_meta` back into 1:1 alignment.

Matched rows are left alone — that's how `type` (the classifier output), `expanded_md` (the AI expansion), `pinned`, and `user_overridden_type` survive prose edits. Insert paths that have a heuristic confidence skip the LLM classifier; ambiguous ones fire `scheduleClassify` async.

Why not an FK? `todos_json` is a JSON column on the `entries` row. Each TodoItem is an array element with its own UUID. SQLite has no syntax for "FK to the `id` field of an array element." The application reconciler is therefore the only enforcement mechanism.

---

## In this codebase

- `src/services/todos/reconcileMeta.ts` → `reconcileTodoMetaForEntry()`.
- `src/services/database.ts` → `getTodoMetasByEntry`, `insertTodoMeta`, `deleteTodoMeta`.
- `src/services/todos/heuristicClassify.ts` → consulted before insert to set initial `type`.
- `src/services/todos/classify.ts` → fired async via `scheduleClassify` for ambiguous lines.

```
Pseudocode (reconcileTodoMetaForEntry):
  existing = getTodoMetasByEntry(entry.id)
  existingByTodoId = map of meta keyed by todoId
  currentIds = set of ids in entry.todos

  for each todo in entry.todos:
    if existingByTodoId has todo.id: continue       // matched, leave alone
    insertTodoMeta(newMetaFromHeuristic(todo))
    if heuristic == null AND not todo.done:
      scheduleClassify(todo.id, todo.text)          // fire LLM async

  for each meta in existing:
    if currentIds has meta.todoId: continue         // still in prose
    deleteTodoMeta(meta.todoId)                     // line gone → meta gone
```

---

## Elaborate

### Where this pattern comes from
JSON-in-relational hybrids are common in modern apps. Postgres has rich JSON operators; SQLite has them too. The trade is that you get one-row-per-document semantics with embedded structured data, but you lose schema-level constraints across that boundary. App-layer reconcilers are the standard answer.

### The deeper principle
**When the schema can't enforce an invariant, code must — and the enforcement must run on every relevant write.** The reconciler is what makes the JSON-array-plus-meta-table design honest. Without it, the system would silently drift.

### Where this breaks down
- Concurrent writes to the same entry where two reconcilers race. SQLite WAL serialises this for loopd; in a multi-writer Postgres setup you'd need explicit locking or compare-and-swap.
- Failures mid-reconcile that leave the gap permanently — but the next commit re-runs reconcile, so the gap heals.

### What to explore next
- [Two-pass matching](./04-two-pass-matching.md) → the pass that produces `todos_json` before reconcile runs.
- [02-dsa/02-reconcile-todo-meta](../02-dsa/02-reconcile-todo-meta.md) → execution trace.

---

## Tradeoffs

- **No FK** — gives: JSON column flexibility (array order is meaningful, no second table for ordering). Costs: integrity is on the app.
- **Self-healing reconciler** — gives: a missed run isn't catastrophic. Costs: between runs there can be silent inconsistency (an orphan meta row briefly).
- **Per-entry reconcile** — gives: each call is small (handful of todos). Costs: adding a new entry-level invariant means a new reconciler.
