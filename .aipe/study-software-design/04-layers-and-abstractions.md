# Layers and abstractions

**Industry name(s):** Layering (APOSD ch. 7), pass-through methods, adjacent layers same abstraction
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

A layer earns its place by offering a *different* abstraction than the layer next to it — different vocabulary, different units, different concerns. When two adjacent layers offer the same abstraction, the inner one is a pass-through: it forwards calls without adding semantic value. APOSD's heuristic: every method should do something a caller couldn't do equivalently by calling the next layer directly. Pass-through methods are the most common form of accidental complexity.

```
  Zoom out — buffr's layer stack, with abstraction shifts marked

  ┌─ UI (app/, src/components/, src/hooks/) ────────────┐
  │  abstraction: screens, components, state hooks      │
  │  ▼ shift                                            │
  └─────────────────────────────────────────────────────┘
  ┌─ Service (src/services/) ───────────────────────────┐
  │  ai/      abstraction: chains (prompt + validate)    │
  │  todos/   abstraction: prose scan, classify, reconcile│
  │  sync/    abstraction: dirty filter, push/pull       │
  │  database.ts  abstraction: typed per-entity writers  │
  │  ▼ shift                                            │
  └─────────────────────────────────────────────────────┘
  ┌─ Storage (SQLite + Supabase) ───────────────────────┐
  │  abstraction: tables, queries                       │
  └─────────────────────────────────────────────────────┘
```

This file inventories buffr's layers and checks the shifts: where does the abstraction genuinely change, where do two adjacent layers offer the same thing.

## Structure pass

Pick the **dependency** axis — where do calls go? Trace it across buffr's stack.

```
  axis = "who calls whom; does each call cross an abstraction shift?"

  UI screen (editor/[date].tsx)
   │  call: handleSave(text)
   ▼
  hook (useEntries) — does it add value or forward?     ← THE INSPECTION POINT
   │  call: database.updateEntry(id, text)
   ▼
  service (database.ts) — different vocabulary: SQL row
   │  call: sqlite.execAsync(...)
   ▼
  storage (SQLite) — different vocabulary: bytes
```

The seam between UI hooks and services is where pass-throughs are most likely. If a hook just calls a service with the same args and returns the same value, it's a pass-through; if it adds state subscription, derived state, or caching, it earns its place.

## How it works

### Move 1 — the pass-through shape (the pattern)

```
  pass-through method — interface and body have the same shape

  ┌─ caller ──────┐    "do X(a, b)"    ┌─ shallow layer ─┐
  │  saveEntry()  │ ─────────────────► │ ─►  next.do_X(a,b)│
  └───────────────┘                    │ ─►  return       │
                                       └──────┬───────────┘
                                              │
                                              ▼
                                       ┌─ real work here ─┐
                                       │  database.do_X    │
                                       └──────────────────┘

  the shallow layer added no abstraction, no validation, no state.
  the caller could have skipped it. it exists only to be named.
```

### Move 2 — buffr's layers, walked

**UI → hooks shift.** Hooks in `src/hooks/` either add subscription-and-state (legitimate, react-pattern earning) or they're pass-throughs to services. The right test: does the hook return state that changes over time, or does it just forward a one-shot call?

```
  legitimate hook — useEntries() (~simplified)

  function useEntries(date) {
    const [entries, setEntries] = useState([]);
    useEffect(() => {
      database.getEntries(date).then(setEntries);
      // subscribes to DB-changed event → re-fetch on remote pull
    }, [date]);
    return entries;
  }
       │
       └─ abstraction shift: hook returns LIVE state; service returns
          one-shot promise. The hook adds subscription, which the caller
          couldn't trivially do itself. Earns its place.

  pass-through hook — hypothetical useDeleteEntry()

  function useDeleteEntry() {
    return (id) => database.softDeleteEntry(id);   // ← no value added
  }
       │
       └─ no state, no subscription, just a forwarder. The component
          could call database.softDeleteEntry(id) directly.
          This kind of hook IS a pass-through; refactor target.
```

**Service layer internal shifts.** Inside `src/services/`, each sub-directory adds a distinct abstraction: `ai/` offers chains (prompt + validation), `todos/` offers prose-scan-and-classify, `sync/` offers dirty-filter dispatch. The shifts are real.

**`database.ts` → SQLite shift.** The biggest shift in the codebase. Callers ask for `insertEntry(text)`; `database.ts` translates to a parameterized SQL statement with bookkeeping columns. This is a genuine abstraction shift (typed entities → SQL rows) — the layer's existence is justified.

**Sync internal layers.** `orchestrator.ts → push.ts/pull.ts → tables/{entries,projects,...}` is a three-level stack. Each level adds something: orchestrator runs the REGISTRY loop; push/pull run the batched cursor; tables/* map between local row shape and cloud row shape. Three real abstraction shifts; no pass-through.

### Move 3 — the principle

A layer earns its place when calling code below it would require materially more code, different vocabulary, or both. Layers that just rename arguments are pass-throughs; merge them upward. The audit smell is uniform: read the layer's interface, then read the next layer's interface, and ask "did the vocabulary actually change?" If not, the inner layer is dead weight.

## Primary diagram

```
  buffr's abstraction shifts — what each layer genuinely offers

  UI screen / component
    abstraction: "render this entry"
              │
              ▼  shift: declarative render → imperative state subscription
  hook (useEntries / useProject / useDayTitle)
    abstraction: live React state from local DB
              │
              ▼  shift: state subscription → one-shot domain operation
  service (database.ts / scanTodos.ts / classify.ts / pushAll())
    abstraction: typed domain entities + business rules
              │
              ▼  shift: typed entity → parameterized SQL row or REST call
  storage (expo-sqlite, Supabase)
    abstraction: bytes on disk, HTTP messages on wire

  EVERY shift is a real one. No pass-through layer.
  ─ Risk area: hooks. Any hook that doesn't subscribe is a pass-through.
    Audit `src/hooks/*` against this test on the next round.
```

## Implementation in codebase

### Real abstraction shifts — the good kind

```
  src/services/ai/summarize.ts (the chain layer)

  export async function summarize(
    entry: Entry, lastNDays: Entry[]
  ): Promise<AISummary> {
    const messages = buildSummaryPrompt(entry, lastNDays);   ← prompt as data
    const parsed = await provider.callModel({                ← HTTP boundary
      model, messages, tool: summaryTool
    });
    return validate.validateAISummary(parsed);               ← typed result
  }
       │
       └─ caller asks "summarize this entry"; the chain hides prompt
          construction, the provider HTTP call, and the schema validation.
          Three abstractions collapsed into one verb. Layer earns its
          place decisively.
```

### The audit target — pass-through hooks

Audit step (not yet done by the contributor): walk `src/hooks/*.ts`, classify each as legitimate (returns state, adds subscription) or pass-through (forwards one call to one service function). For each pass-through: inline it into the component, or convert it to a query-cache hook (React Query / SWR style) that adds memoization and is genuinely deep.

```
  the inspection pattern

  for each hook in src/hooks/:
    does it return live state?       ← yes → legitimate
    does it subscribe to events?      ← yes → legitimate
    does it transform values?         ← yes (non-trivially) → legitimate
    does it just return a callback     ← yes → PASS-THROUGH; inline or upgrade
    that calls a service?
```

## Elaborate

The pass-through critique comes from APOSD chapter 7 — Ousterhout's main complaint about over-modular codebases. The pass-through anti-pattern is the indirect cousin of classitis: where classitis adds many shallow classes, pass-through adds many shallow layers. Both add interface surface without depth.

The "layers must offer different abstractions" rule has older roots — Dijkstra's *THE* operating system (1968) and Parnas's modular decomposition (1972). The modern lesson is that layering is a *constraint* on the design, not a free virtue: a layer that doesn't shift abstraction is a tax on every reader.

## Interview defense

**Q [mid]:** When does a layer NOT earn its place?

**A:** When calling the next layer down would require the same vocabulary, the same arguments, and the same return shape. The classic case is a hook that just returns a callback wrapping one service function — no state, no subscription, no transformation. If the component could call the service directly with no loss, the hook is a pass-through.

```
  pass-through test — one diagram

  ┌─ caller ──┐ ─► ┌─ candidate layer ─┐ ─► ┌─ inner ──┐
  │           │    │  forward verbatim  │    │  do_X(a,b)│
  └───────────┘    └────────────────────┘    └──────────┘
                          ▲
                          │  if NO new abstraction here,
                          │  the layer is dead weight.

  one-line anchor: "every layer should change vocabulary, units, or both"
```

**Q [senior]:** Are buffr's layers all earning their place?

**A:** The service-layer internal shifts are real — `ai/` adds chains, `todos/` adds scan-and-classify, `sync/` adds dirty-filter dispatch, `database.ts` adds typed-entities-over-SQL. The sync layer has three real internal levels (orchestrator → push/pull → tables/*), each with its own vocabulary. The audit target is `src/hooks/` — any hook that doesn't subscribe or transform is a pass-through. I haven't done the per-hook walk yet; that's the next-round work.

**Q [arch]:** How do you stop pass-through layers from accumulating?

**A:** Review every new layer with one question: "does this change vocabulary, units, or both?" If the answer is "well, sort of," the layer doesn't exist for an abstraction reason — it exists because someone wanted a place to hang a name. Merge it upward. The discipline is asking the question every time, not catching pass-throughs after they accumulate.

## Validate

### Level 1 — reconstruct the diagram

Sketch buffr's four layers (UI → hooks → services → storage) with one shift arrow per boundary, labelling what each shift offers.

### Level 2 — explain it out loud

In under 90 seconds: explain why `database.ts` is a legitimate layer above SQLite, and what the test would be for whether a hook in `src/hooks/` earns its place.

### Level 3 — apply to a new scenario

A new contributor proposes a `src/services/api/` layer that wraps `src/services/database.ts`'s calls with a typed `Response<T>` envelope. Pass-through or genuine shift?

Open one of the existing service files (`src/services/ai/summarize.ts`) and verify the test against it before deciding.

### Level 4 — defend the decision

Defend or oppose: "Every service function should be exported through a hook — that's the React way."

Reference the test from Move 3 and your reading of `src/hooks/*`.

## See also

- [`02-deep-vs-shallow-modules.md`](./02-deep-vs-shallow-modules.md) — pass-throughs are the layer-level cousin of shallow modules.
- [`05-pull-complexity-downward.md`](./05-pull-complexity-downward.md) — pass-throughs often appear because complexity was pushed up to callers.
- [`08-red-flags-audit.md`](./08-red-flags-audit.md) — pass-through as a checklist item.
