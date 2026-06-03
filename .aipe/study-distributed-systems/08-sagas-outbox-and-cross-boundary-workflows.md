# Sagas, outbox, and cross-boundary workflows — buffr's prose-commit walk
## Industry name(s): saga, transactional outbox, compensating transaction · Type: Foundational

> Buffr's prose-commit is a multi-step workflow: LLM extraction → reconcile → sync. Each step crosses a boundary or commits a transaction. If a step fails, the system doesn't compensate — it just leaves the state where it was and lets the next prose-commit re-derive it.

## Zoom out, then zoom in

```
  THE PROSE-COMMIT WORKFLOW

  step 1: compose.ts → LLM calls → cache
   ─ if fails: no derived output; user re-triggers later
   ─ idempotent: same input → same output (cached)

  step 2: reconcileMeta.ts → local SQLite txn (multi-table)
   ─ all-or-nothing inside the txn
   ─ if fails: state unchanged from before; safe

  step 3: sync engine → cloud
   ─ debounced; runs later
   ─ at-least-once + idempotent
```

Zoom in: there's no cross-step compensation. The prose is the source of truth (`study-system-design/04-prompt-driven-prose-commit.md`), so any failure leaves the prose intact, and re-running compose+reconcile from the prose reproduces the meta state.

## Structure pass

```
  layers   ─ compose (LLM boundary) ─ reconcile (txn boundary) ─ sync (network boundary)
  axes     ─ atomicity per step
             ─ idempotency end-to-end
  seams    ─ compose ←→ reconcile : in-memory handoff
             ─ reconcile ←→ sync  : SQLite as durable handoff
```

## How it works

### Move 1 — buffr has no saga

```
  a saga has: forward steps + compensating actions.
  buffr has:  forward steps + "re-derive from prose if anything fails."
  
  this is cheaper and correct for buffr's domain.
```

### Move 2 — no outbox either

```
  the outbox pattern: write the row + write an event to be sent later,
  in the same txn. on commit, a separate worker reads the event and
  ships it.
  
  buffr's "dirty filter" is a degenerate outbox — every row that has
  updated_at > synced_at is implicitly an event-to-be-sent. the dirty
  filter substitutes for the outbox table.
```

### Move 3 — the principle: prose-as-source-of-truth makes compensation unnecessary

```
   ┌──────────────────────────────────────────────────┐
   │ when one step is THE source of truth for         │
   │ everything downstream, failure of a later step   │
   │ doesn't require compensation. just re-derive.    │
   │ buffr's prose-commit is shaped this way.         │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// pattern; src/services/prose/commitProse.ts
export async function commitProseForEntry(entry: Entry, userId: string) {
  const composed = await composeProseCommit(entry);   // step 1
  await reconcileMeta(entry, composed, userId);       // step 2
  scheduleSync();                                      // step 3 (async)
}
```

Each step is awaited; a failure in step 1 prevents step 2; a failure in step 2 leaves SQLite as it was before the txn. The user sees their prose; the meta tables may be one prose-commit behind. Re-triggering fixes it.

## Elaborate

The "no saga" choice is correct when one step owns truth and downstream is derived. Sagas pay their cost when multiple services own pieces of the same business invariant — booking a flight + reserving a hotel + charging a card. Buffr has no such invariant.

The "no outbox" choice has a small structural weakness: if the local commit succeeds and the device dies before the sync schedule fires, the row sits dirty until the next app launch. Acceptable; buffr's data isn't time-sensitive.

## Interview defense

**Q [mid]:** What's a saga and do you have one?

**A:** A saga is a multi-step workflow with compensating actions on failure. Buffr doesn't have one — the prose is the source of truth, and failed downstream steps are recovered by re-deriving from prose. Cheaper than sagas; correct for the domain.

**Q [senior]:** What about the outbox pattern?

**A:** The dirty filter (`WHERE updated_at > synced_at`) is a degenerate outbox. It's correct because the application's writes are stamps on the same table. A "real" outbox would matter if buffr emitted events to a Kafka topic or similar — it doesn't.

## Validate

### Level 1 — define a saga.

### Level 2 — explain why buffr doesn't need one.

### Level 3 — apply: a feature wants "sync notification" on a webhook. Saga or outbox? Outbox is right — the SQLite row + webhook-pending event in one local txn.

### Level 4 — defend: "Outbox is over-engineering." Mostly true for buffr's webhook example today; would be wrong at scale.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the substrate.
- `../study-system-design/04-prompt-driven-prose-commit.md` — the workflow's shape.
- `../study-database-systems/05-transactions-isolation-and-anomalies.md` — the txn boundary.
