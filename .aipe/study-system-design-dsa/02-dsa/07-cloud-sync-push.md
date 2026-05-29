# Cloud sync push — batch upsert with mid-batch failure tolerance

**Industry name(s):** Outbox-style push, batched upsert
**Type:** Industry standard · Language-agnostic

> Push only what changed, in chunks small enough that one failure doesn't strand the whole table.

**See also:** → [08-cloud-sync-pull](./08-cloud-sync-pull.md) · → [01-system-design/07-cloud-sync-mirror](../01-system-design/07-cloud-sync-mirror.md) · → [01-system-design/09-debounced-push](../01-system-design/09-debounced-push.md)

---

## Why care

Imagine loading a moving truck with 137 numbered boxes that have to make it to a warehouse across town. You could carry one box at a time — 137 trips, 137 chances for the truck to break down mid-route. Or you stack boxes into pallets of 50, drive each pallet across, and after each pallet lands safely the warehouse manager crosses those box numbers off the master manifest. If the truck breaks down halfway through pallet 2, only those 50 boxes need to be reloaded — the warehouse already has pallet 1 and won't re-receive what's already there.

That is the question this operation answers when an on-device store has to push a backlog of edits to a remote database over an unreliable mobile network: how big should each shipment be, and how do you avoid re-sending what's already arrived? Not "one row per HTTPS round-trip," not "one giant payload of everything at once" — just *batched upserts where the batch size amortises per-trip latency, idempotency on the receiver makes retries safe, and a local cursor column doubles as the retry queue*.

**What depends on getting this right:** the wall-clock duration of a sync, and the resilience of every dirty row to a flaky network. In this codebase the cursor is `synced_at` on each of the 10 synced SQLite tables, and the predicate `WHERE updated_at > synced_at` defines the dirty set. `pushTable` slices that set into batches of 50, upserts each batch to Supabase with `onConflict: 'user_id,id'`, and stamps `synced_at` on the local rows only when the upsert returns OK. If batch 2 of 3 fails on a 502, batches 1 and 3 still get stamped, and the next `schedulePush()` fires `localQueryDirty()` again — it re-selects exactly the 50 rows whose `synced_at` is still stale and retries them. There's no separate failure log, no exponential backoff structure, no in-flight-vs-queued state machine — the SQL predicate IS the retry queue.

Without batching + idempotency (one row per HTTPS call):
- 137 dirty rows × 200ms mobile latency = ~27 seconds of pushing per user typing burst
- A 502 on row 73 either drops that row silently or aborts the loop
- The device's HTTP connection pool gets exhausted halfway through
- The next debounce window can't fire because the previous push is still running

With batched-upsert + `synced_at` retry queue:
- 137 dirty rows in ⌈137/50⌉ = 3 batches × ~200ms = ~600ms total
- Batch 2 fails → only batch 2's 50 rows stay dirty; batch 1 and 3 are stamped
- Next `schedulePush()` fires; `localQueryDirty()` re-selects those 50 rows
- The upsert with `onConflict + LWW` makes re-sending an already-applied batch a server-side no-op
- The user's experience: a successful sync after a momentary blip; no manual retry, no support ticket

Round-trips are the cost; the cursor column IS the retry queue.

---

## How it works

A mover loading boxes onto a truck in groups of 50. After each group lands safely in the warehouse, the mover crosses those box numbers off the manifest. If the truck breaks down halfway, only the boxes still on the truck need to be reloaded — the warehouse manager won't re-receive what's already there. If you're coming from frontend, this is the same shape as React Query's mutation queue with idempotency keys — the client doesn't track "have I already sent this?" because the server's upsert-on-conflict makes resends safe. Three moves: select dirty rows, batch in 50s, upsert + stamp synced_at per successful batch.

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

── Brute force ──────────────────────────────────

Pseudocode (per-row upsert in a loop):

```
  dirty = table.localQueryDirty()
  succeeded, failed = 0, 0
  for row in dirty:
    cloudRow = localToCloud(row)
    err = supabase.from(table).upsert([cloudRow], onConflict: 'user_id,id')
    if err: failed++; continue
    table.localMarkSynced(row.id, now)
    succeeded++
  return { attempted: dirty.length, succeeded, failed }
```

Execution trace (137 dirty rows, one HTTPS roundtrip each):

```
  row 1   upsert OK   137 - 1 = 136 remaining
  row 2   upsert OK   135 remaining
  ...
  row 73  upsert ERR  log failure, continue
  ...
  row 137 upsert OK   0 remaining

  Network: 137 HTTPS round-trips
  At 200ms latency: 137 × 200ms = 27.4s of pushing for one user typing burst
  Wall-clock dominated by latency, not compute.
```

Complexity: O(n) network round-trips (one per row) · O(1) memory.

What goes wrong at scale: at 137 dirty rows × 200ms typical mobile latency = ~27s push time, blocking the next sync window and exhausting the device's HTTP connection pool. At 10,000 dirty rows it's ~33 minutes — unusable. The batch shape collapses n into ⌈n/50⌉ = 200 round-trips for the same 10k rows, ~40s. The per-row brute-force version is the most common shape an engineer reaches for first; it's also the most common reason sync engines feel slow.

── Optimal ──────────────────────────────────────

The insight: batches of 50 amortise the per-round-trip overhead. Per-batch idempotency (via `onConflict + LWW`) means a failed batch leaves `synced_at` unstamped and the next push retries automatically — the SQLite predicate IS the retry queue.

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

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n) RTs       │ O(n / 50) RTs    │
  │ Space           │ O(1)           │ O(50)            │
  │ At 1,000 items  │ 1,000 RTs      │ 20 RTs           │
  │ At 10,000 items │ 10,000 RTs     │ 200 RTs          │
  │ Readable?       │ yes            │ yes              │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: never on a real sync path — latency dominates. The only place per-row is OK is a small dev script (<20 rows). Even then, batching is one extra line of code.

This is what people mean by "batch under, but small enough to retry cheaply." Every bulk-load utility in every database does this (`COPY` with commit intervals, message queue consumers committing offsets per batch). The trick is sizing the batch so a network failure costs at most one batch's worth of work, while still amortising per-call overhead. 50 is the sweet spot for HTTPS-over-Supabase at this codebase's row sizes; the number isn't sacred, it's tuned.

---

## In this codebase

**Algorithm:**       `src/services/sync/push.ts` → `pushTable<TLocal, TCloud>()` L9–L67 (`BATCH_SIZE = 50` const at L7)
**Orchestrator:**    `src/services/sync/orchestrator.ts` → `pushAll()` L38–L60 — walks the 10-table `REGISTRY` (defined L25)
**Per-table glue:**  `src/services/sync/tables/*` — each table exports `localQueryDirty`, `localToCloud`, `localMarkSynced` (the three callbacks `pushTable` consumes)
**Cursor column:**   the SQLite `synced_at` column on every synced table is the durable retry queue — `localQueryDirty` runs `SELECT * WHERE updated_at > synced_at`
**Schema namespace:** `supabase.from(table).upsert(…, { onConflict: 'user_id,id' })` resolves to `buffr.<table>` because `src/services/sync/client.ts:47` sets `db: { schema: 'buffr' }` (migration 0010 moved the tables out of `public`); the upsert + onConflict semantics are unchanged.

---

## Elaborate

### Where this pattern comes from
Batched upsert is the standard pattern for any sync engine — Salesforce Bulk API, Stripe Sync, Postgres `COPY` — all use it. The constants (50, 100, 1000) vary by service but the shape is identical.

### The deeper principle
**Network latency is the constant; row count is the variable. Batches turn N round-trips into N/B round-trips for batch size B.** Pick B large enough that the per-trip overhead amortises, small enough that a failure isn't catastrophic.

### Where this breaks down
- Tables with row sizes that vary wildly. A batch of 50 with one giant row may exceed payload limits while a batch of 50 with tiny rows wastes capacity.
- Cases where intra-batch ordering matters. Upserts with `onConflict` are commutative within a batch, but if you depend on order (e.g., FK dependencies), you need to batch carefully.
- Errors that arrive as data instead of exceptions. The orchestrator that drives `pushTable` logs only when counts are non-zero (`orchestrator.ts:49` — `if (r.succeeded > 0 || r.failed > 0)`). A PostgREST error returned in the response body (RLS denial, `PGRST106` for an unexposed schema) produces zero counts, no throw, and no log — the dirty set never drains and the freeze is silent because reads stay local. Both production freezes that hit this (RLS drift → migration 0009; the `buffr` schema not exposed after migration 0010) trace back to success-only logging; see `01-system-design/07-cloud-sync-mirror.md` "Where this breaks down."

### What to explore next
- [08-cloud-sync-pull](./08-cloud-sync-pull.md) → the read counterpart.
- [01-system-design/09-debounced-push](../01-system-design/09-debounced-push.md) → the debouncer that determines when push runs.

---

## Tradeoffs

We traded transactional sender-side bookkeeping for an idempotent receiver-side upsert plus a SQLite column that doubles as the retry queue.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (batch 50 + LWW     │ Alternative (per-row + retry   │
│                  │ upsert)                        │ table)                         │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Round-trips      │ ⌈n/50⌉ per push                │ n per push                     │
│ Time at 137 rows │ ~600ms total (3 batches × ~200 │ ~27s total (137 × ~200ms)      │
│                  │ ms latency)                    │                                │
│ Time at 10× N    │ ~4s at 1,370 rows              │ ~270s at 1,370 rows — sync     │
│                  │                                │ window blown                   │
│ Code complexity  │ ~67 LOC pushTable + 10 table   │ ~40 LOC per-row but + retry    │
│                  │ glue files                     │ table + drainer + backoff      │
│ Memory churn     │ ~50-row JS array per batch     │ 1 row at a time, but per-row   │
│                  │                                │ Promise allocation × n         │
│ Retry mechanism  │ `synced_at` predicate IS the   │ explicit retry table with row  │
│                  │ retry queue                    │ id + attempt count + next-try  │
│ Failure mode     │ batch all-or-nothing — partial │ per-row tracking, but retry    │
│                  │ failure expressed as 50 still- │ table is a second source of    │
│                  │ dirty rows                     │ truth that can drift           │
│ Idempotency      │ `onConflict + LWW` makes       │ retry table must track "in     │
│                  │ double-apply a no-op           │ flight" vs "queued" states     │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

Batches are all-or-nothing — a partial-batch failure can't be expressed. If batch 2 fails on row 73 inside the upsert, the other 49 rows in the batch don't get `synced_at` either; the next push re-sends all 50. We accept ~5% wasted bandwidth on retry vs the cost of tracking row-level success inside an opaque upsert response.

The 10 tables in `orchestrator.ts:pushAll` (L38–L60) push sequentially with no cross-table transaction. A second device pulling between table pushes can briefly see entries that reference `todo_meta` rows the cloud doesn't yet have. The defensive `if !meta` skip in `getThreadCards` absorbs the gap at single-writer scale; the moment a second writer exists, this becomes observable.

`BATCH_SIZE = 50` is empirical, not theoretical. We measured: 100+ flakes on slow connections when `entries` carries text blobs (payload >100KB); 25 wastes round-trips (4 trips for 100 rows instead of 1). 50 is the floor at which doubling the batch saves one round-trip and halving costs two. A retuneable per-table constant would be more correct; we picked one global value to keep the table glue uniform.

### What the alternative would have cost

A per-row upsert loop (~40 LOC) would be simpler to read, but at 137 dirty rows on a 200ms-latency mobile connection it's 27 seconds of pushing — blowing the next sync window and exhausting the device's HTTP pool. At 10,000 rows it's 33 minutes, unusable.

An explicit retry table (row id + attempt count + next-try-at + last-error) is the textbook outbox shape. It costs ~150 LOC of plumbing (drainer, backoff schedule, lock against the live writer, conflict resolution if the user re-edits a queued row) and introduces a second source of truth for "what needs to be sent" that can drift from `WHERE updated_at > synced_at`. The codebase's choice to make the `synced_at` column itself the queue eliminates the drift class entirely — the predicate is durable, monotonic, and self-resyncing.

### The breakpoint

Fine until two writers exist (multi-device, future feature) or until a single user's dirty backlog exceeds ~5,000 rows in one push window. At 5,000 rows × 200ms latency / 50 batch = ~20s per push — still tolerable but eats the next sync window. The fix at that scale is parallel-batch dispatch (send 4 batches concurrently) which doesn't change the algorithm shape, just the dispatcher.

### What wasn't actually a tradeoff

`onConflict: 'user_id,id'` with Last-Write-Wins isn't really a tradeoff against application-level CRDTs — at single-user-per-account scale the rows have one writer and LWW is the correct semantics, not a compromise. CRDTs would matter the moment two writers concurrently edited the same row, which the current product surface doesn't permit.

---

## Tech reference (industry pairing)

### @supabase/supabase-js

- **Codebase uses:** `@supabase/supabase-js` (upsert + `onConflict`).
- **Why it's here:** batch upsert with conflict semantics drives the idempotent per-batch retry mechanism.
- **Leading today:** Supabase — `adoption-leading`, 2026.
- **Why it leads:** managed Postgres + auth + RLS + Storage in one console; SDK mirrors PostgREST directly.
- **Runner-up:** Neon + Drizzle — `innovation-leading` typed SQL with branch-per-PR workflow.

---

## Summary

The batched-upsert pattern with checkpoint-per-batch progress is the family of "amortise per-call overhead by batching, but keep batches small enough that a failure isn't catastrophic" — the same shape as resumable file uploads, bulk-load utilities (`COPY` with commit intervals), and message-queue consumers committing offsets per batch. In this codebase `pushTable` in `src/services/sync/push.ts` selects `WHERE updated_at > synced_at`, upserts to Supabase in batches of 50 with `onConflict: 'user_id,id'`, then stamps `synced_at` per successful batch so the row stops being "dirty"; on failure it leaves `synced_at` alone so the next push retries the same batch. The constraint that made this the right call was that idempotency on the receiver (upsert-on-conflict with LWW) means the sender doesn't need a separate retry table — the SQLite `synced_at` column IS the durable retry queue. The cost is that batches are all-or-nothing (a partial-batch failure can't be expressed), and the 10 tables in the orchestrator are pushed sequentially with no cross-table transaction, so a second device pulling between table pushes can briefly see entries that reference meta the cloud doesn't yet know about. 50 is empirical, not theoretical: 100+ flakes on slow connections with `entries` text blobs, 25 wastes round-trips.

Key points to remember:
- One HTTPS round-trip per batch of 50, vs one round-trip per row in the brute-force shape — turns ~27s into ~600ms at 137 dirty rows.
- The `synced_at` column IS the retry queue — no separate failure log, no exponential-backoff structure; the next push's predicate re-selects whatever didn't get stamped.
- `onConflict: 'user_id,id'` + LWW means partition-induced double-apply (server applied, response dropped) is invisible — the second upsert is a semantic no-op.
- Batch size 50 is empirically tuned: large enough to amortise round-trip overhead, small enough that a failure costs at most 50 rows on retry.
- No cross-table transaction across the orchestrator's 10 tables — eventually consistent; the defensive `if !meta` skips in downstream readers absorb the gap at single-writer scale.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I know what idempotent retry actually means in practice. `pushTable` doesn't track failed batches in any persistent structure — it just leaves `synced_at` unstamped, and the next call's `WHERE updated_at > synced_at` re-selects them automatically. The interviewer wants to hear that the SQLite predicate IS the retry queue. No retry table, no failure log to drain — the source of truth (`synced_at`) double-purposes as the durable cursor. That's the elegant move; recognizing it is the test.

### Likely questions

[mid] Q: Walk me through what happens to row 73 in your trace if batch 2 fails. Why does the next push pick it up?
      A: Row 73 is in batch 2, which errored, so the loop hit `continue` before reaching `localMarkSynced`. Its `synced_at` stays at its previous value (or NULL if it's never been synced). When the next `pushAll` runs, `localQueryDirty()` does `SELECT * WHERE updated_at > synced_at` — and since row 73's `updated_at` is newer than its stale `synced_at`, it shows up in the dirty set and gets retried. The DB column IS the retry mechanism; there's no separate queue or backoff structure.

```
[row 73 across two push cycles]

  push #1 batch 2 (rows 50-99)
        │
        ▼  upsert HTTPS → 502
  err caught, continue   ◀── no localMarkSynced called
        │                    synced_at unchanged on row 73
        ▼
  push #1 returns: failed=50

  next push fires (debounced 5s later or next commit)
        │
        ▼
  localQueryDirty: SELECT WHERE updated_at > synced_at
        │   row 73 still dirty → re-included
        ▼
  push #2 batch including row 73 → retried (idempotent)
```

[senior] Q: Why 50 specifically? What did you measure?
         A: Empirical, not theoretical. At 100+ rows per batch the supabase-js client started getting flaky on slower connections — payload sizes for `entries` (with `text` blobs) were tipping over 100KB. At 25 the round-trip overhead was eating the gains; 4 round-trips for 100 rows instead of 1. 50 hit the floor where doubling the batch saved one round-trip and halving cost two. It's also small enough that a fail-and-retry cycle is bounded — at most 50 rows have to re-traverse the wire on the next push.

```
                  Path taken (BATCH=50)                Alternative (BATCH=25 or 100)
                  ────────────────────────             ──────────────────────────────────
round-trips/100   2 round-trips                        25→4 RTs (wastes); 100→1 RT (flaky)
payload per RT    ~50KB on entries with text          25→~25KB (safe); 100→~100KB (tips)
flake rate        baseline on mobile networks         25→same; 100→observable timeouts
                                                       on slow Android connections
worst-case retry  ≤50 rows re-sent                     25→25 rows; 100→100 rows wasted
                                                       per failed batch
amortization      doubling halves RTs                   25 doesn't amortize enough
sweet spot        50 — floor where doubling saves     25 too small, 100 too risky
                  1 RT and halving costs 2
```

[arch] Q: What about network partitions — what if the device pushes a batch, the server applies it, but the response is dropped?
       A: That's the partition case where the device thinks the batch failed but the server has actually applied it. On the next push, `localQueryDirty` re-selects those 50 rows because their local `synced_at` is still stale. The retry hits the server, which sees them as `onConflict` matches and runs the upsert again. Because every column is overwritten with the same `(user_id, id, ...same data)`, the second upsert is a no-op semantically. Last-Write-Wins resolves any race where the user kept editing locally — server's older copy of the row gets overwritten by the device's newer `updated_at`. The double-apply is invisible because upserts are idempotent under `onConflict + LWW`.

```
[scale curve — what breaks first at 10× and 100× dirty backlog]

  dirty rows   batches   wall time @200ms/RT   sync window   breaks?
  ──────────   ───────   ──────────────────   ───────────   ──────────────────
  137 (real)   3         ~600ms                next: 5s OK    no
  1,370 (10×)  28        ~5.6s                 next: 5s !    push overruns next debounce
  13,700 (100×) 274      ~55s                  way over       HTTP pool exhaustion   ◀── BREAKS FIRST
  100,000+     2000+     ~7min                 ◀◀ unusable    need parallel batches,
                                                              not a different algorithm
```

### The question candidates always dodge
Q: You said batches are "all-or-nothing per batch." What about transactional consistency *across* tables? If `entries` pushes successfully but `todo_meta` fails, you have rows referencing meta that the cloud doesn't know about.

A: Yes, and that's a real gap. `pushAll` walks 10 tables in sequence; each `pushTable` is independent; there's no cross-table transaction. So I can absolutely have `entries.todos_json` referencing `t-B` while cloud `todo_meta` doesn't yet have a row for `t-B`. The user-visible consequence is that the dashboard, when the user is on a *second device* that pulls before the next push, sees the entry but renders it with `meta` missing — which is exactly why I have the defensive `if !meta || !todo: continue` in `getThreadCards`. The cloud is *eventually consistent across tables*, not transactionally consistent. The principled fix would be a server-side stored procedure that accepted the multi-table batch and committed in one transaction; that's a 3-table or 4-table push API per logical write. I haven't built it because the user-visible cost (a brief render gap on a second device) is invisible at single-user scale, and the implementation cost (a custom RPC for every multi-table write) is high. It's the right call now; it stops being the right call the moment a second device joins.

```
                  Path taken (10 tables sequential)    Suggested (server-side multi-table RPC)
                  ────────────────────────────────────  ──────────────────────────────────
push shape        10 independent pushTable calls       1 RPC per logical write (entry+meta+
                                                       mentions in one BEGIN/COMMIT)
cross-table       inconsistent window between          atomic — server commits all-or-none
consistency       table pushes
2nd device pulls  may see entry without meta;          sees fully-formed entry or nothing
                  defensive skip in getThreadCards
                  hides it
implementation    ~67 LOC pushTable, reused 10× via    custom RPC per write shape (~150
                  table glue                           LOC server + matching client)
                                                       per logical write
race observed     never at single-user scale           race gone formally
verdict           right call now; flip when 2nd        the moment 2nd device joins, this
                  device joins                         becomes the correct shape
```

### One-line anchors
- "The `synced_at` column IS the retry queue — no separate failure log."
- "50 is empirical: 100+ flakes on slow connections, 25 wastes round-trips."
- "Idempotent upsert means partition-induced double-apply is invisible."
- "Eventually consistent across tables — single-writer hides the lack of cross-table transactions."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain cloud sync push to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/sync/push.ts:pushTable`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A push run starts. `localQueryDirty` returns 137 dirty rows for `entries`. Batch 1 (rows 0–49) succeeds. Batch 2 (rows 50–99) fails on a 502 from Supabase. Batch 3 (rows 100–136) succeeds. What is the next state of `synced_at` and `updated_at` across the 137 rows immediately after `pushTable` returns? On the next push fire (assuming no further user edits), how many rows does `localQueryDirty` re-select, and which of the 137 are they?

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/push.ts` L9–L67 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/sync/push.ts` to support what exists
→ Point to `src/services/sync/orchestrator.ts:pushAll` (where a per-table loop would need to become a single multi-table RPC for cross-table transactional consistency) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — added v1.14.0 subtitle block + brute-force section + comparison table.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @supabase/supabase-js.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (mover-with-manifest metaphor + frontend bridge to React Query mutation queue) and Move 3 principle after the Comparison block.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (moving-truck-with-pallets scenario → naming the batched-upsert-with-idempotent-retry pattern → bolded "what depends on getting this right" pivot with `synced_at` cursor-as-retry-queue stakes → before/after bullets comparing per-row vs batched push of 137 dirty rows → one-line summary "round-trips are the cost; the cursor column IS the retry queue").

---
Updated: 2026-05-19 — added `Schema namespace` line to `## In this codebase` documenting migration 0010 (`supabase.from(table).upsert(…)` now resolves to `buffr.<table>` via the client's default schema config; upsert + `onConflict` semantics unchanged).

---
Updated: 2026-05-29 — added a `Where this breaks down` bullet on errors-as-data: the orchestrator's success-only log guard (`orchestrator.ts:49`) hides PostgREST errors returned in the response body (RLS denial, `PGRST106`), so the dirty set silently never drains. Cross-referenced the two production freezes (0009 RLS drift; 0010 schema-not-exposed) and the mirror file's fuller writeup.
