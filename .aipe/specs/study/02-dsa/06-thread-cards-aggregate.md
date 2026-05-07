# Thread cards aggregate — 4 SQL queries + 2 in-memory joins

> Per-dashboard-load aggregate: for each thread, compute `lastMentionAt`, `entriesThisWeek`, `openTodos`, `recentTodos[3]`, `staleness`, `activeDates`. Then sort.

**See also:** → [05-cell-state-decision-tree](./05-cell-state-decision-tree.md) · → [01-system-design/12-manual-touch-deviation](../01-system-design/12-manual-touch-deviation.md)

---

## Quick summary
- **What:** 4 small SQL queries pull per-thread aggregates; 2 in-memory joins (todos+meta, threads+activity) compose the final card list.
- **Why here:** the dashboard needs all of this per thread, every load. A single mega-JOIN in SQL would work but reuses the dashboard's existing `getAllEntries` cache for free.
- **Tradeoff:** more roundtrips than a single JOIN; less than per-thread N+1 queries.

**Real operation:** `getThreadCards` in `src/services/threads/getThreadCards.ts`.

---

## The data

All threads + thread_mentions + todo_meta + entries.

**The problem:** for each thread, compute `lastMentionAt`, `entriesThisWeek`, `openTodos`, `recentTodos[3]`, `staleness`, `activeDates` (manual-touch days). Then sort by pinned → staleness → recent.

---

## Pseudocode

```
  threads          = getThreads(includeArchived=false)            // ~10s of rows
  lastMentionMap   = getLastMentionByThread()                     // 1 SQL aggregate
  activityRows     = SELECT thread_id, entry_date FROM thread_mentions
                     WHERE entry_id IS NULL AND todo_id IS NULL  // manual-touch only
                       AND deleted_at IS NULL
  weekRows         = SELECT thread_id, COUNT(DISTINCT entry_id) AS cnt
                     FROM thread_mentions
                     WHERE entry_id IS NOT NULL
                       AND entry_date >= weekStartISO
                       AND deleted_at IS NULL
                     GROUP BY thread_id
  todoLinkRows     = SELECT DISTINCT thread_id, todo_id FROM thread_mentions
                     WHERE todo_id IS NOT NULL AND deleted_at IS NULL

  allMetas = getAllTodoMetas()                                    // joined in JS
  metaById = Map(allMetas.map(m => [m.todoId, m]))
  todoTextById = built from getAllEntries() entries

  for each thread:
    linkedTodoIds = todoIdsByThread[thread.id]
    openTodos = 0
    recents = []
    for tid in linkedTodoIds:
      meta = metaById[tid]; todo = todoTextById[tid]
      if !meta || !todo || todo.done: continue
      openTodos++
      recents.push({ tid, todo.text, meta.type, todo.createdAt })
    recents.sort(byCreatedAtDesc).take(3)

    lastAt = lastMentionMap[thread.id] ?? null
    days = lastAt ? differenceInDays(now, lastAt) : null
    staleness = computeStaleness(thread, lastAt, now)

    cards.push({ thread, lastAt, days, staleness, entriesThisWeek, openTodos, recents, activeDates })

  return cards.sort(pinned ↓, stalenessRank ↑, lastAt ↓, name ↑)
```

---

## Execution trace

(3 threads, 2 mentions each, today = 2026-05-07):

```
  threads = [#loopd, #health, #journal]
  lastMentionMap   = { loopd: "05-07T09:00", health: "05-04T18:00", journal: null }
  activeDates      = { loopd: {05-07}, health: {}, journal: {} }      ← manual touches
  weekRows         = { loopd: 1, journal: 0 }
  todoIdsByThread  = { loopd: {t-1, t-2}, health: {}, journal: {t-9} }

  Iterate:
    #loopd:
      linked = {t-1, t-2}
      t-1 meta exists, not done → openTodos=1, push recent
      t-2 meta exists, done    → skip
      lastAt 05-07T09:00, days=0, staleness=fresh (target=null, days≤1)
      activeDates={05-07}
    #health:
      linked = {}
      lastAt 05-04T18:00, days=3, staleness=aging (default thresholds: 1d/3d/7d)
    #journal:
      linked = {t-9}
      t-9 meta missing → skip (defensive)
      lastAt null     → staleness=cold

  Sort:
    pinned all false → next key
    stalenessRank: fresh(0) < aging(1) < cold(3)
    Result: [#loopd, #health, #journal]
```

**Complexity:** O(T + M + Q) time where T=threads, M=mentions, Q=todos · O(T + M + Q) space. SQL does the heavy work; JS does linear joins.

---

## Why not run a giant JOIN in SQL?

Could. But `getAllEntries` is already in memory (it's the dashboard's primary state) so reusing it is free. Two SQL roundtrips traded for one in-memory join.

The "giant JOIN" alternative would push everything into Postgres-style aggregates: `SELECT thread_id, COUNT(*), MAX(updated_at), ARRAY_AGG(...)` — but SQLite's array agg is more limited, and the join shape would be cross-product-y between mentions and the entries table.

---

## When brute force is fine

The "brute" alternative is per-thread queries (N+1 pattern: for each thread, run a query). At a few dozen threads that would be hundreds of roundtrips per dashboard load. The aggregate-then-join pattern fixes it cleanly. Don't ship the N+1 version.

---

## In this codebase

- `src/services/threads/getThreadCards.ts` → the orchestrator.
- `src/services/threads/staleness.ts` → `computeStaleness()`.
- `src/services/database.ts` → the helper queries (`getLastMentionByThread`, `getAllTodoMetas`, etc.).
- `src/components/home/DailyScheduleGrid.tsx` → consumer.

---

## Elaborate

### Where this pattern comes from
The "fetch in bulk, join in memory" pattern is older than ORMs — it's how every report-generation system works. ActiveRecord's `includes`, GraphQL DataLoader, Postgres `WITH` CTEs all express the same idea: collapse the N+1 into a constant number of queries.

### The deeper principle
**The number of round-trips is the cost, not the rows in each round-trip.** Network latency dominates SQLite query time at small scale; one query for 10K rows beats 10K queries for 1 row each.

### Where this breaks down
- Working sets that don't fit in memory. The dashboard's "all entries" assumption holds because the user has hundreds, not millions.
- Cases where the joins need server-side filtering that SQL would do better. Loopd's joins are simple lookups; SQL doesn't add much.

### What to explore next
- DataLoader / GraphQL → the same pattern at request granularity.
- Postgres CTE / lateral joins → for richer SQL aggregates.

---

## Tradeoffs

- **4 queries + 2 joins** — gives: bounded round-trips, cheap composition. Costs: more code than a single SELECT.
- **In-memory joins** — gives: leverage existing entries cache. Costs: must keep memory cache fresh.
- **Per-row defensive `skip`** — gives: missing metadata doesn't crash the dashboard. Costs: silent data drops; warn in dev mode if you care.
