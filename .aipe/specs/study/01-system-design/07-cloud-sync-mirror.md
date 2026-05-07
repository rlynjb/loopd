# Cloud sync as a mirror

> The local DB is canonical. Cloud is a mirror. Push and pull are independent flows that share the registry of 10 syncable tables.

**See also:** → [01-local-first-request-flow](./01-local-first-request-flow.md) · → [05-soft-delete](./05-soft-delete.md) · → [08-conflict-last-write-wins](./08-conflict-last-write-wins.md) · → [09-debounced-push](./09-debounced-push.md) · → [10-bootstrap-decision-tree](./10-bootstrap-decision-tree.md)

---

## Quick summary
- **What:** push selects `WHERE updated_at > synced_at`, upserts in batches of 50. Pull selects cloud rows newer than `last_pull_at`, applies `chooseWinner(local, cloud)` per row.
- **Why here:** writes feel instant (no network in the request path). The 5-second push debounce trades a little staleness for vastly fewer round-trips during typing.
- **Tradeoff:** every synced row carries `synced_at` (local-only) and `deleted_at`. Schema noise; worth it.

---

## Cloud sync mirror — diagram

```
  ┌─ Local SQLite ─────────────────┐         ┌─ Cloud (Supabase) ─────────────┐
  │                                │         │                                │
  │   updated_at = canonical       │         │   updated_at = canonical       │
  │   synced_at  = local-only      │         │   (never has synced_at)        │
  │   deleted_at = soft-tombstone  │         │   deleted_at = soft-tombstone  │
  │                                │         │                                │
  │   read: WHERE deleted_at NULL  │         │   read: server-side filtered   │
  │                                │         │                                │
  └────────┬───────────────────────┘         └─────────────▲──────────────────┘
           │                                                │
           │ push:  WHERE updated_at > synced_at            │
           │        upsert in batches of 50                 │
           ├────────────────────────────────────────────────┤
           │ pull:  WHERE updated_at > last_pull_at         │
           │        per-row chooseWinner(local, cloud)      │
           │                                                │
           ▼                                                │
   sync_meta (per-table ledger)                             │
   last_pull_at, last_push_at, pending_pushes               │
```

---

## How it works

Push and pull are separate flows. They share the SyncableTable registry (10 tables) and the `sync_meta` ledger (one row per table tracking `last_pull_at`, `last_push_at`, `pending_pushes`, `last_error`).

Push selects local rows where `updated_at > synced_at` (or `synced_at IS NULL`), batches them by 50, and upserts to Supabase with `onConflict: 'user_id,id'`. On batch success, stamps `synced_at = now` on each row. On batch failure, leaves `synced_at` alone — the next push retries the same batch.

Pull selects cloud rows where `updated_at > sync_meta[table].last_pull_at`, in pages of 200, ordered ASC. For each cloud row it loads the local counterpart and runs `chooseWinner` (last-write-wins). If cloud wins, upserts locally and stamps `synced_at = serverTime`. If local wins, skips.

The pull anchors to `serverTime` (a Postgres RPC) instead of `Date.now()` — local clock skew would otherwise create races against the cloud's own timestamps.

---

## In this codebase

- `src/services/sync/push.ts` → `pushTable()`.
- `src/services/sync/pull.ts` → `pullTable()`.
- `src/services/sync/orchestrator.ts` → `pushAll()`, `pullAll()` walk the registry.
- `src/services/sync/conflict.ts` → `chooseWinner()`.
- `src/services/sync/syncMeta.ts` → ledger reads/writes.
- `src/services/sync/tables/*` — per-table mappers (`localToCloud`, `localFromCloud`, `localQueryDirty`).

```
Push pseudocode (push.ts):
  dirty = SELECT * FROM <table> WHERE updated_at > COALESCE(synced_at, '1970-01-01')
  if dirty empty: return success
  for batch of 50 in dirty:
    cloudRows = batch.map(localToCloud)
    supabase.from(table).upsert(cloudRows, onConflict: 'user_id,id')
    if ok: stamp synced_at on each row
    if err: leave synced_at alone — next push retries the same batch

Pull pseudocode (pull.ts):
  serverTime = supabase.rpc('get_server_time')        // avoid clock skew
  cursor = sync_meta[table].last_pull_at ?? '1970-01-01'
  loop:
    page = supabase.from(table).gt('updated_at', cursor).order('updated_at ASC').limit(200)
    if page empty: break
    for cloudRow in page:
      local = SELECT * FROM <table> WHERE id = cloudRow.id
      winner = chooseWinner(local, cloudRow)            // last-write-wins
      if winner == 'local': skip
      else:                 upsert localFromCloud(cloudRow), stamp synced_at
    cursor = max(updated_at) in page
  sync_meta[table].last_pull_at = serverTime
```

---

## Elaborate

### Where this pattern comes from
This is the classic timestamp-cursor sync engine, descended from CouchDB and DynamoDB streams. The `synced_at` column for the local "watermark" + `updated_at` for the truth is a long-standing pattern — separating "when this changed" from "when we last reported it" is what makes incremental sync possible.

### The deeper principle
**Make canonical and derived states explicit.** `updated_at` is canonical (it travels with the row). `synced_at` is derived (it's local bookkeeping). Confusing the two makes sync impossible to reason about; separating them makes both easy.

### Where this breaks down
- Bidirectional realtime where both sides write the same row in the same second. LWW will pick one and silently drop the other; CRDTs or operational transforms become necessary.
- Tables with massive churn where the dirty set per push is huge. Batches of 50 stop being enough; sharding becomes mandatory.

### What to explore next
- [Conflict resolution: last-write-wins](./08-conflict-last-write-wins.md) → the per-row decision in pull.
- [Bootstrap decision tree](./10-bootstrap-decision-tree.md) → first-cold-start logic.
- [02-dsa/07-cloud-sync-push](../02-dsa/07-cloud-sync-push.md) and [02-dsa/08-cloud-sync-pull](../02-dsa/08-cloud-sync-pull.md) for execution traces.

---

## Tradeoffs

- **Local canonical, cloud mirror** — gives: writes feel instant. Costs: cloud is always slightly stale; never trusted in the read path.
- **Push + pull separate** — gives: each can be retried, scheduled, and tested independently. Costs: more files; you need a registry to keep them coordinated.
- **`synced_at` local-only** — gives: cloud schema stays simple (only `updated_at` + `deleted_at`). Costs: a missed `synced_at` stamp = the row pushes forever; the per-batch stamp must be robust.
