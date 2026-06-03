# Indexing vs query patterns — what buffr queries vs what buffr indexes
## Industry name(s): index-query alignment, covering index · Type: Foundational

> Buffr's queries are dominated by `WHERE user_id = ? AND <something>`. The composite PK `(user_id, id)` covers half of them. Notably absent: `(user_id, updated_at)` for the sync pull and `(user_id, type)` for the todo list-view filter.

## Zoom out, then zoom in

```
  QUERIES                                INDEX HIT?
  ────────────────────────────           ──────────
  WHERE user_id=? AND date=?              PK partial (filter date)
  WHERE user_id=? AND id=?                PK exact
  WHERE user_id=? AND type=? (todo_meta)  PK partial (filter type)
  WHERE updated_at > synced_at            FULL SCAN (local)
  WHERE updated_at > cursor               PK partial (sort updated_at)
```

Zoom in: every query gets the `user_id` prefix from the PK. Beyond that, most queries do a filter+sort step after the index. At buffr's scale this is fast; the scale-tier-up cost is real.

## Structure pass

```
  layers   ─ query ─ index used ─ heap fetch
  axes     ─ alignment (predicate ←→ index columns)
             ─ shape (point vs range)
  seams    ─ planner picks the best alignment available
```

## How it works

### Move 1 — every query is per-user

```
  buffr is single-user per device, but the schema is multi-user-ready.
  every query carries WHERE user_id = ? as a prefix. the composite PK
  guarantees this prefix is fast.
```

### Move 2 — the gap is (user_id, updated_at)

```
  sync pull, prose-commit, "what changed today" — all want
  rows ordered by updated_at. without (user_id, updated_at) the
  planner sorts post-fetch. fine at small scale; not at large.
```

### Move 3 — the principle: index for the queries that run often

```
   ┌──────────────────────────────────────────────────┐
   │ at scale buffr's hot path is the sync pull. its  │
   │ predicate is (user_id, updated_at > cursor).     │
   │ this is the index to add. one CREATE INDEX per   │
   │ synced table; <5 LOC of migration.               │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```sql
-- proposed: supabase/migrations/0013_add_updated_at_indexes.sql
CREATE INDEX IF NOT EXISTS entries_user_updated_idx
  ON buffr.entries (user_id, updated_at);
-- repeat per synced table.
```

```ts
// the SQLite-side dirty filter would also benefit from
// CREATE INDEX entries_dirty_idx ON entries(user_id, updated_at, synced_at)
// but only matters at higher row counts.
```

## Elaborate

The "PK-only" pattern is the smallest correct index set. It works until specific queries get hot. Buffr's sync pull is exactly that — same query shape every tick. Adding the matching index is one-shot work that pays off at every later scale tier.

## Interview defense

**Q [mid]:** What index is missing?

**A:** `(user_id, updated_at)` per synced table. Sync pull structurally needs it. Today the planner does post-fetch sort; tomorrow that spills to disk and sync feels slow.

**Q [senior]:** Why didn't this ship with the schema?

**A:** YAGNI at the time of writing. Adding an index has a write tax; at then-scale (few rows) the planner's post-fetch sort was free.

## Validate

### Level 1 — list the queries and which index each hits.

### Level 2 — explain the leftmost-prefix rule.

### Level 3 — apply: a feature wants "show me last 7 days of nutrition." Query shape? Index? `(user_id, date)`. Already partially served by PK.

### Level 4 — defend: "Add every index that might help." No; write tax compounds.

## See also

- `01-the-data-model-and-its-shape.md`
- `../study-database-systems/03-btree-hash-and-secondary-indexes.md`
- `../study-database-systems/04-query-planning-and-execution.md`
