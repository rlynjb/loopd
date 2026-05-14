# LLM cost optimization

**Industry name(s):** LLM cost optimization, model routing, prompt-length optimization, cost-quality trade-off
**Type:** Industry standard

> Five levers, in order of ROI — most apps pull the wrong one first.

**See also:** → [23-token-economics](./23-token-economics.md) · → [40-llm-caching](./40-llm-caching.md) · → [05-heuristic-before-llm](./05-heuristic-before-llm.md)

---

## Why care

A household's electric bill spikes three months in a row. The first instinct is to swap the bulbs for cheaper ones — that's the move that feels like effort. Walk through the house with a clamp meter instead: the dryer running half-empty twice a day costs more than every bulb combined, an always-on space heater in the hallway costs more than the dryer, and the dishwasher running before its full load could be skipped altogether by waiting four hours. The bulb swap was the temptation lever; the highest-ROI lever was "stop running the dryer when there's nothing to dry."

The implicit question is "where does the spend actually live, and which lever attacks it at the largest multiplier?" LLM cost optimization is the discipline of pulling levers in ROI order, not order-of-temptation. Five levers ranked: (1) heuristic-before-LLM skips the call entirely, (2) prompt caching saves 90% on stable prefixes, (3) semantic caching saves 100% on identical-input hits, (4) model routing buys ~5× cheaper inference on jobs that don't need premium quality, (5) prompt compression saves 10–30% but risks quality. Most teams pull lever 4 first because "use a cheaper model" feels like the senior-engineer move; the higher-ROI architectural levers stay untouched.

**What depends on getting this right:** total spend per chain, where engineering time goes, and whether quality regressions get shipped along with the savings. For loopd only Lever 1 is implemented today (classify's heuristic gates 60–70% of calls — see `[B1.5]` / `[B1.8]`); `[B5.2]` adds prompt caching across eligible chains, `[B5.8]` adds semantic caching for interpret, `[B5.3]` formalises model routing with eval evidence (likely candidate: expand on Haiku). Lever 2 is silently skipped today because most SYSTEM_PROMPTs sit below Anthropic's cacheable-prefix threshold (~1024 tokens for Sonnet 4.6, ~2048 for Haiku 4.5) — pulling it without checking would be a no-op. The prerequisite for any honest lever-pulling is per-chain token logs from `[B1.2]`; optimising without measurement is guessing where the cost lives.

Wrong order (temptation):
- Start with Lever 5 (compress prompts) → 10–30% reduction with real quality risk, eval cycles burned re-testing every chain
- Then Lever 4 (model routing) → ~5× per-chain, ships a subtle quality drop on the chain that needed Sonnet's depth
- Lever 1 never gets pulled; classify continues paying for every easy case the regex could have handled

Right order (ROI):
- Lever 1 first: classify heuristic gates 60–70% of calls; expand similar treatment if a heuristic exists for its easy cases
- Lever 2 next: audit prompt lengths; wrap `cache_control: { type: 'ephemeral' }` on eligible chains' SYSTEM_PROMPTs; cache-creation vs cache-read tokens visible in the `[B1.2]` log
- Lever 3: `interpret_cache` table for stable-input/stable-output chain; re-tap returns in <50ms with zero cost
- Lever 4: `[B5.3]` runs a 20-input quality eval of expand-on-Haiku vs expand-on-Sonnet; if rubric delta ≤5%, route; document decision in `docs/spec.md` or `docs/model-routing.md`
- Lever 5: only pulled if Levers 1–4 are exhausted and a chain's full-priced prefix still dominates spend

Cost is architectural, not configurational — pull levers in ROI order, not in order of temptation.

---

## How it works

Each lever attacks a different part of the cost equation. Cost per chain = `calls × (input_tokens × input_price + output_tokens × output_price)`.

### Lever 1: Skip the call entirely (heuristic-before-LLM)

The cheapest call is the call you don't make. A regex-based heuristic that handles 60-70% of the easy cases means 60-70% of the spend disappears. loopd already does this for classify (see [05-heuristic-before-llm](./05-heuristic-before-llm.md)). It's the highest-ROI lever and almost always the right first move.

For loopd specifically: classify uses this; nothing else does. Most other chains (summarize, caption, expand, interpret) have no heuristic floor and pay full price every time.

### Lever 2: Prompt caching (provider-side)

90% discount on input-side tokens for cached prefixes. See [40-llm-caching](./40-llm-caching.md) for the mechanics. Easy to add (~20 LOC). Constraint: prompt must exceed cacheable-prefix threshold and be stable across calls. loopd's chains have small system prompts (mostly below threshold today).

### Lever 3: Semantic caching (application-side)

100% discount on identical-input hits. Right for stable-input chains like interpret. ~100 LOC. Constraint: invalidation logic + variability isn't desired.

### Lever 4: Model routing (cheaper model for cheaper jobs)

Pick a cheaper model for jobs where the quality difference doesn't matter. Haiku 4.5 is ~5× cheaper than Sonnet 4.6 with notably worse quality on creative or nuanced tasks but adequate quality on structured / classification tasks. loopd routes classify to Haiku; everything else to Sonnet.

The bigger model-routing question: are we using Sonnet on jobs where Haiku would suffice? For loopd, probably yes on `expand` (the expand chain doesn't need Sonnet's reasoning depth for most types). Trying Haiku on expand with measured quality comparison is a real cost win if quality holds.

### Lever 5: Prompt compression

Make prompts shorter. Less context, fewer few-shot examples, tighter instructions. ROI per LOC is low — typically saves 10-30% on input-side cost but risks quality. Pull last.

### Order matters

```
Lever                       Cost impact     Effort       Quality risk
─────────────────────────   ──────────      ─────────    ────────────
1. Heuristic-before-LLM     60-90% of calls Moderate     Low (chain unchanged)
2. Prompt caching           90% on prefix   Low          None (auto)
3. Semantic caching         100% on hit     Moderate     Low (stable input)
4. Model routing            ~5× cheaper     Low + eval   Real (per-chain)
5. Prompt compression       10-30%          Low          Real (testing needed)
```

The practical consequence: most LLM-cost-optimization advice is about #4 or #5 because those feel like the moves a senior engineer would make. The highest-ROI moves are #1, #2, #3 — and they're underspoken because they require thinking about the chain's *shape*, not its *model*.

### Where cost optimization goes wrong

Three patterns:

1. **Optimizing without measuring** — picking a lever without per-chain token logs (see [23-token-economics](./23-token-economics.md)) means you're guessing where the cost lives.
2. **Quality regression invisible** — model routing without eval (see [36-eval-methods](./36-eval-methods.md)) ships subtle quality drops users feel before you measure them.
3. **Pulling lever 5 first** — prompt compression is the most tempting because it feels like craft; it's usually the least valuable.

### This is what people mean by "cost is architectural, not configurable"

The biggest cost wins come from architectural choices (heuristic gates, caching layers, routing decisions), not from configuration (which model, how long the prompt). The principle generalises beyond LLMs — in databases, the biggest perf wins are usually index choices and query restructuring, not connection-pool tuning. Here's the picture.

---

## LLM cost optimization — diagram

```
The five levers, in ROI order

  Lever 1: Heuristic-before-LLM
  ────────────────────────────────────────────────────
  Before:   30 todos/day → 30 LLM calls
  After:    30 todos/day → ~12 LLM calls (heuristic gates 60%)
  Win:      60% of classify spend disappears

  Lever 2: Prompt caching
  ────────────────────────────────────────────────────
  Before:   30 calls × (400 input + 100 output) × full price
  After:    30 calls × (40 cached + 60 non-cached input + 100 output) × full
  Win:      ~36% of input-side spend on caption chain

  Lever 3: Semantic caching
  ────────────────────────────────────────────────────
  Before:   User re-taps interpret on unchanged entry → full price
  After:    Cache hit → 0 cost, ~50ms
  Win:      100% on repeat interpret of same entry

  Lever 4: Model routing
  ────────────────────────────────────────────────────
  Before:   Expand on Sonnet → ~$0.005 per call
  After:    Expand on Haiku → ~$0.001 per call (if quality holds)
  Win:      80% of expand spend (after measurement)

  Lever 5: Prompt compression
  ────────────────────────────────────────────────────
  Before:   Interpret system prompt: 1200 tokens
  After:    Compressed: 800 tokens
  Win:      ~33% of input on interpret system prompt (last lever pulled)
```

---

## In this codebase

**Status:** Case B — only Lever 1 is implemented (classify's heuristic).

The plan in Phase 5:
- `[B5.2]` Prompt caching (Lever 2)
- `[B5.8]` Semantic cache for interpret (Lever 3)
- `[B5.3]` Formalize model routing policy (Lever 4)
- (No explicit Phase 5 build for Lever 5 — pulled last only if other levers exhausted.)

**File:** *(no aggregate-cost-optimization implementation yet)*
**Function / class:** *(each lever lives in its own file — see cross-references)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Cost-optimization discipline in LLM apps emerged around 2023-2024 once production spend got real. The lever-stack-in-ROI-order framing borrows from web performance optimization (lazy-load → cache → compress) and database optimization (index → query plan → schema).

### The deeper principle
Optimize the shape of the work before optimizing the cost-per-unit. The biggest gains are architectural, not configurational.

### Where this breaks down
The lever order assumes a chain you already understand. If you haven't measured (see [23-token-economics](./23-token-economics.md)), pulling levers is guessing. Order also flips at very different scales — at trivial scale, pulling any lever is over-engineering; at hyperscale, prompt compression starts mattering more than at medium scale.

### What to explore next
- [05-heuristic-before-llm](./05-heuristic-before-llm.md) → the implementation of Lever 1
- [40-llm-caching](./40-llm-caching.md) → Levers 2 and 3
- [23-token-economics](./23-token-economics.md) → measurement that makes the lever order honest

---

## Tradeoffs

### Comparison table — pulling levers in different orders

```
┌─────────────────────────┬──────────────────────┬─────────────────────┐
│ Cost dimension          │ ROI order (target)   │ Reverse order       │
├─────────────────────────┼──────────────────────┼─────────────────────┤
│ Cost reduction (typ.)   │ 60-90%               │ 10-30%              │
│ Engineering effort      │ Moderate (heuristic) │ High (testing)      │
│ Quality risk            │ Low (chain unchanged)│ Real (prompt/model) │
│ Time to first win       │ Days                 │ Weeks               │
│ Reversibility           │ High                  │ Low (regressions)   │
└─────────────────────────┴──────────────────────┴─────────────────────┘
```

### Sub-block 1 — what ROI-order gives up

Nothing structural; the order is genuinely better. The cost paid is *discipline* — resisting the urge to start with model routing because it feels like the smart move.

### Sub-block 2 — what reverse-order would have cost

Time, quality, and engineering effort wasted on a sequence of low-ROI moves. Compressing a prompt before adding a heuristic gate is doing the harder thing for ~5× less impact.

### Sub-block 3 — the breakpoint
The lever order is stable until pulling earlier levers exhausts their value. At that point, the marginal-ROI of lever N+1 exceeds lever N. For loopd, this happens roughly when (Levers 1+2+3) have saved >50% of LLM spend and the remaining 50% is dominated by full-priced model calls — at which point model routing becomes the next win.

### What wasn't actually a tradeoff
Not measuring before optimizing was never an option. Token-economics observability (Phase 1's `[B1.2]`) is the prerequisite for any informed cost-optimization decision.

---

## Tech reference (industry pairing)

### Per-chain model routing (cost-quality matrix)

- **Codebase uses:** loopd routes classify to Haiku; the rest run on Sonnet by default.
- **Why it's here:** the cheapest credible decision-knob in production LLM apps.
- **Leading today:** explicit per-chain routing — `adoption-leading`, 2026.
- **Why it leads:** explicit; debuggable; falls in line with provider-abstracted chain layer.
- **Runner-up:** dynamic routing based on input characteristics — `innovation-leading`; e.g., routing short inputs to Haiku and long ones to Sonnet. Pays off at scale.

### Cost-aware libraries (LiteLLM, OpenRouter)

- **Codebase uses:** not used; loopd's provider abstraction is custom.
- **Why it's here:** they pool routing logic, cost tracking, and fallback into one library.
- **Leading today:** OpenRouter — `innovation-leading` for multi-provider routing, 2026.
- **Why it leads:** unifies billing across providers; routes by configured rules; cost telemetry built in.
- **Runner-up:** custom routing in your service layer — `adoption-leading` for codebases that prefer no framework dependencies.

---

## Project exercises

### [B5.3] Formalize model routing policy

- **Exercise ID:** `[B5.3]`
- **What to build:** A section in `docs/spec.md` (or a new `docs/model-routing.md`) that names each chain, the model it currently uses, the rationale, and the threshold at which it would migrate to a different model. For each chain, run a 20-input quality eval on the next-cheaper-tier (e.g., expand on Haiku vs Sonnet) and document the quality delta. If delta is small (eval-judge or rubric ≤5% worse), consider routing.
- **Why it earns its place:** "we route" is a claim; the doc is the receipt. Plus the eval-driven decision keeps Sonnet on the chains that need it and moves the others.
- **Files to touch:** new doc; possible chain-level config changes in `src/services/ai/config.ts`.
- **Done when:** the doc names per-chain model rationale; at least one chain has been evaluated for cheaper-model viability; if a chain moved, the change is documented with eval evidence.
- **Estimated effort:** `1–2 days`.

### Cross-link — Lever 1 (`[B1.5]`, `[B1.8]`), Lever 2 (`[B5.2]`), Lever 3 (`[B5.8]`)

- **Exercise ID:** see each cross-referenced file's Project exercises.
- **What to build:** each lever is implemented in its respective concept file; this one is the *orchestration* and *prioritization* file.
- **Why it earns its place:** to ensure the levers are pulled in ROI order rather than the order they happen to come to mind.
- **Files to touch:** *(this file's role is documentation + orchestration)*.
- **Done when:** all four levers have been pulled or explicitly skipped with documented reason; aggregate cost reduction is measured and documented.
- **Estimated effort:** ongoing through Phase 5.

---

## Summary

LLM cost optimization is the discipline of pulling cost levers in ROI order — skip-the-call > prompt cache > semantic cache > model routing > prompt compression. In loopd only Lever 1 is implemented (classify's heuristic). The constraint that makes ROI-order the right discipline is that architectural levers (skip, cache) deliver 60-90% reductions while configurational levers (model swap, prompt compression) typically deliver 10-30% — pulling levers in temptation-order leaves the biggest wins on the table. The cost being paid until the higher-ROI levers ship is roughly 50-70% of avoidable LLM spend.

Key points to remember:
- Five levers, ordered by ROI: skip > prompt-cache > semantic-cache > model > compress.
- Measure first (see [23-token-economics](./23-token-economics.md)) — optimizing without measurement is guessing.
- Lever 1 is loopd's biggest existing win (classify heuristic gates 60-70%).
- Levers 2-3 are next; both ship cleanly with small code changes.
- Lever 5 (compression) is last — high effort, low ROI, real quality risk.

---

## Interview defense

### What an interviewer is really asking
"How do you reduce LLM costs?" tests whether the candidate has the lever-stack mental model or only knows model swapping. The follow-up about ROI order separates senior candidates.

### Likely questions

  [mid] Q: What levers do you have to reduce LLM cost?
  A: Five, in ROI order. First, skip the call entirely with a heuristic — loopd's classify does this and saves 60-70% of classify spend. Second, prompt caching for stable prefixes — 90% discount on cached input. Third, semantic caching for identical inputs — free on hits, applies to interpret. Fourth, model routing — cheaper model for cheaper jobs. Fifth, prompt compression — last lever pulled because effort-to-impact ratio is worst.
  Diagram:
  ```
  Lever                   Win        Effort     Order
  ─────                   ─────      ─────      ─────
  1. Heuristic gate       60-90%     Med        First
  2. Prompt cache         90% prefix Low        Second
  3. Semantic cache       100% hit   Med        Third
  4. Model routing        ~5× chain  Low+eval   Fourth
  5. Prompt compress      10-30%     Low        Last
  ```

  [senior] Q: Why is model routing usually overrated?
  A: Because it feels like the obvious "senior engineer" move, but it's typically pulling lever 4 before lever 1, 2, or 3. The biggest cost reductions are architectural — skip the call, cache the prefix, cache the response — not configurational. Model routing helps but at a smaller multiplier than the architectural moves and at higher quality risk. The discipline is measuring first (where does the cost actually live?) and then pulling levers in ROI order.
  Diagram:
  ```
  Picked: ROI-order discipline       Suggested: model-swap first
  ────────────────────────           ────────────────────────
  Lever 1-3 first: 60-90% wins        Lever 4 first: 10-30% wins
  Architectural changes               Config-only changes
  Right order: measure → skip → cache  Wrong order: feels easy first
  ```

  [arch] Q: At 100× users, what additional levers appear?
  A: Three. First, batching — many providers offer batch APIs (50% discount, longer latency). Useful for chains where the user isn't waiting (background scheduled work). Second, fine-tuning — at very high volume, a fine-tuned cheaper model can match Sonnet quality on a specific task. Third, on-device inference — for some chains (classify especially), a quantized smaller model running on device eliminates per-call cost entirely. None of these earn their place at solo scale.
  Diagram:
  ```
  Today          →  Levers 1-5
  10× users      →  Levers 1-5 + tighter eval cycles
  100× users     →  + batch APIs for non-interactive chains
  1000× users    →  + fine-tuning per chain + on-device for classify
  ```

### The question candidates always dodge
"Why hasn't loopd pulled Lever 2 yet?" The honest answer: most of loopd's chain SYSTEM_PROMPTs are below Anthropic's cacheable-prefix threshold (1024 tokens for Sonnet, 2048 for Haiku) as of late 2025. Until prompts grow or the threshold drops, prompt caching is silently skipped by the provider. The right action is to document the threshold per chain and revisit when it changes.

```
Picked: skip Lever 2 for now            Suggested: implement Lever 2 anyway
─────────────────────────────             ─────────────────────────────
Prompts below threshold                  No-op savings
Documented decision                      "We have caching" claim that doesn't work
Right at small prompts                   Right at large prompts
```

### One-line anchors
- Five levers, ROI-ordered.
- Measure before optimizing.
- Skip the call beats every other optimization.
- Model routing is overrated as a first move.
- Prompt compression is last, not first.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the five levers in ROI order. Annotate the win, effort, and quality risk of each.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the five levers in ROI order, (b) why measurement comes before optimization, (c) why model routing is overrated as a first move, (d) what's blocking Lever 2 in loopd today.

### Level 3 — Apply it to a new scenario
loopd ships `[B5.2]` and `[B5.8]`. Per-chain spend is now: classify $0.10/mo, summarize $1.20/mo, caption $0.80/mo, expand $2.50/mo, interpret $0.40/mo. Without looking, predict which lever to pull next and why.

Open the comparison table and check whether your prediction matches the "expand on Haiku" possibility.

### Level 4 — Defend the decision you'd change
Today loopd routes classify to Haiku and everything else to Sonnet. If you were starting today, would you route summarize to Haiku by default? Defend your answer.

### Quick check — code reference test
- Which lever is loopd's biggest existing win?
- Where is the model routing decision made?

Answer: Lever 1 (heuristic-before-LLM in classify). `getProvider()` and per-chain model selection in `src/services/ai/config.ts`.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (household-clamp-meter-walkthrough scenario → "where does spend live and which lever attacks it at the largest multiplier" pattern naming → bolded "what depends on getting this right" with `[B1.2]` / `[B5.2]` / `[B5.3]` / `[B5.8]` / `interpret_cache` stakes → wrong-order/right-order bullets walking the five levers → one-line "cost is architectural, not configurational" metaphor).
