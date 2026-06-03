# DSA foundations applied to buffr — what the app uses + what to study

Buffr is not a DSA-heavy codebase. The interesting reusable data-structure work happens in two places: (a) the **reconcile-by-diff** pattern (`reconcileMeta.ts`) which is a set-diff over Maps, and (b) the **debounce + dirty-filter** pattern in sync (a queue-as-query). Everything else is stock React Native + Postgres + SQLite — meaning B-trees on disk (covered by `study-database-systems`) and standard JS arrays/maps in memory.

## The exercised inventory

```
  WHAT BUFFR USES                                  WHERE
  ──────────────────────────────────────────────  ──────────────────
  Map<string, T>                                   reconcileMeta (todo line keys)
  Set<string>                                      reconcileMeta (seen keys)
  Array (sorted by date/id)                        every UI list view
  hash (content hash of prompt input)              ai_summaries cache
  B-tree (PK index)                                Postgres + SQLite
  topo sort                                         not yet exercised
  graph traversal                                   not yet exercised
  dynamic programming                               not yet exercised
  binary search                                     not yet exercised
```

## Findings (ranked)

| Rank | Finding | Concept | Severity |
|---|---|---|---|
| 1 | reconcileMeta is the load-bearing in-memory algorithm | 02-arrays-strings-hash-maps | PRAISE |
| 2 | Hash-by-content for cache key (content-addressable) | 02-arrays-strings-hash-maps | PRAISE |
| 3 | Sorted-by-updated_at scan in sync pull (linear, fine at scale) | 06-sorting-searching | PRAISE |
| 4 | No DSA-shaped algorithm in chains or compose | — | NONE (correct) |
| 5 | No graph or tree algorithm needed | 04, 05 | N/A |
| 6 | DP / recursion / backtracking — not used in product | 07 | N/A (study target) |

## Reading order

For the buffr-grounded subset: `01` (complexity) → `02` (arrays/hashmaps; load-bearing) → `06` (sorting/searching). Then `03–05`, `07` for the missing foundations the reader should study deliberately. `08` is the practice plan that prioritizes the gap.

## Not yet exercised (study targets)

- **Graph traversals** — BFS/DFS. Worth studying; not in buffr.
- **Binary search** — would matter if SQLite weren't doing it for us.
- **Dynamic programming** — not in product code.
- **Heaps** — not in product code.

## Cross-guide seams

- **`study-database-systems`** — on-disk DSA: B-trees, page layout. Owns that.
- **`study-runtime-systems`** — execution-model DSA: event loop queue. Owns that.
- **`study-software-design`** — code-level structure; the reconcile algorithm pattern.
