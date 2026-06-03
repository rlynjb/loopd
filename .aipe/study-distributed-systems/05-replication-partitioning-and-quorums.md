# Replication, partitioning, and quorums — what Supabase does behind the curtain
## Industry name(s): primary-replica, sharding, read quorums, write quorums · Type: Foundational

> Buffr's cloud is a single Postgres primary with managed read replicas. No sharding. No quorum reads. No write quorum. The replication topology is invisible to the app — every query goes through PostgREST to the primary by default.

## Zoom out, then zoom in

```
  WHAT BUFFR USES                       WHAT BUFFR DOESN'T USE

  ─ single primary                       ─ user-level sharding
  ─ managed read replica                 ─ explicit read-replica routing
  ─ streaming WAL replication            ─ quorum reads or writes
  ─ failover by Supabase                 ─ multi-primary
                                          ─ Raft/Paxos
                                          ─ leader election in app
```

Zoom in: the app's mental model is "one Postgres." Supabase's replication is transparent.

## Structure pass

```
  layers   ─ app ─ PostgREST ─ primary ─ replica
  axes     ─ topology (single vs multi)
             ─ partitioning (sharded vs whole)
  seams    ─ PostgREST ←→ primary : routes by default
             ─ primary ←→ replica : managed by Supabase
```

## How it works

### Move 1 — replication is async streaming

```
  primary commits WAL → replica streams WAL → replica applies → done.
  lag: typically <1s. failover: replica becomes primary; small data-loss window.
```

### Move 2 — buffr doesn't partition

```
  one Postgres database. all users in one schema. rows distinguished
  by user_id column.
  
  the scale at which this needs to change: ~1M users or ~100GB.
  buffr is far from either.
```

### Move 3 — the principle: stay simple until growth forces change

```
   ┌──────────────────────────────────────────────────┐
   │ partitioning is the right answer when you have   │
   │ scale that demands it. buffr does not. the cost  │
   │ of partitioning prematurely (operational + data- │
   │ access complexity) is higher than the cost of    │
   │ waiting until evidence forces it.                │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   buffr's cloud topology

   app  ──► PostgREST ──► Postgres primary
                              │
                              │  WAL stream
                              ▼
                         read replica (managed)
                         
   buffr never reads from the replica directly.
   if Supabase fails over, app continues talking to the
   new primary via the same PostgREST URL.
```

## Implementation in codebase

```ts
// pattern; src/services/supabase/client.ts
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: 'buffr' },
});
// no replica config; no read/write split.
```

The app cannot route reads to a replica even if it wanted to — PostgREST doesn't expose that. Supabase Enterprise plans add it; buffr's plan does not.

## Elaborate

The "one engine, one schema, one connection" pattern is the right move for buffr's scale. Sharding, write quorums, and multi-primary are all answers to scaling problems buffr does not yet have. When buffr crosses 100k+ users, the conversation will be different — and at that point, the architecture probably needs more than just sharding (likely a region-per-user pattern).

## Interview defense

**Q [mid]:** How does buffr scale reads?

**A:** It doesn't need to today — single primary handles the load. Supabase has a read replica that the platform may eventually route to; buffr doesn't choose. At the scale where it matters, the platform's auto-scaling is the first answer.

**Q [senior]:** What's the data-loss window on failover?

**A:** Whatever lag was at the moment of failure — typically <1s of unstreamed WAL. The async replication means the replica might not have the most recent committed row when it becomes primary.

## Validate

### Level 1 — diagram the primary→replica streaming.

### Level 2 — explain why buffr doesn't shard.

### Level 3 — apply: at 1M users, what changes? Possibly region partitioning, possibly user_id sharding. Both expensive.

### Level 4 — defend: "Use multi-master from day one." Premature; multi-master adds conflict-resolution complexity buffr doesn't yet face.

## See also

- `04-consistency-models-and-staleness.md` — what replication lag means for reads.
- `../study-database-systems/08-replication-and-read-consistency.md` — engine-side.
- `../study-system-design/audit.md` — scale section.
