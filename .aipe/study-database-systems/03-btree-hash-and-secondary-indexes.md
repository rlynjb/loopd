# B-tree, hash, and secondary indexes — what buffr has and what it doesn't
## Industry name(s): index types, covering index, index selectivity · Type: Foundational mechanism

> Buffr uses only B-tree indexes. The composite PK is the only secondary-shape index on every table. The sync pull's `WHERE updated_at > cursor ORDER BY updated_at` query is structurally an index range scan — and there is no index on `updated_at` to scan.

## Zoom out, then zoom in

```
  THE INDEXES BUFFR HAS

  every synced table:
    PRIMARY KEY (user_id, id)        ← B-tree (composite)

  that's it. no indexes on:
    updated_at        ← used by sync pull cursor
    synced_at         ← used by sync push dirty filter
    deleted           ← used by every read

  THE QUERIES THAT HIT INDEXES VS THE ONES THAT DON'T

  reads "today's entries":
    WHERE user_id = ? AND date = ?     ← partial index hit (user_id prefix)
                                         then filter date in heap

  sync pull:
    WHERE user_id = ? AND updated_at > ?
    ORDER BY updated_at                  ← user_id prefix hit; updated_at
                                          scan after that. could be a problem.

  sync push dirty filter (local SQLite):
    WHERE updated_at > synced_at          ← FULL TABLE SCAN.
                                            always.
```

Zoom in: on the device, the dirty filter is a sequential scan of the whole table. Buffr's tables are tiny (single user, ≤years of data), so this is fine. At 10M+ rows it would not be.

## Structure pass

```
  layers   ─ index ─ leaf ─ heap row
  axes     ─ selectivity (rows per index entry that match)
             ─ shape (point vs range vs prefix)
  seams    ─ query predicate ←→ index columns (must align)
             ─ ORDER BY columns ←→ index order (or sort step)
```

## How it works

### Move 1 — B-tree is a sorted log-N lookup

```
  point lookup:    log N pages
  range scan:      log N pages + (range size / page density) pages
  ORDER BY align:  free if the index covers the order; else a sort
```

### Move 2 — composite index leftmost-prefix rule

```
  index on (user_id, id):
    WHERE user_id = ?              ← hit
    WHERE user_id = ? AND id = ?   ← hit (point lookup)
    WHERE id = ?                   ← NO HIT (no leftmost prefix)
    WHERE user_id = ? AND date = ? ← partial hit (user_id only;
                                       date filter happens after fetch)
```

### Move 3 — the principle: index for the actual query shape

```
  the queries that run most often deserve indexes whose
  shape matches them exactly. buffr's most-frequent queries:
    1. dirty filter on local SQLite (FULL SCAN, fine at scale 1)
    2. pull cursor on Postgres (partial hit)
    3. read entries by date (partial hit; date filter post-fetch)
```

## Primary diagram

```
  what an index on (user_id, updated_at) WOULD do
  vs what (user_id, id) does today:

  current:
   sync pull: B-tree(user_id, id) → range scan all user A rows
                                    → filter updated_at > cursor
                                    → sort by updated_at

  with (user_id, updated_at):
   sync pull: B-tree(user_id, updated_at) → range scan ALREADY ordered
                                              by updated_at; cursor
                                              advances naturally
```

## Implementation in codebase

The only B-tree index per synced table is the composite PK:

```sql
-- supabase/migrations/0007_composite_pks.sql
ALTER TABLE buffr.entries  ADD CONSTRAINT entries_pkey  PRIMARY KEY (user_id, id);
ALTER TABLE buffr.todo_meta ADD CONSTRAINT todo_meta_pkey PRIMARY KEY (user_id, id);
-- ... and so on for each of the 10 synced tables.
```

**The missing index for sync performance:**

```sql
-- proposed: helps sync pull cursor advance cleanly
CREATE INDEX entries_user_updated_idx ON buffr.entries (user_id, updated_at);
```

Worth doing? Today: not yet exercised. Buffr's row count is tiny; the planner does a partial-prefix scan and a sort, all in memory. The breakpoint is when `EXPLAIN ANALYZE` on the pull query shows a sort node spilling — typically 10k+ rows per user.

## Elaborate

The "you have only the PK" pattern is common in small apps. It works until it doesn't. The signal that it's stopped working is usually a slow sync — pull queries that should be sub-second taking seconds because the planner is sorting in memory or, worse, on disk.

The hash-index alternative (Postgres supports `USING hash`) is rarely worth it; it can only do equality lookups, not ranges. Buffr would never use one.

## Interview defense

**Q [mid]:** What index would you add and why?

**A:** `(user_id, updated_at)` on each synced table. The sync pull cursor advances by `updated_at`; today that's a sort step. With the index it's a clean range scan. Worth doing once tables get bigger than memory.

**Q [senior]:** Why doesn't the leftmost-prefix on `(user_id, id)` help the pull query?

**A:** It helps the `user_id =` predicate. After that, the planner has all of user A's rows but they're ordered by `id`, not `updated_at`. It must either filter-then-sort or sequential-scan the range.

## Validate

### Level 1 — sketch the composite-PK B-tree leaf layout.

### Level 2 — explain why a query on `id` alone won't hit the PK.

### Level 3 — apply: a new feature wants "search entries by text." Walk the choices (Postgres trigram index; pg_trgm; or push search to SQLite FTS5 locally).

### Level 4 — defend: "Indexes are write tax; don't add any until you measure." True direction; buffr's writes are tiny and infrequent enough that the tax doesn't matter even with 3-4 indexes.

## See also

- `04-query-planning-and-execution.md` — how the planner uses these indexes.
- `02-records-pages-and-storage-layout.md` — what the leaf points into.
- `../study-data-modeling/03-composite-keys.md` — why composite.
