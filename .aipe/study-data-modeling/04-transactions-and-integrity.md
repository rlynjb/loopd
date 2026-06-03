# Transactions and integrity — what enforces the invariants buffr depends on
## Industry name(s): ACID, foreign key, check constraint, app-level invariant · Type: Foundational

> Buffr has almost no DB-level integrity. No foreign keys. No CHECK constraints beyond NOT NULL. Invariants are enforced by app code (`reconcileMeta`) and the prose-as-source-of-truth invariant. The one real DB-side guard is the composite PK uniqueness.

## Zoom out, then zoom in

```
  WHAT BUFFR ENFORCES                  WHAT BUFFR DOESN'T

  ─ PK uniqueness (composite)          ─ FK references
  ─ NOT NULL on text columns           ─ CHECK constraints
  ─ deleted IN (0,1) (implicit)        ─ ENUM constraints on `type`
  ─ updated_at NOT NULL                ─ multi-table atomicity over PostgREST
```

Zoom in: the absence of FK references is deliberate. With composite PK and per-user partitioning, an FK from `todo_meta.entry_id → entries.id` would have to be `(user_id, entry_id) → (user_id, id)` — possible but adds index overhead. Buffr trusts app code to keep refs valid.

## Structure pass

```
  layers   ─ DB constraints ─ app invariants ─ prose-as-truth
  axes     ─ where invariants are enforced
             ─ what breaks if they're violated
  seams    ─ PK ←→ uniqueness : DB
             ─ reconcile ←→ projection integrity : app code
             ─ prose ←→ derived state : conceptual
```

## How it works

### Move 1 — DB enforces only what's cheap

```
  PK uniqueness: free (the index is there anyway).
  NOT NULL: free (column definition).
  FK: costs an extra index per FK; deferred until needed.
  CHECK: cheap but only if the value set is closed; type values
         change with migrations (e.g., 0008 type reduce).
```

### Move 2 — app enforces multi-table invariants

```
  reconcileMeta runs in one local SQLite txn.
  guarantees: after the txn, todo_meta + entries.todos_json agree.
  if you bypass reconcile by writing directly, the guarantee breaks.
  no DB-side check stops you.
```

### Move 3 — the principle: enforce in the place that costs least to be right

```
   ┌──────────────────────────────────────────────────┐
   │ DB-side enforcement is non-bypassable but adds   │
   │ overhead. app-side is bypassable but cheap to    │
   │ change. buffr's choice: DB enforces uniqueness   │
   │ (cheap, important); app enforces projection      │
   │ integrity (changes often during prompt iteration).│
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```sql
-- composite PK is the load-bearing DB-side guarantee
PRIMARY KEY (user_id, id)
```

```ts
// app-side enforcement runs inside a local SQLite txn
await db.transaction(async tx => {
  await tx.exec(`UPDATE entries SET ... WHERE ...`);
  await reconcileTodoMeta(tx, ...);
  await reconcileThreadMeta(tx, ...);
});
```

## Elaborate

The "thin DB integrity + thick app invariants" pattern is correct for a single-app schema where the app is the only writer. The moment a second writer exists (a SQL admin, a third-party integration), DB-side constraints become essential. Today buffr is the only writer.

The deferred enum constraint on `todo_meta.type` is worth noting. Migration 0008 reduced the set to `todo/idea/knowledge/study/reflect`. Without a CHECK constraint, a future buggy prompt could write `study2` and the DB would accept it. Mitigation: add a CHECK in a future migration once the set is stable.

## Interview defense

**Q [mid]:** What integrity does the DB enforce?

**A:** Composite PK uniqueness and NOT NULL. Everything else (projection integrity, type-set membership, deleted-row semantics) is app code.

**Q [senior]:** Why no foreign keys?

**A:** Composite PKs make FK syntax verbose. App writes are the only writer. Cost > benefit. The day a second writer appears, FKs become essential.

## Validate

### Level 1 — list the DB-enforced constraints.

### Level 2 — explain why reconcile invariants live in app code.

### Level 3 — apply: add a CHECK constraint on todo_meta.type.

### Level 4 — defend: "Add FKs everywhere." Over-investment given single-writer; would matter at multi-tenant.

## See also

- `02-normalization-and-duplication.md` — the projection integrity invariant.
- `../study-database-systems/05-transactions-isolation-and-anomalies.md`
- `../study-software-design/03-information-hiding-and-leakage.md`
