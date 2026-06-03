# Study — Performance engineering (buffr, measured)

Performance audit of buffr. The pattern: buffr is fast by structure (local-first, debounced sync, content-cached chains, heuristic short-circuit). The audit confirms what's defended and surfaces what's not measured.

## The through-line

```
  what is measurably slow or expensive, why, and which change
  improves it without moving the bottleneck?

  for buffr: most things aren't measured. the named risks are
  forward-looking (LLM cost ceiling, sync latency at scale).
  the design buys good perf for free; without measurement we
  can't say WHICH gains the design actually delivers.
```

## Output shape

This is a two-pass audit:

- **`00-overview.md`** — the perf-budget summary and ranked findings.
- **`audit.md`** — Pass 1, the 8-lens walk.
- **`01-` and `02-` pattern files** — Pass 2, the load-bearing perf patterns. Two patterns:
  - `01-cache-shortcircuit-as-cost-ceiling` — the ai_summaries cache is what keeps the per-day LLM bill under any practical threshold.
  - `02-debounce-as-throughput-control` — the 5s debounce coalesces typing bursts into 1 sync cycle.

## Cross-guide seams

- **`study-runtime-systems`** — execution mechanisms (event loop, GC, native I/O).
- **`study-system-design`** — architectural-scale tradeoffs.
- **`study-ai-engineering/06-production-serving/`** — LLM serving concerns.
- **`study-database-systems/04-query-planning-and-execution.md`** — DB-side perf.

## What this guide does NOT cover

- DB engine internals (`study-database-systems`).
- Network protocol (`study-networking`).
- Code-level complexity (`study-software-design`).
