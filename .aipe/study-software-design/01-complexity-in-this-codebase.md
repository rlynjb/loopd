# Complexity in this codebase — the diagnostic

**Industry name(s):** Complexity (APOSD ch. 2), the three symptoms, cognitive load · change amplification · unknown unknowns
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

Okay — before we dive into any specific module or primitive, let's see where complexity actually *bites* in buffr. APOSD names three symptoms: change amplification (a single conceptual change ripples across many files), cognitive load (the module nobody wants to touch), and unknown unknowns (bugs hiding where you didn't know to look). All three show up here — but they're not evenly distributed. Some layers are clean; others are where the audit's later chapters will keep returning.

```
  Zoom out — buffr's layers, with complexity hotspots marked

  ┌─ UI layer (app/, src/components/) ──────────────────────┐
  │  largely shallow — routes + components, low complexity   │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Service layer (src/services/) ──────────────────────────┐
  │  ai/      five chains + provider toggle  (clean)         │
  │  todos/   prose scan → classify → expand → reconcile      │
  │  threads/ + nutrition/  same prose-scanner pattern       │
  │  sync/    ◀──── ★ HIGHEST COMPLEXITY ★                  │ ← we are here
  │           12 files (orchestrator, push, pull, conflict,   │
  │           firstPull, bootstrap, schedulePush, syncMeta,   │
  │           devActions, client, types, tables/*)            │
  │  database.ts  cross-cutting writer (sync side-effects)   │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Storage layer (SQLite + Supabase) ──────────────────────┐
  │  ten synced tables + sync_meta + sync_deletions          │
  └──────────────────────────────────────────────────────────┘
```

This file is the zoom-out for the whole guide. We're going to name the 2–3 highest-complexity hotspots by path, then the next seven concepts dive into the specific primitives — deep modules, leakage, layering, errors, readability — that explain *why* those hotspots concentrate complexity and what to do about them.

## Structure pass

Before walking how complexity manifests, read buffr's shape. We pick one axis — **failure** — and trace it down the stack, because complexity's three symptoms all converge at failure boundaries.

```
  axis = "where does failure originate, propagate, get contained?"

  ┌─ UI layer ─────────────────────────────────────────────┐
  │  failure originates? rarely — errors bubble up from    │
  │  hooks/services. UI layer is a propagator, not a       │
  │  source.                                               │
  └────────────────┬───────────────────────────────────────┘
                   │  seam (LOAD-BEARING)
                   │  failures cross from typed services
                   ▼  into UI as throws or rejected promises
  ┌─ Service layer ────────────────────────────────────────┐
  │  failure originates: AI chain throws · validate.ts     │
  │  throws · DB constraint violations · sync errors       │
  │  failure contains: validate.ts schema gate · soft      │
  │  delete · two-pass matching · the 1:1 invariant        │
  │  reconciler                                            │
  └────────────────┬───────────────────────────────────────┘
                   │  seam (THE silent-failure boundary)
                   │  sync/orchestrator success-only logging
                   ▼  hides errors-as-data here
  ┌─ Storage / Network ────────────────────────────────────┐
  │  failure originates: PostgREST errors returned as      │
  │  data, RLS denial, network drops, schema-not-exposed   │
  └────────────────────────────────────────────────────────┘
```

The seam between Service and Storage is where buffr's worst complexity hides — not in any single layer, but at the boundary, where errors that arrive as *data* (not exceptions) pass through a success-only log guard at `src/services/sync/orchestrator.ts:49,72` and become **invisible**. Two production freezes already fired through this seam (the RLS-drift incident → migration 0009; the PGRST106 schema-not-exposed incident after migration 0010). Both were unknown-unknowns — the bug class APOSD warns is most expensive — and both became unknowns precisely because complexity hid them at a boundary.

## How it works

### Move 1 — the three symptoms (the pattern)

APOSD's diagnostic frame: complexity isn't one thing — it's three observable symptoms. You measure complexity not by code volume but by how the code *feels* to change.

```
  the three symptoms of complexity

  ┌─ change amplification ──────────────────────────────────┐
  │  one conceptual change → many files touched              │
  │  measure: "to add X, I need to edit A, B, C, D, …"       │
  └─────────────────────────────────────────────────────────┘
                       │
                       ▼
  ┌─ cognitive load ────────────────────────────────────────┐
  │  reader holds many facts to understand one line          │
  │  measure: "before I can read this, I need to know …"     │
  └─────────────────────────────────────────────────────────┘
                       │
                       ▼
  ┌─ unknown unknowns ──────────────────────────────────────┐
  │  bug paths you don't even know to test or look for       │
  │  measure: production surprises whose existence wasn't    │
  │  predictable from reading the code                       │
  └─────────────────────────────────────────────────────────┘

  unknown unknowns are the worst — you cannot defend against
  what you cannot see. The other two at least show themselves.
```

### Move 2 — symptom by symptom, walking buffr

**Change amplification — the documented "Common pitfalls" in context.md.** Buffr's `.aipe/project/context.md` literally enumerates change-amplification cases as pitfalls — and that's a real software-design signal: when contributors have to be *warned* about which files to touch together, the design has scattered one decision across too many places.

```
  example: "adding a column to todo_meta"

  one conceptual change → six file edits

  1. update mapper in src/services/database.ts
  2. update insertTodoMeta(...)
  3. update updateTodoMeta(...)
  4. update TodoMetaRow in src/services/sync/tables/todoMeta.ts
  5. write a Supabase migration
  6. ensure defaults round-trip on legacy rows

  the pitfall isn't the count; it's that NONE of these are
  enforced by the compiler. Forget one → silent breakage.
```

The fix at the design level: collapse the knowledge into fewer places. Either generate the mapper from the schema (single source of truth), or make `database.ts` deep enough that adding a column requires touching only one mapper function. That's exactly what APOSD chapter 4 (deep modules) prescribes — covered in concept 02.

**Cognitive load — `src/services/sync/`.** Twelve files (orchestrator, push, pull, conflict, firstPull, bootstrap, schedulePush, syncMeta, devActions, client, types, tables/*). Each *individual* file is small (under 200 lines, single-purpose) — that's not the cost. The cost is that to understand any one sync behavior you have to hold the whole engine in your head: the dirty-filter cursor (`updated_at > synced_at`), the LWW resolution rule, the server-time RPC, the per-table REGISTRY, the success-only log guard. The complexity is *structural* — it's distributed across files at the boundary between this layer and Storage.

**Unknown unknowns — the silent-error guard.** This one is the most expensive class APOSD warns about, and it fires *right here* in two production-confirmed cases:

```
  the bug class: errors returned as data, swallowed by a success-only log

  src/services/sync/orchestrator.ts:49    if (r.succeeded > 0 || r.failed > 0)
                            :72            if (r.applied > 0 || r.fetched > 0)
                                           ── log only when something happened

  PostgREST returns an error in the response body (NOT a throw)
  → r.succeeded = 0, r.failed = 0
  → log guard is false
  → nothing prints; nothing alerts
  → sync silently froze; reads still local-canonical so app FEELS fine

  two production fires:
   ─ RLS drifted on (dashboard toggle) → auth.uid() NULL under anon key
     → every push/pull denied → 0/0 result → silent freeze → 0009 rolled back
   ─ migration 0010 namespaced tables to `buffr` schema; schema not in
     Supabase's exposed-schemas list → PGRST106 → 0/0 result → silent freeze
```

Both bugs fit APOSD's definition of unknown unknowns perfectly: the failure paths were not discoverable from reading the code; they emerged only when production fired. The architectural fix is one line — log on `r.error`, not just on counts. The lesson generalizes to every error-as-data path: where buffr handles errors *as values*, the log/observability path must reflect that the value can be an error.

### Move 3 — the principle

Complexity isn't measured in lines of code; it's measured in **the three symptoms**: how many files break together, how much context is required to read one line, and how many bugs hide where you didn't think to look. Buffr's hotspots are the cross-cutting concerns (sync layer's seam to storage) and the cross-file invariants (the 1:1 todo-meta-to-todos rule, the change-amplification pitfalls in context.md). Every later chapter of this guide names a specific primitive that, applied to a specific buffr file, would reduce one of those symptoms.

## Primary diagram

```
  buffr's complexity map — the three highest-density hotspots

  ┌──────────────────────────────────────────────────────────────┐
  │  HOT (load-bearing complexity)                                │
  │   1. src/services/sync/orchestrator.ts:49,72                  │
  │      ─ success-only log guard; unknown-unknown class           │
  │      ─ already fired twice in production                       │
  │      ─ fix: log on r.error, not just on counts                 │
  │                                                              │
  │   2. src/services/todos/reconcileMeta.ts                      │
  │      ─ enforces 1:1 invariant; cross-file knowledge           │
  │      ─ change amplification on schema changes                  │
  │      ─ fix: generate mappers from schema OR deepen database.ts │
  │                                                              │
  │   3. src/services/database.ts                                 │
  │      ─ cross-cutting bookkeeping (updated_at/deleted_at/      │
  │        synced_at + schedulePush) for every synced write        │
  │      ─ cognitive load: contributors must remember 6 steps     │
  │      ─ fix: deepen — synced-write helper that does all 6      │
  │                                                              │
  ├──────────────────────────────────────────────────────────────┤
  │  WARM (manageable but worth a look)                           │
  │   ─ src/services/sync/ as a whole — structural complexity     │
  │   ─ provider-dispatch blocks repeated in five chain files     │
  ├──────────────────────────────────────────────────────────────┤
  │  COOL (clean)                                                 │
  │   ─ src/services/ai/{summarize,caption,expand,classify,       │
  │     interpret}.ts — each chain is single-purpose, deep         │
  │   ─ app/ + src/components/ — thin, well-layered                │
  │   ─ src/types/ — interface declarations, doing their job       │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

Three concrete hotspots, with file:line evidence.

### Hotspot 1 — orchestrator.ts:49 and :72 (the silent-error guard)

**Use case in buffr:** every cloud sync operation runs through `pushAll()` and `pullAll()` in `src/services/sync/orchestrator.ts`. Both functions iterate the 10-table REGISTRY, call per-table `pushTable()` / `pullTable()`, and log the result. The log guard is success-only.

```
  src/services/sync/orchestrator.ts  (lines ~48–55, the push log guard)

  try {
    const r = await pushTable(table);           ← per-table dispatch
    results.push(r);
    if (r.succeeded > 0 || r.failed > 0) {       ← ★ THE SILENT-ERROR GUARD ★
      console.log(`[buffr sync] push ${r.tableName}: ${r.succeeded} ok, ${r.failed} failed`);
    }
  } catch (err) {                                 ← only catches THROWS, not
    const msg = err?.message ?? String(err);      ── errors-returned-as-data
    console.warn(`[buffr sync] push ${table.tableName} threw:`, msg);
    results.push({ tableName: table.tableName, attempted: 0, succeeded: 0, failed: 0, error: msg });
  }
       │
       └─ when pushTable returns normally with succeeded=0 AND failed=0
          (the exact shape of a PGRST106 error or an RLS-denial), neither
          the if-log fires nor the catch-warn fires. Result: silent freeze.
```

**The fix:** add `|| r.error` to the guard. Ten-line change; converts the entire class of "errors returned as data" from invisible to visible.

### Hotspot 2 — reconcileMeta.ts (the 1:1 invariant + change amplification)

**Use case in buffr:** every time prose is committed (focus blur, screen leave), `scanTodos.scanTodosFromText()` derives a fresh `TodoItem[]` from the `entries.text` source-of-truth. `reconcileMeta.reconcileTodoMetaForEntry()` then keeps `todo_meta` rows in 1:1 correspondence with that array.

```
  src/services/todos/reconcileMeta.ts  (the cross-file invariant)

  the 1:1 invariant must hold across:
   ─ entries.todos_json    (the scanned TodoItem[])
   ─ todo_meta             (one row per TodoItem, joined by todo_id)

  SQLite cannot FK to a JSON-array element, so the FK is enforced
  in TypeScript by reconcileMeta. That makes reconcileMeta the
  single point of truth for this invariant — DEEP module shape.

  but the bookkeeping leaks: callers of database.ts MUST bump
  updated_at + schedulePush() AND call reconcileMeta when the
  prose changes. Skip one → silent drift.
```

**The fix:** combine the writer with the reconciler. A single `commitEntry(...)` deep function in `database.ts` that does prose-write + scan + reconcile + updated_at + schedulePush — six steps collapsed into one interface. Concept 02 (deep modules) names this exact move; concept 05 (pull complexity downward) names which knobs callers should stop having to remember.

### Hotspot 3 — database.ts (cross-cutting bookkeeping)

**Use case in buffr:** every write to a synced table must (1) bump `updated_at`, (2) call `schedulePush()`, (3) on delete, set `deleted_at` instead of removing, (4) preserve `synced_at` if it was already stamped. Forget any → sync drift.

```
  src/services/database.ts  (the bookkeeping cluster)

  insertEntry(...)    ─┐
  updateEntry(...)     │  each must:
  insertNutrition(...) │   ─ stamp updated_at to now()
  updateNutrition(...) │   ─ call schedulePush()    ◀── EASY TO FORGET
  insertHabit(...)     │   ─ NEVER write deleted_at = NULL
  setTodoType(...)     │     on update (preserve tombstones)
  ...                  │   ─ never mutate synced_at directly
                      ─┘     (only the push path stamps it)
```

**The fix:** deepen `database.ts` further with a `withSyncBookkeeping(table, op, body)` wrapper that does the four mandatory steps automatically. Then `insertEntry` etc. only describe the entity-specific logic.

## Elaborate

Ousterhout's three symptoms are diagnostic, not prescriptive — they tell you *where* complexity hides, not *how* to fix it. The rest of this guide walks the prescriptive primitives (deep modules, information hiding, layering, pulling complexity downward, defining errors out) that, applied to the specific hotspots above, would reduce each symptom. Read this concept as the index; read the next seven for the toolkit.

The complexity-as-three-symptoms framing comes from *A Philosophy of Software Design* chapter 2 (Ousterhout 2018, 2nd ed 2021). For the conceptual depth, read the chapter; this guide's value is the buffr-specific findings, which the book doesn't have.

## Interview defense

**Q [mid]:** What's the worst design smell in this codebase right now?

**A:** The success-only log guard in `src/services/sync/orchestrator.ts:49` and `:72`. It's two lines that turned two production sync failures into invisible failures — the RLS-drift freeze and the PGRST106 schema-not-exposed freeze. Both are unknown-unknowns by APOSD's definition, and both share one root cause: errors that arrive as *data* (not exceptions) pass through a guard that only logs when work *happened*. The fix is ten lines; the impact would be every future error-as-data failure becoming visible immediately.

```
  the worst smell — one diagram

  ┌─ today ──────────────────────┐    ┌─ after fix (10 LOC) ─────────┐
  │  if (succeeded || failed)    │    │  if (succeeded || failed ||  │
  │    log(...)                   │    │      r.error)                │
  │  ▲                            │    │    log(...)                  │
  │  zero counts + error-as-data │    │  ▲                            │
  │  = silent                     │    │  every error path visible    │
  └──────────────────────────────┘    └──────────────────────────────┘

  one-line anchor: "log on r.error too — silence at a boundary IS the bug class"
```

**Q [senior]:** Where does change amplification hurt most in buffr?

**A:** Adding a column to `todo_meta` — it's a six-file edit, none enforced by the compiler. The context.md file literally documents this as a "Common pitfall" — which is itself a software-design signal: when contributors need to be warned about cross-file changes, the design has scattered one decision across too many places. The fix is deepening `database.ts` to own the mapper-and-bookkeeping shape — covered in concept 02.

**Q [arch]:** If you could only fix ONE thing about buffr's design, which would it be and why?

**A:** Wrap the sync orchestrator's per-table dispatch in a `withSyncTelemetry` helper that fires on any non-zero outcome (success OR failure OR error). It's the single highest-leverage change because (1) it's small, (2) it eliminates an entire unknown-unknown bug class, (3) it pays back the next time PostgREST returns an error as data — which will happen again. Most refactors trade complexity for capability; this one trades nothing for an entire bug class.

## Validate

### Level 1 — reconstruct the diagram

Sketch the three-symptom diagram (change amplification → cognitive load → unknown unknowns) and place buffr's three hotspots on it.

### Level 2 — explain it out loud

In under 90 seconds: name the three symptoms, give a buffr example of each (the column-add for change amplification, the sync layer for cognitive load, the silent-error guard for unknown unknowns).

### Level 3 — apply to a new scenario

A new contributor adds a "due_at" column to `todo_meta`. Walk what they'd need to edit (use the context.md "Common pitfalls" list to verify). What APOSD primitive would let them skip half of it?

Open `.aipe/project/context.md` ("Common pitfalls" section) and verify your answer against the documented six-file edit.

### Level 4 — defend the decision

Defend or oppose: "The sync layer's complexity is essential complexity (the problem is inherently hard), not accidental complexity. There's no design move that simplifies it."

Reference the code at `src/services/sync/orchestrator.ts:49,72` and the `withSyncTelemetry`-helper proposal above.

## See also

- [`02-deep-vs-shallow-modules.md`](./02-deep-vs-shallow-modules.md) — the prescriptive primitive for hotspots 2 and 3.
- [`03-information-hiding-and-leakage.md`](./03-information-hiding-and-leakage.md) — the leakage that the 1:1 invariant requires.
- [`08-red-flags-audit.md`](./08-red-flags-audit.md) — the consolidated checklist where these three hotspots appear ranked.
- `.aipe/study-system-design-dsa/01-system-design/07-cloud-sync-mirror.md` — the system-altitude view of the sync layer (the architecture, not the design smells).
