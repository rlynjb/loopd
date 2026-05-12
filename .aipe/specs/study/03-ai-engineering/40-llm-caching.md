# LLM caching

**Industry name(s):** Prompt caching, semantic cache, LLM response cache, KV cache reuse
**Type:** Industry standard

> Two different caches at two different layers — each saves a different kind of cost.

**See also:** → [23-token-economics](./23-token-economics.md) · → [41-llm-cost-optimization](./41-llm-cost-optimization.md) · → [14-interpret](./14-interpret.md)

---

## Why care

You ran the same interpret query twice on the same unchanged entry and paid full price both times. Same prompt, same model, same output — but you paid for re-generating it from scratch. Most LLM apps treat each call as fresh; production apps cache aggressively because the savings are real.

LLM caching has two distinct layers. **Prompt caching** is provider-side: the same prefix tokens get cheaper on the second call (Anthropic's `cache_control`, OpenAI's automatic caching). **Semantic caching** is application-side: identical or near-identical inputs return previously-computed outputs. The pattern is the same shape as HTTP caching — there are server-side caches (CDN), client-side caches (browser), and they save different costs. Here's how the two cache layers compose in loopd.

---

## How it works

The two caches operate at different layers and answer different questions.

### Prompt caching (provider-side)

Models compute attention over the input sequence token-by-token. The transformer's intermediate "KV cache" (key-value attention state) at each layer is expensive to compute the first time, cheap to reuse if you replay the same prefix.

Providers expose this as a *cacheable prefix*: mark part of your prompt as cacheable, and on the second call with the same prefix, you pay ~10% of the input-token cost for cached portions. Anthropic does this explicitly with `cache_control`; OpenAI does it automatically.

For loopd: every chain has a static SYSTEM_PROMPT (~100-300 tokens). Wrapping it with `cache_control` means the system prompt is paid full price once, then 10% per call afterward. The 90% discount compounds across thousands of calls.

If you're coming from frontend, this is similar to a CDN cache for static assets — the static system prompt is your asset; the cache pays for storage; you get a discount on reads.

### Semantic caching (application-side)

For chains whose output is deterministic given the input (or where re-running gives slightly different output but the user wants the same one), cache `(input → output)` in your own DB. On second call with the same input, skip the model entirely.

For loopd: `interpret(entry)` returns markdown the user reads. If they tap "interpret" on an unchanged entry twice, today you call the model twice — costing $0.01-0.03 per call. A semantic cache stores the markdown keyed by `(entry.text, entry.updated_at, chain_version)`. On second call with the same key, return cached. Free, instant.

### The two layers compose

```
First interpret call (unchanged entry)
  └─ semantic cache miss
     └─ provider call
        └─ prompt cache miss on first ever call
           → full price input + output

Second interpret call (same entry, unchanged)
  └─ semantic cache HIT
     → instant, free
     (provider never contacted)

Different entry, same chain (typical)
  └─ semantic cache miss (different input)
     └─ provider call
        └─ prompt cache HIT on system prompt
           → 10% input cost on cached portion + full output cost
```

The semantic cache saves *all* the cost on cache hits. The prompt cache saves 90% of the input-side cost when the semantic cache misses.

### Where prompt caching helps and hurts

Helps when:
- System prompts are stable across calls (loopd: yes, every chain).
- System prompts are long enough to matter — Anthropic's minimum cacheable prefix is ~1024 tokens for Sonnet 4.6, ~2048 for Haiku. Below the threshold, caching is silently skipped.
- Volume is high enough to amortize the (small) cache-creation premium on the first call.

Hurts when:
- System prompts change frequently (rotation prompts, dynamic context). Every change invalidates the cache.
- Prompts are short (below the threshold).
- Volume is too low to amortize.

For loopd: caption has the longest SYSTEM_PROMPT (~600 tokens) which is *below* the cacheable threshold for Sonnet 4.6. Caching wouldn't help today; would help if the prompt grew, or if the threshold dropped.

### Where semantic caching helps and hurts

Helps when:
- Inputs are repeatable (same entry, same query).
- Output is deterministic enough that returning cached is acceptable.
- Re-computation cost is high.

Hurts when:
- Inputs are unique (rare to see twice).
- Variability is desired (creative outputs, varied captions).
- Cache invalidation is hard (input changed, but how to detect?).

For loopd: interpret is the natural candidate — same entry, same interpret call, user expects same output. Caption is *not* a good candidate — re-running caption should give *different* variants each time to fight repetition.

### This is what people mean by "two caches, two wins"

Provider-side and application-side caches save different costs. Most production apps benefit from both. The discipline is matching the cache to the chain's properties. Here's the picture.

---

## LLM caching — diagram

```
The two cache layers for loopd's interpret chain

  ┌─ Application layer ───────────────────────────────────┐
  │  interpretEntry(entry)                                │
  │            │                                          │
  │            ▼                                          │
  │  Semantic cache: SELECT FROM interpret_cache          │
  │   WHERE entry_id = X AND entry_text_hash = Y          │
  │     AND chain_version = Z                             │
  │            │                                          │
  │      ┌─────┴─────┐                                    │
  │      │           │                                    │
  │      ▼           ▼                                    │
  │   HIT       MISS                                      │
  │   return    (continue to provider)                    │
  └───────────────────────────────────────────────────────┘
            │
            ▼  on miss
  ┌─ Provider layer ──────────────────────────────────────┐
  │  client.messages.create({                              │
  │    system: [{                                          │
  │      type: 'text',                                     │
  │      text: INTERPRET_SYSTEM_PROMPT,                    │
  │      cache_control: { type: 'ephemeral' }              │
  │    }],                                                 │
  │    messages: [{ role: 'user', content: entry.text }]   │
  │  })                                                    │
  │                                                        │
  │  → Anthropic checks: have we seen this prefix?         │
  │    HIT:  10% of input cost for cached portion         │
  │    MISS: full price + creates cache for future         │
  └────────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ On semantic-cache miss, after response ──────────────┐
  │  INSERT INTO interpret_cache                          │
  │   (entry_id, entry_text_hash, chain_version,          │
  │    output_md, created_at)                             │
  └───────────────────────────────────────────────────────┘
```

---

## In this codebase

**Status:** Case B — no caching today, either layer.

Two build items address this: `[B5.2]` adds Anthropic prompt caching across the chains; `[B5.8]` adds semantic caching for the interpret chain specifically.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, prompt caching is a config flag on each chain; semantic cache lives in `src/services/ai/interpretCache.ts`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Provider-side prompt caching (KV cache reuse) became publicly available in 2024 (Anthropic's manual `cache_control`, OpenAI's automatic). The underlying technique (KV cache sharing across requests) has been an inference-serving optimization for longer.

Application-side semantic caching is older — the standard "memoize expensive function call" pattern, applied to LLM calls. Caches keyed by input hash; salt with chain version to invalidate when the prompt changes.

### The deeper principle
Two layers; two costs; two caches. The same principle holds across web architecture (CDN vs browser cache), databases (buffer pool vs application cache), and search (index cache vs result cache).

### Where this breaks down
Both caches break if the input shape changes silently. A semantic cache keyed on `entry_text_hash` misses if you also depend on context that's not in the hash (e.g., recent captions from other entries). Prompt caching breaks if the "static" system prompt secretly depends on the current date or some external state.

### What to explore next
- [41-llm-cost-optimization](./41-llm-cost-optimization.md) → caching is one of many cost levers
- [23-token-economics](./23-token-economics.md) → why measuring spend matters before caching
- Anthropic's prompt caching docs → cacheable-prefix thresholds and pricing

---

## Tradeoffs

### Comparison table — caching strategies

```
┌────────────────────────┬──────────────────┬──────────────────┬──────────────────────┐
│ Cost dimension         │ No caching       │ Prompt caching   │ Semantic + prompt    │
│                        │ (today)          │ only             │ (target)             │
├────────────────────────┼──────────────────┼──────────────────┼──────────────────────┤
│ Per-call input cost    │ Full             │ ~10% on prefix   │ 0 on hit; ~10% else  │
│ Per-call output cost   │ Full             │ Full             │ 0 on hit; full else  │
│ Per-call latency       │ ~2-5s            │ Same (~2-5s)     │ ~50ms on hit         │
│ Implementation effort  │ 0                │ ~20 LOC          │ ~100 LOC + table     │
│ Storage cost           │ 0                │ Provider-side    │ Local DB             │
│ Invalidation logic     │ N/A              │ Auto             │ Manual               │
│ Right for caption      │ N/A              │ Yes (if prompt   │ No (variability      │
│                        │                  │   exceeds threshold) │ desired)         │
│ Right for interpret    │ N/A              │ Yes              │ Yes                  │
└────────────────────────┴──────────────────┴──────────────────┴──────────────────────┘
```

### Sub-block 1 — what no-caching gives up

Every interpret re-tap pays full price. At solo scale this is pennies per month. At scale, it's meaningful.

### Sub-block 2 — what semantic-only would cost

The semantic cache catches identical-input re-calls; prompt caching catches stable-system-prompt savings across different inputs. Without prompt caching, every chain's system-prompt input cost is full price even though the prompt is fixed. Layering both is strictly better than either alone where applicable.

### Sub-block 3 — the breakpoint
Caching's value scales with call volume. At loopd solo (~30 calls/day), the absolute dollar savings are small but the discipline is correct. At 100k users, prompt caching alone would save ~90% on input-side spend across all chains — a non-trivial number.

### What wasn't actually a tradeoff
Variability is a feature for caption — semantic caching of caption variants is wrong because users want fresh variants on re-roll. Prompt caching is fine there (system prompt is static).

---

## Tech reference (industry pairing)

### Anthropic prompt caching (`cache_control`)

- **Codebase uses:** target for `[B5.2]`.
- **Why it's here:** the primary cost lever for stable system prompts.
- **Leading today:** Anthropic `cache_control` — `adoption-leading`, 2026.
- **Why it leads:** explicit per-block control; 90% discount on cached input; clean API.
- **Runner-up:** OpenAI automatic caching — no manual control; cached prefixes detected automatically; less leverage but no implementation effort.

### Custom semantic cache (local SQLite)

- **Codebase uses:** target for `[B5.8]`.
- **Why it's here:** loopd's local-first architecture; cache colocated with canonical data.
- **Leading today:** application-side semantic cache — `adoption-leading` for repeatable-input chains, 2026.
- **Why it leads:** zero new infrastructure; integrates with existing soft-delete and sync patterns.
- **Runner-up:** Redis or similar dedicated cache — `innovation-leading` at scale; overkill for solo.

---

## Project exercises

### [B5.2] Prompt caching across chains

- **Exercise ID:** `[B5.2]`
- **What to build:** Audit each chain's SYSTEM_PROMPT length. For prompts above the cacheable threshold (1024 tokens on Sonnet, 2048 on Haiku), wrap the system block with `cache_control: { type: 'ephemeral' }` in the Anthropic call. For shorter prompts (most of loopd's today), document the threshold and skip. Re-evaluate when prompts grow.
- **Why it earns its place:** the highest-ROI cost lever in loopd's chain layer; small change, recurring savings.
- **Files to touch:** `src/services/ai/summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts`, `interpret.ts` — wrap system prompts where eligible.
- **Done when:** the eligible chains pass `cache_control` in their API calls; cache-creation tokens vs cache-read tokens are visible in the `[B1.2]` token log.
- **Estimated effort:** `1–4hr`.

### [B5.8] Semantic cache for interpret chain

- **Exercise ID:** `[B5.8]`
- **What to build:** A new local SQLite table `interpret_cache` with columns: `entry_id`, `entry_text_hash`, `chain_version`, `output_md`, `created_at`, `last_read_at`, sync columns. A wrapper around `interpretEntry()` that checks the cache before calling the model; on miss, stores the result. Invalidation: when `entries.updated_at` changes, the next read invalidates by hash mismatch.
- **Why it earns its place:** interpret is the most-expensive chain per call; re-tapping unchanged entries is the most-common cache-hit scenario.
- **Files to touch:** new `src/services/ai/interpretCache.ts`; new migration for `interpret_cache`; wraps `interpret.ts`.
- **Done when:** repeated interpret on unchanged entry returns in <50ms with no provider call; edit invalidates; cache hit rate appears in the AI ops panel.
- **Estimated effort:** `1–2 days`.

---

## Summary

LLM caching has two layers — provider-side prompt caching (90% discount on cached prefix tokens) and application-side semantic caching (zero cost on identical-input hits). In loopd this is not yet implemented; `[B5.2]` adds prompt caching where prompts exceed the cacheable threshold, and `[B5.8]` adds semantic caching for the interpret chain. The constraint that makes the two-layer approach right is that they save different costs and apply to different chains — caption benefits from prompt caching but not semantic; interpret benefits from both. The cost being paid until they ship is a few cents per month per user — small absolutely, meaningful at scale.

Key points to remember:
- Prompt cache = provider-side; saves 90% on input-side prefix tokens.
- Semantic cache = application-side; saves all cost on identical-input hits.
- Caption needs variability; semantic cache wrong there.
- Interpret needs stability; both caches right there.
- Cacheable prefix has a token threshold; check before assuming.

---

## Interview defense

### What an interviewer is really asking
"How do you cache LLM responses?" tests whether the candidate knows the two-layer split.

### Likely questions

  [mid] Q: What's the difference between prompt caching and semantic caching?
  A: Prompt caching is provider-side: the model reuses the KV cache for a cached prefix on repeated calls — pay full price for the prefix once, 10% afterward. Semantic caching is application-side: I store (input → output) in my own DB; on the next call with the same input, return cached without calling the model. They save different costs and apply to different patterns. Stable system prompts benefit from prompt caching across diverse inputs; repeatable-input chains (interpret on unchanged entries) benefit from semantic caching.
  Diagram:
  ```
  Prompt cache:     same prefix, different bodies → discount on prefix tokens
  Semantic cache:   same full input, no model call at all → instant, free
  ```

  [senior] Q: When does semantic caching hurt?
  A: Three cases. First, when variability is the feature — caption deliberately returns different variants on re-roll; caching would freeze the user on yesterday's caption forever. Second, when the cache key doesn't capture all the inputs — if caption depends on `recentCaptions` (last 5 from history) and you key only on the entry text, you cache a stale anti-repetition state. Third, when storage cost dominates — at very high volumes with low repeat-rate, caching is overhead without payoff. For loopd, interpret is the natural fit because it's stable-input, stable-output; caption is the natural anti-fit.
  Diagram:
  ```
  Picked: cache interpret, not caption     Suggested: cache everything
  ──────────────────────────────             ───────────────────────────
  Interpret: stable, same input = same out   Caption gets frozen
  Caption: variable, same input ≠ same out   Anti-repetition breaks
  Right: cache what's stable                 Wrong: cache what shouldn't be
  ```

  [arch] Q: At 10× scale, what changes?
  A: Three shifts. First, prompt caching becomes more valuable (every chain's prefix amortized across 10× calls). Second, semantic cache storage starts mattering — interpret outputs are ~1-5KB each; 10× users = 10× cache table size. Third, cache invalidation needs to scale: today an entry edit invalidates by hash, which is constant cost; at 10× this is still fine but starts being worth indexing.
  Diagram:
  ```
  Today (solo)         →  Prompt cache where threshold allows; semantic for interpret
  10× users            →  Prompt cache savings meaningful (~$5-10/mo)
  100× users           →  Cache table size matters; index entry_text_hash
  1000× users          →  Consider Redis for hot cache; eviction policies
  ```

### The question candidates always dodge
"What if the model output is non-deterministic? Can you still cache?" The honest answer: only if the user wants the same output back. Caching freezes the first response forever (until invalidation). For interpret, this is desired — re-tapping should give the same insight. For caption, it's wrong — re-roll should give different variants. The decision is about what the user expects, not about whether the model is deterministic.

```
Picked: cache where stability is desired     Suggested: cache where determ.
─────────────────────────────────             ─────────────────────────────
User-facing stability decides                 Model determinism decides
Interpret yes, caption no                     Both no (LLMs aren't fully det.)
```

### One-line anchors
- Two layers, two wins.
- Prompt cache: 90% discount on stable prefixes.
- Semantic cache: free on identical-input hits.
- Cache stability; don't cache variability.
- Threshold matters: check cacheable-prefix length before assuming.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the two-layer cache flow for interpret. Annotate where each cache lives and what it saves.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the two cache layers, (b) where each applies in loopd, (c) why caption is wrong for semantic caching, (d) the prompt-cache threshold.

### Level 3 — Apply it to a new scenario
A future loopd chain summarises last week's threads (one call per week, ~500 token input, ~2000 token system prompt). Without looking, decide whether prompt caching, semantic caching, both, or neither is right.

Open the Tradeoffs table and check whether your decision matches the "stable input + frequent re-runs" combination.

### Level 4 — Defend the decision you'd change
Today the plan is `[B5.8]` for interpret only. If you were starting today, would you add semantic caching to summarize too? Defend your answer.

### Quick check — code reference test
- What table holds the interpret semantic cache?
- What flag enables prompt caching on Anthropic?

Answer: `interpret_cache` (target — `[B5.8]`). `cache_control: { type: 'ephemeral' }` on the system block.
