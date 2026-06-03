# Study — Data modeling (buffr's persistent data, applied)

The shape of buffr's data — schema, normalization, indexing, integrity, evolution — audited against how the app actually reads and writes it.

## The through-line

```
  does the data's shape match how it's actually
  read and written — and can it stay correct?

  buffr's data shape is dominated by ONE design choice:
  composite primary keys (user_id, id) on every synced table.
  this single choice drives index design, RLS semantics,
  and the shape of the sync engine.
```

## The two partition seams

- **Against `study-system-design`** — "use Supabase + SQLite, mirror via sync" is architecture (system-design). "the entries table has composite PK, no FK to users, soft-delete column" is data modeling (here).
- **Against `study-dsa-foundations`** — "B-tree as an in-memory data structure" is DSA. "buffr's tables have a B-tree primary key index" is data modeling. The line is: in-memory and reusable → DSA; on-disk and table-specific → here.

## The schema diagram (current, 2026-05-24)

```
  ┌──────────────────┐    ┌──────────────────┐
  │ entries           │    │ ai_summaries     │
  │ (user_id, id)PK   │◀┐  │ (user_id, id) PK │
  │ date              │  │ │ entry_id          │
  │ text              │  │ │ chain             │
  │ todos_json (raw)  │  │ │ input_hash        │
  │ updated_at         │  │ │ result            │
  │ synced_at          │  │ │ updated_at         │
  │ deleted            │  │ │ ...               │
  └──────────────────┘  │ └──────────────────┘
                         │
       ┌─────────────────┘
       │
  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
  │ todo_meta         │    │ threads           │    │ thread_meta       │
  │ (user_id, id)PK   │    │ (user_id, id)PK   │    │ (user_id, id)PK  │
  │ entry_id          │    │ name              │    │ thread_id         │
  │ line_key          │    │ slug              │    │ entry_id          │
  │ type              │    │ updated_at         │    │ snippet           │
  │   (todo|idea|     │    │ deleted            │    │ updated_at        │
  │    knowledge|     │    └──────────────────┘    │ deleted           │
  │    study|reflect) │                            └──────────────────┘
  │ status            │
  │ updated_at         │    ┌──────────────────┐    ┌──────────────────┐
  │ deleted            │    │ nutrition        │    │ nutrition_meta   │
  └──────────────────┘    │ (user_id, id)PK  │    │ (user_id, id)PK  │
                            │ date              │    │ entry_id          │
                            │ protein_g         │    │ ...               │
                            │ updated_at         │    └──────────────────┘
                            │ deleted            │
                            └──────────────────┘

  every synced table has:
    composite PK (user_id, id)
    updated_at, synced_at, deleted

  there is NO `users` table (auth is anon; user_id is the JWT sub).
  there are NO foreign keys between tables. relationships are by
  convention (entry_id columns), not enforced by DB.
```

## Reading order

`01` (the shape) → `02` (normalization) → `03` (indexes vs queries) → `04` (integrity) → `05` (migrations) → `06` (access patterns / storage choice) → `07` (the audit).

## Findings (ranked, headline only — full evidence in `07-`)

| Rank | Finding | File | Severity |
|---|---|---|---|
| 1 | No FKs anywhere; integrity relies on app code | `supabase/migrations/*` | MED (intentional but tracked) |
| 2 | `entries.todos_json` duplicates `todo_meta` rows; reconcileMeta keeps them in sync | `src/services/prose/reconcileMeta.ts` | MED (deliberate denormalization) |
| 3 | Missing index `(user_id, updated_at)` on synced tables | every synced table | MED |
| 4 | RLS disabled (migration 0009) | `supabase/migrations/0009_*` | MED (intentional Phase A) |
| 5 | Schema parity SQLite ↔ Postgres is hand-maintained | `src/services/db/*` | MED |
| 6 | Composite PKs `(user_id, id)` everywhere | every synced table | PRAISE |
| 7 | Soft-delete columns simplify sync semantics | every synced table | PRAISE |
| 8 | Migrations are idempotent + ordered | `supabase/migrations/*` | PRAISE |
| 9 | Type set `todo/idea/knowledge/study/reflect` deliberately reduced | `0008_todo_meta_type_reduce.sql` | PRAISE |

Full details in [`07-data-modeling-red-flags-audit.md`](./07-data-modeling-red-flags-audit.md).
