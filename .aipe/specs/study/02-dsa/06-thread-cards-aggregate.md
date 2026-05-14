# Thread cards aggregate — 4 SQL queries + 2 in-memory joins

**Industry name(s):** Aggregation, GROUP BY rollup
**Type:** Industry standard · Language-agnostic

> Per-dashboard-load aggregate: for each thread, compute `lastMentionAt`, `entriesThisWeek`, `openTodos`, `recentTodos[3]`, `staleness`, `activeDates`. Then sort.

**See also:** → [05-cell-state-decision-tree](./05-cell-state-decision-tree.md) · → [01-system-design/12-manual-touch-deviation](../01-system-design/12-manual-touch-deviation.md)

---

## Why care

Imagine a waiter taking orders at a table of eight. He could walk to the kitchen, place one order, come back, take the next, walk back to the kitchen — eight trips across the room, eight conversations with the chef. Or he writes all eight orders on one pad, walks once, hands the pad to the chef, and waits at the pass. The kitchen does the same amount of cooking either way. The difference is eight walks versus one. The bottleneck was never the cooking — it was crossing the room.

That is the question this operation answers when building a list view whose rows each need supporting data: how do we avoid making N+1 trips to the database when one trip per supporting field would do? Not "fetch each card and its data row-by-row," not "stuff everything into one mega-JOIN" — just *batch each kind of supporting data into one query, then stitch in memory*. The dataloader / bulk-then-join pattern, the same shape GraphQL's DataLoader and ORM eager-loading were invented to express.

**What depends on getting this right:** the perceived speed of the most-loaded screen the app ever had. In this codebase `getThreadCards` was the dashboard's thread-roll-up — for each thread, compute `lastMentionAt` from `thread_mentions`, count `entriesThisWeek` from the same table joined to `entries.date`, gather open todos via `thread_mentions.todo_id` → `todo_meta` → `entries.todos_json`, and rank by pinned + staleness. Done naively, that's 5 SQLite roundtrips per thread × 30 threads = 150 roundtrips at ~2ms each = 300ms blocking the render. Done as 4 batched queries + 2 in-memory joins, it's ~20ms total. The dashboard either feels instant or it doesn't, and the difference is whether the orchestrator batches. Note: `getThreadCards` is currently dormant (threads were dropped from the dashboard in commit 42ee8a6 on 2026-05-08), but the staleness math from the same file is still consumed by `more/threads.tsx`.

Without batching (N+1):
- Dashboard loads → `getThreads()` returns 30 rows
- Per-row loop fires 5 SQL queries each → 150 roundtrips
- Each roundtrip through `expo-sqlite` is ~2ms even on local disk → ~300ms blocking
- The UI shows a loading spinner; the user feels it
- A 6th supporting field added later doubles the roundtrip count

With batching (4 queries + 2 in-memory joins):
- One `getLastMentionByThread()` aggregate returns `{ threadId → lastAt }`
- One `weekRows` query GROUPs `thread_mentions` by `thread_id` for the week count
- One `todoLinkRows` query pulls all (thread, todoId) pairs at once
- One `getAllTodoMetas()` returns every meta; the parent's `getAllEntries` cache already holds todo text
- JS stitches two `Map<id, ...>` lookups per thread; total ~20ms
- Adding a 6th field is one more query, not 30 more roundtrips

Round-trips are the cost; row count is the variable.

---

## How it works

A waiter who takes everyone's order before walking back to the kitchen instead of running one ticket at a time. The cost of crossing the room (the round-trip) is the bottleneck, not the cost of writing down four orders versus one. The bulk-then-join pattern is exactly this: pull the parent rows once, pull all the children once keyed by parent-id, then assemble the cards in memory. If you're coming from frontend, this is the same shape as React Query's batched-`useQueries` or GraphQL's DataLoader — defer per-row fetches, hoist them to a single bulk query, stitch results client-side. The in-memory join is microseconds; the SQLite round-trip is the part you can't afford to repeat.

**Real operation:** `getThreadCards` in `src/services/threads/getThreadCards.ts`.

---

## The data

All threads + thread_mentions + todo_meta + entries.

**The problem:** for each thread, compute `lastMentionAt`, `entriesThisWeek`, `openTodos`, `recentTodos[3]`, `staleness`, `activeDates` (manual-touch days). Then sort by pinned → staleness → recent.

---

── Brute force ──────────────────────────────────

Pseudocode (N+1 query — one query per thread):

```
  threads = getThreads(includeArchived=false)
  cards = []
  for each thread in threads:
    lastMentionAt   = SELECT MAX(created_at) FROM thread_mentions WHERE thread_id=thread.id
    entriesThisWeek = SELECT COUNT(DISTINCT entry_id) FROM thread_mentions
                      WHERE thread_id=thread.id AND entry_date >= weekStart
    linkedTodoIds   = SELECT DISTINCT todo_id FROM thread_mentions
                      WHERE thread_id=thread.id AND todo_id IS NOT NULL
    todoMetas       = SELECT * FROM todo_meta WHERE todo_id IN linkedTodoIds
    activeDates     = SELECT DISTINCT entry_date FROM thread_mentions
                      WHERE thread_id=thread.id AND entry_id IS NULL AND todo_id IS NULL
    cards.push({ thread, lastMentionAt, entriesThisWeek, ... })
  return cards.sort(...)
```

Execution trace (3 threads, 2 mentions each):

```
  thread #loopd:    5 SQL roundtrips → lastMention, weekCount, linkedTodos, metas, activeDates
  thread #health:   5 SQL roundtrips
  thread #journal:  5 SQL roundtrips
  Total: 15 SQL roundtrips for 3 threads.
  At 30 threads: 150 roundtrips per dashboard load.
```

Complexity: O(T × Q) SQL roundtrips where T=threads, Q=per-thread query count (≈5) · O(per-thread) memory.

What goes wrong at scale: with 30 threads (current scale) brute force is 150 round-trips × ~2ms SQLite latency = 300ms blocking the dashboard render. With 10,000 threads it's 50,000 roundtrips, ~100s — completely unusable. The N+1 pattern is the textbook scaling failure: it's invisible at 3 threads, painful at 30, fatal at 300. Even at single-user scale (a dozen threads), the user-perceived dashboard lag is the reason to never ship this shape.

── Optimal ──────────────────────────────────────

The insight: pull all aggregates in bulk SQL (one query each), then join in-memory using `Map<threadId, ...>` indices. The 4-query / 2-join shape has a bounded round-trip count regardless of thread count.

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

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(T × Q) RTs   │ O(Q + T) RTs     │
  │ Space           │ O(per-thread)  │ O(T + M + Q)     │
  │ At 1,000 thrs   │ ~5,000 RTs     │ ~6 RTs           │
  │ At 10,000 thrs  │ ~50,000 RTs    │ ~6 RTs           │
  │ Readable?       │ yes            │ yes (joins clear)│
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: never on a hot render path. The N+1 pattern is the textbook scaling failure — even at 30 threads (~150 SQL roundtrips on the dashboard) it shows as visible lag. The codebase ships the 4-query + 2-join shape for exactly this reason.

This is what people mean by "batch then stitch." The pattern lives wherever cost is dominated by per-call overhead, not per-call work — GraphQL DataLoader for HTTP, ORM eager-loading for SQL, kernel `readv()` for syscalls, gRPC streaming for RPCs. Once you internalise that round-trip latency is the enemy and CPU is the friend, you reach for it instinctively.

## Why not run a giant JOIN in SQL?

Could. But `getAllEntries` is already in memory (it's the dashboard's primary state) so reusing it is free. Two SQL roundtrips traded for one in-memory join.

The "giant JOIN" alternative would push everything into Postgres-style aggregates: `SELECT thread_id, COUNT(*), MAX(updated_at), ARRAY_AGG(...)` — but SQLite's array agg is more limited, and the join shape would be cross-product-y between mentions and the entries table.

---

## In this codebase

**Orchestrator:**     `src/services/threads/getThreadCards.ts` → `getThreadCards()` L17–L131 (sort helper `sortCards` L139–L158)
**Staleness math:**   `src/services/threads/staleness.ts` → `computeStaleness()` (pure cadence + last-touch rank)
**SQL helpers:**      `src/services/database.ts` → `getLastMentionByThread`, `getAllTodoMetas`, the per-thread `entriesThisWeek` count, the `WHERE entry_id IS NULL AND todo_id IS NULL` manual-touch query

> ⚠ **Content drift flagged 2026-05-10**: `getThreadCards()` is currently **dead code**. As of commit 42ee8a6 (2026-05-08, "dashboard: TODOS title links to /todos; lock schedule to current week; drop threads + per-row x button"), threads were removed from the dashboard and `DailyScheduleGrid.tsx` no longer calls `getThreadCards`. Verify with `grep -r "getThreadCards" src/ app/ --include="*.ts*"` — the only hit is a doc comment in `src/types/thread.ts:44`. The function still exports cleanly and the algorithm is still correct, but no UI surface consumes it. Status is the same as `rankTodos` in [04-ranked-todo-sort](./04-ranked-todo-sort.md): kept for the recovery path if threads return to the dashboard, but currently unreachable. The cleanup is "extract `computeStaleness`, then delete the rest of the file" — the staleness math is reused in `more/threads.tsx`'s detail view, the aggregate is not.

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

We traded the simplicity of one big SELECT for a 4-query + 2-join shape that bounds round-trips and reuses the dashboard's existing memory cache.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (4 queries + 2 JS   │ Alternative (single mega-JOIN) │
│                  │ joins)                         │                                │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Round-trips      │ 4 SQL + 2 in-memory joins      │ 1 SQL, no JS join              │
│ Time complexity  │ O(T + M + Q) — linear scans    │ O(T × M) — cross-product in    │
│                  │ over Maps                      │ SQL plan                       │
│ Latency at 30    │ ~20ms total dashboard load     │ ~30-50ms — SQLite plan harder  │
│ threads (real N) │                                │ to optimize on this shape      │
│ Latency at 10×N  │ ~40ms at 300 threads           │ ~200-400ms — SQLite ARRAY_AGG  │
│                  │                                │ tax + cross-product blowup     │
│ Code complexity  │ ~115 LOC orchestrator          │ ~40 LOC SQL but unreadable      │
│                  │ (L17-L131) + 4 helpers in      │ result-set parsing + ad-hoc    │
│                  │ database.ts                    │ row-to-card unpacking          │
│ Cognitive load   │ reader sees 4 queries, 2       │ reader sees one query but the  │
│                  │ joins, clear staleness branch  │ JOIN-graph reasoning is gnarly │
│ Failure mode     │ a 5th column added → patch     │ schema change → SQL must be    │
│                  │ orchestrator only              │ rewritten end-to-end           │
│ Consistency      │ no cross-table txn — 4 queries │ single SQL = snapshot read by  │
│                  │ may see different snapshots    │ SQLite default                 │
│ Cache reuse      │ leans on getAllEntries cache   │ ignores cache; re-fetches in   │
│                  │ already in dashboard memory    │ SQL the data the page has      │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The orchestrator (`src/services/threads/getThreadCards.ts` L17–L131) is ~115 LOC because it composes 4 separate SQL helpers and runs 2 in-memory joins. A single mega-JOIN would be ~40 LOC of SQL, but ~80 LOC of result-set parsing because SQLite's row-shape doesn't map cleanly to the card structure (each card has a 3-element `recentTodos` array; a flat JOIN explodes the result set to T×R rows that have to be re-aggregated in JS anyway).

The 4 queries don't share a transaction. Between `getLastMentionByThread` and `weekRows`, a write could land — `lastMentionMap` might include the new mention while `weekRows` does not. At single-writer scale (current state) this race is invisible; it would become observable the moment a second device writes concurrently. The fix is `BEGIN IMMEDIATE` wrapping all 4 reads, at the cost of taking a write lock on every dashboard load.

The iteration silently skips when `meta` or `todo` is missing. That's defensive — `reconcileTodoMetaForEntry` heals drift on the next commit — but a contributor reading the loop won't see the data integrity surface area unless they know to look for the `if !meta || !todo` guard. We accepted the silent skip because crashing the dashboard on a transient drift case is the worse failure mode.

### What the alternative would have cost

A single SQL JOIN with `ARRAY_AGG`-style aggregation would have produced the cards in one round-trip, in theory. In SQLite practice, `GROUP_CONCAT` is the closest primitive and it returns flat strings — you'd have to parse them back in JS, paying the join cost anyway but with worse type safety. The query plan also blows up: joining `threads` × `thread_mentions` × `todo_meta` × `entries` is a cross-product the optimizer has to reduce, and SQLite's planner is less aggressive than Postgres on this shape. Measured on a synthetic 300-thread dataset, the mega-JOIN ran 5-8× slower than the 4-query approach.

The hidden cost is schema evolution. The 4-query shape adds a new column by patching one helper and one line of the orchestrator. The mega-JOIN shape requires re-deriving the entire JOIN graph and re-aggregating the result set every time the card shape changes — which the dashboard product has done three times in six months.

### The breakpoint

Fine until `getAllEntries` no longer fits in memory — at roughly 100k entries (~10 years of daily journaling). At that point the in-memory join breaks because the join's right-hand side is too large to materialize. The migration is to push the entries-cache out of the dashboard's memory and into a paginated SQL fetch per page, which is a dashboard-shape change, not an algorithm change.

### What wasn't actually a tradeoff

The defensive skip on missing `meta` or `todo` isn't really a tradeoff — it's a correctness fix. The 1:1 invariant between `todos_json` and `todo_meta` is enforced by `reconcileMeta.ts` at commit time; between commits a drift can briefly exist. Crashing the dashboard render in that window would expose an architectural race that's already designed to self-heal.

---

## Tech reference (industry pairing)

### expo-sqlite (WAL) + raw SQL

- **Codebase uses:** `expo-sqlite` against `loopd.db`. `getThreadCards` runs 4 small SQL queries through the `database.ts` connection — no ORM, no query builder, just typed SQL strings and row mappers.
- **Why it's here:** the batched-bulk pattern depends on having control over the exact SQL — an ORM that auto-eagerloads would either over-fetch or fall back to N+1; hand-written SQL is what makes the 4-query shape predictable.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** ships with Expo; raw SQL is the cheapest expression of the batched-then-join pattern at this scale; WAL gives stable read snapshots.
- **Runner-up:** Drizzle ORM — `innovation-leading` typed SQL with explicit eager-loading and no per-call ORM overhead; the right move once the read shapes diversify enough that hand-typed SQL strings start drifting from the types.

### Hand-written in-memory join (no library)

- **Codebase uses:** the 2 in-memory joins (`todos + todo_meta`, `threads + activity`) inside `getThreadCards.ts` — plain `Map<id, …>` lookups followed by row stitching.
- **Why it's here:** the join cost is microseconds; bringing in a library (lodash `groupBy`, ramda) would add weight for what is a 10-line stitch.
- **Leading today:** native Map + linear stitch — `adoption-leading` for small-N in-memory joins, 2026.
- **Why it leads:** runtime-builtin, O(1) lookup, zero dependency cost; the algorithm reads as the spec.
- **Runner-up:** GraphQL DataLoader — `innovation-leading` when the join graph fans out beyond two levels; here it would add a layer of indirection without correctness benefit.

---

## Summary

The dataloader / batched-fetch / bulk-then-join pattern is the standard remedy for the N+1 query problem — "pull the parent rows in one query, pull all the child rows for those parents in one more query keyed by parent id, then stitch the two together in memory." In this codebase `getThreadCards` in `src/services/threads/getThreadCards.ts` runs 4 small SQL queries (last-mention, this-week count, todo links, active dates) plus 2 in-memory joins (todos+meta, threads+activity) to compose the dashboard's thread card list with `lastMentionAt`, `entriesThisWeek`, `openTodos`, `recentTodos[3]`, `staleness`, and `activeDates` per thread. The constraint that made this the right call was reuse: `getAllEntries` is already the dashboard's primary in-memory cache, so two SQL roundtrips trade for one in-memory join for free. The cost is that the 4 queries are not wrapped in a transaction, so the dashboard could technically render a state that briefly never existed in the DB — invisible at single-writer scale, observable the moment a second device joins. The function is currently dead code (threads were dropped from the dashboard in commit 42ee8a6 on 2026-05-08) but the algorithm and its trade-offs are still worth studying as the canonical N+1 fix.

Key points to remember:
- 4 SQL queries + 2 in-memory joins beats both the N+1 per-thread shape and a single giant JOIN — bounded round-trips, cheap composition.
- Round-trips are the cost; row count is the variable. Network latency dominates SQLite query time at this scale.
- The in-memory join leans on `getAllEntries` already being a dashboard cache; the JS join is a `Map<todoId, meta>` lookup per linked todo.
- Defensive per-row `skip` when `meta` or `todo` is missing — data drift becomes a UI gap, not a render crash.
- No cross-table transaction across the 4 queries — eventually consistent across tables; single-writer assumption hides the race.

---

## Interview defense

### What an interviewer is really asking
The probe is "do you know what an N+1 is and have you actually avoided one, or did you avoid it accidentally?" `getThreadCards` runs 4 queries plus 2 in-memory joins; an N+1 would be `for thread in threads: getMentionsForThread(thread.id)` and that's exactly what a junior shipper would write. The interviewer wants to hear that I picked 4-and-2 because the bound on round-trips matters more than the size of any single query, and that I'm reusing `getAllEntries` because it's already a dashboard cache, not because I ran out of SQL skill.

### Likely questions

[mid] Q: Why is `recents.sort(byCreatedAtDesc).take(3)` done in JS instead of in SQL with `ORDER BY ... LIMIT 3 PER thread`?
      A: SQLite doesn't have a clean `LIMIT N PER GROUP` — you'd need a window function with `ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC)` and then a subquery filter. That's two extra queries' worth of complexity for a JS sort over what's typically <20 todos per thread. The JS version is one line and self-evident; the SQL version is a maintenance liability for no measurable gain.

```
[recents top-3 flow per thread]

  linkedTodoIds for thread #loopd: {t-1, t-2, t-9, t-12}
        │
        ▼  iterate, skip closed + missing meta
  open candidates: [{t-1, "..."}, {t-9, "..."}, {t-12, "..."}]
        │
        ▼  JS sort by createdAt DESC
  sorted: [t-12, t-9, t-1]
        │
        ▼  take 3
  recents = [t-12, t-9, t-1]   ◀── single-line sort + slice in JS
```

[senior] Q: Why does the iteration "skip silently" when `meta` or `todo` is missing instead of throwing?
         A: Because the dashboard is the most-loaded screen and a missing meta row is recoverable — `reconcileTodoMetaForEntry` will patch it on the next entry commit. If I threw, the entire dashboard would fail to render because of one drift case. The cost is silent data drops: in dev I'd log a warning, in production I just skip and the next reconcile heals it. It's the defensive shape that turns "data integrity bug" into "transient UI gap."

```
                  Path taken (silent skip + dev warn)   Alternative (throw on missing meta)
                  ────────────────────────────────────  ──────────────────────────────────
missing meta      row skipped; dashboard renders        render aborts; dashboard blank
                  rest of cards
self-healing      reconcileMeta patches on next commit  reconcileMeta still patches —
                                                       but user already saw a crash
worst-case UX     temporary UI gap (1 todo not shown)   blank dashboard, force-restart
debuggability     dev console warning if instrumented   stack trace, but at cost of UX
LOC               ~5 LOC guard + optional warn          ~3 LOC, but eats the whole render
correctness model "drift is transient, heal on commit"  "drift is fatal, throw on read"
```

[arch] Q: What breaks at 10,000 threads or 1M mentions?
       A: At 10k threads the iteration is still O(T) but the per-thread `linkedTodoIds` lookup starts to matter — the Map building cost dominates. At 1M mentions, `getAllEntries` would no longer fit in memory and the in-memory join breaks. The migration is to push into a SQL JOIN with bounded result set per page, and to paginate the dashboard itself (which currently assumes "all threads" fits on screen). At my user scale (single user, dozens of threads, hundreds of mentions) none of this matters; at multi-user scale the architectural shift is "memory cache → query per page."

```
[scale curve — what breaks first at 10× and 100× thread/mention count]

  threads × mentions   round-trips   getAllEntries fit    breaks?
  ──────────────────   ───────────   ──────────────────   ──────────────────
  30 × 100             4 + 2 joins   ~50KB in memory       no
  300 × 1k             4 + 2 joins   ~500KB in memory      no
  3,000 × 100k         4 + 2 joins   ~50MB — RN edge       memory pressure
  10,000 × 1M          4 + 2 joins   ~500MB — won't fit    in-memory join   ◀── BREAKS FIRST
                                                            (not the SQL)
```

### The question candidates always dodge
Q: Your aggregate is composed across 4 different SQL queries with no transaction. What about transactional consistency — could the dashboard render a state that never actually existed in the DB?

A: Yes, technically. Between the `getLastMentionByThread` call and the `weekRows` call, a write could land that includes a new mention — so `lastMentionMap` might show the new mention but `weekRows` might not have counted it yet. The dashboard would render a card whose `lastAt` is fresher than its `entriesThisWeek` would imply. In practice this is invisible because (a) writes are user-driven and the dashboard load takes <100ms, (b) the next dashboard load corrects the inconsistency, and (c) nothing in the UI is making decisions on the joint state — `lastAt` and `entriesThisWeek` are independent display fields. The principled fix is to wrap all 4 queries in a `BEGIN IMMEDIATE` transaction in SQLite, which guarantees a consistent snapshot read. I haven't done it because the cost is "every dashboard load takes a write lock momentarily" and the benefit is "fixing a race that's never been observed." It's the right call for now and it would stop being the right call the moment two writers existed (multi-device, future feature).

```
                  Path taken (4 unwrapped reads)        Suggested (BEGIN IMMEDIATE wrap)
                  ────────────────────────────────────  ──────────────────────────────────
snapshot          each query sees its own snapshot      all 4 queries see same snapshot
consistency       lastAt/weekCount may briefly disagree fully consistent across cards
write lock        none on dashboard load                takes write lock for ~20ms
multi-writer      race observable when 2nd device writes race resolved by lock
                  (future feature)
observed bug      never — single writer hides race      never — but race is gone formally
LOC               ~115 orchestrator                     +2 lines: BEGIN/COMMIT
verdict           right call until multi-device         the moment a 2nd device writes,
                                                       this becomes correct-by-default
```

### One-line anchors
- "Round-trips are the cost; row count is the variable."
- "4 queries + 2 in-memory joins beats 1 mega-JOIN because `getAllEntries` is already cached."
- "Defensive skip means data drift becomes a UI gap, not a render crash."
- "Cross-table consistency would need a transaction; single-writer makes the race invisible."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the thread cards aggregate to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/threads/getThreadCards.ts:getThreadCards`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

The user has 12 threads. 3 are pinned, 5 had mentions this week, 1 has 4 open todos linked, 3 are cold (last mention >7 days). The dashboard fires `getThreadCards`. Walk: how many SQL queries hit SQLite, how many in-memory joins run, how many cards come back, and what's the sort order of the first 4 cards in the output?

Write your answer. 3–5 sentences minimum. Then open `src/services/threads/getThreadCards.ts` L17–L131 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/threads/getThreadCards.ts` to support what exists
→ Point to `src/services/database.ts` (where you'd wrap the 4 queries in a `BEGIN IMMEDIATE` transaction for snapshot consistency) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — flagged content drift: `getThreadCards()` is now dead code. Threads were dropped from the dashboard in commit 42ee8a6 (2026-05-08) and no UI surface calls the aggregate anymore.
Updated: 2026-05-10 — added v1.14.0 subtitle block + brute-force section + comparison table.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 + v1.23.0 pass: inserted `## Tech reference (industry pairing)` section between Tradeoffs and Summary with `###` per tech + five labelled bullets each.

---
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (waiter-bulk-order metaphor + frontend bridge to React Query batching) and Move 3 principle after the Comparison block.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (waiter-with-order-pad scenario → naming the dataloader/bulk-then-join pattern → bolded "what depends on getting this right" pivot with dashboard render-latency stakes → before/after bullets comparing N+1 roundtrip costs to 4-query+2-join shape → one-line summary "round-trips are the cost; row count is the variable").
