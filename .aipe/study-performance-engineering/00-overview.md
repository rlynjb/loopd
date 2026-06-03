# Performance overview — buffr by the numbers

## The implicit budget

```
  what the user FEELS                      target
  ──────────────────────────────          ───────
  "I typed and it appeared"                <50ms
  "I tapped today and it loaded"           <100ms
  "I committed and saw the new todos"      <5s
  "my notes synced to the other device"    <60s

  what we ACTUALLY measure
  ──────────────────────────────
  (nothing yet)
```

Today there is no instrumentation. The targets are inferred from "the UX feels right." Without measurement, the audit cannot confirm whether the design is delivering on them — only that there's no evidence it isn't.

## Findings (ranked)

| Rank | Finding | Lens | Severity |
|---|---|---|---|
| 1 | No perf budget documented, no baseline measurements | 1, 2 | MED (structural — preempt now) |
| 2 | LLM cost per active user per day — only known approximately | 6 | MED |
| 3 | Sync pull in-memory sort at scale (no `(user_id, updated_at)` index) | 5 | MED |
| 4 | Cache hit rate on `ai_summaries` not measured | 6 | LOW |
| 5 | UI startup time not profiled | 7 | LOW |
| 6 | Cache short-circuit caps per-day LLM cost ceiling | 6 | PRAISE (see [`01-cache-shortcircuit-as-cost-ceiling.md`](./01-cache-shortcircuit-as-cost-ceiling.md)) |
| 7 | Debounce coalesces typing bursts | 6 | PRAISE (see [`02-debounce-as-throughput-control.md`](./02-debounce-as-throughput-control.md)) |
| 8 | Heuristic-before-LLM saves ~70% of classify calls | 6 | PRAISE |
| 9 | Local-first reads keep p99 UI latency near constant | 7 | PRAISE |

## Reading order

`audit.md` (the lens walk) → `01-` (cache short-circuit, the cost ceiling) → `02-` (debounce, the throughput control). Pattern 01 is the load-bearing finding for cost; pattern 02 for throughput.

## Not yet exercised

- **Profiling pass** — never run.
- **Baseline workload** — undefined.
- **Performance regression tests** — none.
- **Crash / freeze rate metrics** — none.
- **LLM cost dashboards** — managed by Anthropic/OpenAI's dashboards externally.
