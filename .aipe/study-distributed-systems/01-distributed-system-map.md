# The buffr coordination map — two boundaries, no peer-to-peer
## Industry name(s): system map, failure-domain map · Type: Foundational

> Buffr coordinates across exactly two boundaries — device↔LLM provider (stateless HTTP) and device↔Supabase (stateful sync). No peer-to-peer. No quorum. No leadership. The map is small by design.

## Zoom out, then zoom in

```
  LAYERS — every coordination edge

   device
     │
     ├─► LLM provider  (HTTP, stateless, per-call)
     │     ─ retry possible
     │     ─ failover Anthropic → OpenAI for some chains
     │
     └─► Supabase      (HTTP via PostgREST, stateful, batched)
           ─ sync engine queues and retries
           ─ cursor-pull resumability
           ─ LWW conflict on multi-device writes

   NO device-to-device.
   NO quorum reads.
   NO consensus.
```

Zoom in: the absence of peer-to-peer is structural. Two buffr devices belonging to the same user *do* coordinate, but only transitively through Supabase. Neither device knows the other exists at the protocol layer; they just both sync to the same cloud.

## Structure pass

```
  layers   ─ in-app modules ─ network boundaries ─ external systems
  axes     ─ statefulness   (stateless HTTP vs stateful sync)
             ─ failure mode  (retry vs failover vs queue)
  seams    ─ device ←→ LLM      : prompt + response
             ─ device ←→ Supabase: batch upsert + cursor pull
```

## How it works

### Move 1 — failure domains are independent

```
  LLM provider down  → AI features degrade; sync unaffected.
  Supabase down      → sync queues; AI features unaffected.
  device offline     → both queue; UI works from SQLite.
```

### Move 2 — no in-app coordination layer

```
  buffr has no:
   ─ message queue (no Redis/Kafka/SQS)
   ─ pubsub bus
   ─ scheduler (cron jobs)
   ─ workers
  
  the orchestrator runs in the app process. one event loop.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ small coordination surface is a feature.          │
   │ every boundary added is a new partial-failure mode│
   │ that has to be handled. buffr's two-boundary map  │
   │ is the smallest correct shape for the use case.   │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   buffr's coordination

         ┌────────────────────────────┐
         │  device                     │
         │   ┌─────────────────────┐   │
         │   │  app process        │   │
         │   │   ─ UI               │   │
         │   │   ─ service layer    │   │
         │   │   ─ SQLite           │   │
         │   └─────────────────────┘   │
         └──────┬────────────────┬─────┘
                │                │
                ▼                ▼
         ┌──────────┐    ┌──────────────┐
         │ LLM API  │    │   Supabase   │
         │  (HTTPS) │    │  (HTTPS)     │
         └──────────┘    └──────────────┘
                              │
                              ▼
                         ┌──────────┐
                         │ Postgres │ (single primary, managed)
                         └──────────┘
```

## Implementation in codebase

No distributed systems module exists. The "distributed" aspect is the sync engine plus the LLM client. See:

- `src/services/sync/orchestrator.ts` — the Supabase boundary.
- `src/services/ai/*` — the LLM boundary.
- `src/services/supabase/client.ts` — the PostgREST client config.

There is no `src/services/distributed/` because there is nothing to put there.

## Elaborate

The "smallest correct coordination surface" pattern is the right framing for an app at buffr's scale. Many distributed systems courses focus on Raft, Paxos, sharding strategies — none of which buffr needs. The day buffr needs one of them, the architecture will have to change shape; until then, the cost of not having them is zero.

The two patterns that *are* present (stateless HTTP retry, stateful at-least-once sync) cover ~80% of distributed systems concerns for an app of this shape. Concepts 02–04 walk those.

## Interview defense

**Q [mid]:** Is buffr a distributed system?

**A:** At the protocol level, yes — there are network boundaries with partial failure. At the architectural level, no — there's no in-app coordination, no quorum, no consensus. Two boundaries: stateless to LLM providers, stateful to Supabase. Everything else is local-process.

**Q [senior]:** What would force you to add coordination primitives?

**A:** Real-time multi-device sync (need server-push channels). Or background workers offloading LLM work from the device (need a queue). Or a per-user rate-limited API surface (need a shared rate-limiter). None of these are on the spec today.

## Validate

### Level 1 — draw the coordination map.

### Level 2 — name the failure domains and which feature breaks when each goes down.

### Level 3 — apply: a new feature pushes vlog blobs to Supabase Storage. New coordination boundary? Yes — same shape as Postgres sync (HTTP, retryable, idempotent by content hash).

### Level 4 — defend: "Buffr should use a proper job queue for sync." Cost: more infra, more failure modes. Benefit: only meaningful if sync work exceeds what the device can do inline.

## See also

- `02-partial-failure-timeouts-and-retries.md` — what each boundary does on failure.
- `04-consistency-models-and-staleness.md` — what consistency buffr provides.
- `../study-system-design/audit.md` — the architectural shape this map sits inside.
