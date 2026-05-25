# Retry and circuit breaker

**Industry name(s):** Retry, exponential backoff, circuit breaker, fail-fast
**Type:** Industry standard

> Retry with exponential backoff for transient failures (network blips, occasional 429s). Circuit breaker for sustained failures (provider down) — after N consecutive failures, fail fast for T seconds. Both layered: retry handles flakes; circuit breaker handles outages.

**See also:** → [04-rate-limiting-and-backpressure](./04-rate-limiting-and-backpressure.md) · → [`04-agents-and-tool-use/06-error-recovery`](../04-agents-and-tool-use/06-error-recovery.md) · → [`01-llm-foundations/08-provider-abstraction`](../01-llm-foundations/08-provider-abstraction.md)

---

## Why care

### Move 1 — The grounded scenario

Buffr's `summarize` chain fails. Network blip, 500 from the provider, momentary 429 — any of these is transient. Without retry, the user sees "AI failed"; manual reload or wait. With retry, the second attempt succeeds within seconds and the user sees nothing. But: if the provider is sustained-down (outage), retry-forever amplifies the failure. Circuit breaker handles that.

### Move 2 — Name the question the pattern answers

That do-I-retry question is what retry + circuit breaker answer. Not "always retry" (amplifies sustained failures); just *what's the policy for transient vs sustained failures*.

### Move 3 — Why answering that question matters

**What breaks without retry:** every transient blip surfaces as user-visible failure. **What breaks without circuit breaker:** every provider outage means hammering a broken service with retries (wastes tokens, prolongs the issue). Buffr today has neither — chain errors propagate to the UI as silent fallbacks.

### Move 4 — Concrete before/after

Without retry/circuit breaker:
- Provider blip → user sees "AI error" → manual retry → works
- Provider outage → every chain call retries → all fail → user sees "AI broken"

With retry + circuit breaker:
- Provider blip → automatic retry → user never sees the issue
- Provider outage → first few retries fail → circuit opens → subsequent calls fail-fast (no wasted tokens) → after timeout, half-open probe → resume when provider recovers

### Move 5 — The one-line summary

Retry with exponential backoff for transient; circuit breaker for sustained; both layered.

---

## How it works

### Move 1 — The mental model

```
   ┌─ Retry with backoff ──────────────────────────┐
   │  Attempt 1 fails → wait 1s → attempt 2        │
   │  Attempt 2 fails → wait 2s → attempt 3        │
   │  Attempt 3 fails → wait 4s → give up          │
   │  (exponential backoff with jitter)            │
   └────────────────────────────────────────────────┘

   ┌─ Circuit breaker ─────────────────────────────┐
   │  After N consecutive failures, "open" the     │
   │  circuit. All requests fail fast for T        │
   │  seconds. Then "half-open" — try one. If it   │
   │  succeeds, close. If not, open again.         │
   └────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — retry policy.** Exponential backoff (1s, 2s, 4s, 8s...) with jitter (±25% randomness to avoid herd behaviour). Cap retries at 3-5 attempts. Distinguish retryable errors (5xx, 429, network) from non-retryable (4xx auth, validation).

**Layer 2 — circuit breaker states.** Closed (normal, requests pass through). Open (failed; all requests fail fast for T seconds, T typically 30-60s). Half-open (probe state; one request allowed; success → close, fail → open again).

```
   States and transitions
   ──────────────────────
                  ┌──────────┐
   normal flow → │  closed  │
                  └────┬─────┘
                       │ N consecutive failures
                       ▼
                  ┌──────────┐
                  │   open   │ ← fail fast for T seconds
                  └────┬─────┘
                       │ T elapsed
                       ▼
                  ┌────────────┐
                  │ half-open  │ ← probe with one request
                  └────┬───────┘
              ┌────────┴────────┐
              │                 │
              ▼ success         ▼ failure
            close              open
```

**Layer 3 — interaction with rate limiting.** Retry inside the local rate-limiting queue; the queue ensures retries don't pile up. Circuit breaker tracks failure rate; opens when sustained.

### Move 3 — The principle

Retry for transient; fail-fast for sustained; the layering preserves both responsiveness and resource health.

---

## Retry + circuit breaker — diagram

```
┌─ Full request flow ────────────────────────────────────────────────────┐
│                                                                        │
│   request                                                              │
│         │                                                              │
│         ▼                                                              │
│   ┌──────────────────────────────┐                                     │
│   │ circuit breaker state        │                                     │
│   └──────────────┬───────────────┘                                     │
│                  │                                                     │
│             ┌────┴────┐                                                │
│             │ open?   │                                                │
│             └────┬────┘                                                │
│                  │                                                     │
│             ┌────┴─────┐                                               │
│             │          │                                               │
│             ▼ yes      ▼ no                                            │
│           fail-fast    rate-limit queue + concurrency cap              │
│                              │                                         │
│                              ▼                                         │
│                       LLM call (attempt 1)                             │
│                              │                                         │
│                         ┌────┴────┐                                    │
│                         │ result? │                                    │
│                         └────┬────┘                                    │
│                              │                                         │
│                         ┌────┴─────┐                                   │
│                         │          │                                   │
│                         ▼ success  ▼ retryable error                   │
│                       return       wait 1s × jitter → attempt 2 ...   │
│                                    if still failing after N: error +   │
│                                    increment circuit breaker counter   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr has neither retry nor circuit breaker today.**

`B5.1` builds the retry layer; `B5.4` builds the circuit breaker. Errors today propagate as throws; the UI has silent fallbacks (cache hit if available, else error state).

---

## Elaborate

### Where this pattern comes from

Retry with exponential backoff: classical distributed-systems pattern. Circuit breaker: Michael Nygard's "Release It!" 2007; Martin Fowler's writeup popularized it for service-oriented architectures.

### The deeper principle

Transient vs sustained failures need different handling. Conflating them produces either fragility (no retry) or amplification (retry forever).

### Where this breaks down

For low-volume systems (buffr single-user), neither pattern is load-bearing today. Build when traffic patterns demand it.

### What to explore next

- [04-rate-limiting-and-backpressure](./04-rate-limiting-and-backpressure.md) — sibling layer
- [`04-agents-and-tool-use/06-error-recovery`](../04-agents-and-tool-use/06-error-recovery.md) — agent-level error handling

---

## Tradeoffs

The breakpoint: implement retry on growth path; implement circuit breaker after retry produces sustained-failure cost data.

---

## Tech reference

- **Retry:** exponential backoff with jitter; cap at 3-5 attempts.
- **Circuit breaker:** three states; T typically 30-60s; N typically 5 failures.

---

## Project exercises

### B5.4 — Circuit breaker for provider outages

- **Exercise ID:** `B5.4`
- **What to build:** wrap each chain in a circuit breaker per provider; configure 5 failures in 60s to open; T=60s before half-open probe.
- **Done when:** simulated provider outage opens the circuit; calls fail fast; UI shows "AI temporarily unavailable."
- **Estimated effort:** 4 hours.

---

## Summary

- Retry for transient (exponential backoff, jitter, cap).
- Circuit breaker for sustained (closed/open/half-open).
- Layered.
- Buffr: Case B; build on growth path.

---

## Interview defense

**Q [mid]:** Why both retry AND circuit breaker?

**A:** Retry handles transient failures (network blips, occasional 429s). Without retry, every blip is user-visible. But retry alone amplifies sustained failures — a provider outage means every call retries 3-5 times before failing. Circuit breaker handles sustained: after N consecutive failures, open the circuit; all subsequent calls fail fast for T seconds. Layered, you get responsiveness on flakes AND restraint on outages.

### One-line anchors

- Retry for transient; circuit breaker for sustained.
- Three states: closed, open, half-open.
- Layered; both needed for production.

---

## Validate

### Quick check
- What's the difference between transient and sustained failure?
- What are the three circuit breaker states?
- What's buffr's current behaviour on provider outage?
