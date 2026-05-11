# The 1:1 invariant (and why it's not a foreign key)

**Industry name(s):** Application-enforced invariant, reconciler pattern
**Type:** Project-specific

> Every `TodoItem` in `entries.todos_json` has exactly one matching `todo_meta` row. SQLite can't FK to a JSON-array element, so the application reconciler is the enforcement.

**See also:** → [03-single-source-of-truth](./03-single-source-of-truth.md) · → [04-two-pass-matching](./04-two-pass-matching.md) · → [02-dsa/02-reconcile-todo-meta](../02-dsa/02-reconcile-todo-meta.md)

---

## Why care

Not every relationship between two pieces of data can be expressed with a foreign key. The moment one side lives inside a JSON column, inside a document, or inside a remote system, the database engine can't help you keep them in sync — there's no constraint to violate at write time. The integrity guarantee has to move out of the schema and into your code, and most teams discover that the hard way after their first orphan row leaks into production.

An application-enforced invariant is a rule that the database can't check, kept honest by a reconciler that periodically walks both sides and patches the diff. It belongs to the family of "eventual consistency between coupled stores" patterns — the same problem solved by Kubernetes controllers reconciling desired vs. actual state, by search indexes catching up to their source-of-truth tables, and by cache-invalidation workers. The trick is always: pick one side as authoritative, accept brief drift, and make the patch step idempotent. Here's how that actually works in this codebase.

---

## How it works

The reconciler runs after every `scanTodos`. Its inputs are the freshly-scanned `todos[]` and the existing `todo_meta` rows for that entry. Its output is a series of inserts and deletes that bring `todo_meta` back into 1:1 alignment.

Matched rows are left alone — that's how `type` (the classifier output), `expanded_md` (the AI expansion), `pinned`, and `user_overridden_type` survive prose edits. Insert paths that have a heuristic confidence skip the LLM classifier; ambiguous ones fire `scheduleClassify` async.

Why not an FK? `todos_json` is a JSON column on the `entries` row. Each TodoItem is an array element with its own UUID. SQLite has no syntax for "FK to the `id` field of an array element." The application reconciler is therefore the only enforcement mechanism. Here's the diagram of the whole flow.

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

## In this codebase

**Reconciler:**       `src/services/todos/reconcileMeta.ts` → `reconcileTodoMetaForEntry()` L48–L92 (with async-fire helper `scheduleClassify` L13–L46)
**SQLite helpers:**   `src/services/database.ts` — `getTodoMetasByEntry`, `insertTodoMeta`, `deleteTodoMeta` (the three calls inside the reconciler)
**Heuristic gate:**   `src/services/todos/heuristicClassify.ts` → `heuristicClassify()` L71–L102 — consulted on insert to set initial `type`
**LLM fallback:**     `src/services/todos/classify.ts` → `classifyTodo()` — fired async via `scheduleClassify` for ambiguous lines

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

We traded a schema-level guarantee for application-layer flexibility: SQLite would refuse to enforce 1:1 across the JSON/table boundary anyway, so the integrity work moved into TypeScript where it can also run the heuristic-then-LLM logic the schema never could.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (app reconciler)  │ Alternative (FK + cascade or │
│                  │                              │  embedded JSON meta)         │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Schema guarantee │ none — TypeScript enforces   │ FK + cascade enforced by DB  │
│                  │ via reconcileTodoMetaForEntry│ (but impossible — can't FK   │
│                  │ on every prose commit        │ to JSON-array element)       │
│ Read cost        │ entries.text small;          │ entries.* bloated by         │
│                  │ todo_meta queried separately │ embedded expanded_md (often  │
│                  │ when needed                  │ 100s of lines per todo)      │
│ Cross-entry      │ SQL on todo_meta: pinned=1,  │ JSON gymnastics — every      │
│ queries          │ type='bug' — first-class     │ aggregate query walks all    │
│                  │                              │ entries' JSON                │
│ Cloud-sync       │ per-table batches; clean     │ entries push carries full    │
│ shape            │                              │ todo_meta payload every time │
│ Failure recovery │ next commit re-runs and      │ FK constraint violation =    │
│                  │ heals (self-healing)         │ hard failure at write time   │
│ Complexity cost  │ ~150 LOC in reconcileMeta.ts │ would need triggers + regexp │
│                  │ + heuristic + scheduleClassify│extension + migration glue    │
│ Brief drift      │ allowed mid-reconcile        │ atomic — but only because    │
│ window           │ (heals next commit)          │ the alternative is impossible│
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

The 1:1 guarantee is no longer a schema fact — it's a TypeScript fact. `reconcileTodoMetaForEntry` (`src/services/todos/reconcileMeta.ts` L48–L92, ~45 LOC) plus `scheduleClassify` (L13–L46, ~33 LOC) is the only thing standing between drift and correctness. Any write path that scans prose but forgets to call the reconciler will leak orphans silently. We pay for this in two ways: in code review, every new write path has to be audited for "did you call the reconciler?", and in onboarding, a new contributor reads `reconcileMeta.ts` and asks "wait, why isn't this a foreign key?" — the answer takes the spec's Principle 11 paragraph to explain.

Between reconciler runs the data is briefly inconsistent. If a `[]` line is deleted at 10:00:00.000 and the screen blurs at 10:00:00.250, there's a 250ms window where the prose has 4 todos and the meta has 5. No UI surface reads during that window — but a synchronous crash dump would show the drift. We accept this because the next commit closes it.

A new entry-level invariant means a new reconciler. Today we have one (todos↔meta); adding "thread mentions must have a matching prose tag" would mean a parallel `reconcileMentions` (and we do have it, in `scanThreads.ts` L169–L230). Each new invariant adds a maintenance line item: someone must remember the reconciler exists when adding a new write path.

### What the alternative would have cost

The "obvious" alternative — FK with `ON DELETE CASCADE` — isn't actually available. SQLite has no syntax to FK from a side table to an element of a JSON column. So the alternative being weighed is *embedding* `todo_meta` as another JSON column on `entries`, eliminating the side table.

That path would have made every `SELECT * FROM entries` carry the full `expanded_md` payload for every todo on that entry. `expanded_md` can be 100+ lines of markdown per ambiguous todo; on a day with 8 todos the entry row would inflate from ~2 KB to 50+ KB. The dashboard's `getEntriesForDate` and the journal's autosave round-trip would both pay that cost on every read. Cross-entry queries like "show me all `pinned=1` todos" or "show me all `type='bug'` todos across the week" would become JSON traversals instead of indexed SQL — a 50× slowdown at the 100-entry scale.

Cloud sync would also suffer. The mirror pushes per-table rows; embedded meta would mean every entries-row push carries the entire meta payload, every time, even when only the prose changed. With per-table batches the meta delta is small; with embedded meta the smallest delta is "the whole row."

### The breakpoint

Fine until the app moves off SQLite. On a real RDBMS with rich triggers (Postgres `BEFORE INSERT`/`AFTER DELETE` plus generated columns) the reconciler could be inlined as triggers, with `regexp_matches` doing the heuristic in-database. At that point the application reconciler becomes redundant — the cost shifts from "TypeScript code we audit" to "trigger code that runs in the migration path." On SQLite it's not even close; on Postgres it would be a real choice.

### What wasn't actually a tradeoff

SQLite triggers with `json_each` weren't a real option. The reconciler needs to call `heuristicClassify` (regex against prose-shape patterns) and `scheduleClassify` (async LLM fire-and-forget) on insert. Triggers run inside the SQL engine — they can't reach into TypeScript to invoke an async network call. A trigger could enforce a *structural* 1:1 but couldn't run the type-classification logic that gives the meta row its value on insert. Without that logic the meta rows are empty placeholders, which defeats the point of having them.

---

## Tech reference (industry pairing)

### expo-sqlite

- **Codebase uses:** `expo-sqlite` (via `database.ts`) as the SQLite engine.
- **Why it's here:** the file frames the entire invariant design around `expo-sqlite`'s constraint: no FK to a JSON-array element, and regexp extensions not enabled by default — both SQLite-engine limitations that forced the app-layer reconciler.
- **Leading today:** `expo-sqlite` — `adoption-leading` for RN local DB, 2026.
- **Why it leads:** ships with the Expo SDK; battle-tested WAL mode; mirrors the SQLite C API directly with zero bridge cost for Expo projects.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding with no bridge cost; the perf-tier alternative for bare React Native projects.

---

## Summary

An application-enforced invariant is a rule the database can't check, kept honest by a reconciler that walks both sides and patches the diff — pick one side as authoritative, accept brief drift, and make the patch step idempotent. In this codebase `entries.todos_json` is a JSON array of TodoItems and `todo_meta` is a separate table keyed on `todoId`; after every `scanTodos`, `reconcileTodoMetaForEntry` in `src/services/todos/reconcileMeta.ts` loads existing meta, inserts what's missing (consulting `heuristicClassify` and firing `scheduleClassify` async on ambiguity), and deletes orphans whose `todoId` is no longer in prose. The constraint was that SQLite can't FK to an element of a JSON column, so the app code is the only integrity gate, and `todo_meta.expanded_md` is too large to embed in the entry's JSON without bloating every entry read. The cost is that integrity now lives in TypeScript instead of the schema, and a partial reconcile leaves orphans or missing meta rows briefly — acceptable because the next commit re-runs reconcile and heals the gap. A SQLite-trigger alternative was considered and rejected because triggers can't easily run the heuristic-then-LLM conditional logic the reconciler needs.

Key points to remember:
- `todos_json` (JSON array on `entries`) and `todo_meta` (separate table keyed on `todoId`) are kept 1:1 by `reconcileTodoMetaForEntry`, not by a foreign key.
- The reconciler runs after every prose scan; matched rows are left alone, preserving `type`, `expanded_md`, `pinned`, and `user_overridden_type` across edits.
- Lives in step 1 (Data model) and step 5 (Failure handling) of the system-design checklist.
- Self-healing — partial state is allowed because the next commit's diff sees the gap and patches it.
- The cost of "no FK" is that integrity moves out of the schema and into TypeScript, where a missed call site can silently drift until the next reconcile.

---

## Interview defense

### What an interviewer is really asking
Storing a JSON array on a row alongside a side table that should be 1:1 with the array elements is the kind of design that makes database engineers wince. The interviewer wants to know whether you understand what you're giving up (no FK, no `ON DELETE CASCADE`) and whether your enforcement strategy is principled — not "I'll remember to update both."

### Likely questions

[mid] Q: A user adds a new `[]` line. Walk me through what happens to `todo_meta`.

A: The prose commit fires `scanTodosFromText`, which produces a new `TodoItem` in the entry's `todos_json`. Then `reconcileTodoMetaForEntry` runs: it loads existing `todo_meta` for the entry, builds a Set of current `todoId`s from the new `todos_json`, and inserts a `todo_meta` row for each TodoItem id that doesn't have one yet. The initial `type` comes from `heuristicClassify`; if the heuristic returns null, `scheduleClassify` fires the LLM async. The user sees the `[]` immediately; the type lands a moment later when classification returns.

```
[new "[]" line lifecycle]

  user types "[] call mom"
        │
        ▼  commit boundary
  scanTodosFromText → new TodoItem{id:t-X, text:"call mom"} in todos_json
        │
        ▼
  reconcileTodoMetaForEntry
        │   existingByTodoId has t-X?  no
        ├── insertTodoMeta(t-X, type from heuristicClassify("call mom"))
        │      heuristic returns "todo" → row written with type="todo"
        │      (or returns null → row written, then scheduleClassify fires LLM async)
        ▼
  UI shows the [] immediately; type appears the moment classify returns
```

[senior] Q: Why not store `todo_meta` as another JSON column on `entries` and avoid the reconciler entirely?

A: Three reasons. First, `todo_meta.expanded_md` can be hundreds of lines of markdown — embedding it in the entry's JSON would bloat every read of the entry by a multiple. Second, the cloud sync layer pushes per-table; per-row JSON inflation makes batches awkward. Third, the meta table queries support filters like "all todos with `pinned = 1` across all entries" or "all todos of `type = 'bug'`" — those are SQL queries on a normal table; they'd be JSON gymnastics on an embedded column. The reconciler is the cost of separating identity (in JSON) from metadata (in a table); I think it's the right tradeoff.

```
                  Path taken (side table + reconciler)   Alternative (embedded JSON meta)
                  ──────────────────────────────────     ──────────────────────────────
entries row size  ~2 KB (prose only)                     ~50 KB (prose + expanded_md ×N)
SELECT * FROM     reads only what UI needs                always carries 100s lines/todo
 entries          (prose lazily joined to meta)          even when meta isn't displayed
pinned=1 query    SQL: WHERE pinned=1 — indexed          JSON walk across every entry
                                                          for every aggregate query
cloud-sync push   per-table delta — small                row-level — pushes full JSON
                                                          even when only prose changed
integrity glue    reconciler (~150 LOC)                  none, but performance bleeds
where the cost is one-time reading reconcileMeta.ts      every read of every entry
```

[arch] Q: How does the design handle a partial reconcile — say the app crashes mid-loop?

A: Self-healing on the next commit. If the reconciler inserts the meta row for todo A but crashes before todo B, the entry has a missing meta for B. On the next prose commit (which fires every focus blur, screen leave, save), `reconcileTodoMetaForEntry` runs again, loads existing meta, sees B is still missing, inserts it. The orphan-direction works the same way — if a `[]` line is deleted but the meta deletion didn't fire, the next commit notices the gap and soft-deletes. The design assumes commits are frequent and the system is allowed to be temporarily inconsistent.

```
At commit frequency dropping (e.g., long-form prose, no blur events):

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — prose autosaves every keystroke │
  └─────────────────────────────────────────────┘
              │
  ┌─ Commit triggers (focus blur / leave / save)┐
  │ assumes 10s+ frequency under normal use     │  ◀── BREAKS FIRST
  │ if user types for 30+ min without leaving   │     (drift window grows linearly;
  │ the screen, drift window grows              │     no self-heal until commit fires)
  └─────────────────────────────────────────────┘
              │
  ┌─ Reconciler (self-healing) ─────────────────┐
  │ idempotent — runs as many times as needed   │
  │ each run closes any gap the last one left   │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: SQLite supports JSON1 functions. You could use `json_each` + a trigger to enforce 1:1. Why didn't you?

A: I considered it. The block was that triggers in SQLite are not portable — they don't survive a schema migration cleanly, and they don't run the kind of conditional logic the reconciler needs (heuristic classify, scheduleClassify-on-ambiguous, soft-delete instead of hard-delete). A trigger would also have to run the heuristic regex inside SQLite, which means reaching for `regexp` extensions that aren't enabled by default in `expo-sqlite`. The application reconciler is more code, but it's TypeScript code with the same imports as the rest of the service layer; it's debuggable, testable, and changes ship via the normal code path, not a schema migration. If I were running on Postgres with rich trigger support, the answer might be different — but at this scale, the reconciler is the simpler tool.

```
                  Path taken (TS reconciler)             Suggested (SQLite trigger + json_each)
                  ──────────────────────────────         ──────────────────────────────────
heuristic gate    heuristicClassify(text) in TS          would need regexp extension enabled
                  imports + reads the same patterns      in expo-sqlite (not on by default)
LLM async fire    scheduleClassify → Haiku/4o-mini       cannot — trigger runs in SQL engine,
                                                          no fetch / no async
soft-delete       deleteTodoMeta stamps deleted_at       trigger could ON DELETE … but the
                                                          row needs deleted_at = now, not gone
migration story   ships with normal TypeScript changes   every change is a new migration
debugging         set a breakpoint, log to console       open sqlite3 CLI, EXPLAIN, hope
code surface      ~150 LOC                               ~50 LOC trigger + extension setup +
                                                          migration handler
where it pays back on Postgres with rich trigger lang.   today, on expo-sqlite, never
```

### One-line anchors
- "SQLite can't FK to a JSON-array element — that's the constraint, the reconciler is the response."
- "The reconciler runs after every prose scan; partial state is allowed because the next scan heals it."
- "Identity in JSON, metadata in a table — separation chosen for cloud-sync batching and SQL filterability."
- "Self-healing means missed reconciles aren't catastrophic — they're temporary inconsistencies the next commit closes."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the 1:1 invariant to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/reconcileMeta.ts:reconcileTodoMetaForEntry`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

You're called in to debug a user's broken state. They have an entry whose `todos_json` lists 4 ids `[t-A, t-B, t-C, t-D]`, but `todo_meta` for that entry has 3 rows: `[t-A, t-B, t-X]` — `t-X` is for a todo that was deleted from prose two commits ago, and `t-C/t-D` are missing. The user types a new keystroke. What does `reconcileTodoMetaForEntry` do, in order, on the next commit? Will every step be reachable in a single run, or does it take two?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/reconcileMeta.ts` L48–L92 to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/reconcileMeta.ts` to support what exists
→ Point to a SQLite-trigger-based alternative (which would need to live in `supabase/migrations/` and bypass the heuristic+LLM logic) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).

---
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram. Skipped layer labels — the diagram is a schema-shape illustration (JSON column vs side table) entirely within the storage layer, not a cross-layer composition.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for expo-sqlite.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.
