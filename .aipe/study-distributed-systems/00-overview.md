# Distributed systems in buffr — coordination across two boundaries

buffr's coordination surface is small but real. Two boundaries cross "the device": the **device ↔ LLM provider** boundary (Anthropic / OpenAI; HTTP; stateless), and the **device ↔ Supabase** boundary (PostgREST; stateful; the sync engine's home turf). Most of distributed-systems theory either applies trivially or doesn't apply at all because there's no peer-to-peer coordination here.

## The coordination map

```
  ┌─────────────────────────────────────────────────────────┐
  │                       buffr                              │
  │                                                          │
  │  ┌──────────────┐    ┌──────────────┐    ┌────────────┐ │
  │  │ device       │    │ device       │    │ device     │ │
  │  │ (today's     │    │ (tomorrow's  │    │ (next      │ │
  │  │  primary)    │    │  hypothetical│    │  device)   │ │
  │  └──────┬───────┘    └──────┬───────┘    └─────┬──────┘ │
  │         │                   │                  │         │
  │         │  (no peer-to-peer between devices)   │         │
  │         │                                      │         │
  └─────────│──────────────────────────────────────│─────────┘
            │                                      │
            │     all coordination is star-shaped  │
            │                                      │
            ▼                                      ▼
       ┌────────────┐                      ┌────────────┐
       │ Supabase   │                      │ LLM        │
       │ Postgres   │                      │ providers  │
       │ (single    │                      │ (Anthropic │
       │  region)   │                      │  + OpenAI) │
       └────────────┘                      └────────────┘
```

Two coordination patterns:

1. **Device ↔ Supabase** is stateful: cursor-pull replication. Eventually consistent. LWW conflict on multi-device writes.
2. **Device ↔ LLM provider** is stateless: request/response. Retry on transient failure. Provider abstraction lets the primary fail over to the fallback.

## Findings (ranked)

| Rank | Finding | Concept | Severity |
|---|---|---|---|
| 1 | Sync retry semantics are at-least-once; idempotency by composite-PK upsert (correct) | 03-idempotency | PRAISE |
| 2 | LWW conflict resolution is deterministic with local-wins tiebreak | 04-consistency-models | PRAISE |
| 3 | Server-time RPC for `synced_at` avoids device-clock skew | 07-clocks-coordination | PRAISE |
| 4 | No outbox table; if cloud sync succeeds but local stamp fails, sync re-pushes (idempotency saves it) | 08-sagas-outbox | LOW |
| 5 | No DLQ for poison-row sync failures (a row that fails every push) | 06-queues-backpressure | MED |
| 6 | LLM provider failover requires manual selection (no automatic circuit-breaker today) | 02-partial-failure | MED |
| 7 | Sync runs at-least-once but partial batch failures aren't surfaced (silent-error guard) | 02-partial-failure + cross-link debug-obs/01 | HIGH |
| 8 | No quorum, no leadership, no consensus needed (single primary Supabase) | 05-replication-partitioning, 07-leadership | N/A |

## Reading order

`01` (the map) → `02` (the partial-failure floor) → `03` (the idempotency contract sync depends on) → `04` (consistency model) → `05` (replication shape) → `06` (queues; thin for buffr) → `07` (clocks) → `08` (the multi-step workflow — buffr's prose-commit) → `09` (the audit).

## Not yet exercised

- **Quorums** — buffr never reads from multiple replicas; never needs majority.
- **Leadership** — no in-app coordination; Supabase manages primary internally.
- **Sagas with compensation** — the prose-commit is multi-step but in one local SQLite txn; no cross-service rollback.
- **Streams / pubsub** — no Supabase Realtime; no Kafka; no in-app event bus.
- **Distributed locks** — no need; single-user single-device serialization is per-process.

## Cross-guide seams

- **`study-system-design`** — the coordination shape (canonical-local + cloud-mirror).
- **`study-database-systems`** — local consistency mechanisms (MVCC, isolation, durability).
- **`study-debugging-observability`** — silent-error guard hides partial-batch failures.
- **`study-runtime-systems`** — how retries / debounce schedule inside the JS event loop.
