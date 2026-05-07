# Cloud sync push — batch upsert with mid-batch failure tolerance

> Push only what changed, in chunks small enough that one failure doesn't strand the whole table.

**See also:** → [08-cloud-sync-pull](./08-cloud-sync-pull.md) · → [01-system-design/07-cloud-sync-mirror](../01-system-design/07-cloud-sync-mirror.md) · → [01-system-design/09-debounced-push](../01-system-design/09-debounced-push.md)

---

## Quick summary
- **What:** select `WHERE updated_at > synced_at`, upsert in batches of 50 with `onConflict: 'user_id,id'`. Stamp `synced_at` per successful batch.
- **Why here:** big payloads risk timeouts; per-row pushes risk hundreds of round-trips. 50 is the empirical sweet spot.
- **Tradeoff:** a transient mid-batch failure leaves the failed 50 unsynced; the next push retries them (idempotent thanks to `onConflict`).

**Real operation:** `pushTable` in `src/services/sync/push.ts`.

---

## The data

```
  table.localQueryDirty() → 137 dirty rows
  BATCH_SIZE = 50
  Supabase upsert with onConflict: 'user_id,id'
```

**The problem:** push only what changed, in chunks small enough that one failure doesn't strand the whole table. On per-batch success, stamp `synced_at` so the row is no longer "dirty"; on failure, leave `synced_at` alone so the next push retries the same batch.

---

## Pseudocode

```
  dirty = table.localQueryDirty()                  // SELECT * WHERE updated_at > synced_at
  if dirty.empty:
    recordPushSuccess(table, now, 0)
    return zeroResult

  succeeded, failed = 0, 0
  for offset in 0, 50, 100, ...:
    batch = dirty[offset : offset+50]
    cloudRows = batch.map(localToCloud)
    err = supabase.from(table).upsert(cloudRows, onConflict: 'user_id,id')
    if err:
      failed += batch.length
      lastErr = err.message
      continue                                     // don't stamp synced_at
    stampedAt = now
    for row in batch:
      table.localMarkSynced(row.id, stampedAt)
    succeeded += batch.length

  if failed == 0: recordPushSuccess(...)
  else:           recordSyncError(table, lastErr)
  return { attempted: dirty.length, succeeded, failed }
```

**Execution trace** (137 dirty, batch 2 fails):

```
  batch 1  rows 0-49    upsert OK    stamp 50 rows synced_at  succeeded=50
  batch 2  rows 50-99   upsert ERR   skip stamp                failed=50
  batch 3  rows 100-136 upsert OK    stamp 37 rows synced_at  succeeded=87

  Total: attempted=137, succeeded=87, failed=50
  recordSyncError(table, "<batch-2 err>")

  Next push: localQueryDirty re-selects the 50 rows that didn't get synced_at
             → retries them (idempotent thanks to onConflict + LWW)
```

**Complexity:** O(n) network ops grouped into ⌈n/50⌉ batches; each batch is one HTTPS round-trip · O(BATCH_SIZE) space.

---

## Why batched, not single upsert

One giant upsert would make a 50KB+ payload that supabase-js doesn't love, and a network blip would lose all 137 rows of progress. 50 is small enough to retry cheaply, big enough that 200 todos = 4 round-trips.

---

## When brute force is fine

The "brute" alternative is per-row upserts (one HTTP call per dirty row). At 137 dirty rows on a typing burst, that's 137 round-trips × ~200ms = 27 seconds of pushing. Don't ship that. Batched is the only viable shape at scale.

---

## In this codebase

- `src/services/sync/push.ts` → `pushTable()`.
- `src/services/sync/orchestrator.ts` → `pushAll()` walks the registry of 10 tables.
- `src/services/sync/tables/*` → per-table `localQueryDirty`, `localToCloud`, `localMarkSynced`.

---

## Elaborate

### Where this pattern comes from
Batched upsert is the standard pattern for any sync engine — Salesforce Bulk API, Stripe Sync, Postgres `COPY` — all use it. The constants (50, 100, 1000) vary by service but the shape is identical.

### The deeper principle
**Network latency is the constant; row count is the variable. Batches turn N round-trips into N/B round-trips for batch size B.** Pick B large enough that the per-trip overhead amortises, small enough that a failure isn't catastrophic.

### Where this breaks down
- Tables with row sizes that vary wildly. A batch of 50 with one giant row may exceed payload limits while a batch of 50 with tiny rows wastes capacity.
- Cases where intra-batch ordering matters. Upserts with `onConflict` are commutative within a batch, but if you depend on order (e.g., FK dependencies), you need to batch carefully.

### What to explore next
- [08-cloud-sync-pull](./08-cloud-sync-pull.md) → the read counterpart.
- [01-system-design/09-debounced-push](../01-system-design/09-debounced-push.md) → the debouncer that determines when push runs.

---

## Tradeoffs

- **BATCH_SIZE = 50** — gives: small enough to retry, big enough to amortize. Costs: arbitrary; can be tuned by table.
- **Stamp synced_at on success** — gives: idempotent retries on failure. Costs: a partial-batch failure can't be expressed (all-or-nothing per batch).
- **`onConflict: 'user_id,id'`** — gives: commutative, idempotent upserts. Costs: every synced table needs the composite PK shape.
