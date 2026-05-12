# Retry and circuit breaker

**Industry name(s):** Retry with exponential backoff, circuit breaker, fail-fast on outage
**Type:** Industry standard

> Two patterns that compose — retry small failures; stop hammering big ones.

**See also:** → [42-rate-limiting-backpressure](./42-rate-limiting-backpressure.md) · → [11-failure-modes](./11-failure-modes.md)

---

## Why care

A transient network blip drops one classify call. The user sees the todo stuck at `type='todo'` because nothing retried. The same week, Anthropic has a 30-minute outage; every call from loopd fails; each retry hammers the dying provider; the user's UI freezes intermittently. Two different failure shapes; one retry policy doesn't handle both.

Retry and circuit breaker are the pair of patterns for handling external-call failures. **Retry** recovers from transient errors (one bad network round-trip). **Circuit breaker** detects sustained outages and stops trying for a while — preventing retry storms during real downtime. The pattern is the same shape as production resilience in any distributed system: small failures get retried; big failures get backed off. Here's the version for LLM calls.

---

## How it works

The two patterns address opposite failure scales.

### Retry with exponential backoff — for small, transient failures

A single failed call usually means a transient hiccup: network jitter, provider-side blip, momentary rate-limit overshoot. Retry with backoff handles this:

```
Attempt 1: call → fails (5xx or network)
Wait 250ms (with jitter)
Attempt 2: call → fails
Wait 500ms (with jitter)
Attempt 3: call → fails
Wait 1000ms (with jitter)
Attempt 4: give up; surface error to caller
```

Three attempts with exponential delay covers most transient failures. The jitter prevents synchronized retries from many concurrent callers.

If you're coming from frontend, this is the same shape as React Query's `retry: 3` plus `retryDelay: exponential` — same primitive, different runtime.

### Circuit breaker — for sustained, large failures

When the *cumulative* failure pattern signals real downtime (5 consecutive failures, or 50% failure rate over a minute), retrying further is wasted work and makes things worse for an already-struggling provider. The circuit breaker has three states:

```
States:
  CLOSED   — calls flow normally; failures counted
  OPEN     — calls short-circuit; return error immediately for T seconds
  HALF-OPEN— after T seconds, let one probe through; if it succeeds, close;
             if it fails, stay open another T seconds
```

The state transitions:

```
CLOSED  ──N consecutive failures──►  OPEN
OPEN    ──T seconds elapsed──►       HALF-OPEN
HALF-OPEN  ──probe succeeds──►       CLOSED
HALF-OPEN  ──probe fails──►          OPEN
```

For loopd: defaults of N=5 (5 consecutive failures) and T=120s (2-minute open period) give the provider time to recover without retry pressure.

### Why they compose

Retry handles single-call failures; circuit breaker handles sustained failures. Together they cover the spectrum:

```
Failure scale                       Handled by
─────────────────────────────       ──────────────────────
One bad request                      Retry (succeeds attempt 2)
Brief network blip (a few seconds)   Retry (succeeds attempt 3)
Provider 30-second hiccup            Retry exhausts; chain fails
Provider 30-minute outage            Circuit breaker opens after 5 failures
```

Without the circuit breaker, the 30-minute outage scenario means *every chain call retries 3× and fails*, hammering the provider during downtime. With the breaker, after 5 failures the breaker opens and subsequent calls return immediately — saving time, money, and provider load.

### Where they're wrong

- **Retry on the wrong errors** — 4xx errors are usually permanent (bad request, auth failure). Retrying them just wastes calls. Only retry 5xx, 429, and network errors.
- **Breaker too sensitive** — opening on every transient burst causes false-positive outages. Tune N high enough to require sustained failure.
- **No probe in half-open** — without a probe, the breaker can't recover; the system stays open forever.

### How it composes with the queue

[42-rate-limiting-backpressure](./42-rate-limiting-backpressure.md) introduces the queue. Retry and circuit breaker live *inside* the queue:

```
queue.enqueue(chainName, fn)
   ↓ wait for concurrency slot
   ↓ check circuit breaker — if OPEN, return error immediately
   ↓ run fn() with retry-with-backoff wrapper
   ↓ on success: close breaker, return result
   ↓ on failure after retries: increment breaker, return error
```

The queue gives you backpressure; retry gives you transient resilience; the breaker gives you outage resilience. The three together make a robust external-call layer.

### This is what people mean by "production-grade external calls"

In dev you can ignore failure modes; in production every external call has a probability of failing, and the question is what happens when one does. Retry + circuit breaker is the standard answer. Here's the picture.

---

## Retry and circuit breaker — diagram

```
The full call lifecycle with retry + circuit breaker

  caller invokes aiQueue.enqueue(chainName, fn)
            │
            ▼  wait for concurrency slot
  ┌─ Backpressure layer ────────────────────────────────┐
  │  (see [42-rate-limiting-backpressure])               │
  └─────────────────────────────────────────────────────┘
            │
            ▼  check circuit breaker state
  ┌─ Circuit breaker ───────────────────────────────────┐
  │  State: CLOSED | OPEN | HALF-OPEN                    │
  │                                                      │
  │  if OPEN → return BreakerOpenError immediately       │
  │  if HALF-OPEN → allow one probe; track outcome      │
  │  if CLOSED → continue                                │
  └─────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ Retry wrapper ─────────────────────────────────────┐
  │  for attempt in 1..3:                                │
  │    try:                                              │
  │      return await fn()                               │
  │    except RetryableError:                            │
  │      sleep(2^(attempt-1) × 250ms + jitter)          │
  │  raise FinalError                                    │
  └─────────────────────────────────────────────────────┘
            │
       ┌────┴────┐
       │         │
       ▼         ▼
   success    failure after retries
       │         │
       │         ▼
       │     breaker.recordFailure()
       │         │
       │         ▼
       │     if consecutive failures ≥ 5: state = OPEN
       │
       ▼
   breaker.recordSuccess()
   state = CLOSED if currently HALF-OPEN
```

```
Failure scales and the patterns that handle them

  ┌─────────────────────────────┬────────────────────────────┐
  │ Failure scale                │ Pattern that handles it    │
  ├─────────────────────────────┼────────────────────────────┤
  │ 1 transient blip             │ Retry attempt 2 succeeds   │
  │ Brief 5-second outage        │ Retry attempts 2-3 succeed │
  │ 30-second flap               │ Some retries succeed, some │
  │                              │ fail; chain may surface    │
  │                              │ partial errors             │
  │ 30-minute outage             │ Circuit breaker opens;     │
  │                              │ calls fail fast            │
  │ Permanent auth failure (401) │ Don't retry; surface       │
  │                              │ immediately                │
  └─────────────────────────────┴────────────────────────────┘
```

---

## In this codebase

**Status:** Case B — partial. loopd has try/catch at each chain call site (see [11-failure-modes](./11-failure-modes.md)), no retry, no circuit breaker. `interpret.ts` has a one-retry pattern (`one retry on validate-fail`); not the same shape (that's content-level retry, not transport-level retry).

`[B5.1]` adds retry; `[B5.4]` adds the circuit breaker.

**File:** *(no implementation today; transport-level retry is absent)*
**Function / class:** *(if shipped, both live in `src/services/ai/queue.ts` as wrappers around the enqueued function)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Retry with exponential backoff is one of the oldest production patterns — present in TCP, in distributed-database client libraries, in every HTTP client SDK. Circuit breaker was popularized by Michael Nygard's *Release It!* (2007) and codified by Netflix's Hystrix library (2012). The pair has been standard production resilience pattern for over a decade.

### The deeper principle
Different failure scales need different recovery strategies. One-size-fits-all retry policies either underreact (no retry for transient failures) or overreact (retry storm during real outages). Patterns specialized for failure scale are universal in production-grade systems.

### Where this breaks down
Both patterns assume the failure is *retryable* — a 5xx or network error. They don't help when the failure is content-shaped (the model returns invalid JSON). loopd's existing `expand.ts` "one retry on validate-fail" handles the content-shaped case separately; that's a different pattern.

### What to explore next
- [42-rate-limiting-backpressure](./42-rate-limiting-backpressure.md) → the queue layer that hosts retry and breaker
- [11-failure-modes](./11-failure-modes.md) → the broader failure-mode taxonomy
- `expand.ts`'s one-retry pattern → the content-level retry analog

---

## Tradeoffs

### Comparison table — resilience strategies

```
┌──────────────────────────┬────────────────────┬─────────────────────┬───────────────────────┐
│ Cost dimension           │ Retry + breaker    │ Retry only          │ No resilience         │
│                          │ (target)           │ (partial today)     │                       │
├──────────────────────────┼────────────────────┼─────────────────────┼───────────────────────┤
│ Transient failure recovery│ Good              │ Good                │ None                  │
│ Outage behavior          │ Fail fast (good)   │ Retry storm (bad)   │ Fail visible          │
│ User-visible failures    │ Minimal            │ Some                │ Many                  │
│ Provider-side impact     │ Low during outage  │ High during outage  │ Same as retry only    │
│ Implementation effort    │ ~150 LOC           │ ~50 LOC             │ 0                     │
│ Complexity overhead      │ State machine      │ Simple loop         │ N/A                   │
│ Observability needs      │ Breaker state log  │ Retry attempt count │ None                  │
└──────────────────────────┴────────────────────┴─────────────────────┴───────────────────────┘
```

### Sub-block 1 — what retry + breaker gives up

A simple state machine to maintain (~150 LOC vs ~50 for retry alone). Breaker state needs to be observable — a "breaker open!" banner in the AI ops panel helps users understand why their chains aren't working during an outage. Without that, the breaker silently filters all calls and the user wonders why their classify never runs.

### Sub-block 2 — what retry-only would cost

Retry storms during real outages. If Anthropic has a 30-minute outage and every chain call retries 3× before giving up, that's *3× the failed-call volume* during the worst possible time — burdens the recovering provider, wastes time, and gives users worse experience (long waits before each call gives up).

### Sub-block 3 — the breakpoint
Retry alone is sufficient if outages are rare AND short. Past either threshold, the circuit breaker pays for itself. For loopd at solo scale, outages are *rare* but *unpredictable*; the breaker is cheap insurance.

### What wasn't actually a tradeoff
"No resilience" is acceptable in prototype phase. Past first user, it's not — every retry-able failure becomes a user-visible bug.

---

## Tech reference (industry pairing)

### Custom retry with exponential backoff + jitter

- **Codebase uses:** target plan for `[B5.1]`.
- **Why it's here:** standard production pattern; ~50 LOC.
- **Leading today:** custom in-app retry — `adoption-leading` for client-side, 2026.
- **Why it leads:** explicit, debuggable, integrates with existing queue.
- **Runner-up:** `p-retry` (npm) — `innovation-leading` for one-liner retry; small dependency.

### Custom circuit breaker

- **Codebase uses:** target plan for `[B5.4]`.
- **Why it's here:** loopd has no existing dependency suitable; ~100 LOC custom is the right size.
- **Leading today:** custom — `adoption-leading` for client-side, 2026.
- **Why it leads:** zero dependencies; full control over state transitions.
- **Runner-up:** `opossum` (npm) — `innovation-leading` Hystrix-style circuit breaker for Node. Mature, well-documented; adds a dependency.

---

## Project exercises

### [B5.1] Request queue with retry/backoff (retry half)

- **Exercise ID:** `[B5.1]` (the retry half — backpressure half lives in [42-rate-limiting-backpressure](./42-rate-limiting-backpressure.md))
- **What to build:** A `retryWithBackoff(fn, options)` wrapper around `aiQueue.enqueue`'s function. Default 3 attempts; 250ms initial delay; exponential (2^attempt) × 250ms; jitter ±20%. Retry on 5xx, 429, network errors only — never on 4xx (treat as permanent).
- **Why it earns its place:** the most common failure mode in production LLM systems is transient. A simple retry recovers >90% of them invisibly.
- **Files to touch:** `src/services/ai/queue.ts` (extend with retry wrapper); per-chain error classification logic.
- **Done when:** an injected 503 fixture retries twice and surfaces; a 401 fixture fails on first try without retry; jitter prevents synchronized re-fires across concurrent callers.
- **Estimated effort:** `1–4hr` (after `[B5.1]` queue exists).

### [B5.4] Circuit breaker for provider outage

- **Exercise ID:** `[B5.4]`
- **What to build:** A circuit breaker that wraps the retry layer. Per-provider state (loopd has two: Anthropic, OpenAI). Defaults: N=5 consecutive failures → OPEN; T=120s open period → HALF-OPEN; one successful probe → CLOSED; failed probe → OPEN another T. State and counts are visible in `[B1.8]`'s AI ops panel.
- **Why it earns its place:** the "real outage" failure mode is rare but high-impact. Without a breaker, every call retries and dies during a real Anthropic outage — making the app feel broken.
- **Files to touch:** new `src/services/ai/circuitBreaker.ts`; integrates with `aiQueue.enqueue()`; surfaced in AI ops panel.
- **Done when:** the breaker opens after 5 consecutive failures; blocks for 2 minutes; probes after; ops panel shows state per provider; users see a clear "AI temporarily unavailable" banner when breaker is open.
- **Estimated effort:** `1–2 days`.

---

## Summary

Retry and circuit breaker compose to handle the two scales of external-call failure — retry for transient hiccups, circuit breaker for sustained outages. In loopd both are unimplemented today; `[B5.1]` adds retry, `[B5.4]` adds the breaker. The constraint that makes the pair the right call is that they address opposite failure shapes: retry without breaker causes retry storms during real outages; breaker without retry leaves transient failures unrecovered. The cost being paid until they ship is user-visible failures (stuck classifications, occasional silent failures during transient network issues) and retry storms during any provider outage.

Key points to remember:
- Retry handles transient; circuit breaker handles sustained.
- Three attempts with exponential backoff + jitter is the standard retry shape.
- Breaker state machine: CLOSED → OPEN → HALF-OPEN → CLOSED.
- Retry only on 5xx, 429, network — never on 4xx.
- Surface breaker state to users; silent failure is worse than visible.

---

## Interview defense

### What an interviewer is really asking
"How do you handle LLM provider failures?" tests whether the candidate has both patterns. Bonus probe: "what about during a real outage?" — separates retry-only from retry+breaker.

### Likely questions

  [mid] Q: What's exponential backoff with jitter?
  A: A retry policy where each attempt waits exponentially longer than the previous — 250ms, 500ms, 1000ms, etc. — and jitter adds random variation (~±20%) to prevent synchronized retries from concurrent callers. The exponential pattern gives the failing system time to recover; the jitter prevents thundering-herd patterns when many callers all retry at the same moment.
  Diagram:
  ```
  Attempt 1: call → fail
  wait: 250ms + jitter
  Attempt 2: call → fail
  wait: 500ms + jitter
  Attempt 3: call → fail
  wait: 1000ms + jitter
  Attempt 4: give up
  ```

  [senior] Q: When does retry hurt instead of help?
  A: During real outages. If Anthropic has a 30-minute outage and every chain retries 3× before giving up, you've tripled the failed-call volume hitting the recovering provider. The circuit breaker stops this — after 5 consecutive failures, it opens for 2 minutes, returning errors immediately without retries. After 2 minutes it lets one probe through; if successful, normal traffic resumes. Without the breaker, retry pressure during downtime actively makes the provider's recovery harder.
  Diagram:
  ```
  Picked: retry + breaker            Suggested: retry only
  ───────────────────────             ──────────────────────
  Outage: breaker opens, fail fast    Outage: every call retries 3×
  Provider load during outage: ~0     Provider load: 3× normal
  ~150 LOC                            ~50 LOC
  Right at production                 Right at "outages don't happen"
  ```

  [arch] Q: At 100× users, what changes?
  A: Three shifts. First, the breaker becomes more important because outages affect more users simultaneously — fail-fast saves much more provider load. Second, per-user vs global breaker state matters — if one user's call pattern triggers a 429 cluster, you don't want to break for everyone. Third, the breaker state needs persistence and synchronization across instances if you have multiple workers — at solo scale it's in-process; at backend scale it's Redis or similar.
  Diagram:
  ```
  Today (solo)         →  In-process breaker per provider
  10× users            →  Same in-process; user-bucketed retry budget
  100× users           →  Redis-backed breaker state; multi-instance sync
  1000× users          →  Per-user budgets + global outage detection
  ```

### The question candidates always dodge
"How do you tune N and T for the breaker?" The honest answer: empirically. Start with N=5 and T=120s; if you see false-positive breaker opens during routine ops, increase N; if recovery is slow, decrease T; if outages keep slipping through, decrease N. The tuning is feature-by-feature, eval-driven, and never finished — production resilience is a continuously-monitored property, not a one-shot configuration.

```
Picked: empirical tuning             Suggested: textbook defaults forever
─────────────────────────             ─────────────────────────────
Watch breaker state in prod           Set once, forget
Adjust on false-positives/negatives   Never adjusts
Right at "we monitor"                 Right at "we don't monitor"
```

### One-line anchors
- Retry small failures; break on big ones.
- Three attempts with backoff + jitter.
- Breaker: 5 fails → open 2 minutes → probe → close or stay open.
- Never retry 4xx.
- Surface breaker state; silent failures are worse than visible.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the full call lifecycle: backpressure → breaker → retry → call. Annotate state transitions for the breaker.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) what retry handles vs what circuit breaker handles, (b) why retry-only is dangerous in outages, (c) the three breaker states, (d) the role of jitter.

### Level 3 — Apply it to a new scenario
Anthropic has a 5-second hiccup. loopd's classify chain is mid-burst (10 calls in flight). Without looking, walk through what each layer does, in order.

Open the diagram and check whether your walkthrough matches: retry succeeds at attempt 2 or 3; breaker stays CLOSED; user sees no failures.

### Level 4 — Defend the decision you'd change
Today the plan is custom retry + custom breaker. If you were starting today, would you use `p-retry` and `opossum` (the npm packages) instead? Defend your answer.

### Quick check — code reference test
- What file holds both patterns?
- What's the breaker's "open" duration default?

Answer: `src/services/ai/queue.ts` + `src/services/ai/circuitBreaker.ts` (target — `[B5.1]` + `[B5.4]`, not yet created). T = 120 seconds (2 minutes).
