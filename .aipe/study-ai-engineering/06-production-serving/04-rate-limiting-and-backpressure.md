# Rate limiting and backpressure

**Industry name(s):** Rate limiting, backpressure, request queue
**Type:** Industry standard

> Providers have rate limits (RPM, TPM). Without local rate limiting, bursts cause 429s. With it, requests queue gracefully. Backpressure: when the queue grows beyond a threshold, reject new requests rather than queue indefinitely.

**See also:** → [05-retry-and-circuit-breaker](./05-retry-and-circuit-breaker.md) · → [`01-llm-foundations/06-token-economics`](../01-llm-foundations/06-token-economics.md) · → [`04-agents-and-tool-use/06-error-recovery`](../04-agents-and-tool-use/06-error-recovery.md)

---

## Why care

### Move 1 — The grounded scenario

Imagine buffr at 1000 DAU. User opens the editor at 9am sharp; all 1000 users do the same. 1000 `summarize` chain calls hit Anthropic in a 5-minute window. Anthropic's rate limit (say 1000 RPM tier 2) just barely accommodates this — but throw in `caption` and `interpret` and the system 429s. Without local rate limiting, the cascading errors break the UI for half the users. With it, requests queue locally, draining at the provider's rate.

### Move 2 — Name the question the pattern answers

That what-happens-on-burst question is what rate limiting answers. Not "should I have rate limits" (yes); just *what shape — token-bucket queue, concurrency cap, backpressure threshold*.

### Move 3 — Why answering that question matters

**What breaks without rate limiting:** every burst becomes 429s; users see "the AI isn't working." For buffr's solo-dev current scale, this isn't a problem (one user, no bursts). For any growth path, it becomes load-bearing.

### Move 4 — Concrete before/after

Without local rate limiting:
- Burst → many concurrent requests → some succeed, many 429
- Retry logic on 429 → may amplify the burst
- Cascading failures

With local rate limiting + backpressure:
- Burst → requests queue locally
- Queue drains at provider's rate
- Beyond queue threshold → reject new requests, return graceful error to UI

### Move 5 — The one-line summary

Local queue + concurrency cap + queue-depth threshold; bursts queue gracefully; overflows reject early.

---

## How it works

### Move 1 — The mental model

```
   Burst of requests
     │
     ▼
   ┌──────────────────────────────┐
   │ Request queue                │
   │ ────────────────────────────  │
   │ Pop up to N concurrent       │
   │ Wait if at limit             │
   └──────────────┬───────────────┘
                  │
                  ▼
             LLM provider
                  │
                  ▼
             Response
```

### Move 2 — The layered walkthrough

**Layer 1 — concurrency cap.** Limit how many requests run in parallel. Buffr's per-device cap could be small (3 concurrent) since requests are user-initiated. For server-side systems, the cap depends on provider tier.

**Layer 2 — token-bucket queue.** Tokens regenerate at the provider's RPM rate; each request consumes a token. When tokens run out, new requests wait. Smooths bursts without per-request 429s.

**Layer 3 — backpressure.** When the queue depth exceeds a threshold (e.g., 50 pending requests), reject new requests with a clear error ("too many pending — try again in a minute"). Better than queueing indefinitely and timing out per request.

```
   Three layers
   ────────────
   concurrency cap:    "at most N in flight"
   token bucket:       "drain at provider's RPM"
   backpressure:       "reject when queue depth > threshold"
```

### Move 3 — The principle

Local rate limiting matches the provider's pace; backpressure prevents unbounded growth; both together produce graceful degradation under load.

---

## Rate limiting + backpressure — diagram

```
┌─ Request flow with rate limiting ──────────────────────────────────────┐
│                                                                        │
│   incoming request                                                     │
│         │                                                              │
│         ▼                                                              │
│   ┌──────────────────────────────┐                                     │
│   │ check queue depth            │                                     │
│   └──────────────┬───────────────┘                                     │
│                  │                                                     │
│             ┌────┴────┐                                                │
│             │ > thresh│                                                │
│             └────┬────┘                                                │
│                  │                                                     │
│             ┌────┴─────┐                                               │
│             │          │                                               │
│             ▼ yes      ▼ no                                            │
│           reject     ┌──────────────────────────────┐                  │
│           early      │ enqueue                      │                  │
│                      └──────────────┬───────────────┘                  │
│                                     │                                  │
│                                     ▼  token-bucket pop                │
│                      ┌──────────────────────────────┐                  │
│                      │ concurrency cap check        │                  │
│                      │ run if under cap; else wait  │                  │
│                      └──────────────┬───────────────┘                  │
│                                     │                                  │
│                                     ▼                                  │
│                                LLM provider                            │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr has no rate limiting today.**

`B5.1` curriculum build: request queue with retry/backoff for all chains and RAG retrievals. For buffr's current single-user scale, this is a no-op; for any growth path (multi-user, shared backend), it becomes load-bearing.

---

## Elaborate

### Where this pattern comes from

Token-bucket and leaky-bucket algorithms are decades old in network engineering. LLM-specific rate limiting is the same shape applied to provider API limits.

### The deeper principle

Bursts overwhelm; queuing smooths; bounded queues prevent unbounded growth. Universal pattern.

### Where this breaks down

For very low-volume systems (buffr single-user), rate limiting is over-engineered. Build when traffic shape demands it.

### What to explore next

- [05-retry-and-circuit-breaker](./05-retry-and-circuit-breaker.md) — what happens when limits are hit
- [`04-agents-and-tool-use/06-error-recovery`](../04-agents-and-tool-use/06-error-recovery.md) — broader error recovery

---

## Tradeoffs

The breakpoint: implement when traffic patterns produce bursts (multi-user backend) or when provider rate limits are within an order of magnitude of typical traffic.

---

## Tech reference

- **Implementation:** in-process queue + setInterval token regen.
- **Backpressure threshold:** typically 10x average steady-state queue depth.

---

## Project exercises

### B5.1 — Request queue with retry/backoff

- **Exercise ID:** `B5.1`
- **What to build:** wrap chain calls in a per-provider queue with concurrency cap (3); token-bucket RPM limit matching provider tier; backpressure rejection at queue depth >50.
- **Done when:** burst test (50 simultaneous calls) drains smoothly without 429s.
- **Estimated effort:** 6 hours.

---

## Summary

- Three layers: concurrency cap, token bucket, backpressure.
- Smooths bursts; prevents unbounded growth.
- Buffr: Case B; load-bearing on growth path.

---

## Interview defense

**Q [mid]:** What's the difference between rate limiting and backpressure?

**A:** Rate limiting throttles outgoing requests to match the provider's pace (token bucket). Backpressure rejects incoming requests when the queue gets too deep — prevents unbounded growth. Together: rate limiting handles "slow down"; backpressure handles "stop accepting." Without backpressure, a sustained overload eventually times out every request; with backpressure, the system degrades gracefully.

### One-line anchors

- Three layers: concurrency cap, token bucket, backpressure.
- Smooth bursts; bound the queue.
- Required on multi-user growth path.

---

## Validate

### Quick check
- What three layers compose rate limiting?
- When does buffr need this?
- What's the difference between queueing and rejecting?
