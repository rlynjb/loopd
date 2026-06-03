# Debounced batched sync — the bridge between canonical-local and cloud-mirror
## Industry name(s): debounced sync, batched upsert, cursor pull, dirty-tracking sync · Type: Architecture pattern

> Sync runs on a debounce timer (5s after the last write). Each tick pushes dirty rows per table in batches, then pulls remote changes via a per-table cursor. The pattern preserves bandwidth, battery, and order without giving up the "writes feel instant" UX.

## Zoom out, then zoom in

```
  THE SYNC CYCLE

  1. user writes → SQLite updated_at stamped
  2. scheduleSync() called
  3. (debounce 5s; coalesce bursts)
  4. orchestrator wakes:
     for each table:
       push: SELECT WHERE updated_at > synced_at LIMIT BATCH
             upsert batch to Postgres
             stamp synced_at on success
       pull: SELECT WHERE updated_at > cursor LIMIT PAGE
             apply locally; advance cursor
  5. log result (★ silently fails if r.error and counts=0)
  6. exit; wait for next scheduleSync()
```

Zoom in: the debounce coalesces bursts of writes (typing produces dozens of UPDATE statements per second). The batch upsert keeps PostgREST request count low. The cursor pull lets the device resume from any point without re-fetching the whole table.

## Structure pass

```
  layers   ─ scheduler ─ orchestrator ─ per-table push/pull ─ Supabase JS
  axes     ─ frequency  (debounced vs continuous)
             ─ granularity (single row vs batch vs whole table)
             ─ direction   (push vs pull; conflict via LWW)
  seams    ─ scheduler ←→ orchestrator: the debounce timer
             ─ push     ←→ pull        : same orchestrator cycle
             ─ pull     ←→ cursor      : resumability
```

## How it works

### Move 1 — debounce buys bandwidth and battery

```
  no debounce:                debounce 5s:
  ───────────                 ──────────
  N writes → N PUT calls       N writes → 1 batch PUT
  battery: high                battery: low
  bandwidth: high              bandwidth: low (batch compression)
  latency to durability: low   latency: 5s (acceptable for journal)
```

### Move 2 — batched upsert collapses round-trips

```
  per-row upsert:              batched upsert:
  ─────────────                 ──────────────
  for row in dirty:            supabase.from(table).upsert(dirty)
    supabase.from()             
      .upsert(row)              1 PostgREST call. ON CONFLICT
                                 clause does per-row resolution
                                 server-side.
  N round-trips                1 round-trip
```

The batch size (~100-200 rows in practice) is sized so a single PostgREST request stays under the URL/body limits and completes within reasonable network timeouts.

### Move 3 — pull cursor enables resumable sync

```
  state: per-table cursor in sync_state
  query: WHERE updated_at > cursor ORDER BY updated_at LIMIT N
  advance: cursor = max(updated_at) in returned page
  
  interrupted pull (network dies mid-page): cursor not advanced;
  next sync re-fetches from the same point. idempotent by design.
```

## Primary diagram

```
   the orchestrator loop

   ┌─ scheduleSync called (any write) ─┐
   │                                    │
   │  coalesce in 5s window             │
   │                                    │
   │  ▼                                 │
   │  for table in tables:              │
   │    push:                            │
   │      r = pushTable(table)           │
   │      if (succ||fail) log ◄── ★      │
   │    pull:                            │
   │      r = pullTable(table)           │
   │      if (apply||fetch) log ◄── ★    │
   │                                    │
   │  done. exit.                       │
   └────────────────────────────────────┘

   ★ this is the silent-error guard.
     debug-obs/01 explains what it hides.
```

## Implementation in codebase

```ts
// pattern; src/services/sync/orchestrator.ts (approximate)
export async function runSync(ctx: SyncCtx) {
  for (const table of SYNCED_TABLES) {
    const r = await pushTable(table, ctx);
    if (r.succeeded > 0 || r.failed > 0) {                // ← :49
      console.log(`[buffr sync] push ${table}: ${r.succeeded} ok, ${r.failed} failed`);
    }
  }
  for (const table of SYNCED_TABLES) {
    const r = await pullTable(table, ctx);
    if (r.applied > 0 || r.fetched > 0) {                 // ← :72
      console.log(`[buffr sync] pull ${table}: ${r.applied} applied, ${r.fetched} fetched`);
    }
  }
}
```

**Line-by-line read:**

- `SYNCED_TABLES` is a fixed ordered list. Push order matters when foreign-key-shaped relationships exist (parent before child); buffr's relationships are loose (composite PKs, no FKs across tables), so order is mostly cosmetic.
- The guard at `:49` and `:72` is the load-bearing observability hole. See `../study-debugging-observability/01-success-only-log-guard.md`.
- The function has no per-row error recovery; it has per-table batch error recovery (whole batch fails together; LWW resolution if it partially succeeded). Per-row recovery would add code complexity for a failure mode that's structurally rare with idempotent upserts.

## Elaborate

The debounce-batch-cursor triad is the standard shape for "single-user, multi-device, eventually consistent" sync. It generalizes to Notion-like apps, Bear, Drafts, Things, and many others. The specific choices that vary are:

- **Debounce window:** 5s for buffr. 1s for collaborative apps (Linear). 30s for low-importance sync (background analytics).
- **Batch size:** 100-500 for typical row sizes. 10-50 for large blobs.
- **Cursor field:** `updated_at` for time-based; integer LSN for replication-log-based; vector clock for CRDTs.

Buffr's choice of `updated_at` as cursor is the simplest correct one for non-collaborative single-user use. It does mean two devices writing to the same row at the same `updated_at` need a deterministic tiebreaker — buffr's is "local wins on tie," which prevents flapping.

The pattern has one structural weakness in buffr's implementation: **the success-only log guard**. The debounce + batch design is sound; the orchestrator's failure to surface error-as-data is what makes it silently fragile. Fixing the guard (`|| r.error`) closes the gap without changing the architecture.

## Interview defense

**Q [mid]:** Walk me through how a write gets to the cloud.

**A:** Local SQLite UPDATE stamps `updated_at = Date.now()`. `scheduleSync()` resets the debounce timer to 5s. After 5s of no new writes, the orchestrator runs. For each table, it selects rows where `updated_at > synced_at`, batches them, and upserts to Supabase via PostgREST. Successful rows get their `synced_at` stamped to the server's timestamp.

**Q [senior]:** What happens if the device dies mid-sync?

**A:** The push half is per-table; if the device dies before `synced_at` is stamped, the next sync re-picks-up those rows (dirty filter still selects them). The upsert is idempotent (composite PK with `ON CONFLICT`), so re-pushing the same rows is safe. The pull half advances cursor only after rows are applied locally; an interrupted pull starts from the un-advanced cursor next cycle. Whole design is at-least-once with idempotent application.

**Q [arch]:** Why not use the Supabase Realtime channel for pushed-from-server changes?

**A:** Cost and complexity. The debounce-pull model works fine for buffr's single-user-multi-device pattern. Realtime would matter for collaborative editing or for "another user just changed something" notifications — buffr has neither today. The day buffr adds multi-user features, this is the upgrade.

## Validate

### Level 1 — sketch the debounce → push → pull → exit loop.

### Level 2 — explain why upsert is idempotent and why that matters.

### Level 3 — apply: a feature wants "instant cross-device update." Walk: requires Realtime or polling at a tighter interval. Trade-off is battery + bandwidth.

### Level 4 — defend: "Push and pull should be parallel, not sequential." Could be — both sides are independent. Sequential keeps logs in stable order and simplifies failure reasoning. Worth changing if sync latency ever becomes a complaint.

## See also

- [`01-canonical-local-with-cloud-mirror.md`](./01-canonical-local-with-cloud-mirror.md) — why this bridge exists.
- [`audit.md`](./audit.md) — Pass 1's lens 2 (data flow) and lens 6 (failure handling).
- `../study-debugging-observability/01-success-only-log-guard.md` — the silent-error bug in this code.
- `../study-database-systems/08-replication-and-read-consistency.md` — cursor mechanics in detail.
- `../study-distributed-systems/03-conflict-resolution.md` — LWW conflict semantics.
