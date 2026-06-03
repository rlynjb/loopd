# Backpressure, bounded work, and cancellation — buffr's "what we don't do"
## Industry name(s): bounded concurrency, backpressure, cancellation tokens · Type: Foundational

> Buffr has no explicit backpressure mechanism. No cancellation tokens on chain calls. `Promise.all` in classify could fan out 20 LLM calls in parallel. At single-user scale none of this bites; at scale all three need work.

## Zoom out, then zoom in

```
  WHAT'S MISSING

  ─ no bounded concurrency on Promise.all
   ▸ classify fan-out could be 20+ parallel LLM calls
   ▸ cache shortcircuits most; few uncached calls reach LLM
  ─ no cancellation
   ▸ user closes the entry; chain call still runs
   ▸ wastes a few hundred ms of compute
  ─ no rate limit
   ▸ no governor on chain call rate
   ▸ Anthropic SDK has its own retry; saves us
```

Zoom in: at single-user scale, "wastes a chain call's worth of compute" is rounding error. At multi-tenant scale (workers processing many users), unbounded fan-out is a DDoS-on-self.

## Structure pass

```
  layers   ─ caller ─ fan-out ─ execution ─ cleanup
  axes     ─ concurrency limit
             ─ cancellation propagation
```

## How it works

### Move 1 — `Promise.all` is unbounded

```
  await Promise.all(candidates.map(c => classify(c, ctx)));
  
  if candidates.length = 20, 20 parallel LLM calls.
  cache short-circuits ~70%; ~6 actually hit the LLM.
  acceptable for a single user. not for batch processing.
```

### Move 2 — no cancellation

```
  if user navigates away mid-prose-commit, the chain still runs
  to completion. result is cached so it isn't wasted entirely.
```

### Move 3 — the principle: bound the fan-out

```
   ┌──────────────────────────────────────────────────┐
   │ a small change — replace Promise.all with a      │
   │ p-limit-style bounded concurrency — caps the     │
   │ fan-out at, say, 4. costs little. closes a real  │
   │ scaling concern.                                 │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// current
await Promise.all(candidates.map(c => classify(c, ctx)));

// proposed (bounded)
const limit = pLimit(4);
await Promise.all(candidates.map(c => limit(() => classify(c, ctx))));
```

For cancellation, wrap chain calls in `AbortController`:

```ts
// proposed
const ac = new AbortController();
// on entry unmount: ac.abort();
await callAnthropic({ signal: ac.signal });
```

## Elaborate

The "no cancellation" property is fine when chains are short. As LLM calls get slower (longer context, more reasoning), cancellation becomes more valuable — the user shouldn't pay for a stale call's compute. Worth investing in once chain p95 latency exceeds a few seconds.

## Interview defense

**Q [mid]:** What concurrency does the classifier fan out?

**A:** Unbounded. `Promise.all` over all candidate lines. Cache short-circuits ~70%; the rest hit the LLM in parallel.

**Q [senior]:** What's the failure mode?

**A:** Multi-tenant batch processing would hit Anthropic's rate limit (or our budget). Bounded concurrency with p-limit caps this.

## Validate

### Level 1 — name the three missing primitives.

### Level 2 — explain the fan-out shape.

### Level 3 — apply: add bounded concurrency to classify.

### Level 4 — defend: "Buffr doesn't need any of this." True today; not true at scale.

## See also

- `03-event-loop-and-async-io.md`
- `../study-ai-engineering/06-production-serving/` (rate limit, backpressure)
- `../study-system-design/05-heuristic-before-llm-classifier.md` (the upstream optimizer)
