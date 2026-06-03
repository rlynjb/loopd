# Normalization and duplication — when buffr stores the same fact twice on purpose
## Industry name(s): 3NF, denormalization, single source of truth · Type: Foundational

> Buffr's main denormalization is `entries.todos_json` vs `todo_meta`. Both store the same per-line todo data. `reconcileMeta` keeps them in sync. The duplication earns its keep — the JSON is for fast whole-entry reads; the rows are for query/filter views.

## Zoom out, then zoom in

```
  THE DUPLICATION

  entries.todos_json    JSON array, one element per todo line
                         used by: today's prose view (fast render)
  todo_meta             one row per todo line
                         used by: list views, filtering, counts

  same data, two shapes. reconcile keeps them aligned.
```

Zoom in: this is deliberate denormalization. Normalizing to just `todo_meta` would force the prose view to JOIN every read. Normalizing to just `entries.todos_json` would force the list view to parse all entries' JSON to filter.

## Structure pass

```
  layers   ─ prose ─ entries.todos_json ─ todo_meta
  axes     ─ access shape (whole-entry vs filtered-row)
             ─ read frequency vs write frequency
  seams    ─ todos_json ←→ todo_meta : reconcile
```

## How it works

### Move 1 — denormalize when the read pattern needs it

```
  prose view reads entries.* in one query. having todos_json
  inline saves a JOIN per render.
  
  list view filters across many entries by type. having todo_meta
  with an index on (user_id, type) saves a full scan.
  
  two reads; two shapes; reconcile keeps them in sync.
```

### Move 2 — reconcile is the load-bearing maintainer

```
  if reconcileMeta ever fails between updating one and the other,
  the data drifts. mitigation: both writes happen in one local
  SQLite txn (study-database-systems/05).
```

### Move 3 — the principle: duplicate only when reads demand it

```
   ┌──────────────────────────────────────────────────┐
   │ buffr's one denormalization is justified by      │
   │ two distinct access shapes. that's the only      │
   │ rationale for storing the same fact twice.       │
   │ "for performance" without naming the query is    │
   │ how denormalization rots.                         │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// pattern; src/services/prose/reconcileMeta.ts
await db.transaction(async (tx) => {
  await tx.exec(`UPDATE entries SET todos_json = ?, updated_at = ? WHERE user_id = ? AND id = ?`,
                 [JSON.stringify(todoSnapshot), now, userId, entryId]);
  await reconcileTodoMeta(tx, entry, todos, userId);
});
```

Both writes happen inside one SQLite transaction. Either both land or neither does. The denormalization is safe by construction.

## Elaborate

The "prose+meta" pattern is the standard answer for "I want the data both as a document and as queryable rows." Other places it shows up: caching computed aggregates (a daily nutrition_total alongside the per-line nutrition_meta rows); materialized views that prevent expensive recomputation.

The cost is the reconcile code — one place where the two shapes must agree. Compared to the alternatives (JOIN on every prose view, or parse-on-every-list), the cost is paid where it's most maintainable.

## Interview defense

**Q [mid]:** Why is the same todo stored in two places?

**A:** Two access patterns. Today's prose view reads entries by id; having todos_json inline saves a JOIN. List views filter by type; having todo_meta as rows lets the index help. reconcileMeta keeps both shapes in sync inside one local SQLite txn.

**Q [senior]:** What if the two shapes drift?

**A:** They can't, structurally — both writes are in one local txn. If reconcile is buggy, the prose still wins (it's the source of truth); a fresh prose-commit re-derives both.

## Validate

### Level 1 — name the two shapes and what each is for.

### Level 2 — explain why both can't be authoritative.

### Level 3 — apply: thread mentions in entries — store them as JSON in entries (like todos) or normalize to thread_meta? Normalize; the list view by thread is the common case.

### Level 4 — defend: "Denormalization is debt." Sometimes; here it's earned.

## See also

- `01-the-data-model-and-its-shape.md` — the schema.
- `04-transactions-and-integrity.md` — what holds the two in sync.
- `../study-software-design/03-information-hiding-and-leakage.md` — the code analog.
