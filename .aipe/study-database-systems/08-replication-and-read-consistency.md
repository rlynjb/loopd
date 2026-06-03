# Replication and read consistency — what arrives at the second machine
## Industry name(s): primary-replica, read replica, replication lag, eventual consistency · Type: Foundational mechanism

> Supabase has at least one read replica. Buffr doesn't read from it explicitly. The interesting replication boundary for buffr is not "primary → replica on Supabase" but "Postgres → SQLite via sync engine" — that's the load-bearing replication path.

## Zoom out, then zoom in

```
  TWO REPLICATION BOUNDARIES

  managed (Supabase):
    Postgres primary ──► Postgres read replica
    (streaming WAL replication; lag typically <1s)

  application (buffr's sync engine):
    Postgres ──► SQLite on device N
    (cursor-based pull; lag = sync interval + network)
```

Zoom in: the application-level boundary is what users actually experience as "did my note appear on device 2?" The Supabase-internal one is invisible to buffr today because the app only ever reads from the primary (PostgREST's default).

## Structure pass

```
  layers   ─ source ─ stream ─ destination ─ apply
  axes     ─ lag (ms to minutes)
             ─ ordering (FIFO vs LWW)
             ─ delivery (at-most-once vs at-least-once)
  seams    ─ Postgres WAL ←→ replica WAL apply
             ─ Postgres ←→ SQLite (cursor + upsert)
```

## How it works

### Move 1 — managed replication is asynchronous

```
  primary commits → WAL → replica appends → replica commits.
  the primary doesn't wait. lag is real but small.
  failover: replica becomes primary; the in-flight WAL gap is the
  data-loss window (typically <1s on managed Postgres).
```

### Move 2 — buffr's sync is also asynchronous

```
  device A writes → SQLite → debounced sync → upsert to Postgres.
  device B's pull → cursor scan WHERE updated_at > last_cursor.
  ordering: by updated_at (server-side LWW tiebreak).
  delivery: at-least-once (an interrupted pull resumes from cursor).
```

### Move 3 — the principle: name your consistency model

```
   ┌──────────────────────────────────────────────────┐
   │ buffr is EVENTUALLY CONSISTENT across devices.   │
   │ a write on device A is visible on device B after │
   │ sync (seconds to minutes).                       │
   │ "consistent" reads don't exist in this model.    │
   │ LWW is the convergence guarantee.                │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   the convergence path

   device A          Postgres          device B
      │                 │                 │
      │  write v=10     │                 │
      ├─────────────────▶                 │
      │                 │                 │
      │                 │  pull cursor    │
      │                 │◀────────────────┤
      │                 │  returns v=10   │
      │                 ├─────────────────▶
      │                 │                 │
      │  write v=20     │                 │
      ├─────────────────▶                 │
      │                 │                 │
      │   ┌─── B's next pull ──────────┐  │
      │   │ pull cursor advances to    │  │
      │   │ v=20's updated_at          │  │
      │   └────────────────────────────┘  │
      │                 ├─────────────────▶
      │                 │                 │
      │                 │   B sees v=20   │
      │                 │   eventually    │
```

## Implementation in codebase

The pull cursor is the bridge:

```ts
// pattern; verify path: src/services/sync/pull.ts
async function pullTable(table: string, ctx: SyncCtx) {
  const cursor = await getCursor(table, ctx);
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .gt('updated_at', cursor)
    .order('updated_at', { ascending: true })
    .limit(PAGE_SIZE);
  // apply locally; advance cursor to max(updated_at) in page.
}
```

The cursor advances to the max `updated_at` in the returned page — pages without a row are no-ops. A page that returns fewer than `PAGE_SIZE` rows is the end of the stream for now; sync exits.

**The replication-lag trap:** if the primary commits at T=100 and Supabase's replica is at T=99, a pull from the replica returns rows up to T=99. The cursor advances to whatever the max returned was. Next pull will pick up the T=100 row. No data loss; possibly out-of-order reads at the application level (a later-T row visible before a earlier-T row that hadn't replicated yet). Buffr doesn't suffer this because PostgREST reads from the primary by default.

## Elaborate

The right mental model is "two replication boundaries, both eventual." Strong consistency (linearizability) isn't on the table without giving up the local-first design. CRDTs would offer better merge semantics than LWW (no overwrites of independent edits), but for a single-user-multi-device journal, LWW with a deterministic tiebreak is the right call. The cost is "if you edit the same paragraph on two offline devices, the later one wins."

## Interview defense

**Q [mid]:** How does sync work across devices?

**A:** Each device has a pull cursor. The cursor is the high-watermark `updated_at` it's seen. Pull queries `WHERE updated_at > cursor ORDER BY updated_at LIMIT N`. Apply to local. Advance cursor. Eventually consistent.

**Q [senior]:** What can go wrong with cursor-based replication?

**A:** Clock skew on the source — if `updated_at` is set by the device, two devices can race. Buffr fixes this by stamping `synced_at` from a server-time RPC; conflict resolution uses `updated_at` deterministically. Still, the standard cursor-pull failure modes apply: a row updated at the exact cursor time can be missed (use `>=` plus dedupe); pages can grow if many rows share the same `updated_at`.

**Q [arch]:** Why not CRDTs?

**A:** Single-user model; concurrent edits are rare; deterministic LWW is enough. CRDTs add per-row metadata (vector clocks or operation logs), increase storage and complexity, and the merge semantics are only valuable if collaborative editing is the use case — buffr isn't collaborative.

## Validate

### Level 1 — sketch the cursor-pull mechanism.

### Level 2 — explain why eventual consistency is acceptable here.

### Level 3 — apply: a feature wants "the user must see their note on device 2 within 1s." Walk: forces server-push (websocket); buffr today only does pull-on-app-open. Cost is real-time infra.

### Level 4 — defend: "Replace LWW with CRDTs." Wrong call for single-user; right for collaborative editing.

## See also

- `05-transactions-isolation-and-anomalies.md` — Postgres-side consistency.
- `06-locks-mvcc-and-concurrency-control.md` — LWW conflict resolution.
- `../study-distributed-systems/02-consistency-models.md` — the full taxonomy.
- `../study-distributed-systems/03-conflict-resolution.md` — LWW vs CRDTs.
