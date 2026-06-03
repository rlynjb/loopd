# Data-modeling red flags — the ranked checklist
## Industry name(s): schema review checklist · Type: Audit summary

> The consolidated data-modeling scorecard for buffr. Most flags are LOW because the schema is small and well-thought-out. The structural ones — schema parity SQLite↔Postgres, missing indexes, no FKs — are documented and waiting.

## Zoom out, then zoom in

```
  top three moves (ranked)
  ─────────────────────────────────────────────────────────
  1. add (user_id, updated_at) index per synced table
     ✓ matches sync pull's actual query shape
  2. write a schema-parity test (SQLite ↔ Postgres column-by-column)
     ✓ closes the structural risk of hand-maintained mirror
  3. re-enable RLS in Phase B with named auth.uid()-based policies
     ✓ 0009 was intentional Phase A; Phase B reverses it
```

## Structure pass

```
  axis = "if this fires, what's the cost?"

  HIGH    silent data integrity loss
  MED     scale-tier-up cost
  LOW     style; preempt now
  PRAISE  the design currently prevents the flag
```

## How it works

### Move 1 — the checklist

```
  row: flag, fires?, severity, fix
```

### Move 2 — buffr's data-modeling scorecard

**Model shape**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Schema as one JSON blob | ✗ — PRAISE | — | relational+JSON hybrid |
| No discernible model | ✗ — PRAISE | — | clear ER structure |
| Composite PK pattern consistent | ✗ — PRAISE | — | (user_id, id) on every synced table |

**Normalization**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Same fact editable in two places | ✗ — PRAISE | — | prose is source-of-truth |
| Denormalization without justification | ✗ — PRAISE | — | todos_json justified by access shape |
| Reconcile is the load-bearing maintainer | ✗ INTENTIONAL | — | covered by local SQLite txn |

**Indexes**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Hot query with no supporting index | ✓ TRUE | MED | `(user_id, updated_at)` index |
| Indexes that aren't used | ✗ — PRAISE | — | only PK indexes exist |
| N+1 query pattern in code | ✗ NOT YET | — | scan once per prose-commit |

**Integrity**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| FK references missing | ✓ INTENTIONAL | MED | acceptable single-writer; revisit later |
| CHECK constraints absent on closed sets | ✓ TRUE | LOW | add CHECK on todo_meta.type once stable |
| Multi-write without txn | ✗ — PRAISE | — | reconcile uses local SQLite txn |

**Evolution**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Destructive migration with no rollback | ✗ — PRAISE | — | every migration forward-only + idempotent |
| Column drop without backfill plan | ✗ NOT YET | — | none planned |
| Schema parity SQLite ↔ Postgres hand-maintained | ✓ TRUE | MED | write a parity test |

**Access patterns**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Relational schema fighting document access | ✗ — PRAISE | — | hybrid matches |
| Storage choice unsupported by access pattern | ✗ — PRAISE | — | SQLite+Postgres correct |

**Security-adjacent**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| RLS disabled | ✓ INTENTIONAL Phase A | MED | re-enable in Phase B with named policies |
| user_id assumed but not enforced | ✓ TRUE | MED | RLS enforces this when re-enabled |

### Move 3 — the principle

```
  buffr's data model is well-shaped for its scale. the structural
  risks (parity, missing index, no FK) are documented and waiting.
  the top three moves close the gaps that will bite first at the
  next scale tier.
```

## Primary diagram

```
   buffr data-modeling scorecard

   HIGH SEVERITY
    ─ (none today)

   MED SEVERITY
    ─ missing (user_id, updated_at) index per synced table
    ─ schema parity SQLite↔Postgres hand-maintained
    ─ RLS disabled (Phase A)
    ─ no FKs (single-writer mitigates)

   LOW SEVERITY
    ─ no CHECK constraint on todo_meta.type
    ─ no rollback files for migrations
    ─ JSONB used for some columns that could be relational

   PRAISE
    ─ composite PK (user_id, id) everywhere
    ─ relational + JSON hybrid matches access pattern
    ─ prose-as-source-of-truth eliminates dup-edit risk
    ─ reconcile in local SQLite txn (multi-table atomicity)
    ─ migrations forward-only + idempotent
    ─ type set deliberately reduced (migration 0008)
    ─ soft-delete pattern across every synced table
```

## Implementation in codebase

The three actions, in order:

```sql
-- 1. (user_id, updated_at) indexes
-- supabase/migrations/0013_add_updated_at_indexes.sql
CREATE INDEX IF NOT EXISTS entries_user_updated_idx
  ON buffr.entries (user_id, updated_at);
-- repeat for the other synced tables.
```

```ts
// 2. schema parity test (proposal)
// tests/schema-parity.test.ts
import { expect, test } from 'vitest';
test('SQLite and Postgres schemas match column-by-column', async () => {
  const sqliteCols = await getSqliteColumns(table);
  const pgCols = await getPostgresColumns(table);
  expect(sqliteCols).toEqual(pgCols);
});
```

```sql
-- 3. RLS Phase B (future migration)
ALTER TABLE buffr.entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY entries_self ON buffr.entries
  USING (auth.uid() = user_id);
```

## Elaborate

The data-modeling audit shows buffr is in a quietly good state. The schema decisions match the access patterns. The denormalization is justified. The risks are documented. The discipline at the migration level (forward-only, idempotent, "fix carries the story" comments) compounds.

## Interview defense

**Q [mid]:** What's the biggest schema risk?

**A:** SQLite ↔ Postgres parity drift. Today: discipline. Tomorrow: a parity test. The cost of getting it wrong is silent data loss on push (a column that exists on SQLite but not Postgres is dropped at PostgREST).

**Q [senior]:** What's the next index to add?

**A:** `(user_id, updated_at)` per synced table. Sync pull structurally orders by this; without the index the planner sorts in memory. Cheap to add; pays off at the next scale tier.

## Validate

### Level 1 — sketch the severity ladder.

### Level 2 — explain why no flag is HIGH today.

### Level 3 — apply: add the parity test.

### Level 4 — defend: "Add FKs everywhere." Over-investment for single-writer; structural at multi-writer.

## See also

- All concept files 01–06.
- `../study-database-systems/09-database-systems-red-flags-audit.md`
- `../study-security/02-authentication-and-authorization.md`
- `../study-debugging-observability/01-success-only-log-guard.md`
