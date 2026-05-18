# LLM caching

**Industry name(s):** Prompt caching, semantic cache, LLM response cache, KV cache reuse
**Type:** Industry standard

> Two different caches at two different layers — each saves a different kind of cost.

**See also:** → [23-token-economics](./23-token-economics.md) · → [41-llm-cost-optimization](./41-llm-cost-optimization.md) · → [14-interpret](./14-interpret.md)

---

## Why care

A modern web app runs two cache layers side by side. One: Cloudflare's edge cache holds the stable parts of every response — CSS, JS bundles, immutable assets — keyed by URL, shared across every visitor who hits the same route. Two: the React Query cache on the client holds the user-specific data the logged-in user just fetched — their profile, their issues — keyed by `(queryKey, userId)`, specific to this user's repeat reads. Two completely different savings: one shared across many visitors at the edge layer, one specific to this user's identical inputs. The Anthropic Console's prompt-cache stats panel exposes the same split for LLM calls — `cache_creation_input_tokens` vs `cache_read_input_tokens` per call.

The implicit question is "at which layer is the work being repeated, and what kind of cache catches it?" LLM caching is the answer split into two: prompt caching is provider-side (KV-cache reuse on a stable prefix — Anthropic `cache_control`, OpenAI automatic; 90% discount on cached input tokens, threshold ~1024 for Sonnet 4.6 / ~2048 for Haiku), and semantic caching is application-side (store input → output keyed on a hash; on identical input, skip the model entirely). They save different costs and apply to different chains — stable prompts across diverse inputs vs identical inputs across the same prompt.

**What depends on getting this right:** which chains pay full price for repeat work and which don't, and which chains stay variable when variability is the feature. For buffr `[B5.2]` adds Anthropic `cache_control` to eligible chains' SYSTEM_PROMPTs (audit length first — caption's ~600-token prompt is *below* Sonnet 4.6's cacheable threshold today, so caching is silently skipped; interpret's prompt qualifies). `[B5.8]` adds a local `interpret_cache` table keyed on (entry_id, entry_text_hash, chain_version) — re-tapping interpret on an unchanged entry returns in <50ms with no provider call. Caption is the explicit anti-fit for semantic caching — variability is the feature, anti-repetition history depends on `recentCaptions`, the cache would freeze the user on yesterday's caption forever.

Without either cache:
- User taps interpret on an unchanged entry → full $0.01–0.03 + 2–5 seconds; tap again ten seconds later → full $0.01–0.03 + 2–5 seconds again
- Every chain's static SYSTEM_PROMPT pays full input-token price across thousands of calls
- Solo scale loses pennies; multi-tenant at 100k users loses ~90% of input-side spend (~$5–10/mo and up)

With both caches layered:
- Prompt cache (provider-side): wrap eligible SYSTEM_PROMPTs with `cache_control: { type: 'ephemeral' }`; first call pays full price + creates the cache, subsequent calls pay ~10% on the cached prefix; visible in the `[B1.2]` token log as cache-creation vs cache-read tokens
- Semantic cache (application-side): `interpret_cache` row created on miss; next read with the same (entry_text_hash, chain_version) returns instant, free; edit invalidates by hash mismatch; sync columns ride the existing `schedulePush` pattern
- Caption: prompt cache eligible (once prompt grows past threshold), semantic cache wrong — re-roll must produce different variants; the anti-repetition state depends on `recentCaptions` outside the cache key

The semantic cache saves all the cost on hits; the prompt cache saves 90% on prefixes when the semantic cache misses — two layers, two wins, two different chains earn each.

---

## How it works

The two caches operate at different layers and answer different questions.

The two caches and their interaction in one picture:

```
   incoming call:                  chain(input)
                       │
                       ▼  check #1: semantic cache (app-side)
                       │
   ┌────────────────────────────────────────────────────┐
   │ Layer 1: semantic cache (your DB)                    │
   │   key:   hash(input + chain_version)                 │
   │   value: cached output (full markdown / full JSON)   │
   │                                                       │
   │   on HIT → return cached, skip model entirely          │
   │             cost: 0 dollars, ~50ms                     │
   │   on MISS → fall through to layer 2                    │
   └────────────────────┬───────────────────────────────┘
                        │  miss
                        ▼
                       check #2: prompt cache (provider-side)
                       │
   ┌────────────────────────────────────────────────────┐
   │ Layer 2: prompt cache (Anthropic / OpenAI side)      │
   │   provider stores the KV-cache for stable prefixes    │
   │   (your SYSTEM_PROMPT marked with cache_control)      │
   │                                                       │
   │   on HIT → 10% of normal input-token cost for the     │
   │             cached portion; output still full price    │
   │             cost: ~$0.001-0.005, ~2-5s                 │
   │   on MISS → full input + output cost                   │
   │             cost: ~$0.01-0.03, ~2-5s                   │
   └────────────────────┬───────────────────────────────┘
                        │
                        ▼
                       save output to semantic cache
                       (if the chain is semantic-cache-eligible)
                       │
                       ▼
                       return output to caller

   the two save different things:
     semantic cache → ALL the cost on identical inputs
     prompt cache   → 90% of input cost on identical prefixes
                       (still pays output cost every time)
```

The four sub-sections below trace each layer, how they compose, and where prompt caching's threshold makes it silently no-op.

### Prompt caching (provider-side)

Models compute attention over the input sequence token-by-token. The transformer's intermediate "KV cache" (key-value attention state) at each layer is expensive to compute the first time, cheap to reuse if you replay the same prefix.

Providers expose this as a *cacheable prefix*: mark part of your prompt as cacheable, and on the second call with the same prefix, you pay ~10% of the input-token cost for cached portions. Anthropic does this explicitly with `cache_control`; OpenAI does it automatically.

For buffr: every chain has a static SYSTEM_PROMPT (~100-300 tokens). Wrapping it with `cache_control` means the system prompt is paid full price once, then 10% per call afterward. The 90% discount compounds across thousands of calls.

If you're coming from frontend, this is similar to a CDN cache for static assets — the static system prompt is your asset; the cache pays for storage; you get a discount on reads.

Anthropic's prompt-cache markup, with what changes per call:

```
   first call (cache creation):
   client.messages.create({
     model: 'claude-sonnet-4-6',
     system: [{
       type: 'text',
       text: LONG_SYSTEM_PROMPT,           ◄── ~2000 tokens
       cache_control: { type: 'ephemeral' } ◄── mark as cacheable
     }],
     messages: [{ role: 'user', content: input }]
   });
   
   response.usage = {
     cache_creation_input_tokens: 2000,     ◄── paid full + 25% premium
     cache_read_input_tokens: 0,             ◄── cache didn't exist yet
     input_tokens: 50,                       ◄── the dynamic user input
     output_tokens: 200
   };
   
   subsequent call (cache hit):
   (same call shape, same SYSTEM_PROMPT)
   
   response.usage = {
     cache_creation_input_tokens: 0,
     cache_read_input_tokens: 2000,          ◄── 90% discount on cached
     input_tokens: 50,                       ◄── dynamic part full price
     output_tokens: 200
   };
   
   cache_read_input_tokens billed at ~10% of normal input rate.
   90% saving on the 2000-token prefix, every call after the first.
```

The 90% discount compounds — once you're past the cache-creation premium, every call is mostly free on the input side.

### Semantic caching (application-side)

For chains whose output is deterministic given the input (or where re-running gives slightly different output but the user wants the same one), cache `(input → output)` in your own DB. On second call with the same input, skip the model entirely.

For buffr: `interpret(entry)` returns markdown the user reads. If they tap "interpret" on an unchanged entry twice, today you call the model twice — costing $0.01-0.03 per call. A semantic cache stores the markdown keyed by `(entry.text, entry.updated_at, chain_version)`. On second call with the same key, return cached. Free, instant.

The `interpret_cache` table shape, with hit/miss/invalidate flow:

```
   interpret_cache table:
   ┌──────────┬──────────────────┬───────────────────────────┬──────────────┐
   │ entry_id │ entry_text_hash  │ markdown                  │ chain_version │
   ├──────────┼──────────────────┼───────────────────────────┼──────────────┤
   │ e-12     │ 'abc123...'      │ '## Today\n\nI worked...'  │ '2.1.0'      │
   │ e-45     │ 'def789...'      │ '## Patterns\n\nThe...'     │ '2.1.0'      │
   └──────────┴──────────────────┴───────────────────────────┴──────────────┘

   user taps interpret on entry e-12:
     ▼
   compute hash(entry.text) = 'abc123...'
     ▼
   SELECT markdown FROM interpret_cache
     WHERE entry_id = 'e-12'
       AND entry_text_hash = 'abc123...'
       AND chain_version   = '2.1.0';
     ▼
   ┌────────────────────────────────────────┐
   │ HIT → return cached markdown            │
   │   cost: 0, latency: ~50ms                │
   │   no provider call                        │
   ├────────────────────────────────────────┤
   │ MISS → run interpret(entry.text)         │
   │   cost: ~$0.005, latency: ~3-5s          │
   │   INSERT into interpret_cache             │
   └────────────────────────────────────────┘

   invalidation:
     user edits entry.text → hash changes
       → next interpret() call: hash mismatch → MISS → re-compute
       → old row stays until cleanup (cheap; rare)
   
   chain version bump (prompt change):
     deploy with chain_version = '2.2.0'
       → every entry's old cache row mismatches on chain_version
       → next interpret() call → MISS → fresh markdown with new prompt
       → old rows can be lazily evicted
```

The hash-on-input strategy makes invalidation free — the user edits text, the hash changes, the next call misses naturally.

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
- System prompts are stable across calls (buffr: yes, every chain).
- System prompts are long enough to matter — Anthropic's minimum cacheable prefix is ~1024 tokens for Sonnet 4.6, ~2048 for Haiku. Below the threshold, caching is silently skipped.
- Volume is high enough to amortize the (small) cache-creation premium on the first call.

The cacheable-prefix threshold per buffr chain:

```
   chain         current SYSTEM_PROMPT length    cacheable (Sonnet 4.6)?
   ──────────    ─────────────────────────       ───────────────────────
   summarize     ~1500 tokens                     YES (above 1024)
   caption       ~600 tokens                       NO  (below 1024;
                                                    silently skipped today)
   classify      ~150 tokens                       NO  (below 1024)
   expand        ~1200 tokens                      YES (above 1024)
   interpret     ~2200 tokens                      YES (above 1024)

   below-threshold rows: the cache_control marker is accepted
   but silently has no effect — no cache_creation tokens, no
   cache_read tokens, no discount.
   
   audit cost: 5 minutes per chain to count tokens via tiktoken.
   the silent-skip is the trap — you THINK you're caching but
   you aren't, until you check the response.usage fields.
```

Audit the prompt length before claiming the cache works; the threshold is the trap.

Hurts when:
- System prompts change frequently (rotation prompts, dynamic context). Every change invalidates the cache.
- Prompts are short (below the threshold).
- Volume is too low to amortize.

For buffr: caption has the longest SYSTEM_PROMPT (~600 tokens) which is *below* the cacheable threshold for Sonnet 4.6. Caching wouldn't help today; would help if the prompt grew, or if the threshold dropped.

### Where semantic caching helps and hurts

Helps when:
- Inputs are repeatable (same entry, same query).
- Output is deterministic enough that returning cached is acceptable.
- Re-computation cost is high.

Hurts when:
- Inputs are unique (rare to see twice).
- Variability is desired (creative outputs, varied captions).
- Cache invalidation is hard (input changed, but how to detect?).

For buffr: interpret is the natural candidate — same entry, same interpret call, user expects same output. Caption is *not* a good candidate — re-running caption should give *different* variants each time to fight repetition.

### This is what people mean by "two caches, two wins"

Provider-side and application-side caches save different costs. Most production apps benefit from both. The discipline is matching the cache to the chain's properties. Here's the picture.

---

## LLM caching — diagram

```
The two cache layers for buffr's interpret chain

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
Caching's value scales with call volume. At buffr solo (~30 calls/day), the absolute dollar savings are small but the discipline is correct. At 100k users, prompt caching alone would save ~90% on input-side spend across all chains — a non-trivial number.

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
- **Why it's here:** buffr's local-first architecture; cache colocated with canonical data.
- **Leading today:** application-side semantic cache — `adoption-leading` for repeatable-input chains, 2026.
- **Why it leads:** zero new infrastructure; integrates with existing soft-delete and sync patterns.
- **Runner-up:** Redis or similar dedicated cache — `innovation-leading` at scale; overkill for solo.

---

## Project exercises

### [B5.2] Prompt caching across chains

- **Exercise ID:** `[B5.2]`
- **What to build:** Audit each chain's SYSTEM_PROMPT length. For prompts above the cacheable threshold (1024 tokens on Sonnet, 2048 on Haiku), wrap the system block with `cache_control: { type: 'ephemeral' }` in the Anthropic call. For shorter prompts (most of buffr's today), document the threshold and skip. Re-evaluate when prompts grow.
- **Why it earns its place:** the highest-ROI cost lever in buffr's chain layer; small change, recurring savings.
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

LLM caching has two layers — provider-side prompt caching (90% discount on cached prefix tokens) and application-side semantic caching (zero cost on identical-input hits). In buffr this is not yet implemented; `[B5.2]` adds prompt caching where prompts exceed the cacheable threshold, and `[B5.8]` adds semantic caching for the interpret chain. The constraint that makes the two-layer approach right is that they save different costs and apply to different chains — caption benefits from prompt caching but not semantic; interpret benefits from both. The cost being paid until they ship is a few cents per month per user — small absolutely, meaningful at scale.

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
  A: Three cases. First, when variability is the feature — caption deliberately returns different variants on re-roll; caching would freeze the user on yesterday's caption forever. Second, when the cache key doesn't capture all the inputs — if caption depends on `recentCaptions` (last 5 from history) and you key only on the entry text, you cache a stale anti-repetition state. Third, when storage cost dominates — at very high volumes with low repeat-rate, caching is overhead without payoff. For buffr, interpret is the natural fit because it's stable-input, stable-output; caption is the natural anti-fit.
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
In under 90 seconds, explain: (a) the two cache layers, (b) where each applies in buffr, (c) why caption is wrong for semantic caching, (d) the prompt-cache threshold.

### Level 3 — Apply it to a new scenario
A future buffr chain summarises last week's threads (one call per week, ~500 token input, ~2000 token system prompt). Without looking, decide whether prompt caching, semantic caching, both, or neither is right.

Open the Tradeoffs table and check whether your decision matches the "stable input + frequent re-runs" combination.

### Level 4 — Defend the decision you'd change
Today the plan is `[B5.8]` for interpret only. If you were starting today, would you add semantic caching to summarize too? Defend your answer.

### Quick check — code reference test
- What table holds the interpret semantic cache?
- What flag enables prompt caching on Anthropic?

Answer: `interpret_cache` (target — `[B5.8]`). `cache_control: { type: 'ephemeral' }` on the system block.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (coffee-shop-frothed-milk-and-regular's-order scenario → "which layer is the work being repeated" pattern naming → bolded "what depends on getting this right" with `[B5.2]` / `[B5.8]` / `interpret_cache` / `cache_control` stakes → without/with bullets walking interpret vs caption fit → one-line "two layers, two wins, two different chains earn each" metaphor).

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care to anchor on real software (replaced coffee-shop-two-savings analogy with the Cloudflare edge cache + React Query cache split, plus the Anthropic Console prompt-cache stats panel).

---
Updated: 2026-05-14 — v1.32.0 pass: R1 no-op (Why care + How it works Move 1 already at level-3/4 — Cloudflare edge cache + React Query cache + Anthropic Console are engineering surfaces, acceptable). Added Move 1 mnemonic diagram (two-layer cache flow: semantic-first then prompt-cache fallthrough; cost/latency per outcome) + 3 new Move 2 sub-section diagrams: Anthropic cache_control markup with usage-field changes between first vs subsequent calls, interpret_cache table shape with hit/miss/invalidate flow, prompt length threshold per chain showing which silently skip. Sub-section 3 already had a code-flow diagram. Total: 4 new diagrams.
