# Transactions, isolation, and anomalies — what buffr implicitly assumes
## Industry name(s): ACID, isolation levels, snapshot isolation, serializable · Type: Foundational mechanism

> Buffr never explicitly names an isolation level. Postgres defaults to Read Committed; SQLite is serial in practice (one writer). The app code assumes both — without saying so.

## Zoom out, then zoom in

```
  ISOLATION LEVELS, ranked by strength

   READ UNCOMMITTED  : sees uncommitted rows (not in Postgres)
   READ COMMITTED    : sees only committed rows; Postgres default
   REPEATABLE READ   : reads in a txn see the same snapshot
   SERIALIZABLE      : full serializability; concurrent txns
                         behave as if they ran in some order
```

Zoom in: every Supabase JS call is its own implicit transaction. Buffr's app code never opens a multi-statement transaction over PostgREST (it can't — PostgREST doesn't expose `BEGIN`/`COMMIT` to clients). Every write is a single-statement upsert, which is a single auto-committed txn at Read Committed. The implications cascade.

## Structure pass

```
  layers   ─ statement ─ txn ─ isolation snapshot
  axes     ─ atomicity (per statement vs per group)
             ─ isolation (what concurrent txns see)
             ─ durability (when the commit returns)
  seams    ─ app statement ←→ PostgREST txn (1:1, no batching)
             ─ SQLite ←→ filesystem (per-statement or per-transaction)
```

## How it works

### Move 1 — atomicity at the statement level only (Postgres side)

```
  buffr's pushTable does:
    supabase.from('entries').upsert(batch, { onConflict: '...' })

  this is ONE statement → ONE auto-commit txn.
  if 50 rows in the batch, either all 50 land or none of them do
  (within that single statement's atomicity).
```

The PostgREST `upsert(batch)` translates to a single SQL `INSERT ... ON CONFLICT ... DO UPDATE` statement. Atomic. The next batch is a new transaction.

### Move 2 — Read Committed's surprises

```
  RC sees each row at the time the row is read.
  TWO sequential SELECTs in one txn CAN return different rows.
  buffr's queries never do "select-then-select within a txn"
  so this doesn't bite — at the cost of never being able to use
  multi-statement consistency.
```

### Move 3 — the principle: name what you assume

```
   ┌─────────────────────────────────────────────────┐
   │ buffr assumes Read Committed implicitly. that's │
   │ fine because no operation reads twice in a txn  │
   │ or depends on cross-row consistency. if a       │
   │ future feature needs "read A, read B, write     │
   │ based on both consistently," it can't get that  │
   │ via PostgREST.                                  │
   └─────────────────────────────────────────────────┘
```

## Primary diagram

```
   anomalies and which level prevents them

   anomaly             RC      RR      SI      SER
   ─────────────────   ──      ──      ──      ───
   dirty read          ✓       ✓       ✓       ✓
   non-repeatable      ✗       ✓       ✓       ✓
   phantom read        ✗       partial ✓       ✓
   serialization       ✗       ✗       ✗       ✓
   anomaly

   ✓ = prevented by this level
```

## Implementation in codebase

```ts
// every supabase call is its own implicit txn
await supabase.from('entries').upsert(rows, { onConflict: 'user_id,id' });
```

There is no `supabase.rpc('begin')` anywhere; PostgREST does not expose `BEGIN`/`COMMIT`. Multi-statement transactions would require a server-side function (Postgres function with `pg.serializable` semantics) — buffr has none.

**Where this could bite later:** if buffr ever needs "update entries.text AND update todo_meta in one atomic step from the device," the answer is a single RPC function on Postgres, not two app-level upserts. Today the reconcile flow runs in local SQLite, where SQLite *does* support real transactions, and the sync engine pushes the result. The atomic boundary is the local SQLite transaction; the cloud sees the post-commit shape.

## Elaborate

The "Postgres default is Read Committed" trap is real but small for buffr. The bigger pattern is: any app that uses PostgREST cannot use multi-statement transactions from the client. Every "I need atomicity across two writes" forces either:

1. a Postgres function (server-side txn), or
2. local SQLite transaction + sync (the buffr pattern).

Buffr picks (2). It works because the local DB is canonical and the cloud is downstream.

## Interview defense

**Q [mid]:** What isolation level does Postgres run by default and what does that mean?

**A:** Read Committed. Each statement sees only committed rows at its start time. Two statements in the same transaction can see different rows. Buffr's app code never uses multi-statement transactions over PostgREST, so RC is fine.

**Q [senior]:** When would you need Serializable?

**A:** When two concurrent transactions could each individually be valid but together produce an invariant violation — e.g., "ensure exactly one row has status='active' across all users." Buffr has no such invariant. If it did, the right move would be a server-side function with explicit `SET LOCAL transaction_isolation = 'serializable'` and retry-on-conflict.

**Q [arch]:** What's the atomicity boundary in buffr's data flow?

**A:** Two: the local SQLite transaction (when reconcileMeta runs across multiple tables), and the single PostgREST statement (per sync push batch). There's no atomicity *between* the local commit and the cloud commit — that's eventually consistent via LWW.

## Validate

### Level 1 — list the four standard isolation levels in order.

### Level 2 — explain what Read Committed prevents and what it doesn't.

### Level 3 — apply: design a "transfer points between two users" feature. Where does atomicity live? Probably a Postgres function with Serializable isolation.

### Level 4 — defend: "Just use Serializable for everything." Cost: more deadlocks, more retries, throughput drops. For buffr's workload (mostly single-user reads/writes) it would be over-investment.

## See also

- `06-locks-mvcc-and-concurrency-control.md` — the mechanisms isolation rests on.
- `07-wal-durability-and-recovery.md` — when "committed" actually durably commits.
- `../study-distributed-systems/02-consistency-models.md` — buffr's eventual consistency between SQLite and Postgres.
