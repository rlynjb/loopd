# Runtime-systems red flags — the ranked checklist
## Industry name(s): runtime review checklist · Type: Audit summary

> Buffr's runtime is simple — one JS thread + native I/O. Most flags are LOW or N/A. The three worth naming: unbounded fan-out in classify, no cancellation propagation, and no explicit chain timeout discipline.

## Zoom out, then zoom in

```
  top three moves (ranked)
  ─────────────────────────────────────────────────────────
  1. bound classify fan-out via p-limit(4)
     ✓ caps multi-tenant blast radius
  2. add AbortController to chain calls
     ✓ unbinds wasted compute on user navigation
  3. document per-chain timeouts explicitly
     ✓ prevents a hung provider from blocking compose
```

## Structure pass

```
  axis = "what fires when?"

  HIGH    blocks UI or freezes app
  MED     burns compute / cost
  LOW     style; not yet exercised
  PRAISE  the runtime model prevents the flag
```

## How it works

### Move 1 — checklist

### Move 2 — scorecard

**Threads / processes**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Worker threads needed but absent | ✗ N/A | — | no CPU-bound work in JS today |
| One-thread model misunderstood | ✗ — PRAISE | — | code is async-correct |

**Event loop**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Long-sync chunks blocking UI | ✗ NOT YET | — | watch when adding heavy local computation |
| Tight loop without yield | ✗ NOT YET | — | same |

**Shared state**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Async sequencing race in writes | ✗ — PRAISE | — | LWW + idempotent rows |
| Module-level mutable state | ✗ — PRAISE | — | minimal; no globals |

**Memory**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Unbounded in-memory cache | ✗ — PRAISE | — | caches are DB-side |
| Closure retention of large data | ✗ NOT YET | — | profile if a feature adds it |

**Filesystem / streams**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Orphan upload files | ✗ NOT YET | — | add cleanup pass on app start |
| Unmanaged file descriptors | ✗ — PRAISE | — | SQLite + Expo manage |

**Backpressure / cancellation**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Unbounded `Promise.all` fan-out | ✓ TRUE | LOW | bounded concurrency with p-limit |
| No cancellation on chain calls | ✓ TRUE | LOW | AbortController |
| No explicit chain timeout discipline | ✓ TRUE | LOW | per-chain timeout constants |

### Move 3 — the principle

```
  buffr's runtime is well-behaved by RN's defaults. the three
  named flags are pre-emptive, not currently firing. fixing them
  is cheap (~50 LOC each) and removes scaling concerns.
```

## Primary diagram

```
   buffr runtime scorecard

   HIGH SEVERITY: (none)
   MED SEVERITY:  (none)
   LOW SEVERITY:
    ─ no bounded concurrency on classify fan-out
    ─ no cancellation tokens on chain calls
    ─ no explicit per-chain timeout discipline

   PRAISE:
    ─ async-correct sync engine (per-table awaits)
    ─ SQLite I/O off-thread via native module
    ─ no module-level mutable caches
    ─ Hermes GC handles short-lived allocations
```

## Implementation in codebase

The three actions:

```ts
// 1. p-limit on fan-out
import pLimit from 'p-limit';
const limit = pLimit(4);
await Promise.all(candidates.map(c => limit(() => classify(c, ctx))));

// 2. AbortController on chain calls
const ac = new AbortController();
// ...
await callAnthropic(prompt, { signal: ac.signal });

// 3. per-chain timeouts
const TIMEOUTS = { summarize: 30_000, classify: 15_000, ... };
```

## Elaborate

The runtime is quietly correct. The flags are forward-looking — they'd start to matter the day buffr handles batch jobs or longer-running chains. None of them bite today.

## Interview defense

**Q [mid]:** What's the biggest runtime risk?

**A:** None firing today. The forward-looking one is unbounded fan-out in classify — it could spike LLM cost in a batch scenario. p-limit fixes it.

**Q [senior]:** What's the most important PRAISE finding?

**A:** Async-correctness. The sync engine awaits per-table; never blocks UI. The classifier respects the single-thread model. Nothing in buffr does CPU-bound sync work on the JS thread.

## Validate

### Level 1 — sketch the severity ladder.

### Level 2 — explain why no flag is HIGH.

### Level 3 — apply: add the three fixes.

### Level 4 — defend: "Add a Worker for sync." Sync is I/O-bound; no CPU savings.

## See also

- All concept files 01–07.
- `../study-system-design/05-heuristic-before-llm-classifier.md`
- `../study-ai-engineering/06-production-serving/`
- `../study-performance-engineering/audit.md`
