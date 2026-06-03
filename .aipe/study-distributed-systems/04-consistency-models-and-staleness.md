# Consistency models and staleness — what buffr promises
## Industry name(s): linearizability, sequential, causal, eventual consistency · Type: Foundational

> Buffr is eventually consistent across devices. The local SQLite is strongly consistent (within the device). The cloud mirror converges to the latest write via LWW. There's no read-your-writes guarantee across devices, because there are no cross-device reads in the user-facing path.

## Zoom out, then zoom in

```
  THE LADDER

   linearizable     strongest; every read sees the latest write
   sequential       writes appear in some consistent order
   causal           if A → B, every observer sees A before B
   eventual         all replicas eventually converge

   buffr:
    ─ LOCAL:  strong (one engine, one writer)
    ─ CLOUD:  primary is sequentially consistent; replicas are
              eventually consistent (Supabase's job)
    ─ ACROSS DEVICES:  eventual via LWW
```

Zoom in: the within-device experience is strongly consistent. The cross-device experience is eventual. The boundary is where buffr's complexity lives — the sync engine.

## Structure pass

```
  layers   ─ user write ─ local store ─ sync ─ cloud ─ other device
  axes     ─ consistency level
             ─ visibility latency
  seams    ─ local ←→ sync : strong
             ─ sync ←→ cloud : sequential within Postgres
             ─ cloud ←→ device B : eventual (next pull)
```

## How it works

### Move 1 — local is strong by construction

```
  one process, one writer per row. SQLite's MVCC + serial writes
  give linearizable reads within the device.
```

### Move 2 — cross-device is eventual

```
  device A writes at T=10
  device B's last pull was at T=5
  device B reads stale until next pull (T=15-ish, after debounce)
  
  staleness window: ~5-30 seconds typical.
```

### Move 3 — LWW resolves the conflict

```
   ┌──────────────────────────────────────────────────┐
   │ if devices A and B write the same row at         │
   │ overlapping times, the cloud applies whichever   │
   │ arrives later. updated_at decides; tiebreak is   │
   │ deterministic (local wins on equal timestamps).  │
   │ the loser's write is silently overwritten.       │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   the staleness window

   device A   cloud    device B
      │        │         │
      │ T=10   │         │
      │ write  │         │
      ├────────▶  v=10  │
      │        │         │
      │        │         │  T=15 read
      │        │         │◀────────│
      │        │  pull   │         │
      │        ├─────────▶ v=10   │
      │        │  but...           │
      │        │                   │
      │ T=20   │                   │
      │ write  │                   │
      ├────────▶  v=20             │
      │        │         │ T=22 read
      │        │         │◀────────│
      │        │  pull   │         │
      │        │  not    │         │
      │        │  yet    │         │
      │        │  STALE  │         │
```

## Implementation in codebase

LWW is implemented in the conflict resolver (`src/services/sync/conflict.ts` or in the push's ON CONFLICT clause):

```sql
ON CONFLICT (user_id, id) DO UPDATE
  SET ... WHERE entries.updated_at < EXCLUDED.updated_at;
```

The WHERE clause is the LWW guard. On equal timestamps, the existing row stays (a form of "first stable wins" once a tie reaches the cloud).

## Elaborate

The "no cross-device read in the user-facing path" property is what spares buffr from harder consistency models. Every read is from local SQLite. The user never sees a "Loading from cloud..." spinner; they see SQLite's current state, which is always strongly consistent within the device.

The cost: staleness across devices. Acceptable for journaling; unacceptable for collaborative editing.

## Interview defense

**Q [mid]:** What consistency does buffr provide?

**A:** Strong within a device. Eventual across devices. The cross-device staleness window is the debounce + sync interval — typically 10-30 seconds.

**Q [senior]:** What's the worst-case staleness?

**A:** Device offline for hours. When it comes back online, sync pulls all changes since the last cursor. No data loss; user sees a "settling" period.

## Validate

### Level 1 — list the four consistency levels.

### Level 2 — explain why local is strong.

### Level 3 — apply: collaborative editing on the same paragraph. LWW clobbers; need CRDTs.

### Level 4 — defend: "Eventual consistency is too weak for any real app." Wrong — every cross-region replicated system is eventually consistent. The question is whether the staleness window is acceptable for the use case.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the substrate.
- `05-replication-partitioning-and-quorums.md` — Postgres's replication shape.
- `../study-database-systems/08-replication-and-read-consistency.md` — engine-side view.
