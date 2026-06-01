# Information hiding and leakage

**Industry name(s):** Information hiding (Parnas 1972; APOSD ch. 5–6), leakage, temporal decomposition, knowledge edited twice
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

A *leak* is a fact about one module that another module is required to know — the knowledge has crossed a boundary that should have contained it. The cost shows up as "edit two files together or it breaks," and the silent variant is the worst (it compiles, runs, and corrupts state). APOSD's heuristic: every leak is a design smell; some are fixable, some are essentially complex and you accept the cost knowingly.

```
  Zoom out — where leaks live in buffr

  ┌─ UI layer ────────────────────────────────────────────┐
  │  components: largely leak-free                         │
  └──────────────────────┬────────────────────────────────┘
                         │
  ┌─ Service layer ──────▼────────────────────────────────┐
  │  ai/         clean — chains hide prompts + validation  │
  │  todos/      ★ THE 1:1 INVARIANT ★    ← we are here    │
  │              todos_json ↔ todo_meta knowledge known    │
  │              in reconcileMeta AND every writer         │
  │              that touches prose                        │
  │  threads/    smaller leak: slug-as-canonical           │
  │  sync/       updated_at semantic crosses many files —  │
  │              but properly contained inside the layer    │
  └──────────────────────┬────────────────────────────────┘
                         │
  ┌─ Storage ────────────▼────────────────────────────────┐
  │  SQLite cannot FK to a JSON-array element             │
  │  → the 1:1 FK must live in TS code, not the schema     │
  └───────────────────────────────────────────────────────┘
```

This file names the four leaks worth caring about in buffr — one essential (the 1:1 invariant, which has a documented reason), two accidental (the override-lock semantic, the prose-derivation rule), one clean (the sync columns, which are cross-cutting but properly localized to one layer).

## Structure pass

The axis for leakage is **state ownership**. Trace it across modules: where is a fact authored, where is it read, and how many places must agree?

```
  axis = "who owns this fact, and how many places must know it?"

  fact: "todos_json and todo_meta must be 1:1"
       │
       ▼
  authored in:  src/services/todos/reconcileMeta.ts
                (the enforcer of the invariant)
       │
       ▼
  read / acted on in:
   ─ src/services/database.ts        (writers must invoke reconcile)
   ─ src/services/ai/expand.ts       (expansion writes to a meta row)
   ─ app/journal/[date].tsx          (UI assumes 1:1 when rendering)
       │
       ▼
  the seam: there is no FK enforcing this. The knowledge IS the FK.
            Forget one writer → silent state drift.
```

A leak is load-bearing when changing the owning fact in one place doesn't force the dependent places to change too. Buffr's 1:1 invariant has that property exactly — it's the textbook leak.

## How it works

### Move 1 — the leak pattern

```
  every leak has the same shape

  ┌─ module A ──────┐                      ┌─ module B ──────┐
  │                 │   ─ knows fact F ─►   │                 │
  │  owns F         │                       │  depends on F    │
  │                 │   ◄── must edit ──    │                 │
  │                 │     together when     │                 │
  └─────────────────┘     F changes         └─────────────────┘
         ▲                                          ▲
         └─── two places that must agree ───────────┘
              changing only one = silent bug
```

The fix is information hiding: make F private to A (or to a layer that owns both A and B). When that's not possible — when the underlying machinery (here, SQLite) can't carry the constraint — the leak is essential, and the design must compensate (single enforcer, documented invariant, integration test). Buffr does the latter; concept 06 covers the error-handling style that goes with it.

### Move 2 — the four leaks, walked

**Leak 1 — the 1:1 invariant (essential; documented; mitigated).** SQLite cannot foreign-key to an element inside a JSON array column, so `entries.todos_json[i].id` cannot FK to `todo_meta.todo_id`. The invariant has to live in TypeScript. `reconcileMeta.reconcileTodoMetaForEntry()` is the single enforcer; every code path that writes prose must invoke it.

```
  the 1:1 leak — pseudocode

  // on prose commit (focus blur / screen leave):
  todoItems  ← scanTodos.scanTodosFromText(entry.text)   // derive from prose
  reconcile(todoItems, existingTodoMeta)                  // ★ MUST RUN ★
  entry.todos_json ← serialize(todoItems)
  database.updateEntry(entry)

  the leak: "must call reconcile" is a fact known by every caller of
  updateEntry that touches prose. Skip it → todos_json and todo_meta
  diverge. SQLite cannot enforce it; the design accepts the leak and
  centralizes the enforcer.
```

This leak is **essential** in APOSD's terms — the data model genuinely can't carry the constraint. The acceptance is principled: one enforcer, documented as Principle #1 of the 1:1 invariant in `docs/spec.md` and listed in `.aipe/project/context.md` as a non-negotiable.

**Leak 2 — the `user_overridden_type` semantic (accidental; partially fixable).** The override-lock flag's meaning is known in three places: `classify.ts` reads it to skip re-classification, `database.ts setTodoType()` writes `user_overridden_type = true` when the user manually changes the chip, and `reconcileMeta.ts` must NOT clear it on reconciliation. Three places that must agree.

```
  the override-lock leak — three places

  classify.ts:          if (meta.user_overridden_type) return meta.type;
  database.ts setTodoType:  user_overridden_type = true;
  reconcileMeta.ts:    preserve existing meta.user_overridden_type
                        (never overwrite via the reconcile path)

  the fix: deepen database.ts with a setLLMType() vs setUserType()
  distinction. Then user_overridden_type is set INSIDE the writer, not
  asked-for by callers. Two places shrink to one.
```

This leak is accidental — the data model could carry it differently (an enum `type_source: 'llm' | 'user'` with the lock derived). The current shape works but has a wider leak surface than needed.

**Leak 3 — prose-as-canonical for drops (essential; well-contained).** The marker syntax (`[]` for todos, `** food N kcal` for nutrition, `#tag` for thread mentions) is known by the scanners in `services/todos/`, `services/nutrition/`, `services/threads/`. The knowledge "what does the prose look like" leaks into each scanner — but it's *bounded* there. Outside services, nobody knows the marker syntax. That's contained leakage, which is the goal.

**Leak 4 — the sync columns (cross-cutting; properly localized).** `updated_at`, `synced_at`, `deleted_at` semantics are known in `database.ts` (writers stamp), `sync/push.ts` (dirty-filter reads), `sync/pull.ts` (server-time writes), `sync/conflict.ts` (LWW arbitration). Four files — but all in one layer, and the semantics are documented as principles in spec.md. This is not a leak; it's a **layer-scoped invariant**, which is what layered design buys you.

### Move 3 — the principle

A leak isn't a categorical bad — it's a cost that the design has to pay back somewhere. Essential leaks (the data model can't carry the constraint) get a single enforcer plus documentation. Accidental leaks (the design could carry it differently) get refactored. Cross-cutting facts confined to one layer aren't leaks — they're the reason the layer exists. The audit job is to tell the three apart.

## Primary diagram

```
  buffr's leaks — ranked by accidental-vs-essential

  ESSENTIAL (accepted; centrally enforced)
   ─ 1:1 invariant (todos_json ↔ todo_meta)
     SQLite cannot FK to JSON-array element
     enforcer: src/services/todos/reconcileMeta.ts
     documented: docs/spec.md §10 + context.md non-negotiable

   ─ prose-canonical for drops (markers in entries.text)
     scanners contain the leak inside services/

  ACCIDENTAL (refactor candidates)
   ─ user_overridden_type semantic
     known in classify.ts, database.ts setTodoType, reconcileMeta.ts
     fix: setLLMType() vs setUserType() distinction in database.ts

  LAYER-SCOPED (not a leak)
   ─ updated_at / synced_at / deleted_at trio
     known across sync/ and database.ts but contained in one layer
     this is what "layered design" buys you
```

## Implementation in codebase

### Essential leak — the 1:1 invariant

```
  src/services/todos/reconcileMeta.ts  (the enforcer, ~50 lines)

  export function reconcileTodoMetaForEntry(
    entryId, todoItems, existingMeta
  ) {
    // for each new TodoItem without meta → INSERT a meta row
    // for each removed TodoItem with meta → soft-delete the meta row
    // for each surviving TodoItem with meta →
    //   preserve user_overridden_type   ← ★ the override leak's mitigation ★
    //   preserve classifier_confidence
    //   keep type as-is unless prose changed materially
    //
    // this function is the ENTIRE enforcer of the invariant.
    // every caller that writes prose must invoke it.
  }
       │
       └─ the documentation lives in context.md as a non-negotiable.
          The "FK" is the contract embodied here. Skip the contract →
          silent state drift.
```

### Accidental leak — the override-lock

```
  the leak today (three places must agree)

  src/services/todos/classify.ts:           ~L30
    if (meta?.user_overridden_type === true) return meta.type;  ← read

  src/services/database.ts setTodoType:      ~L420
    UPDATE todo_meta SET type=?, user_overridden_type = TRUE     ← write

  src/services/todos/reconcileMeta.ts:        ~L60
    // preserve existing user_overridden_type — do not overwrite

  the fix: collapse to two

  src/services/database.ts:
    setLLMType(todoId, type)   ← INTERNAL: user_overridden_type = FALSE
    setUserType(todoId, type)  ← INTERNAL: user_overridden_type = TRUE

  then callers don't know the flag exists. classify.ts asks for "type",
  database.ts owns the lock semantic. One leak gone.
```

## Elaborate

The information-hiding framing comes from Parnas's 1972 paper *On the Criteria to Be Used in Decomposing Systems into Modules* — the founding text of modular software design — and is the load-bearing thread through APOSD chapters 5 and 6. Ousterhout's contribution is the practical heuristic of *naming leakage explicitly* as the cost, rather than just praising hiding as the virtue. Buffr's documented "Common pitfalls" list in `.aipe/project/context.md` is the leakage made visible — every entry is a leak that future contributors are warned about.

The essential vs accidental distinction comes from Fred Brooks's *No Silver Bullet* (1986). Brooks's framing is that some complexity is intrinsic to the problem domain; you can't refactor it away. Most software-design "smells" are accidental — but a fraction are essential, and treating them as accidental wastes effort. The 1:1 invariant in buffr is essential; the override-lock is accidental.

## Interview defense

**Q [mid]:** What's a leak in buffr's design, and what makes it essential vs accidental?

**A:** The 1:1 invariant between `todos_json` and `todo_meta` is essential — SQLite genuinely cannot FK to a JSON-array element, so the constraint can't live in the schema; it has to live in TypeScript (`reconcileMeta.ts`). The override-lock semantic (`user_overridden_type`) is accidental — three files must agree on its meaning today, but a refactor to `setLLMType()` vs `setUserType()` inside `database.ts` would collapse it to one. The audit job is telling them apart: essential gets a single enforcer + documentation; accidental gets refactored.

```
  essential vs accidental — the one-diagram answer

  ESSENTIAL:                        ACCIDENTAL:
  ┌────────────┐ leak ★             ┌────────────┐ leak ◐
  │ data model │ ─►  centrally       │ design     │ ─► refactor
  │ can't carry│     enforced +      │ could carry│    to hide
  │ constraint │     documented      │ differently│    inside writer
  └────────────┘                     └────────────┘

  one-line anchor: "essential gets a single enforcer; accidental gets refactored"
```

**Q [senior]:** When is a cross-file fact NOT a leak?

**A:** When it's confined to one layer that exists for that fact. The `updated_at`/`synced_at`/`deleted_at` trio in buffr crosses four files in `services/sync/` and one in `database.ts` — five files that agree on the semantics. But the agreement is contained inside one layer (sync), so the leak doesn't extend across architectural seams. That's the layered-design payoff — facts that look cross-cutting are actually layer-scoped. The check: would a caller *outside* the layer have to know it? If no, not a leak.

**Q [arch]:** How would you spot the next leak in this codebase?

**A:** Watch the `.aipe/project/context.md` "Common pitfalls" list grow. Every time a pitfall gets added, that's documentation acknowledging a leak. The audit is in the diff: which pitfalls are essential (must be documented because the constraint can't be enforced mechanically) and which are accidental (could be hidden inside a deeper module). The override-lock would be the next refactor; the 1:1 invariant stays as-is.

## Validate

### Level 1 — reconstruct the diagram

Draw the leak pattern (module A owns fact F → module B depends on F → must edit together).

### Level 2 — explain it out loud

In under 90 seconds: name buffr's essential leak and one accidental leak. Explain why the first stays and the second is a refactor.

### Level 3 — apply to a new scenario

A new contributor proposes a `due_at` column on `todo_meta` that the UI reads to sort todos. Trace the leak: which files know about `due_at`, and is it essential or accidental?

Verify by reading `src/services/todos/reconcileMeta.ts` (~L40–L80) and the documented "Common pitfalls" in `.aipe/project/context.md`.

### Level 4 — defend the decision

Defend or oppose: "The 1:1 invariant should be enforced by adding a stored-procedure trigger on Supabase that validates todos_json and todo_meta agree."

Reference `supabase/migrations/0001_initial_schema.sql` (the schema constraints today) and `src/services/todos/reconcileMeta.ts:L1–L120` (the TS enforcer).

## See also

- [`02-deep-vs-shallow-modules.md`](./02-deep-vs-shallow-modules.md) — the deep-module fix for the override-lock leak.
- [`04-layers-and-abstractions.md`](./04-layers-and-abstractions.md) — why the sync-columns trio is layer-scoped, not a leak.
- [`06-errors-and-special-cases.md`](./06-errors-and-special-cases.md) — what to do when leaks are essential and the constraint must live in code.
- [`08-red-flags-audit.md`](./08-red-flags-audit.md) — leakage as a red-flag checklist item.
