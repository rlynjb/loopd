# Query planning and execution — what the engines actually do
## Industry name(s): query plan, execution plan, optimizer · Type: Foundational mechanism

> Both engines have planners. Buffr has never run EXPLAIN against either. At today's scale this is fine; the moment a query feels slow, EXPLAIN is the first move.

## Zoom out, then zoom in

```
  PLAN STAGES on Postgres            on SQLite
  ───────────────────────────       ────────────────────
   parse        SELECT user_id...    parse
   rewrite      RLS policy applied   (no rewrite)
   plan         pick index, join     pick index
                method, sort order
   execute      scan ─ filter ─       scan ─ filter ─ sort
                sort ─ aggregate
```

Zoom in: buffr's queries are all single-table, no joins. The planner's job collapses to "pick an index (or sequential scan), filter, sort, return." There are no aggregations beyond `count(*)` (used nowhere in production paths). The planner cost model rarely surprises here.

## Structure pass

```
  layers   ─ parser ─ planner ─ executor
  axes     ─ cost (planner's estimate) vs actual
             ─ row count estimates (stats) vs reality
  seams    ─ predicate ←→ index column order
             ─ ORDER BY ←→ index natural order
```

## How it works

### Move 1 — the planner picks based on statistics

Postgres tracks per-column histograms (`pg_stats`). The planner uses them to estimate predicate selectivity. Bad stats → bad plans. Buffr never runs `ANALYZE` manually; Postgres autovacuum does it.

### Move 2 — sort vs index-order

```
  ORDER BY updated_at:
    without index on updated_at  → sort step (in memory or to disk)
    with index on updated_at     → index scan in natural order

  for buffr's tiny tables: in-memory sort is free.
  for 10k+ rows per user: sort spills; index becomes load-bearing.
```

### Move 3 — N+1 patterns to avoid

```
  the N+1 trap:
   for entry of entries:
     await db.query('SELECT ... WHERE entry_id = ?', [entry.id]);

  buffr doesn't have this today because every read returns whole
  rows (no follow-up fetches per row). But the prose-commit's
  reconcileMeta scans entries.todos_json and writes to todo_meta —
  this could become N+1 if not careful.
```

## Primary diagram

```
  the path of "fetch today's entry"

  query:  SELECT * FROM entries
          WHERE user_id = $1 AND date = $2 AND deleted = 0;

  postgres plan:
    Index Scan using entries_pkey on entries
      Index Cond: (user_id = $1)
      Filter: (date = $2 AND deleted = 0)

  cost:   ~3 page reads + filter on ~365 user rows.
          ~1ms cold; <0.1ms warm.
```

## Implementation in codebase

No `EXPLAIN` lives in the repo. Worth adding at the moment a query becomes consequential. The first candidate is the sync pull:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM buffr.entries
WHERE user_id = '...' AND updated_at > '2026-01-01'
ORDER BY updated_at
LIMIT 100;
```

Reading this would name the index-or-scan choice and the sort method (in-memory vs external).

For SQLite, the equivalent is `EXPLAIN QUERY PLAN`:

```sql
EXPLAIN QUERY PLAN
SELECT * FROM entries WHERE user_id = ? AND date = ?;
-- expected: SEARCH entries USING INDEX entries_pkey (user_id=?)
```

## Elaborate

The planner is *usually right* on simple queries. Where it goes wrong is on:

- correlated predicates (Postgres's row estimates assume independence)
- LIMIT with ORDER BY where the index doesn't cover the order
- joins on columns with skewed distribution

Buffr has none of these today. The first time it will matter is the first time someone writes an aggregation across all users (analytics) — and at that point the right move is to read the plan, not to guess.

## Interview defense

**Q [mid]:** What does the planner do?

**A:** Picks an index (or sequential scan), picks a join method (none for buffr), picks a sort order (with or without an index), and estimates the cost. The planner is the layer between "this query" and "this sequence of page reads."

**Q [senior]:** When have you been bitten by a bad plan?

**A:** Not yet on buffr — the queries are too simple. The classic case is a query whose plan was fine at small scale and becomes a sequential scan at large scale because stats drifted or the index lost selectivity.

## Validate

### Level 1 — sketch the plan stages for a SELECT.

### Level 2 — explain when a sort step happens.

### Level 3 — apply: a query is suddenly 100x slower in production. What's the first command you run? `EXPLAIN ANALYZE`.

### Level 4 — defend: "We don't need to look at plans for an app this small." True today. The discipline of looking is what makes a 10x query slowdown a 5-minute diagnosis instead of an afternoon.

## See also

- `03-btree-hash-and-secondary-indexes.md` — what the planner picks from.
- `02-records-pages-and-storage-layout.md` — what the plan's "cost" measures (page I/O).
- `../study-debugging-observability/audit.md` — observability of slow queries.
