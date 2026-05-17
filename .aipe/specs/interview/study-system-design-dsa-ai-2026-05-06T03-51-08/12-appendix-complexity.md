# Appendix — Complexity cheat sheet

This is the lookup table you scan five minutes before the interview. Every major data operation in buffr, with its current time and space complexity, the file it lives in, and whether it holds at 10× scale (interpreted as ~10K active todos / habits / mentions per user).

If you can hold this table in your head, you can answer "what does X cost" instantly without recomputing — which is what an interviewer is implicitly testing when they ask "how does this scale?"

## Read operations

```
operation                       file                         time           space     10× ok?
──────────────────────────────────────────────────────────────────────────────────────────────
getEntryById                    services/database.ts         O(log N)       O(1)      ✓ (PK)
getEntriesByDate                services/database.ts         O(log N + M)   O(M)      ✓ (idx)
                                                              M = entries on date
getAllEntries                   services/database.ts         O(N)           O(N)      ⚠ project cols
getTodoMetasByEntry             services/database.ts         O(log N + T)   O(T)      ✓
                                                              T = todos in entry
getAllTodoMetas                 services/database.ts         O(N)           O(N)      ⚠ paginate
getThreads                      services/database.ts         O(log N + K)   O(K)      ✓
                                                              K = threads
getThreadCards                  services/threads/            O(M + T)       O(T)      ⚠ aggregate
                                getThreadCards.ts             M = mentions
getAISummary                    services/database.ts         O(log N)       O(1)      ✓ (PK)
getRecentAISummaries(date, 5)   services/database.ts         O(log N + 5)   O(1)      ✓
──────────────────────────────────────────────────────────────────────────────────────────────
```

## Write operations

```
operation                       file                         time           space     10× ok?
──────────────────────────────────────────────────────────────────────────────────────────────
addEntry                        services/database.ts         O(1) +sched    O(1)      ✓
updateEntry                     services/database.ts         O(1) +sched    O(1)      ✓
softDeleteEntry                 services/database.ts         O(1) +sched    O(1)      ✓
insertTodoMeta                  services/database.ts         O(1) +sched    O(1)      ✓
updateTodoMeta                  services/database.ts         O(1) +sched    O(1)      ✓
deleteTodoMeta                  services/database.ts         O(1) +sched    O(1)      ✓
schedulePush                    services/sync/schedulePush   O(1)           O(1)      ✓
                                                              (debounce only)
──────────────────────────────────────────────────────────────────────────────────────────────
+sched = the call enqueues a debounced cloud push (5s); the enqueue itself
         is O(1). The actual push runs later and is O(D) per table where D
         is the dirty-row count.
```

## Sync operations

```
operation                       file                         time           space     10× ok?
──────────────────────────────────────────────────────────────────────────────────────────────
chooseWinner(local, cloud)      services/sync/conflict.ts    O(1)           O(1)      ✓
pushTable(table)                services/sync/push.ts        O(D + B*ceil)  O(B)      ⚠ batch=50
                                                              D = dirty rows
                                                              B*ceil = network calls
                                                              ⌈D/50⌉ batches
pullTable(table)                services/sync/pull.ts        O(P + 200P)    O(200)    ⚠ paginate
                                                              P = pages of 200
pushAll                         services/sync/orchestrator   sum over tables          ⚠ serial
                                                              currently sequential
pullAll                         services/sync/orchestrator   sum over tables          ⚠ serial
recordPushSuccess               services/sync/syncMeta.ts    O(1)           O(1)      ✓
recordSyncError                 services/sync/syncMeta.ts    O(1)           O(1)      ✓
get_server_time RPC             pg/0003_server_time_rpc.sql  O(1) net       O(1)      ✓
──────────────────────────────────────────────────────────────────────────────────────────────
```

## Pure function operations (scanners + reconcilers + derivers)

```
operation                       file                         time           space     10× ok?
──────────────────────────────────────────────────────────────────────────────────────────────
collectMatches(text)            services/todos/scanTodos.ts  O(L)           O(L)      ✓
                                                              L = lines of prose
scanTodosFromText(text, ex)     services/todos/scanTodos.ts  O(L × E)       O(L+E)    ✓ per-entry
                                                              E = existing todos
                                                              ≈ O(L²) worst case
rewriteTodoLine(text, todo, up) services/todos/scanTodos.ts  O(L)           O(L)      ✓
heuristicClassify(text)         services/todos/heuristic-    O(K)           O(1)      ✓
                                Classify.ts                   K = pattern count (constant)
reconcileTodoMetaForEntry       services/todos/              O(T) DB ops    O(T)      ✓
                                reconcileMeta.ts              T = todos in entry
scanNutritionFromText           services/nutrition/scan…     O(L)           O(L)      ✓
scanThreadsFromText             services/threads/scan…       O(L × S)       O(L+S)    ✓
                                                              S = thread slugs
computeStaleness(thread, last)  services/threads/            O(1)           O(1)      ✓
                                staleness.ts
formatStalenessLabel            services/threads/            O(1)           O(1)      ✓
                                staleness.ts
cellStateFor(habit, date,       components/home/cellState.ts O(1)           O(1)      ✓
            today, checked)                                   (Set.has = O(1))
cellStateForThread              components/home/cellState.ts O(1)           O(1)      ✓
isoWeekDates(monday)            services/habits/cadence.ts   O(1)           O(7)      ✓
summarizeCadence(habit)         services/habits/cadence.ts   O(1)           O(1)      ✓
──────────────────────────────────────────────────────────────────────────────────────────────
```

## UI render operations

```
operation                       file                         time           space     10× ok?
──────────────────────────────────────────────────────────────────────────────────────────────
SmartTodoList sort + render     components/home/             O(N log N)     O(N)      ⚠ N=50K=10ms
                                SmartTodoList.tsx             memoized on
                                                              [entries, metas]
                                                              renders top 5 only
TodosScreen sort + filter       app/todos.tsx                O(N log N)     O(N)      ⚠ ScrollView
                                                              renders ALL filtered
                                                              → use FlatList
DailyScheduleGrid render        components/home/             O(R × 7)       O(R × 7)  ✓
                                DailyScheduleGrid.tsx         R = habit + thread rows
AISummaryCard render            components/home/             O(C)           O(C)      ✓
                                AISummaryCard.tsx             C = clip count (≤ ~15)
──────────────────────────────────────────────────────────────────────────────────────────────
```

## AI operations

```
operation                       file                         latency        cost      10× ok?
──────────────────────────────────────────────────────────────────────────────────────────────
summarize(date)                 services/ai/summarize.ts     ~3-5s          ~$0.005   ⚠ user-facing
                                                              (Claude Sonnet 4.6
                                                               + caption call)
generateCaption(input)          services/ai/caption.ts       ~2-3s          ~$0.003   ⚠ called from
                                                                                          summarize
classifyTodo(text)              services/todos/classify.ts   ~300-500ms     ~$0.0001  ⚠ user-async
                                                              (Claude Haiku 4.5)
testConnection                  services/ai/summarize.ts     ~500ms         ~$0.00001 ✓
classifyAmbiguousMeta           services/todos/migrateMeta   N × classify   N × $.0001  ⚠ batch
                                                              currently serial          at scale
──────────────────────────────────────────────────────────────────────────────────────────────
```

## Boot-time operations

```
operation                       file                         time           10× ok?
──────────────────────────────────────────────────────────────────────────────────────────────
useDatabase open                hooks/useDatabase.ts         ~50-100ms      ✓
runMigrations                   services/database.ts         O(M)           ✓
                                                              M = local migrations
backfillTodosFromText           services/todos/migrate.ts    O(N) entries   ⚠ once-only
                                                              SecureStore-gated
backfillNutritionFromText       services/nutrition/migrate   O(N) entries   ⚠ once-only
backfillTodoMeta                services/todos/migrateMeta   O(N) entries   ⚠ once-only
backfillThreadMentions          services/threads/migrate.ts  O(N × S)       ⚠ once-only
backfillHabitsCadence           services/habits/migrate.ts   O(K)           ⚠ once-only
clipMigration (1080p proxy)     services/clipMigration.ts    O(C) clips     ⚠ FFmpeg, slow
bootstrapCloudSync              services/sync/bootstrap.ts   detects state  ⚠ once-only
pullAll on each boot            services/sync/orchestrator   network        ⚠ paginated
pushAll on each boot            services/sync/orchestrator   O(dirty rows)  ✓
auto-summarize yesterday        app/_layout.tsx              ~3-5s          ⚠ network
──────────────────────────────────────────────────────────────────────────────────────────────
```

## What changes at 10× scale

The cheat sheet for "what's the bottleneck and what's the fix":

| Bottleneck | Today | At 10× | Mitigation |
|---|---|---|---|
| `getAllEntries` for dashboard | full SELECT | wide row, 1MB | SELECT only needed cols |
| `TodosScreen` ScrollView | renders all rows | OOM at 10K | switch to `FlatList` |
| `pullTable` paginated boot | 200 per page | 50× pages | parallel pull across tables |
| `pushAll` serial tables | one at a time | 10× longer | parallel where no FK deps |
| Classifier catch-up | serial per todo | hours of work | batched LLM call (50 at once) |
| `getThreadCards` aggregate | full mention scan | 10× longer | materialized `thread_summary` |
| Sort on every dashboard render | O(N log N) | 50K = 10ms | SQL ORDER BY + LIMIT |
| Sync push QPS at peak hour | per-user 5s debounce | thousands/sec | jitter + per-user rate limit |
| AI compose latency | ~5s | unchanged | doesn't scale with users |
| AI compose cost | $0.005/call | $0.005/call | aggregate budget grows |

## What doesn't change at any scale

- `chooseWinner` is O(1). Stays O(1).
- `cellStateFor` is O(1). Stays O(1).
- `computeStaleness` is O(1). Stays O(1).
- `getEntryById` is O(log N) on the `(user_id, id)` index. Stays.
- The 12 architectural principles in `docs/spec.md §10`. Doctrine doesn't scale; it just keeps applying.
- The single-write-site discipline in `database.ts`. Always one place to look.
- The local-first read model. SQLite is always milliseconds.

## Memory footprint at 10× scale (reference)

```
Item                            count  bytes/each   total
────────────────────────────────────────────────────────────
entries                         3,650  ~2KB         ~7MB
  (10 years × 365 days; row =   prose + JSON cols)
todos                           50,000 ~200B (in JSON)  ~10MB
todo_meta                       50,000 ~150B            ~7.5MB
thread_mentions                 30,000 ~100B            ~3MB
habits                          50     ~150B            ~7.5KB
threads                         500    ~200B            ~100KB
ai_summaries                    3,650  ~3KB             ~11MB
nutrition                       50,000 ~80B             ~4MB
sync_meta                       12     ~200B            ~2.4KB
────────────────────────────────────────────────────────────
Total local SQLite                                      ~42MB

Cloud Postgres mirror (10 tables, no local-only sync_meta/sync_deletions)
                                                        ~42MB per user
```

The 10× scale of "1 active power user with 10 years of history" is well under 100MB locally. Storage is not the bottleneck at any reasonable solo timeline. The bottleneck is *write QPS* if cross-device sync gets aggressive, and *AI cost* if every active session triggers compose.

## Practice the lookup

Five minutes before the interview, rehearse this:

- "What's `chooseWinner` cost?" → O(1).
- "What's the dashboard sort cost?" → O(N log N), memoized, ~10ms at N=50K.
- "What's the cost to scan a todo line?" → O(L × E) per entry, ≈ O(L²) typical.
- "What's the cost to push a row to cloud?" → O(1) network call per batch of up to 50; the *enqueue* is O(1).
- "What's a render of `DailyScheduleGrid`?" → O(rows × 7), all O(1) cells, total <5ms.
- "What's `summarize` latency?" → ~3-5 seconds, two LLM calls, ~$0.005.

If those answers come out as instant, you can talk about scale fluently. If they don't, run the table again.
