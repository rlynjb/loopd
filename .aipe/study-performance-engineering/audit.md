# Pass 1 — the 8-lens performance audit

## 1. performance-budget

There is no explicitly documented performance budget. The inferred user-facing targets (overview) are derived from "the UX feels right." For an app whose primary marketing is "feels instant," that's a structural risk: without a number, regressions don't trigger any signal.

**The shape of a buffr-specific budget:**

| Operation | Inferred target | Status |
|---|---|---|
| keystroke → render | <16ms (one frame) | not measured |
| screen open → render | <100ms cold; <50ms warm | not measured |
| prose-commit → meta visible | <5s typical | not measured |
| sync push → cloud visible | <30s typical | not measured |
| LLM chain p95 | <10s | not measured |

→ See `01-cache-shortcircuit-as-cost-ceiling.md` for the related cost budget.

## 2. measurement-baselines-and-profiling

No baselines. No profiler runs. No instrumentation harness. The "before/after" evidence for any optimization would have to be reconstructed manually each time.

The cheapest first investments (~1 day each):

- **React Native Performance Monitor** in dev to spot frame drops.
- A small `console.time` wrapper around chain calls + sync cycles, captured into a debug screen.
- One representative workload script: "create 30 entries, push, then pull on a fresh device." Captures the most likely scaling tier.

## 3. latency-throughput-and-tail-behavior

Latency budgets (inferred, see lens 1) are all user-facing. Throughput is the sync push/pull cycle — debounced 5s, batched per table. No queue depth metric. No p95/p99 capture.

Likely tail-behavior trap: a single sync cycle that fans out a large dirty batch. At today's row counts, this is small. The structural risk is a backlog accumulating during a long offline period — the resume-sync's first cycle could be large.

→ See `02-debounce-as-throughput-control.md` for the upstream control.

## 4. cpu-memory-and-allocation

Hermes GC handles short-lived allocations cheaply. There is no in-memory cache that could grow unbounded (chain cache is DB-side). The risk surface here is small.

Worth measuring once: peak memory during a vlog upload (multi-MB blob in memory? streamed?). If buffered, this could pressure low-end devices.

## 5. io-network-and-database-bottlenecks

**Database side:** the sync pull's lack of `(user_id, updated_at)` index will surface as a sort node at the next scale tier. The fix is in `study-database-systems/09-` — one-line index per table.

**Network side:** three peers; OkHttp pools connections. The known bottleneck is the LLM call (500ms-30s typical). The mitigation is the cache + heuristic, addressed in pattern 01.

**Filesystem:** vlog uploads stream (verify). SQLite WAL handles concurrent reads/writes cheaply.

## 6. caching-batching-and-backpressure

This is buffr's strongest lens. Three patterns work together:

- **Content-hashed cache (`ai_summaries`):** caps the per-day LLM cost; see [`01-cache-shortcircuit-as-cost-ceiling.md`](./01-cache-shortcircuit-as-cost-ceiling.md).
- **Heuristic before LLM:** saves ~70% of classify calls (`study-system-design/05`).
- **Debounce + batched sync:** coalesces typing into one sync per 5s window; see [`02-debounce-as-throughput-control.md`](./02-debounce-as-throughput-control.md).

The hole: no backpressure on the chain fan-out (`Promise.all` over candidates). At single-user scale this is fine; at batch processing scale it's a self-DoS. See `study-runtime-systems/07`.

## 7. rendering-client-and-mobile-performance

Local-first reads keep UI latency near constant — every screen renders from SQLite. The frame budget (16ms) is not measured but the design pattern keeps the UI thread free of network and LLM work. Vlog rendering and large-entry rendering are the two places main-thread work could spike; neither has been profiled.

## 8. performance-red-flags-audit

| Rank | Flag | Severity | Fix |
|---|---|---|---|
| 1 | No documented perf budget | MED | publish targets; track in a doc |
| 2 | No baseline measurements | MED | one-week instrumentation pass |
| 3 | No `(user_id, updated_at)` index → in-memory sort at scale | MED | cross-link db-systems/09 |
| 4 | No cache-hit-rate metric on `ai_summaries` | LOW | one query in a debug screen |
| 5 | No bounded concurrency on `Promise.all` fan-out | LOW | preempt at next scale tier |
| 6 | No memory profile of vlog upload | LOW | one focused pass |
| 7 | Cache short-circuit caps LLM cost ceiling | PRAISE | maintain |
| 8 | Debounce coalesces sync traffic | PRAISE | maintain |
| 9 | Heuristic short-circuit saves ~70% of classify calls | PRAISE | maintain |
| 10 | Local-first reads keep UI latency constant | PRAISE | maintain |

**Top three moves:**

1. Document a perf budget.
2. Add cheap instrumentation around chain calls + sync cycles.
3. Add the `(user_id, updated_at)` index per synced table (cross-cuts with db-systems/09).
