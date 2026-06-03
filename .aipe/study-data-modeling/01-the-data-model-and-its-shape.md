# The data model and its shape — entities, relationships, the schema as built
## Industry name(s): ER model, schema topology, data shape · Type: Foundational

> Ten synced tables. Every table is per-user (composite PK `(user_id, id)`). Relationships are by convention (e.g., `entry_id` column), not enforced by foreign keys. The model is "wide and shallow" — many small tables, no deep object graphs.

## Zoom out, then zoom in

```
  LAYERS

  one user
   ├─ entries (one per day; the prose)
   │   ├─ todos_json (denormalized projection)
   │   ├─ todo_meta (normalized projection)
   │   ├─ thread_meta (mention edges)
   │   ├─ nutrition_meta (per-line)
   │   └─ ai_summaries (chain results)
   ├─ threads (named contexts; cross-day)
   ├─ nutrition (daily aggregates)
   └─ vlogs (uploaded clip metadata)
```

Zoom in: `entries` is the load-bearing table. Everything else either projects from `entries.text` (todo_meta, thread_meta, nutrition_meta, ai_summaries) or aggregates by date (nutrition, vlogs).

## Structure pass

```
  layers   ─ entries (truth) ─ derived meta ─ aggregates
  axes     ─ per-day  vs cross-day
             ─ derived vs authored
  seams    ─ entries.text ←→ todo_meta : reconcile
             ─ entries.text ←→ thread_meta : reconcile
             ─ todo_meta ←→ entries.todos_json : kept in sync
```

## How it works

### Move 1 — entries is the canonical row

```
  one entry per (user_id, date). composite PK = (user_id, id).
  id is monotonic per user. text is the user's prose for the day.
```

### Move 2 — meta tables are projections of prose

```
  reconcileMeta scans entries.text after each prose-commit.
  todo_meta gets one row per todo line in the prose.
  thread_meta gets one row per impacted thread.
  nutrition_meta gets one row per nutrition line.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ wide-and-shallow with per-row projections is the │
   │ shape that pairs well with prose-as-source-of-   │
   │ truth. it gives the UI fast row-shaped reads     │
   │ while keeping the user's writing in one place.   │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   the through-line

   user writes
   prose into                       
   entries.text                     
        │                            
        │  reconcileMeta             
        ▼                            
   projected rows                    
   ─ todo_meta            ◄── queried by UI for the list view
   ─ thread_meta           ◄── queried for the cross-day thread view
   ─ nutrition_meta        ◄── aggregated for the chart view
   ─ ai_summaries          ◄── shown as today's caption
```

## Implementation in codebase

The schema lives in `supabase/migrations/*.sql`. The local SQLite schema is hand-mirrored in `src/services/db/migrations.ts` (verify path). The two MUST match column-for-column on every synced table.

```sql
-- supabase/migrations/0001_initial.sql (abbreviated)
CREATE TABLE buffr.entries (
  user_id UUID NOT NULL,
  id BIGINT NOT NULL,
  date TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  todos_json JSONB NOT NULL DEFAULT '[]',
  updated_at BIGINT NOT NULL,
  synced_at BIGINT,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
```

## Elaborate

The "wide and shallow" pattern fits buffr because the access pattern is row-shaped (one entry per screen). The alternative — one big JSON document per day — would require parsing the whole document for every list view query. The current shape lets `SELECT type, count(*) FROM todo_meta WHERE user_id = ? AND deleted = 0 GROUP BY type` run as one index scan.

## Interview defense

**Q [mid]:** Draw the schema from memory.

**A:** Ten synced tables. Entries is canonical. Five meta tables project from entries.text (todo, thread, nutrition meta + ai_summaries cache). Threads and nutrition are top-level. Vlogs are blob metadata.

**Q [senior]:** Why no `users` table?

**A:** Anon auth today; user_id is the JWT sub. When real auth ships, a users table will appear, but only with profile fields not needed for the per-row PK.

## Validate

### Level 1 — sketch the schema.

### Level 2 — explain why meta tables are projections.

### Level 3 — apply: design a new "tag" feature. New tag_meta table? Probably; same shape as todo_meta.

### Level 4 — defend: "Just use one big JSON column per day." Wrong; UI would be slow on every list view.

## See also

- `02-normalization-and-duplication.md` — the prose vs todo_meta dup.
- `06-access-patterns-and-storage-choice.md` — why this shape works for buffr.
- `../study-database-systems/03-btree-hash-and-secondary-indexes.md` — index implications.
