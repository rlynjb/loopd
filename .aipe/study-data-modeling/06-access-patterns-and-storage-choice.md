# Access patterns and storage choice — why buffr's shape fits the engines
## Industry name(s): relational vs document vs KV, access-pattern-driven design · Type: Foundational

> Buffr's access pattern is row-shaped: every screen reads "one entry" or "many entries filtered by something." That maps cleanly to a relational schema with composite PK. JSON columns (`entries.todos_json`, `entries.meta`) cover the few document-shaped reads.

## Zoom out, then zoom in

```
  ACCESS PATTERNS

  daily entry view    ─► SELECT * FROM entries WHERE user_id=? AND date=?
                        + JSON parse todos_json
  todo list view      ─► SELECT type, status FROM todo_meta
                        WHERE user_id=? AND deleted=0
                        GROUP/FILTER by type
  thread view         ─► SELECT * FROM thread_meta WHERE thread_id=?
                        JOIN (in spirit) entries by entry_id
  nutrition chart     ─► SELECT date, protein_g FROM nutrition
                        WHERE user_id=? ORDER BY date DESC LIMIT 30
  cache lookup        ─► SELECT * FROM ai_summaries
                        WHERE chain=? AND input_hash=?
```

Zoom in: all five are row-shaped. None requires document parsing across many rows. The relational+JSON hybrid is the right fit.

## Structure pass

```
  layers   ─ UI need ─ query ─ engine response
  axes     ─ row-shaped vs document-shaped
             ─ point lookup vs aggregate
  seams    ─ UI requirement ←→ schema shape (must align)
```

## How it works

### Move 1 — relational for queryable, JSON for embedded

```
  if a field is queried/filtered ─► column
  if a field is only-ever-read-as-blob ─► JSON
  
  buffr: todo_meta.type is column (filtered). entries.todos_json is
  blob (read-with-entry, never filtered standalone).
```

### Move 2 — wrong choice would force JOIN-everywhere

```
  if buffr had stored todos as just JSON inside entries:
   ─ todo list view requires parsing all entries' JSON
   ─ count by type requires SELECT + parse + tally in app
  
  this is the trap of "just use Mongo for everything."
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ pick the shape that matches the queries. mix     │
   │ shapes deliberately when access patterns mix.    │
   │ Postgres + JSON columns is the standard answer.  │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   the shape match

   row-shaped reads
   (most of buffr)         ────► relational columns
                                  (entries, todo_meta, ...)

   embedded-with-row reads
   (todos_json,            ────► JSONB column
    entries.meta)                 (read-with-row, fast)

   key-value lookup
   (ai_summaries by hash)  ────► row with hash column + index
                                  (relational + index does KV well)
```

## Implementation in codebase

The schema decisions are spread across migrations 0001-0010. Pattern:

```sql
-- columns for what's queried
ALTER TABLE buffr.todo_meta ADD COLUMN type TEXT NOT NULL;
CREATE INDEX ON buffr.todo_meta (user_id, type);
-- JSON for what's read as blob
ALTER TABLE buffr.entries ADD COLUMN meta JSONB NOT NULL DEFAULT '{}';
```

## Elaborate

The "relational for queryable, JSON for blob" hybrid is the standard pattern for apps with mixed access shapes. Postgres' JSONB makes this nearly free. Buffr exploits it without going full document store. The alternative (everything as columns) would have made adding a new field a migration; the JSON `meta` blob lets new fields ship without DB changes when they're not queried.

## Interview defense

**Q [mid]:** Why a relational DB for buffr?

**A:** The access patterns are row-shaped. List views, filter views, aggregate views — all relational primitives. A document store would force whole-document reads for every list.

**Q [senior]:** Why JSON columns at all?

**A:** For fields read only as blobs alongside the row (entries.todos_json, entries.meta). The cost is parse-on-read; the benefit is no migration to add a new sub-field.

## Validate

### Level 1 — name the access patterns.

### Level 2 — explain why "everything in JSON" would be wrong here.

### Level 3 — apply: a new feature wants per-entry images with metadata. Shape? Probably a separate images table (queryable by date, filterable by has_image), with the blob in Supabase Storage.

### Level 4 — defend: "Use Mongo because it's faster for documents." Wrong for buffr's mixed shape.

## See also

- `01-the-data-model-and-its-shape.md`
- `03-indexing-vs-query-patterns.md`
- `../study-database-systems/02-records-pages-and-storage-layout.md`
- `../study-system-design/01-canonical-local-with-cloud-mirror.md`
