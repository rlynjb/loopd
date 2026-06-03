# Runtime systems in buffr — one JS process, one event loop

buffr is a React Native app. The runtime is **Hermes** (the optimized JavaScript engine bundled with RN on Android). One process. One JavaScript event loop. No worker threads in buffr's app code today. Native code (SQLite, networking, image processing) runs off-thread but the JS side sees it as awaitable Promises.

## The runtime map

```
  ┌─────────────────────────────────────────────────────────┐
  │  Android process (one)                                   │
  │                                                          │
  │  ┌──────────────────────────────────────────────────┐   │
  │  │  Hermes JS thread (event loop)                    │   │
  │  │   ─ UI render (React reconciler)                   │   │
  │  │   ─ service layer (chains, sync, prose)            │   │
  │  │   ─ all buffr application code                     │   │
  │  └──────────────────────────────────────────────────┘   │
  │                                                          │
  │  ┌──────────────────────────────────────────────────┐   │
  │  │  native threads (managed by RN/Expo modules)      │   │
  │  │   ─ SQLite I/O (expo-sqlite-next)                  │   │
  │  │   ─ HTTP (Anthropic, OpenAI, Supabase)             │   │
  │  │   ─ vlog upload                                    │   │
  │  │   ─ image encoding                                 │   │
  │  └──────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────┘
```

JS sees these as async. The event loop never blocks on disk or network — the work happens on native threads and resolves a Promise back into the JS queue.

## Findings (ranked)

| Rank | Finding | Concept | Severity |
|---|---|---|---|
| 1 | Sync runs entirely on the JS event loop; large dirty batches could stall UI | 03-event-loop | LOW (small batches today) |
| 2 | No cancellation tokens on chain calls — a slow LLM call holds the chain | 07-backpressure-bounded-work | LOW |
| 3 | No bounded concurrency on `Promise.all` fan-out in classify (could fan out 20 LLM calls at once) | 07-backpressure-bounded-work | LOW (cache short-circuits most) |
| 4 | No worker threads; React/sync/prose all share the JS thread | 02-processes-threads-tasks | LOW (CPU is not the bottleneck) |
| 5 | Image decoding can block briefly on large uploads | 06-filesystem-streams | LOW |
| 6 | Shared state is pure-functional (no in-process mutexes needed) | 04-shared-state-races | PRAISE |
| 7 | Hermes GC is generational + low-pause | 05-memory-stack-heap-gc | PRAISE |
| 8 | All I/O is async via native modules | 03-event-loop, 06-filesystem | PRAISE |

## Reading order

`01` (runtime map) → `02` (threads/tasks framing) → `03` (event loop — load-bearing) → `04` (shared state) → `05` (memory) → `06` (filesystem/streams) → `07` (backpressure) → `08` (audit).

## Not yet exercised

- **Worker threads** — no `Worker` API usage in app code.
- **Background tasks** — no `expo-task-manager` background fetch.
- **Foreign function calls** — buffr only uses RN's bridge.
- **In-process channels** — no event emitters between modules; data flows through awaited Promises.

## Cross-guide seams

- **`study-system-design`** — the architectural shape these runtime mechanisms execute inside.
- **`study-testing`** — fake timers and module-reset discipline (the harness recommendation).
- **`study-debugging-observability`** — what observability the runtime exposes (Sentry breadcrumbs, RN devtools).
- **`study-performance-engineering`** — perf budgets and where the runtime would surface them.
