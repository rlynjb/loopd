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

---

## Interview defense

### What an interviewer is really asking
Storing a JSON array on a row alongside a side table that should be 1:1 with the array elements is the kind of design that makes database engineers wince. The interviewer wants to know whether you understand what you're giving up (no FK, no `ON DELETE CASCADE`) and whether your enforcement strategy is principled — not "I'll remember to update both."

### Likely questions

[mid] Q: A user adds a new `[]` line. Walk me through what happens to `todo_meta`.

A: The prose commit fires `scanTodosFromText`, which produces a new `TodoItem` in the entry's `todos_json`. Then `reconcileTodoMetaForEntry` runs: it loads existing `todo_meta` for the entry, builds a Set of current `todoId`s from the new `todos_json`, and inserts a `todo_meta` row for each TodoItem id that doesn't have one yet. The initial `type` comes from `heuristicClassify`; if the heuristic returns null, `scheduleClassify` fires the LLM async. The user sees the `[]` immediately; the type lands a moment later when classification returns.

[senior] Q: Why not store `todo_meta` as another JSON column on `entries` and avoid the reconciler entirely?

A: Three reasons. First, `todo_meta.expanded_md` can be hundreds of lines of markdown — embedding it in the entry's JSON would bloat every read of the entry by a multiple. Second, the cloud sync layer pushes per-table; per-row JSON inflation makes batches awkward. Third, the meta table queries support filters like "all todos with `pinned = 1` across all entries" or "all todos of `type = 'bug'`" — those are SQL queries on a normal table; they'd be JSON gymnastics on an embedded column. The reconciler is the cost of separating identity (in JSON) from metadata (in a table); I think it's the right tradeoff.

[arch] Q: How does the design handle a partial reconcile — say the app crashes mid-loop?

A: Self-healing on the next commit. If the reconciler inserts the meta row for todo A but crashes before todo B, the entry has a missing meta for B. On the next prose commit (which fires every focus blur, screen leave, save), `reconcileTodoMetaForEntry` runs again, loads existing meta, sees B is still missing, inserts it. The orphan-direction works the same way — if a `[]` line is deleted but the meta deletion didn't fire, the next commit notices the gap and soft-deletes. The design assumes commits are frequent and the system is allowed to be temporarily inconsistent.

### The question candidates always dodge
Q: SQLite supports JSON1 functions. You could use `json_each` + a trigger to enforce 1:1. Why didn't you?

A: I considered it. The block was that triggers in SQLite are not portable — they don't survive a schema migration cleanly, and they don't run the kind of conditional logic the reconciler needs (heuristic classify, scheduleClassify-on-ambiguous, soft-delete instead of hard-delete). A trigger would also have to run the heuristic regex inside SQLite, which means reaching for `regexp` extensions that aren't enabled by default in `expo-sqlite`. The application reconciler is more code, but it's TypeScript code with the same imports as the rest of the service layer; it's debuggable, testable, and changes ship via the normal code path, not a schema migration. If I were running on Postgres with rich trigger support, the answer might be different — but at this scale, the reconciler is the simpler tool.

### One-line anchors
- "SQLite can't FK to a JSON-array element — that's the constraint, the reconciler is the response."
- "The reconciler runs after every prose scan; partial state is allowed because the next scan heals it."
- "Identity in JSON, metadata in a table — separation chosen for cloud-sync batching and SQL filterability."
- "Self-healing means missed reconciles aren't catastrophic — they're temporary inconsistencies the next commit closes."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
