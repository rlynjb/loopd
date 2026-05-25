# 06 — Production serving

Five patterns for hardening LLM applications past prototype: caching, cost optimization, prompt injection defense, rate limiting, retry + circuit breaker. Buffr exercises caching (Case A) and the implicit per-chain model routing; everything else is Case B with Phase 5 build targets.

## Concepts

1. **[LLM caching](./01-llm-caching.md)** — three layers: provider, semantic, exact-match. Buffr's `ai_summaries.summary_json` is exact-match.
2. **[LLM cost optimization](./02-llm-cost-optimization.md)** — five levers, ordered. Measure first; pull in order.
3. **[Prompt injection](./03-prompt-injection.md)** — four defense layers: sanitize, schema, review, side-effect isolation.
4. **[Rate limiting and backpressure](./04-rate-limiting-and-backpressure.md)** — local queue + concurrency cap + queue-depth threshold.
5. **[Retry and circuit breaker](./05-retry-and-circuit-breaker.md)** — retry for transient; circuit breaker for sustained.

## What buffr exercises today

- **Case A:** exact-match caching (`ai_summaries.summary_json`); per-chain model routing (Haiku for classifier, Sonnet for others).
- **Case A (partial):** prompt-injection defense via schema enforcement (layer 2) and side-effect isolation (layer 4).
- **Case B:** prompt caching, semantic cache, sanitization, output review, rate limiting, retry, circuit breaker. All Phase 5 build targets.

## Reading order

Read 1–2 for the cost-related layers (caching is the first lever after measurement). Read 3 for safety (prompt injection). Read 4–5 for reliability (rate limiting + retry/circuit breaker). All five compose; pick by what your scale demands.

## Note on production observability

The curriculum's `C5.6` production observability concept overlaps heavily with `05-evals-and-observability/04-llm-observability`. The cross-reference is intentional — observability spans both eval-driven iteration and production serving. See the eval section for the trace-data shape; this section's observability is about surfacing the data in dashboards (`B5.5` builds `app/more/ai-ops.tsx`).
