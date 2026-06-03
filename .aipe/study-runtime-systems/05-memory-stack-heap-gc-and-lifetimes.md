# Memory, stack, heap, GC, and lifetimes — Hermes' contribution
## Industry name(s): generational GC, V8/Hermes memory model · Type: Foundational

> Hermes uses a generational GC with low-pause minor collections. JS objects live on the heap; primitives live where they're used. Buffr never explicitly manages memory; large strings (entries.text) are the only thing that could pressure the heap.

## Zoom out, then zoom in

```
  WHAT BUFFR CARES ABOUT             WHAT BUFFR DOESN'T

  ─ large string allocations         ─ explicit free()
   (entries.text, JSON blobs)        ─ stack vs heap decisions
  ─ object retention via closures    ─ pointer arithmetic
  ─ React component lifetime          ─ manual lifetime tracking
```

Zoom in: in a single-user daily journal, the heap pressure is minimal. The largest objects are JSON-parsed entry meta blobs (~kB each) and a handful of in-memory caches. GC is effectively invisible.

## Structure pass

```
  layers   ─ allocation ─ retention ─ collection
  axes     ─ short-lived vs long-lived
             ─ pressure (heap growth rate)
```

## How it works

### Move 1 — generational GC works well for short-lived

```
  Hermes' young generation is small + fast to collect.
  most function-local allocations die before promotion.
  long-lived objects (the SQLite handle, React state) are
  promoted once and not touched.
```

### Move 2 — retention is what bites

```
  a closure capturing a large array prevents that array from GC.
  in buffr: be careful with caches that grow unbounded.
   ai_summaries is row-stored (DB-side), not in-memory; safe.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ Hermes' GC is good. retention via closures or    │
   │ module-level caches is the only realistic memory │
   │ failure mode at single-user scale. periodically  │
   │ profile memory via dev tools if any feature      │
   │ holds large data structures in JS.                │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

No explicit memory management anywhere. Watch for:

```ts
// pattern to watch
const cache = new Map<string, BigThing>();   // module-level; grows forever
// ★ unless bounded, this is a leak
```

Buffr's caches are DB-side (`ai_summaries` table), so this trap doesn't fire.

## Elaborate

The "GC is invisible" property holds at single-user scale. The day buffr does on-device ML (loading a model into memory), the GC and memory pressure conversation changes.

## Interview defense

**Q [mid]:** What's Hermes' GC behavior?

**A:** Generational, low-pause. Short-lived allocations die in the young generation quickly. Long-lived objects are promoted once.

**Q [senior]:** What would cause a memory issue in buffr?

**A:** An unbounded in-memory cache. Today there isn't one — caches are DB-side. If a feature added one, it'd need bounding (LRU or TTL).

## Validate

### Level 1 — explain generational GC.

### Level 2 — name the closure-retention trap.

### Level 3 — apply: an LRU cache for chain prompts. How big? Bounded by count, evict on insert.

### Level 4 — defend: "Add an in-memory cache layer above the DB." Only if profiling shows DB hits are the bottleneck.

## See also

- `01-runtime-map.md`
- `04-shared-state-races-and-synchronization.md`
- `../study-performance-engineering/audit.md`
