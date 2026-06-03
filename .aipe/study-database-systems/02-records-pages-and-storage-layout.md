# Records, pages, and storage layout — where rows actually live
## Industry name(s): storage layout, page format, row organization · Type: Foundational mechanism

> Storage is pages. Every read and write moves at least one page. The page size and the locality of related rows decide most of what feels "fast" or "slow" before any query plan runs.

## Zoom out, then zoom in

```
  PAGES — the unit of disk I/O on both engines

  SQLite                          Postgres
  ┌────────────────────┐          ┌────────────────────┐
  │ 4 KiB pages         │          │ 8 KiB pages         │
  │ one file: buffr.db   │          │ heap files + visibility│
  │ rowid order on disk  │          │ insertion order, then │
  │   for CLUSTERED PK   │          │ vacuum compaction     │
  │ B-tree leaf = row    │          │ heap tuple, separate  │
  │   data inline        │          │ from index            │
  └────────────────────┘          └────────────────────┘
```

Zoom in: buffr's `entries` table on Postgres is a heap (rows scattered in insertion order). The `(user_id, id)` PK is a B-tree pointing into the heap. On SQLite, with composite PK and `WITHOUT ROWID`, rows would be stored *in PK order in the B-tree leaves* — buffr doesn't use `WITHOUT ROWID`, so rows are stored in rowid order with a separate B-tree index on `(user_id, id)`.

This means: on SQLite, reads ordered by `(user_id, id)` still hit the index, then jump to the rowid in the leaf — non-clustered access pattern.

## Structure pass

```
  layers   ─ rows ─ pages ─ files ─ filesystem
  axes     ─ locality (rows near each other on disk)
             ─ density (rows per page)
             ─ I/O amplification (page size vs row size)
  seams    ─ row layout ←→ index layout
             ─ index entry ←→ heap row (Postgres) or B-tree leaf (SQLite)
```

## How it works

### Move 1 — page is the unit; rows are the user-facing primitive

```
  every read of one row pulls one page (typically).
  every write of one row dirties one page (typically).
  the bigger the page, the more rows per I/O — but the larger the I/O.
```

### Move 2 — buffr's row sizes

```
  entries (largest):
    date TEXT (10b) + text TEXT (∞; usually <2 KiB) + meta JSON (var)
    + user_id (UUID 16b) + id (BIGINT 8b)
    + updated_at, synced_at, deleted, ...
    typical row: 1-3 KiB

  todo_meta (small):
    user_id + id (24b) + type (var, ≤30b) + ...
    typical row: <100b
```

`entries` are the densest. ~3 rows per Postgres page; ~1-2 per SQLite page. `todo_meta` packs ~80+ rows per Postgres page.

### Move 3 — the principle

```
   ┌─────────────────────────────────────────────────┐
   │ if reads are by-user-by-day, store rows so that │
   │ a "user's day" lives in one or two pages.       │
   │ buffr partially does this (composite PK by      │
   │ user_id), partially doesn't (heap insertion).   │
   └─────────────────────────────────────────────────┘
```

## Primary diagram

```
  postgres heap layout (entries)

  page 1: [r1-user-A][r2-user-B][r3-user-A][r4-user-A][r5-user-C]
  page 2: [r6-user-B][r7-user-A][r8-user-C][r9-user-A]...
              ↑ user A's rows are scattered across pages

  B-tree index (user_id, id):
       root → ... → leaf: [(A, 1, page1)(A, 3, page1)(A, 4, page1)
                            (A, 7, page2)(A, 9, page2)...]

  reading user A's entries hits one index range scan +
  scattered page reads.
```

## Implementation in codebase

```sql
-- supabase/migrations/0007_composite_pks.sql (approximate)
ALTER TABLE buffr.entries
  ADD CONSTRAINT entries_pkey PRIMARY KEY (user_id, id);
```

The composite PK gives the B-tree the right *order*. It does NOT cluster the heap. For a workload that reads "give me user A's entries for the last 7 days," Postgres will:

1. B-tree range scan on the PK for user A → list of TIDs.
2. For each TID, fetch the heap page. Cache helps a lot here.

For SQLite (no `WITHOUT ROWID` in buffr), same shape: index scan → rowid → page.

**The improvement nobody has done yet:** `CLUSTER entries USING entries_pkey` on Postgres physically re-orders the heap by the PK. One-shot operation; subsequent inserts will scatter again. Worth doing if read latency on day-views ever becomes a complaint. Today: not yet exercised.

## Elaborate

The row-vs-page distinction is invisible until it isn't. Buffr's tables are small enough that everything fits in memory; locality doesn't matter today. The moment the cumulative size of `entries` exceeds shared_buffers (Postgres) or page cache (SQLite), the locality story starts to matter — that's when "fetch this user's last 30 days" becomes "fetch 30 scattered pages."

The principle generalizes: think of pages as the I/O unit, design row layouts to pack related rows together, and clustered storage (or its equivalent) is the next-level optimization.

## Interview defense

**Q [mid]:** What's a page and why does it matter?

**A:** It's the unit of I/O the storage engine reads and writes. On Postgres it's 8 KiB; on SQLite 4 KiB. Every read fetches at least one page; every write dirties at least one page. The number of rows per page decides how much you get for free per I/O.

**Q [senior]:** Why might the same query be fast on day 1 and slow on day 365?

**A:** Locality decays. New rows go to new pages. A "fetch this user's data" query that started as "one page, one I/O" becomes "many pages, many I/Os" as the heap fills with other users' rows. Clustering or partitioning can restore locality.

## Validate

### Level 1 — diagram

Sketch the page → row → index relationship for `entries`.

### Level 2 — explain

Under 90s: define page, define locality, name buffr's PK and what it does for B-tree order vs heap order.

### Level 3 — apply

A teammate asks "should we use `WITHOUT ROWID` on SQLite for entries?" Walk the tradeoff: clusters rows by PK; reduces one index level; costs row updates that change PK (none of buffr's do). Verdict: probably worth it; not done.

### Level 4 — defend

Defend or oppose: "Page size doesn't matter at our scale."

True today; false at ~10M rows. The cost of getting it wrong scales with table size.

## See also

- `03-btree-hash-and-secondary-indexes.md` — the index that points into pages.
- `04-query-planning-and-execution.md` — how the planner counts page reads.
- `../study-data-modeling/03-composite-keys.md` — why `(user_id, id)`.
