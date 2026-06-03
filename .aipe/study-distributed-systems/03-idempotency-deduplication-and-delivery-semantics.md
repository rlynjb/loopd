# Idempotency, deduplication, and delivery semantics — why buffr's at-least-once is safe
## Industry name(s): idempotency, at-least-once, exactly-once illusion · Type: Foundational

> Buffr's sync push is at-least-once. The upsert pattern with composite PK makes every push idempotent — re-pushing the same row produces the same end state. Effective exactly-once behavior emerges from at-least-once + idempotency.

## Zoom out, then zoom in

```
  DELIVERY GUARANTEES

  at-most-once:    each message tried 0 or 1 times. data loss on failure.
  at-least-once:   each message tried ≥1 times. duplicates possible.
  exactly-once:    impossible in pure distributed systems.
                   approximated by at-least-once + idempotency.

  buffr:           at-least-once delivery + idempotent application
                   = effective exactly-once.
```

Zoom in: every sync tick re-considers every dirty row. A row pushed successfully but with `synced_at` not yet stamped (device died between the two) is re-pushed next tick. PostgREST's `ON CONFLICT (user_id, id) DO UPDATE` makes the second push a no-op (or LWW-resolved update if updated_at changed).

## Structure pass

```
  layers   ─ tick ─ dirty filter ─ batch ─ upsert ─ stamp synced_at
  axes     ─ delivery (best-effort vs guaranteed)
             ─ idempotency (safe to re-do vs not)
  seams    ─ batch ←→ upsert : the idempotency boundary
             ─ upsert ←→ stamp : crash here = re-push (safe)
```

## How it works

### Move 1 — composite PK + upsert = idempotent application

```
  INSERT INTO entries (user_id, id, text, updated_at, ...)
    VALUES (...)
  ON CONFLICT (user_id, id) DO UPDATE
    SET text = EXCLUDED.text, updated_at = EXCLUDED.updated_at, ...
    WHERE entries.updated_at < EXCLUDED.updated_at;   ← LWW guard
```

The `WHERE` clause is the LWW guard — if a newer version is already in cloud (somehow), the upsert is a no-op.

### Move 2 — buffr's idempotency keys are stable

```
  every row has a stable id.
  every row has stable user_id.
  composite (user_id, id) is the dedup key.
  no need for client-generated idempotency-key headers.
```

### Move 3 — the principle: at-least-once + idempotency = effective exactly-once

```
   ┌──────────────────────────────────────────────────┐
   │ true exactly-once is impossible across an        │
   │ unreliable network. effective exactly-once is    │
   │ what every well-designed system aims for. buffr's│
   │ choice — at-least-once delivery + idempotent     │
   │ upsert — is the standard pattern.                │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// pattern; src/services/sync/push.ts
await supabase.from(table).upsert(rows, {
  onConflict: 'user_id,id',
  ignoreDuplicates: false,  // LWW via updated_at on conflict
});
```

The `onConflict` clause is the idempotency contract. Without it, duplicate inserts would either fail with unique-violation or silently succeed depending on the SDK.

## Elaborate

The "idempotency by stable PK" pattern works because buffr's rows have natural stable identity — the user creates a row once, edits it many times. The id is generated client-side (UUID or monotonic int) and stays constant through the row's lifetime.

Alternative: idempotency-key headers (Stripe-style). Useful when the operation has no natural stable id (e.g., "charge $X to card Y"). Not needed for buffr's row-based shape.

## Interview defense

**Q [mid]:** What delivery guarantee does the sync engine provide?

**A:** At-least-once. The orchestrator re-considers every dirty row on each tick; if a push succeeded but the `synced_at` stamp didn't land, the row is re-pushed next tick. The upsert with composite PK + LWW guard makes the re-push a no-op or a LWW-resolved update.

**Q [senior]:** Why doesn't at-least-once cause double-counting?

**A:** Because the application is idempotent. Buffr's writes are upserts, not increments. There's no "+=1" operation that would compound on retry. If buffr ever added a counter, it would need a different idempotency mechanism (e.g., an event-id-set the counter checks before applying).

## Validate

### Level 1 — define at-least-once.

### Level 2 — explain why upsert with composite PK is idempotent.

### Level 3 — apply: design a counter feature ("how many entries this month"). Naive `UPDATE ... SET count = count + 1` is unsafe; need an event-set or server-side aggregate.

### Level 4 — defend: "Stop saying 'effective exactly-once' — that's not a thing." It is, in colloquial usage. The point is that the user sees no duplicates and no data loss.

## See also

- `02-partial-failure-timeouts-and-retries.md` — why at-least-once is needed.
- `04-consistency-models-and-staleness.md` — what LWW does on actual conflict.
- `../study-database-systems/06-locks-mvcc-and-concurrency-control.md` — Postgres's role.
