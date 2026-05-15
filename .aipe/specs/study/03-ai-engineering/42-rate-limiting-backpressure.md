# Rate limiting and backpressure

**Industry name(s):** Rate limiting, backpressure, throttling, queue + concurrency cap
**Type:** Industry standard

> When a chain wants to fire 50 calls at once and the provider's limit is 10/sec — what stands between them.

**See also:** → [43-retry-circuit-breaker](./43-retry-circuit-breaker.md) · → [11-failure-modes](./11-failure-modes.md) · → [09-async-classification](./09-async-classification.md)

---

## Why care

Make a fast burst of requests to the GitHub API and the response headers tell you exactly what's happening: `X-RateLimit-Remaining: 4` then `3` then `2`, and the moment it hits 0 the next call returns 429 with `Retry-After: 47`. Stripe ships `X-Stripe-Rate-Limit-Remaining` headers for the same reason. AWS API Gateway exposes throttling as a configurable limit per route. None of these services trust their clients to be polite — they expose limits explicitly and well-behaved SDKs (Octokit, the GitHub CLI, the Stripe SDK) read the headers and queue work to stay under the cap. The client's queue is the rate limiter the developer actually controls; the provider's hard limit is the one the developer is trying to never hit.

The implicit question is "what stands between the burst of work and the slow external service that can't absorb it?" Rate limiting and backpressure are the pair: the provider sets external limits (RPM, TPM — 429 when exceeded, sometimes with a `Retry-After` header), and your code's queue is the internal mechanism that respects them. The queue is the rate limiter you actually control; size it conservatively and you never trigger the provider's. Three flavours: concurrency cap (never more than N in-flight, cheapest), token bucket (earn tokens at rate R, spend per call), adaptive backoff (slow down on 429s, speed up otherwise).

**What depends on getting this right:** burst tolerance during sync-pull / batch-expand / multi-entry operations, whether 429 storms reach users as visible failures, and whether per-chain caps aggregate correctly against the provider's global ceiling. For loopd the partial pattern lives in `src/services/ai/expand.ts:25` as `MAX_CONCURRENT = 3` — per-call-site backpressure that works for expand alone but doesn't coordinate with other chains. `[B5.1]` lifts the pattern into a centralized `src/services/ai/queue.ts` with per-chain caps (classify=6, summarize=1, caption=1, expand=3, interpret=1) plus an optional global per-provider budget. Every chain migrates from direct provider calls to `aiQueue.enqueue(chainName, callFn, options)`; queue depth is visible in the planned AI ops panel.

Without centralized backpressure:
- Sync-pull brings 50 entries → 50 `scheduleClassify` async calls fire simultaneously
- Provider: 10 succeed, 40 return 429; retry logic re-fires all 40; burst-protection blocks the retries too
- User experience: "first launch is broken"
- Cross-chain interference: expand's `MAX_CONCURRENT=3` holds, but classify fans out unrestricted; total concurrent calls = 3 + N can exceed Anthropic's per-account limit even when each chain individually is under cap

With centralized queue + concurrency caps:
- 50 entries → 50 instant enqueues; queue drains at cap of 6 concurrent classify calls
- 50 succeed over ~10 seconds; the provider never sees a burst it can't absorb
- User experience: "indexing in background; results appear over 10s"
- `Retry-After` header respected on the rare 429 that still occurs; queue depth observable per chain
- Cost paid: ~100 LOC for the shared module, plus one-line migration in each chain — versus scattered per-chain conventions that don't aggregate

The queue is the rate limiter you actually control — size it conservatively and the provider's never trips.

---

## How it works

Two facts shape the design: providers have rate limits, and your code can produce work faster than the limits allow during bursts.

The two paths a burst can take, with and without backpressure:

```
   trigger: sync-pull brings 50 entries down from cloud;
   each one fires scheduleClassify async
                       │
              ┌────────┴────────┐
              ▼                 ▼
   WITHOUT backpressure         WITH centralized queue (cap=6)
   ┌──────────────────────┐    ┌──────────────────────────────────┐
   │ 50 calls fire        │    │ 50 enqueue() calls fire instantly  │
   │ simultaneously       │    │                                    │
   │     │                 │    │ queue holds 50; runs 6 in-flight   │
   │     ▼                 │    │                                    │
   │ provider receives 50  │    │ provider receives 6 at a time      │
   │ in 100ms             │    │ at sustained 6-concurrent rate     │
   │     │                 │    │                                    │
   │     ▼                 │    │ no 429s, no retries needed         │
   │ rate-limit kicks in   │    │ all 50 complete in ~10s             │
   │ 10 succeed            │    │                                    │
   │ 40 return 429         │    │ user sees "indexing in background" │
   │     │                 │    │ → results appear over 10s          │
   │     ▼                 │    │                                    │
   │ retry logic fires     │    └──────────────────────────────────┘
   │ all 40 → still 429
   │     │
   │     ▼
   │ exponential backoff
   │     ▼
   │ ~30s of failures
   │ before recovery
   │
   │ user sees: "first
   │ launch is broken"
   └──────────────────────┘

   the queue moves the friction from the provider's hard limit
   (where 429s = user-visible failures) to the app's soft limit
   (where queue depth = "indexing in background").
```

The six sub-sections below trace the provider's exposed limits, the backpressure pattern, loopd's existing per-chain MAX_CONCURRENT, the centralized-queue shape, the three flavours of backpressure, and where it goes wrong.

### The provider's view

Most providers expose two limits:

- **Requests per minute (RPM)** — typically 100s to 1000s for paid tiers.
- **Tokens per minute (TPM)** — typically 100k to millions; the harder ceiling.

Exceed either and the provider returns 429 (Too Many Requests). Some providers (Anthropic) include a `retry-after` header; others (some OpenAI tiers) just say "wait."

For loopd at solo scale, the provider's limits are far above current usage — but burst patterns (sync-pull, multi-entry expand, batch eval runs) can hit them.

### Your code's view — backpressure

Backpressure is a queue-with-concurrency-cap. You don't ask the provider "can I call?" — you cap your own concurrency to a value comfortably below the provider's limit, and queue up excess work.

If you're coming from frontend, this is the same shape as React's `Suspense` boundary plus a request-batching layer — you don't fire 100 requests on a single render; you let the layer flatten and rate-shape them.

### loopd's existing pattern

loopd already has `MAX_CONCURRENT = 3` in `expand.ts`. This is backpressure at a per-call-site level — when expand processes multiple todos, no more than 3 hit the provider simultaneously. The pattern is correct; it just isn't centralized. The plan in `[B5.1]` is to lift this into a shared queue that every chain uses.

### The shape of a centralized queue

```
Centralized AI call queue (target — [B5.1])

  ┌─ Producer side ─────────────────────────────────────┐
  │  classify() │ summarize() │ caption() │ expand()    │
  │  Each calls aiQueue.enqueue(chainName, callFn)      │
  └─────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ Queue layer ───────────────────────────────────────┐
  │  Per-chain concurrency cap                           │
  │  ┌────────────┬────────────┬────────────┬────────┐  │
  │  │ classify:6 │ summarize:1│ caption:1  │ expand:3│ │
  │  └────────────┴────────────┴────────────┴────────┘  │
  │                                                      │
  │  Global rate budget: ≤50 calls / minute              │
  │  Token budget:       ≤30k tokens / minute            │
  └─────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ Provider call ─────────────────────────────────────┐
  │  client.messages.create({...})                       │
  └─────────────────────────────────────────────────────┘
```

### Three kinds of backpressure

1. **Concurrency cap** — never more than N in-flight. Cheap, deterministic. loopd's existing `MAX_CONCURRENT=3`.
2. **Token bucket** — earn tokens at rate R; spend one per call; block when bucket empty. Smooths bursts.
3. **Adaptive backoff** — slow down when 429s appear; speed up when they don't. Self-tuning.

For loopd, concurrency cap is sufficient. Token bucket would matter at higher scale; adaptive backoff matters most when you don't know the provider's limit in advance.

The three flavours compared:

```
   flavour               implementation               best when
   ────────────────      ──────────────────────       ────────────────────────
   concurrency cap        let inFlight = 0;            you know the provider's
                          if (inFlight >= MAX) {        limit and your bursts
                            queue.push(fn);             aren't massive
                          } else {
                            inFlight++;
                            run(fn).finally(
                              () => inFlight--
                            );
                          }
                          
   token bucket           let tokens = MAX_TOKENS;     bursts are spiky AND
                          setInterval(() => {           you have a known RPM
                            tokens = Math.min(           limit per minute
                              tokens + REFILL_RATE,
                              MAX_TOKENS
                            );
                          }, 1000);
                          // before each call:
                          if (tokens > 0) {
                            tokens--;
                            run(fn);
                          } else {
                            queue.push(fn);
                          }
                          
   adaptive backoff       let backoff = 0;             you don't know the
                          on 429 response:              provider's limit OR
                            backoff = Math.min(         the limit changes
                              backoff * 2 + 1, MAX);     (multi-tenant cloud)
                            sleep(backoff);
                            retry();
                          on success:
                            backoff = max(0, backoff/2);
                          
   loopd today: concurrency cap (MAX_CONCURRENT=3) only.
   [B5.1] centralises it; token bucket + adaptive backoff are
   future additions if scale or unknown limits force them.
```

Concurrency cap is the cheapest pattern that actually works at solo scale; the other two are upgrades for when scale or uncertainty demands them.

### Where it goes wrong

- **No backpressure at all** — every chain fires whenever it wants; bursts hit 429s. Symptoms: user-visible failures during sync-pull or multi-entry operations.
- **Wrong granularity** — backpressure per chain, not per provider. Two chains both at 3-concurrent on the same provider = 6-concurrent total, still triggering 429.
- **Backpressure but no retries** — the queue smooths the rate but provider hiccups still fail individual calls. See [43-retry-circuit-breaker](./43-retry-circuit-breaker.md).

### This is what people mean by "the queue is the rate limiter you control"

You can't talk to the provider's rate limiter except by getting 429s. Your queue is the rate limiter you actually control. Sizing it conservatively means you never trigger the provider's. Here's the picture of the design.

---

## Rate limiting and backpressure — diagram

```
Sync-pull stress test (50 entries arriving at once)

  Without backpressure
  ────────────────────
  50 entries → 50 classify calls fire simultaneously
              ↓
  Provider:  10 succeed; 40 get 429
              ↓
  Retry storm: 40 retries → 30 of those also 429
              ↓
  User experience: "first launch is broken"

  With centralized queue + concurrency cap (target)
  ─────────────────────────────────────────────────
  50 entries → 50 enqueues (instant)
              ↓
  Queue layer: drains at cap of 6 concurrent classify calls
              ↓
  Provider:  50 succeed over ~10 seconds
              ↓
  User experience: "indexing in background; results appear over 10s"
```

---

## In this codebase

**Status:** Case B — partial. loopd has `MAX_CONCURRENT=3` in `expand.ts` (per-call-site backpressure). No centralized queue, no per-provider budget, no token-bucket.

The plan: `[B5.1]` lifts the pattern into a shared `src/services/ai/queue.ts` that every chain uses, with per-chain caps and a global per-provider budget.

**File:** *(partial — `src/services/ai/expand.ts:25` has `MAX_CONCURRENT = 3`)*
**Function / class:** *(centralized version: `aiQueue.enqueue()` in `src/services/ai/queue.ts` — target, not yet created)*
**Line range:** *(expand.ts L25 for the existing per-chain version)*

---

## Elaborate

### Where this pattern comes from
Rate limiting + backpressure is one of the most-cited patterns in production engineering — from web servers (nginx rate-limit module), to async runtimes (Tokio's semaphores), to messaging systems (Kafka backpressure, RabbitMQ flow control). The LLM-specific version is just the same pattern, applied to a specific kind of expensive external call.

### The deeper principle
You can't optimize what you can't bound. A system with no rate ceiling is at the mercy of its busiest moment; a system with a queued ceiling has a predictable max throughput and graceful queuing behavior beyond it.

### Where this breaks down
A queue isn't free — it adds latency for queued calls. At very low volume (no burstiness), a queue does nothing useful. At very high volume, the queue grows unboundedly and you need backpressure all the way up to user-facing surfaces ("you've hit the limit, try later"). The middle range — bursty but bounded — is where queues shine.

### What to explore next
- [43-retry-circuit-breaker](./43-retry-circuit-breaker.md) → the retry layer that pairs with backpressure
- [11-failure-modes](./11-failure-modes.md) → how rate-limit errors fit into the broader failure taxonomy
- loopd's existing `expand.ts` `MAX_CONCURRENT=3` — the partial-shape inspiration

---

## Tradeoffs

### Comparison table — backpressure strategies

```
┌──────────────────────┬─────────────────────┬────────────────────────┬───────────────────────┐
│ Cost dimension       │ Centralized queue   │ Per-chain only         │ No backpressure       │
│                      │ (target)            │ (today, partial)       │ (worst)               │
├──────────────────────┼─────────────────────┼────────────────────────┼───────────────────────┤
│ Burst tolerance      │ High                │ Medium                  │ None                  │
│ Cross-chain budget   │ Yes (per provider)  │ No (siloed)            │ N/A                   │
│ Implementation effort│ ~100 LOC            │ ~10 LOC per chain      │ 0                     │
│ Observability        │ Single queue depth  │ N counters             │ N/A                   │
│ 429 rate (typical)   │ ~0                  │ Low                    │ Burst-driven          │
│ Right at solo scale  │ Yes (best practice) │ Sufficient for now     │ Insufficient at burst │
└──────────────────────┴─────────────────────┴────────────────────────┴───────────────────────┘
```

### Sub-block 1 — what centralized queue gives up

One shared module to maintain instead of per-chain caps. ~100 LOC vs scattered per-chain conventions. Coordination overhead — if two chains hammer the queue from different threads, you need locking or message-passing.

### Sub-block 2 — what per-chain-only would cost

Cross-chain interference. Today expand caps at 3 concurrent; if classify and expand fire concurrently with a burst, total concurrent provider calls = 3 (expand) + N (classify), and N is uncapped. At burst-time this can exceed provider limits.

### Sub-block 3 — the breakpoint
Per-chain backpressure is sufficient as long as (a) burst-time totals across chains stay below provider limits, AND (b) chains don't coordinate (no "expand 50 entries fanout" pattern). Both hold for loopd today. Centralized queue is the right shape but isn't urgent.

### What wasn't actually a tradeoff
"No backpressure" was never an option. loopd shipped `MAX_CONCURRENT=3` early in expand because the alternative was visible failures.

---

## Tech reference (industry pairing)

### Custom in-app queue

- **Codebase uses:** target plan; partial existing pattern in `expand.ts`.
- **Why it's here:** loopd's stack has no external job queue (no Redis, no managed broker); in-app is the right shape.
- **Leading today:** in-app async queue with concurrency cap — `adoption-leading` for client-side rate management, 2026.
- **Why it leads:** zero new infrastructure; debuggable in the same logs as the chain code.
- **Runner-up:** managed queue (BullMQ + Redis) — `innovation-leading` at multi-user backend scale; overkill for solo loopd.

### Anthropic / OpenAI rate-limit headers

- **Codebase uses:** target consumer (read `retry-after` header on 429s).
- **Why it's here:** providers expose retry hints in headers; respecting them is cheap.
- **Leading today:** `Retry-After` header on 429 — `adoption-leading`, 2026.
- **Why it leads:** standard pattern; works without complex client-side logic.

---

## Project exercises

### [B5.1] Request queue with retry/backoff for all chains + RAG retrievals

- **Exercise ID:** `[B5.1]` (this is the rate-limiting half; retry half lives in [43-retry-circuit-breaker](./43-retry-circuit-breaker.md))
- **What to build:** A centralized `src/services/ai/queue.ts` with `aiQueue.enqueue(chainName, callFn, options)`. Per-chain concurrency caps (configurable; defaults: classify=6, summarize=1, caption=1, expand=3, interpret=1). Optional global per-provider budget (cap total in-flight across chains). Every chain in `src/services/ai/*.ts` migrates its direct provider calls to `aiQueue.enqueue()`.
- **Why it earns its place:** the load-bearing layer that turns "bursts work" from luck to design.
- **Files to touch:** new `src/services/ai/queue.ts`; edit each chain to enqueue rather than call directly.
- **Done when:** every chain goes through the queue; a forced 50-entry burst (via dev tools) drains over time without 429s; per-chain queue depth is visible in the AI ops panel.
- **Estimated effort:** `1–2 days`.

---

## Summary

Rate limiting and backpressure are the pair of patterns that bound how fast loopd talks to LLM providers. The provider sets external limits (RPM, TPM); loopd's queue is the internal mechanism that respects them. In loopd this is partially implemented — `expand.ts` has per-call-site backpressure via `MAX_CONCURRENT=3`, but there's no centralized queue. `[B5.1]` lifts the pattern into a shared module. The constraint that makes centralized queueing the right call is that bursts across chains (sync-pull, multi-entry expand, batch eval) can exceed provider limits even when each chain individually is under cap. The cost being paid until `[B5.1]` ships is fragile burst handling.

Key points to remember:
- Backpressure = your queue; rate limit = provider's ceiling.
- Concurrency cap is the cheapest backpressure that works.
- Per-chain caps don't add up correctly — centralized is better.
- Respect `Retry-After` headers when provided.
- The queue you control beats the rate limiter you don't.

---

## Interview defense

### What an interviewer is really asking
"How do you handle rate limits?" tests whether the candidate has backpressure designed in or only retries. The deeper question is whether they distinguish external limits from internal queues.

### Likely questions

  [mid] Q: What's the difference between rate limiting and backpressure?
  A: Rate limiting is the *external* ceiling — the provider's RPM and TPM limits. Backpressure is the *internal* mechanism — your code respecting that ceiling by queueing work instead of firing it all at once. The queue is the rate limiter you actually control; sizing it conservatively means you never trigger the provider's. loopd has per-call-site backpressure today (`MAX_CONCURRENT=3` in expand) and plans `[B5.1]` to centralize it.
  Diagram:
  ```
  Your code → queue (backpressure) → provider (rate limit)
              ↑ you control          ↑ they control
  ```

  [senior] Q: Why centralize the queue if per-chain backpressure already exists?
  A: Cross-chain interference. Today expand caps at 3 concurrent; classify caps at N (uncapped). When sync-pull brings 50 entries at once, expand stays at 3 in-flight but classify fans out unrestricted — total concurrent calls to Anthropic can exceed the provider limit. Centralized queue with both per-chain caps AND a global per-provider budget closes the gap. The interview signal is recognising that backpressure must be coordinated across chains, not just within each.
  Diagram:
  ```
  Picked: centralized queue              Suggested: per-chain only
  ──────────────────────────             ──────────────────────────
  Per-chain caps + global budget         Per-chain caps only
  Aggregate ≤ provider limit             Aggregate can exceed
  ~100 LOC                                Scattered per-chain
  Right at burst-tolerant design         Right when bursts don't happen
  ```

  [arch] Q: At 100× users, what changes?
  A: Three shifts. First, in-app queues stop being sufficient — at backend scale you need a real job queue (BullMQ, Sidekiq, etc.) with persistence so work survives restarts. Second, per-user quotas appear — one user can't monopolize the global budget. Third, token-bucket smoothing replaces concurrency-only caps to handle sustained high rate vs bursty patterns differently.
  Diagram:
  ```
  Today (solo)         →  In-app queue + per-chain caps
  10× users            →  + global per-provider budget
  100× users           →  + per-user quotas + persistent queue (Redis)
  1000× users          →  + token-bucket smoothing + tiered quotas
  ```

### The question candidates always dodge
"Why concurrency cap instead of true rate-per-second limiting?" The honest answer: concurrency caps are dead-simple to implement (a counter and a wait), while true rate-per-second limiting requires a timer-based token-bucket implementation. For loopd's scale, concurrency caps deliver 95% of the value at 20% of the code. The right answer is "we're choosing simpler-and-good-enough; we'd add token-bucket when concurrency-only fails."

```
Picked: concurrency cap (target)       Suggested: token-bucket
─────────────────────────────           ──────────────────────
~50 LOC                                  ~150 LOC
"≤ N in-flight"                          "≤ R per second over T window"
Right for bursts                         Right for sustained high rate
```

### One-line anchors
- The queue is the rate limiter you control.
- Concurrency cap < token bucket < adaptive — pick by need.
- Per-chain caps don't aggregate correctly.
- Respect `Retry-After` when provided.
- Bursts are the failure case; bound throughput beats unbounded.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the sync-pull burst flow — without backpressure (failures) and with centralized queue (smooth drain).

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the difference between rate limiting and backpressure, (b) why per-chain caps don't aggregate correctly, (c) loopd's `MAX_CONCURRENT=3` as the partial existing pattern, (d) what `[B5.1]` adds.

### Level 3 — Apply it to a new scenario
A future loopd feature: batch-expand 30 todos for a "weekly review." Without looking, design the call pattern — sequential? Parallel? With what cap? Why?

Open the diagram and check whether your design uses centralized queue.

### Level 4 — Defend the decision you'd change
Today the plan is in-app queue. If you were starting today at 100× scale, would you use Redis-backed BullMQ from day 1? Defend your answer.

### Quick check — code reference test
- What file holds the existing `MAX_CONCURRENT` cap?
- What's the target centralized queue location?

Answer: `src/services/ai/expand.ts:25`. `src/services/ai/queue.ts` (target — `[B5.1]`, not yet created).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (coffee-shop-rope-line-and-espresso-machine scenario → "what stands between the burst of work and the slow external service" pattern naming → bolded "what depends on getting this right" with `expand.ts:25` / `MAX_CONCURRENT=3` / `aiQueue.enqueue()` / `[B5.1]` stakes → without/with bullets walking the 50-entry sync-pull burst → one-line "queue is the rate limiter you actually control" metaphor).

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care to anchor on real software (replaced coffee-shop-rope-line analogy with npm install rate-limits, GitHub X-RateLimit-Remaining header, Stripe API throttling, AWS API Gateway throttling).

---
Updated: 2026-05-14 — v1.32.0 pass: R1 no-op (anchors at level-3/4 — GitHub + Stripe + AWS rate-limit headers are engineering surfaces, acceptable). Added Move 1 mnemonic diagram (burst-of-50 with vs without backpressure side-by-side) + 1 new Move 2 sub-section diagram (three flavours of backpressure with code snippets and when-each-fits guidance). Sub-section "shape of a centralized queue" already had a comprehensive diagram. Total: 2 new diagrams.
