# Locks, MVCC, and concurrency control — what holds buffr's writes from clobbering each other
## Industry name(s): MVCC, row-level locks, optimistic vs pessimistic concurrency · Type: Foundational mechanism

> SQLite is single-writer (one writer at a time, period). Postgres uses MVCC (no read locks; writers don't block readers; conflicting writers serialize). Buffr is single-user, so writer contention is structurally rare on both engines.

## Zoom out, then zoom in

```
  CONCURRENCY MODELS

  SQLite:
    one writer at a time (file-level lock in journal mode;
    in WAL mode, readers continue while one writer commits).
    structurally serial for writes.

  Postgres (MVCC):
    each row has a version chain. readers see the version
    visible at their snapshot. writers create new versions.
    no read locks; row-level write locks; deadlocks possible.
```

Zoom in: buffr's contention surface is small. A single user writes from one device at a time (mostly). The realistic concurrency events are:

1. App writes a row in SQLite while the sync engine is reading the same table for push. SQLite WAL handles this — readers see the pre-write snapshot.
2. Two devices push the same row concurrently to Postgres. This is the LWW conflict; the second-arriving update overwrites the first based on `updated_at`.

## Structure pass

```
  layers   ─ statement ─ lock acquisition ─ commit
  axes     ─ read vs write locks (none in MVCC reads)
             ─ optimistic vs pessimistic
  seams    ─ statement ←→ lock manager
             ─ row version ←→ visibility check
```

## How it works

### Move 1 — MVCC is reader-friendly

```
  in Postgres:
    SELECT never blocks on UPDATE. readers see the row version
    that was committed at their snapshot's start.

  in SQLite WAL mode:
    SELECT never blocks on INSERT/UPDATE (in the same DB). readers
    see the pre-write snapshot.
```

This is why buffr's UI reads from SQLite even while the sync engine writes to SQLite — no contention.

### Move 2 — write conflicts

```
  postgres: two concurrent UPDATEs on the same row.
    first acquires row-level lock; second blocks.
    when first commits, second proceeds with the new version.
    no deadlock unless multi-row locks acquired in different orders.

  buffr: this happens only when two devices push the same entry.
    LWW (updated_at) decides the winner.
```

### Move 3 — the principle: buffr's contention is two-device, not in-process

```
   ┌─────────────────────────────────────────────────┐
   │ in-process contention: nil. one user, one app,  │
   │ debounced sync. structurally serial.            │
   │ two-device contention: LWW. expected to be rare.│
   │ if it weren't rare, CRDTs would be the answer.  │
   └─────────────────────────────────────────────────┘
```

## Primary diagram

```
   LWW conflict (two devices)

   device A      cloud         device B
      │            │              │
      │  update    │              │
      ├────────────▶  v=10        │
      │  ok        │              │
      │◀───────────┤              │
      │            │  update      │
      │            │◀─────────────┤  v=15
      │            │  v=15 wins   │
      │            │  ok          │
      │            ├──────────────▶
      │            │              │
      │  pull      │              │
      ├────────────▶  v=15        │
      │◀───────────┤  A converges │
      │            │  to v=15     │
```

## Implementation in codebase

buffr's LWW is in `chooseWinner` (or similar in the sync engine). Pattern:

```ts
// pattern; verify path: src/services/sync/conflict.ts
function chooseWinner(local: Row, remote: Row): Row {
  if (remote.updated_at > local.updated_at) return remote;
  if (local.updated_at > remote.updated_at) return local;
  return local;  // tie → keep local; deterministic
}
```

Deterministic tiebreaker is the right move. Coin-flip tiebreakers create flapping.

## Elaborate

The MVCC-vs-locking distinction matters most for read throughput. Pure 2PL (two-phase locking) blocks readers when there's a writer; MVCC doesn't. Postgres's invention here is that readers always get a snapshot, which means a long-running analytics query doesn't block writers.

The cost is the version chain — old versions accumulate until vacuum cleans them. Buffr's writes are tiny; vacuum is automatic; never noticed.

## Interview defense

**Q [mid]:** What's MVCC?

**A:** Multi-version concurrency control. Each row has versions. Readers see the version visible at their snapshot. Writers create new versions. No read locks; writers serialize only on the same row.

**Q [senior]:** When have you debugged a deadlock?

**A:** Not on buffr — too simple. The classic case is two transactions locking rows in different orders. Postgres detects the cycle and aborts one; the app retries. Buffr would never see this because there are no multi-row transactions over PostgREST.

## Validate

### Level 1 — explain MVCC in 3 sentences.

### Level 2 — when does a writer block a reader in Postgres? Almost never.

### Level 3 — apply: a feature wants "atomic increment of a per-user counter." How? Server-side function with `UPDATE ... SET v = v + 1 RETURNING v`, atomic at the row-lock level.

### Level 4 — defend: "We don't need to think about concurrency, single user." Mostly true. The two-device case is real; LWW handles it.

## See also

- `05-transactions-isolation-and-anomalies.md` — what isolation MVCC enables.
- `08-replication-and-read-consistency.md` — multi-replica MVCC.
- `../study-distributed-systems/03-conflict-resolution.md` — LWW and beyond.
