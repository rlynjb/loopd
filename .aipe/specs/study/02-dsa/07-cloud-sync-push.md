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

---

## Interview defense

### What an interviewer is really asking
The probe is whether I know what idempotent retry actually means in practice. `pushTable` doesn't track failed batches in any persistent structure — it just leaves `synced_at` unstamped, and the next call's `WHERE updated_at > synced_at` re-selects them automatically. The interviewer wants to hear that the SQLite predicate IS the retry queue. No retry table, no failure log to drain — the source of truth (`synced_at`) double-purposes as the durable cursor. That's the elegant move; recognizing it is the test.

### Likely questions

[mid] Q: Walk me through what happens to row 73 in your trace if batch 2 fails. Why does the next push pick it up?
      A: Row 73 is in batch 2, which errored, so the loop hit `continue` before reaching `localMarkSynced`. Its `synced_at` stays at its previous value (or NULL if it's never been synced). When the next `pushAll` runs, `localQueryDirty()` does `SELECT * WHERE updated_at > synced_at` — and since row 73's `updated_at` is newer than its stale `synced_at`, it shows up in the dirty set and gets retried. The DB column IS the retry mechanism; there's no separate queue or backoff structure.

[senior] Q: Why 50 specifically? What did you measure?
         A: Empirical, not theoretical. At 100+ rows per batch the supabase-js client started getting flaky on slower connections — payload sizes for `entries` (with `text` blobs) were tipping over 100KB. At 25 the round-trip overhead was eating the gains; 4 round-trips for 100 rows instead of 1. 50 hit the floor where doubling the batch saved one round-trip and halving cost two. It's also small enough that a fail-and-retry cycle is bounded — at most 50 rows have to re-traverse the wire on the next push.

[arch] Q: What about network partitions — what if the device pushes a batch, the server applies it, but the response is dropped?
       A: That's the partition case where the device thinks the batch failed but the server has actually applied it. On the next push, `localQueryDirty` re-selects those 50 rows because their local `synced_at` is still stale. The retry hits the server, which sees them as `onConflict` matches and runs the upsert again. Because every column is overwritten with the same `(user_id, id, ...same data)`, the second upsert is a no-op semantically. Last-Write-Wins resolves any race where the user kept editing locally — server's older copy of the row gets overwritten by the device's newer `updated_at`. The double-apply is invisible because upserts are idempotent under `onConflict + LWW`.

### The question candidates always dodge
Q: You said batches are "all-or-nothing per batch." What about transactional consistency *across* tables? If `entries` pushes successfully but `todo_meta` fails, you have rows referencing meta that the cloud doesn't know about.

A: Yes, and that's a real gap. `pushAll` walks 10 tables in sequence; each `pushTable` is independent; there's no cross-table transaction. So I can absolutely have `entries.todos_json` referencing `t-B` while cloud `todo_meta` doesn't yet have a row for `t-B`. The user-visible consequence is that the dashboard, when the user is on a *second device* that pulls before the next push, sees the entry but renders it with `meta` missing — which is exactly why I have the defensive `if !meta || !todo: continue` in `getThreadCards`. The cloud is *eventually consistent across tables*, not transactionally consistent. The principled fix would be a server-side stored procedure that accepted the multi-table batch and committed in one transaction; that's a 3-table or 4-table push API per logical write. I haven't built it because the user-visible cost (a brief render gap on a second device) is invisible at single-user scale, and the implementation cost (a custom RPC for every multi-table write) is high. It's the right call now; it stops being the right call the moment a second device joins.

### One-line anchors
- "The `synced_at` column IS the retry queue — no separate failure log."
- "50 is empirical: 100+ flakes on slow connections, 25 wastes round-trips."
- "Idempotent upsert means partition-induced double-apply is invisible."
- "Eventually consistent across tables — single-writer hides the lack of cross-table transactions."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
