# Migrations and evolution — how buffr's schema changes
## Industry name(s): forward-only migrations, zero-downtime DDL, backfill · Type: Foundational

> Migrations are forward-only, numbered, and idempotent. The Postgres side runs via Supabase migration files. The SQLite side is hand-maintained. The two must align. There is no automated parity check.

## Zoom out, then zoom in

```
  THE MIGRATION CHAIN (Postgres side, supabase/migrations/)

  0001 initial schema (entries, todos_json, todo_meta, ...)
  0002 add ai_summaries
  0003 add threads + thread_meta
  ...
  0006 add todo_meta.type column
  0007 composite PKs on every synced table
  0008 todo_meta type reduce (remove unused types)
  0009 disable RLS phase A
  0010 namespace schema as `buffr`
  0011-0012 ... (recent additions)
  0013 (proposed: add (user_id, updated_at) indexes)
```

Zoom in: every migration is forward-only. There's no rollback file. Recovery from a bad migration is "write a new migration that fixes it."

## Structure pass

```
  layers   ─ Postgres side ─ SQLite side ─ app code
  axes     ─ idempotency
             ─ reversibility
             ─ data preservation
  seams    ─ Postgres ←→ SQLite : hand-maintained parity
```

## How it works

### Move 1 — forward-only with idempotency

```
  every CREATE TABLE: IF NOT EXISTS
  every ALTER: a check first, or write the migration so
   re-running is a no-op
  every backfill: UPDATE ... WHERE ... (also idempotent)
```

### Move 2 — schema parity is manual

```
  Postgres migrations: supabase/migrations/00NN_*.sql
  SQLite mirror:       src/services/db/migrations.ts (verify path)
  
  if they drift, sync silently drops columns or fails (depending
  on the divergence direction).
```

### Move 3 — the principle: every change ships in two places

```
   ┌──────────────────────────────────────────────────┐
   │ until parity is automated, every schema change   │
   │ must edit BOTH sides. checklist culture, not     │
   │ tooling. the structural risk is real but small   │
   │ at single-developer scale.                        │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```sql
-- pattern: supabase/migrations/0008_todo_meta_type_reduce.sql
-- the migration that named the type set as 'reduce' (not adding a type)
UPDATE buffr.todo_meta SET type = 'todo'
  WHERE type IN ('action', 'task', 'errand');  -- collapse
-- (the proposed final set: todo, idea, knowledge, study, reflect)
```

```ts
// pattern: src/services/db/migrations.ts
const migrations = [
  { v: 1, sql: 'CREATE TABLE IF NOT EXISTS entries (...);' },
  // ... must mirror Postgres side
];
```

## Elaborate

The "forward-only, hand-maintained parity" pattern is the cheapest possible discipline. It assumes a single attentive engineer and a small surface area. The day a second engineer or a 50-table schema lands, automating parity becomes worth the work.

The 0009 RLS-disable migration is itself a model of "the fix carries the story" — the header comment in the SQL documents why RLS was disabled (the silent-freeze incident). Future readers running the migration see the story.

## Interview defense

**Q [mid]:** How do you ship a new column?

**A:** Write a Postgres migration (`ALTER TABLE ADD COLUMN`). Mirror it in SQLite migrations. Update the sync engine to push/pull the new column. Test on device.

**Q [senior]:** What's the structural risk?

**A:** Schema parity drift between SQLite and Postgres. Today: discipline + code review. Tomorrow: a test that creates a row, pushes it, pulls it, asserts column equality.

## Validate

### Level 1 — explain "forward-only, idempotent."

### Level 2 — name the parity risk.

### Level 3 — apply: dropping a column. Three-phase pattern — (a) stop writing it, (b) ship app code that doesn't read it, (c) drop in a later migration.

### Level 4 — defend: "Use a migration framework like Prisma." Maybe; would solve parity but adds a heavy dep.

## See also

- `01-the-data-model-and-its-shape.md`
- `../study-database-systems/07-wal-durability-and-recovery.md`
- `../study-security/02-authentication-and-authorization.md` (the 0009 incident)
