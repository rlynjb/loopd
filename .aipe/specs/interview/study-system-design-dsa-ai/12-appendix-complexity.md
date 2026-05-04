# Appendix — Complexity Cheat Sheet

A reference for every major data operation in loopd. For each: the source file, the current asymptotic complexity (time / space), and a note on whether it holds at 10× scale (10× journal entries, 10× todos, 10× threads).

## Notation

- `N` = number of journal entries (current scale ~200)
- `T` = number of todos across all entries (current scale ~1500)
- `M` = number of meta rows (= T, paired 1:1 with todos)
- `R` = number of thread mentions (current scale ~300)
- `K` = number of threads (current scale ~25)
- `H` = number of habits (current scale ~10)

10× scale = N=2000, T=15000, M=15000, R=3000, K=250, H=100.

## Read operations

| Operation | File | Time | Space | 10× safe? |
|---|---|---|---|---|
| `getEntriesByDate(date)` | `database.ts` | O(log N) via `entries(date)` index | O(1) | ✓ |
| `getAllEntries()` | `database.ts` | O(N) | O(N) | ✓ — `entries(date)` index, sequential scan |
| `getTodoMeta(todoId)` | `database.ts` | O(1) PK lookup | O(1) | ✓ |
| `getAllTodoMetas()` | `database.ts` | O(M) | O(M) | △ — full table scan; only used in reorder, infrequent |
| `getMentionsByEntry(entryId)` | `database.ts` | O(log R) via `thread_mentions(entry_id)` | O(R per entry) | ✓ |
| `getMentionsByThread(threadId)` | `database.ts` | O(log R) via `thread_mentions(thread_id, created_at)` | O(R per thread) | ✓ |
| `getThreadBySlug(slug)` | `database.ts` | O(1) via `threads(slug) UNIQUE` | O(1) | ✓ |
| `getThreads(includeArchived)` | `database.ts` | O(K) | O(K) | ✓ — `threads(archived)` index |
| `getRecentAISummaries(beforeDate, n)` | `database.ts` | O(log N + n) via `ai_summaries(date)` | O(n) | ✓ |
| `rankTodos(entries)` | `todos/rank.ts` | O(T log T) sort + O(T) flatten | O(T) | △ — at 15000 todos, sort takes measurable time on Android. SQL view recommended at scale |
| `getThreadCards()` | `threads/getThreadCards.ts` | O(K × R per thread) aggregate | O(K) | △ — single-pass aggregator; works but should switch to grouped SQL at scale |
| `getThreadDetail(threadId)` | `threads/getThreadDetail.ts` | O(R per thread + entries-with-mentions) | O(R per thread) | ✓ |

## Write operations

| Operation | File | Time | Space | 10× safe? |
|---|---|---|---|---|
| `updateEntry(id, patch)` | `database.ts` | O(1) update + O(1) schedulePush | O(text length) | ✓ |
| `insertEntry(entry)` | `database.ts` | O(1) | O(text length) | ✓ |
| `updateTodoMeta(todoId, patch)` | `database.ts` | O(1) PK update | O(1) | ✓ |
| `insertMention(mention)` | `database.ts` | O(1) | O(1) | ✓ |
| `deleteMention(id)` | `database.ts` | O(1) (soft-delete via `deleted_at`) | O(1) | ✓ |
| `createThread({name, slug})` | `threads/crud.ts` | O(1) PK insert + slug-unique check | O(1) | ✓ |
| `updateTodo(entryId, todoId, patch)` | `todos/crud.ts` | O(text length) for `rewriteTodoLine` + O(1) write | O(text length) | ✓ |

## Scanner operations (commit-time)

| Operation | File | Time | Space | 10× safe? |
|---|---|---|---|---|
| `scanTodosFromText(text, existing)` | `todos/scanTodos.ts` | O(L + existing) with HashMaps; line count L ≤ ~200 per entry | O(L + existing) | ✓ |
| `reconcileTodoMetaForEntry(entryId)` | `todos/reconcileMeta.ts` | O(todos in entry) DB ops + O(1) classifier per ambiguous | O(todos in entry) | ✓ |
| `scanNutritionForEntry(entryId, text)` | `nutrition/scanNutrition.ts` | O(L + nutrition rows for entry) two-pass | O(L) | ✓ |
| `parseTags(text)` | `threads/scanThreads.ts` | O(L × tags-per-line) Set-deduped | O(unique tags) | ✓ |
| `resolveTagsToThreadIds(tags)` | `threads/scanThreads.ts` | O(K) per scan + O(unknown tags) creates | O(K) | ✓ — getThreads(true) is a full table scan, K=250 fine |
| `scanThreadMentionsForEntry(entryId, text)` | `threads/scanThreads.ts` | O(L + R per entry) two-pass | O(R per entry) | ✓ |

## Cloud sync operations

| Operation | File | Time | Space | 10× safe? |
|---|---|---|---|---|
| `pushAll()` | `sync/orchestrator.ts` | O(dirty rows) batched 50/req | O(50) per batch | ✓ — batching makes this network-bound, not CPU |
| `pullAll()` | `sync/orchestrator.ts` | O(rows changed since last_pull) paginated 1000/page | O(1000) per page | ✓ |
| `chooseWinner(local, cloud)` | `sync/conflict.ts` | O(1) | O(1) | ✓ |
| `schedulePush()` | `sync/schedulePush.ts` | O(1) debounce | O(1) | ✓ |

## AI operations

| Operation | File | Time | Space | 10× safe? |
|---|---|---|---|---|
| `heuristicClassify(text)` | `todos/heuristicClassify.ts` | O(text length × pattern count) ~150 patterns | O(1) | ✓ |
| `classifyTodo(text, todoId)` | `todos/classify.ts` | network-bound, ~400ms p50 | O(1) per call | △ — per-key rate limit; at 10× user count, gateway needed |
| `expand(todoId)` | `todos/expand.ts` | network-bound, ~1.5s p50, capped 3 concurrent | O(context block size) | △ — same rate-limit story |
| `summarize(date)` | `ai/summarize.ts` | network-bound, two LLM calls, ~3s p50 | O(entries-for-day prose) | ✓ — once per day per device |
| `generateCaption(input)` | `ai/caption.ts` | network-bound, ~1.5s p50 | O(rawLog size) | ✓ |

## Frontend rendering

| Operation | File | Time | Space | 10× safe? |
|---|---|---|---|---|
| `SmartTodoList` (top 5) | `app/index.tsx` | O(T) flatten + O(T log T) sort + slice | O(T) | △ — see `rankTodos`, SQL view recommended at scale |
| `/todos` page filter+sort | `app/todos.tsx` | O(M filtered) → `FlatList` virtualization | O(visible window) | ✓ — virtualization scales |
| Daily Schedule tracker | `app/index.tsx` | O(K + H) + O(activity-per-row) | O(K + H) | ✓ |
| Habit heatmap row | `home/HabitHeatmapRow.tsx` | O(14 cells × 1 lookup per habit) | O(1) | ✓ |
| Thread detail mentions | `app/threads/[id].tsx` | O(R per thread) sorted | O(R per thread) | ✓ |

## Operations that need attention before 10×

**`rankTodos`** is the single most likely bottleneck. At 15,000 todos, the in-memory flatten + sort runs on every dashboard mount. The fix is a SQL view (`todos_with_meta_ranked`) with a CASE expression for source priority and an indexed `ORDER BY`. This is in `docs/backlog.md` as a deferred optimization.

**`getThreadCards`** does per-thread aggregation in JS. At K=250 threads with R=3000 mentions, the cost is acceptable but should be moved to a single GROUP BY query at scale. Same backlog category.

**`getAllTodoMetas`** is the only full-table scan in active use; it's called from `ensureAllTodoPositions` which only runs on the user's first manual reorder ever. At 15,000 rows this is still well under a second on Android, but worth keeping an eye on.

**`classifyTodo`** and `expand` hit per-key rate limits at multi-tenant scale (Phase B). The architectural fix is a server-side gateway (covered in chapter 4). This is the single largest pre-launch refactor required for multi-tenant.

## Summary

Most of the codebase is already O(1) or O(log N) at the persistence layer thanks to careful indexing. The hot paths (scanner reconcile, sync push) are O(N) in the touched-row count and benefit from batching. The dashboard's `rankTodos` is the one CPU hot spot that scales worse than ideal — flagged for SQL replacement when entry count crosses 1000+.

No quadratic-or-worse algorithms are in active hot paths. The sync orchestrator's hand-maintained order arrays (chapter 8) are an architectural smell, not a complexity issue.
