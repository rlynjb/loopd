# LLM caching

**Industry name(s):** Prompt caching, semantic cache, exact-match cache
**Type:** Industry standard

> Three cache layers: provider-side prompt caching (cheap on cache hit); your-side semantic cache (embed query, return cached if close); your-side exact-match cache (hash input, return cached if identical). Each catches a different repeat shape.

**See also:** → [02-llm-cost-optimization](./02-llm-cost-optimization.md) · → [`02-context-and-prompts/03-prompt-chaining`](../02-context-and-prompts/03-prompt-chaining.md) · → [`ai-features-in-this-codebase`](../ai-features-in-this-codebase.md)

---

## Why care

### Move 1 — The grounded scenario

Buffr's home dashboard renders the day's `AISummary` every time the user opens the editor for that date. Without caching, every open is a full chain call — Sonnet 4.6 latency, full token cost. With buffr's existing per-day cache in `ai_summaries.summary_json`, the second-and-later opens hit cache → SQLite read → 5ms. Cache is what makes the feature feel fast.

### Move 2 — Name the question the pattern answers

That should-I-cache question is what LLM caching answers. Not "is caching always good" (stale cache = stale results); just *what are the three cache layers and when does each pay off*.

### Move 3 — Why answering that question matters

**What breaks without caching:** every load pays the LLM tax. For buffr's day-summary feature read repeatedly, the cache is the difference between "feature works" and "feature is unusable."

### Move 4 — Concrete before/after

Without cache:
- Every editor open → chain call → ~2 sec latency + ~$0.005 cost
- 10 opens/day per user → $0.05/day per user (or 100 DAU → $5/day)

With cache (buffr today):
- First open → chain call → cache to `ai_summaries.summary_json`
- Subsequent opens → SQLite read → 5ms, free
- 10x reduction in cost AND latency

### Move 5 — The one-line summary

Three caches: provider prompt caching (cheapest); semantic cache (medium); exact-match cache (safest). Pick by what repeats — system prompts, similar queries, or identical inputs.

---

## How it works

### Move 1 — The mental model

```
   ┌─ Prompt caching (provider-side) ──────────────┐
   │  Long system prompts cached by the provider;  │
   │  cache hits cost ~10% of normal input cost.   │
   │  E.g. Anthropic prompt caching.               │
   └────────────────────────────────────────────────┘

   ┌─ Semantic cache (your side) ──────────────────┐
   │  Embed the query, check if a similar query    │
   │  was answered recently, return cached if      │
   │  close enough.                                │
   │  Risk: stale answers if data changed.         │
   └────────────────────────────────────────────────┘

   ┌─ Exact-match cache (your side) ───────────────┐
   │  Hash the input, return cached output if      │
   │  identical input. Safest, lowest hit rate.    │
   └────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — exact-match cache (buffr today).** Cache keyed by input identity. Buffr's `ai_summaries.summary_json` is keyed by `(user_id, date)` — for the same day, same user, same result. Cheap, safe, simple. Invalidate on entry edit (set `summary_json = null` to force regeneration).

```
   buffr's exact-match cache
   ─────────────────────────
   key:    (user_id, date)
   value:  AISummary + caption variants
   store:  ai_summaries.summary_json
   invalidate:  entry text changes for that date
```

**Layer 2 — semantic cache.** For chains where similar inputs should reuse outputs but inputs aren't identical. Embed the query; cosine-search a `semantic_cache` table; if top-1 similarity > 0.95, return cached output. Risk: stale data — if the underlying corpus changed, the cached answer is wrong.

**Layer 3 — provider prompt caching.** Anthropic and OpenAI both support prompt prefix caching: the long system prompt (or other shared prefix) is cached on the provider side; subsequent calls with the same prefix pay ~10% of the normal input cost on the cached portion. Useful when buffr's chains share a large system prompt across many calls.

```
   Provider prompt caching ROI
   ───────────────────────────
   buffr summarize system prompt: ~400 tokens, shared across all calls
   without caching: 400 tokens × $3/M × all calls
   with caching: 400 tokens × $0.30/M after first call (10% rate)
   savings: 90% on shared prefix
```

### Move 3 — The principle

Cache layers stack: exact-match for repeat reads (cheapest, safest); semantic for similar queries (medium); provider prefix caching for shared system prompts (free with right call shape).

---

## LLM caching — diagram

```
┌─ Three cache layers ───────────────────────────────────────────────────┐
│                                                                        │
│   Buffr's day-summary read                                             │
│         │                                                              │
│         ▼                                                              │
│   ┌──────────────────────────────────┐                                 │
│   │ Layer 1: exact-match cache       │                                 │
│   │   key: (user_id, date)            │                                 │
│   │   ai_summaries.summary_json       │                                 │
│   └──────────────┬───────────────────┘                                 │
│                  │                                                     │
│             ┌────┴────┐                                                │
│             │ cached? │                                                │
│             └────┬────┘                                                │
│                  │                                                     │
│             ┌────┴─────┐                                               │
│             │          │                                               │
│             ▼ yes      ▼ no                                            │
│           return    run chain                                          │
│           cached         │                                             │
│                          ▼                                             │
│             ┌──────────────────────────────────┐                       │
│             │ Layer 3: provider prompt caching │                       │
│             │   shared prefix cached on        │                       │
│             │   provider side                  │                       │
│             └──────────────┬───────────────────┘                       │
│                            │                                           │
│                            ▼                                           │
│                       cache to summary_json                            │
│                       return result                                    │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A — buffr uses exact-match caching via `ai_summaries.summary_json`.**

**Files:**
- `src/services/ai/compose.ts` — orchestrator. Reads `ai_summaries` first; runs chain only on miss.
- `src/services/database.ts` — `getCachedSummary(userId, date)` and `setCachedSummary(...)`.
- `supabase/migrations/0001_schema.sql` — `ai_summaries` table with `summary_json` column and `(user_id, date)` PK.

Layer 2 (semantic cache) is Case B — would apply to a hypothetical future "ask your journal" feature where similar queries should reuse cached answers. Layer 3 (provider prompt caching) is Case B — `B5.2` curriculum build target; would save ~90% on shared system prompt tokens.

---

## Elaborate

### Where this pattern comes from

Caching is universal in systems engineering; the LLM-specific shapes (provider prompt cache, semantic cache) emerged 2023-2024 with provider support and embedding maturity.

### The deeper principle

Repeat-read systems benefit from caching. The cache layer's shape matches the repeat shape: identical → exact match; similar → semantic; shared prefix → provider.

### Where this breaks down

For chains whose inputs are unique every call (rare for buffr), exact-match cache never hits. For chains where staleness matters (live data), semantic cache is dangerous.

### What to explore next

- [02-llm-cost-optimization](./02-llm-cost-optimization.md) — caching is the biggest cost lever after heuristic routing
- [`02-context-and-prompts/03-prompt-chaining`](../02-context-and-prompts/03-prompt-chaining.md) — cache at chain boundaries

---

## Tradeoffs

The breakpoint: exact-match cache always when inputs repeat. Semantic when queries vary but answers should overlap. Provider prefix when system prompt is shared.

---

## Tech reference

- **Anthropic prompt caching:** `cache_control: { type: "ephemeral" }` on message blocks; 5-minute TTL.
- **OpenAI prompt caching:** automatic for prompts >1024 tokens (no opt-in needed).
- **Semantic cache:** vector DB + threshold check.

---

## Project exercises

### B5.2 — Enable Anthropic prompt caching on shared system prompts

- **Exercise ID:** `B5.2`
- **What to build:** add `cache_control` to the system prompt section in each chain's message array; verify cache hits in the response usage.
- **Why it earns its place:** ~90% savings on shared prefix tokens once enabled; trivial change.
- **Files to touch:** `src/services/ai/{summarize,caption,expand,classify,interpret}.ts`.
- **Done when:** response `cache_read_input_tokens` is non-zero on second call.
- **Estimated effort:** 1 hour.

### B5.8 — Semantic cache for interpret chain

- **Exercise ID:** `B5.8`
- **What to build:** before running `interpret` for a date, embed the entry text; check `interpret_cache` for similarity > 0.95 within last 7 days; if hit, return cached.
- **Done when:** repeated similar inputs hit the cache.
- **Estimated effort:** 4 hours.

---

## Summary

- Three layers: exact-match (buffr today), semantic (Case B), provider (Case B).
- Cache key matches repeat shape.
- Invalidate on source change.

---

## Interview defense

**Q [mid]:** What's the cheapest cache to add and why?

**A:** Provider prompt caching. Trivial code change (add `cache_control` to system prompt block); ~90% savings on cached prefix tokens; no staleness risk because the cache is provider-managed with a short TTL. The biggest cost lever for chains that share a long system prompt.

### One-line anchors

- Three layers: exact-match, semantic, provider.
- Exact-match cache buffr uses today.
- Provider prompt cache is the cheapest add.

---

## Validate

### Quick check
- What's buffr's existing cache?
- What's the cache key?
- What invalidates the cache?
