# Queues, streams, ordering, and backpressure — what buffr doesn't have
## Industry name(s): message queue, event stream, dead-letter queue, backpressure · Type: Foundational

> Buffr has no queue. No stream. No DLQ. The "queue" of dirty rows lives in SQLite as `WHERE updated_at > synced_at` — a query, not a queue. This is fine at single-user scale; it would not survive a multi-tenant cloud-backed worker pool.

## Zoom out, then zoom in

```
  WHAT BUFFR USES                       WHAT BUFFR DOESN'T HAVE

  ─ SQLite as "queue" (dirty filter)    ─ message queue (Redis/Kafka/SQS)
  ─ debounce as rate-limit               ─ event stream (Realtime/Pub/Sub)
  ─ in-process orchestrator               ─ dead-letter queue
  ─ at-least-once via dirty filter        ─ backpressure mechanism
                                          ─ ordering guarantees beyond
                                             "updated_at sorts pulls"
```

Zoom in: the SQLite-as-queue pattern is the right minimum for a single-user app. The day buffr adds background workers offloading LLM work, that needs to change.

## Structure pass

```
  layers   ─ dirty rows (SQLite) ─ orchestrator (in-process) ─ Supabase
  axes     ─ ordering (none across rows; FIFO per-row via updated_at)
             ─ backpressure (debounce is the only governor)
  seams    ─ dirty filter ←→ orchestrator : implicit queue
```

## How it works

### Move 1 — the "queue" is a query

```
  SELECT * FROM entries WHERE updated_at > synced_at;
  
  no explicit head/tail. no consumer offset.
  the orchestrator picks up everything dirty each tick.
```

### Move 2 — backpressure is the debounce timer

```
  fast writes → many dirty rows → next sync sends them all.
  if the sync can't keep up, dirty rows pile up; eventually
  one sync cycle takes longer. there's no explicit pushback
  to the writer.
```

### Move 3 — no DLQ today

```
  if a row fails every push (poison row):
   ─ it stays dirty forever
   ─ every sync tick re-tries it
   ─ wastes one round-trip per tick, forever
   ─ no surfaced signal to operator
  
  THIS IS A REAL HOLE. mitigation: a "failure count" column,
  exclude rows with count > N from the dirty filter, surface them
  in a debug screen.
```

## Implementation in codebase

```ts
// pattern; src/services/sync/orchestrator.ts
async function getDirty(table: string, userId: string) {
  return db.queryAll(
    `SELECT * FROM ${table} WHERE user_id = ? AND updated_at > synced_at`,
    [userId],
  );
}
```

No `MAX(failure_count)` or `LIMIT` on the dirty filter — pull everything dirty per tick. At buffr's scale this is fine; at higher row counts it would need pagination.

## Elaborate

The "no queue" pattern is the right minimum for a single-process app. The cost of adding a real queue (Redis or similar) would be:

- new failure mode (queue down)
- new operational concern (queue size monitoring)
- new code path (producer/consumer)

For buffr's use case (single-user, debounced background sync), none of these pay off. The day there's a worker pool or a multi-tenant pipeline, the conversation changes.

The DLQ gap is the one structural hole worth naming. A row that fails every push (e.g., a row whose foreign key references something that doesn't exist) burns one push-call per tick forever.

## Interview defense

**Q [mid]:** Why don't you use a real message queue?

**A:** Single-user, single-process, debounced sync. The SQLite-as-queue pattern is the cheapest correct shape. Adding a real queue would be over-investment for the failure modes it solves.

**Q [senior]:** What's the failure mode you can't handle today?

**A:** Poison rows — a row that fails every push, e.g., schema violation against the cloud-side. The dirty filter keeps re-selecting it. No DLQ; no skip-list; no surfaced signal. The fix is a `push_failures` counter column + exclude-on-N+1 in the dirty filter.

## Validate

### Level 1 — explain why a query can serve as a queue.

### Level 2 — name the missing DLQ failure mode.

### Level 3 — apply: design a DLQ for buffr. A column on each synced table + dirty-filter exclusion. ~30 LOC.

### Level 4 — defend: "Add Kafka for sync." Massive over-investment. SQLite is the right substrate today.

## See also

- `02-partial-failure-timeouts-and-retries.md` — what poison rows look like.
- `03-idempotency-deduplication-and-delivery-semantics.md` — why we can re-push safely.
- `../study-system-design/02-debounced-batched-sync.md` — the in-process queue pattern.
