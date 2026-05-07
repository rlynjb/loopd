# 02 — Data structures and algorithms

Every algorithm in this section is grounded in a real loopd operation. Each file includes a brute force version, an optimal version, an execution trace, and a comparison.

## Index

| # | Operation | One-line |
|---|---|---|
| 01 | [Two-pass scan: matching prose lines to existing todos](./01-two-pass-scan-todos.md) | Map + Set, exact text then line-index. Identity survives prose edits. |
| 02 | [todo_meta reconciliation: 1:1 invariant](./02-reconcile-todo-meta.md) | Map + Set diff: insert missing, delete orphans, leave matches. |
| 03 | [Two-pass thread mention reconcile (line-shift tolerant)](./03-two-pass-thread-mentions.md) | Pass 2 uses `±3 line shift` tolerance for moved tags. |
| 04 | [Ranked todo flatten + sort (legacy)](./04-ranked-todo-sort.md) | Compose-into-one-comparator. Currently dead code; only `formatRelativeTime` is consumed. |
| 05 | [Daily-schedule grid cell state](./05-cell-state-decision-tree.md) | Pure decision tree, O(1) per cell. |
| 06 | [Thread cards aggregate](./06-thread-cards-aggregate.md) | 4 SQL queries + 2 in-memory joins. Avoids N+1. |
| 07 | [Cloud sync push](./07-cloud-sync-push.md) | Batch upsert (50/batch) with mid-batch failure tolerance. |
| 08 | [Cloud sync pull](./08-cloud-sync-pull.md) | Cursor-by-timestamp pagination (200/page) anchored to server time. |
| 09 | [Tag parsing with code-fence masking](./09-tag-parsing-code-fence.md) | Mask code regions to spaces (preserve offsets), then per-line regex. |
| 10 | [Heuristic-first classifier](./10-heuristic-first-classifier.md) | Ordered regex checks. Returns `'todo'` or `null`; `null` defers to LLM. |
| 11 | [Pinned-first sort (live)](./11-pinned-first-sort.md) | Two-key comparator: pinned first, then createdAt DESC. |

## Complexity cheat sheet

```
┌────────────────────────────────────────────┬──────────────┬─────────┬──────────────┐
│ Operation                                  │ Time         │ Space   │ At 10×?      │
├────────────────────────────────────────────┼──────────────┼─────────┼──────────────┤
│ scanTodosFromText (per entry)              │ O(n + m)     │ O(n+m)  │ ✓ fine       │
│ reconcileTodoMetaForEntry                  │ O(n + m)     │ O(n+m)  │ ✓ fine       │
│ reconcileMentions (per entry)              │ O(n × m)     │ O(n)    │ ✓ fine — small per-entry n,m │
│ rankTodos (legacy; not currently called)   │ O(n log n)   │ O(n)    │ ✓ fine       │
│ /todos + dashboard pinned-first sort       │ O(n log n)   │ O(1)    │ ✓ fine       │
│ parseTags (single text)                    │ O(L)         │ O(L)    │ ✓ fine       │
│ getThreadCards (dashboard load)            │ O(T + M + Q) │ O(T+M+Q)│ ✓ fine       │
│ heuristicClassify (per todo)               │ O(R) ≈ O(1)  │ O(1)    │ ✓ fine       │
│ classifyTodo (LLM)                         │ O(1) calls   │ O(1)    │ ✓ network bound — async per todo │
│ expandTodo (LLM)                           │ O(1) calls   │ O(1)    │ ✓ capped at 3 in-flight  │
│ pushTable (per table)                      │ O(n/50) net  │ O(50)   │ ✓ fine — paginated         │
│ pullTable (per table)                      │ O(n/200) net │ O(200)  │ ✓ fine — paginated         │
│ chooseWinner (per row)                     │ O(1)         │ O(1)    │ ✓ fine       │
│ cellStateFor (per grid cell)               │ O(1)         │ O(1)    │ ✓ fine       │
│ DailyScheduleGrid render (7 × N habits)    │ O(7N)        │ O(N)    │ ✓ fine       │
│ summarize (LLM call + JSON parse)          │ O(1) call    │ O(P)    │ ✓ network    │
└────────────────────────────────────────────┴──────────────┴─────────┴──────────────┘
```

**No ✗ flags currently.** The codebase has been audited at the algorithm level — every hot path uses Map/Set lookups or pagination. The places that *look* O(n × m) (`reconcileMentions`) are bounded by per-entry small constants that don't scale with the full database.

The honest scaling concern in this codebase is not algorithm complexity but **per-todo LLM cost**. `expand` runs Claude Sonnet at ~$0.04 per call; a careless "expand all" UI would burn through the user's budget. Mitigation in code: `MAX_CONCURRENT = 3` cap in `expand.ts:25`, and the heuristic-first gate on classify so most lines never reach the LLM at all.

---

## Update log

- **2026-05-07** — sort row corrected: `/todos` and the dashboard now use the pinned-first comparator (file 11), not the deprecated NULL-position rule. The `rankTodos` row is annotated as "not currently called" — the function lives in `rank.ts` but no app code consumes it.
