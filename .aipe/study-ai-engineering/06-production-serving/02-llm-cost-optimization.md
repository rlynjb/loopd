# LLM cost optimization

**Industry name(s):** LLM cost optimization, model routing, cheap-first
**Type:** Industry standard

> Five levers, ranked by impact: heuristic-before-LLM (don't call), model routing (cheap model when capability sufficient), prompt caching (provider-side), shorter outputs (output cost dominates), batch processing. Measure per chain first; optimize the actual cost driver, not the one you happen to be working on.

**See also:** → [`01-llm-foundations/06-token-economics`](../01-llm-foundations/06-token-economics.md) · → [`01-llm-foundations/07-heuristic-before-llm`](../01-llm-foundations/07-heuristic-before-llm.md) · → [01-llm-caching](./01-llm-caching.md)

---

## Why care

### Move 1 — The grounded scenario

Buffr's monthly bill is $87. You want to cut it. Default move: "switch to a cheaper model" across the board. Without measurement, you switch summarize from Sonnet to Haiku; quality drops; users notice. Turns out summarize was $5 of the $87 — the cost driver was interpret at $72. You optimized the wrong chain.

### Move 2 — Name the question the pattern answers

That which-lever question is what cost optimization answers. Not "which is cheapest" (per-chain depends); just *what's the order to pull levers and what data tells me to pull which one*.

### Move 3 — Why answering that question matters

**What breaks without ordered levers:** random optimization. Quality drops on chains that didn't need it; the actual cost driver stays unfixed. The order matters because the levers compound.

### Move 4 — Concrete before/after

Without ordered levers:
- Switch all chains to cheaper model
- Quality drops; bill drops modestly
- Half the wins reverse when you revert to Sonnet on the chain that broke

With ordered levers:
- Measure (B1.2 logging) → identify interpret as the cost driver
- Add prompt caching (B5.2) → ~30% savings on shared prefix
- Switch interpret to Haiku for first draft, Sonnet for refinement (B5.3) → big additional savings
- Add semantic cache for repeat queries (B5.8) → marginal
- Total: 50% cost reduction without quality loss

### Move 5 — The one-line summary

Five levers ranked: don't call (heuristic), call cheaper (model routing), cache, shorten output, batch. Measure before pulling; the order matters.

---

## How it works

### Move 1 — The mental model

```
   Request
     │
     ▼
   ┌─────────────────────┐
   │ Heuristic short-    │   90% cost cut on chains it applies to
   │ circuit (if any)    │
   └─────────┬───────────┘
             │ miss
             ▼
   ┌─────────────────────┐
   │ Cheap model first   │   50-70% cost cut on chains where
   │ (if quality enough) │   capability is sufficient
   └─────────┬───────────┘
             │ if insufficient
             ▼
   ┌─────────────────────┐
   │ Expensive model     │   full cost on chains that genuinely
   │ fallback            │   need it
   └─────────────────────┘

   Plus orthogonal levers:
   ┌─────────────────────┐
   │ Prompt caching      │   90% cut on cached prefix tokens
   │ Shorter outputs     │   output cost is 3-5× input cost
   │ Batch processing    │   2x discount on async batches
   └─────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — measure first.** Per-chain logging (concept `01-llm-foundations/06`). Without it, optimization is guesswork. Buffr's planned `B1.2` is the gate.

**Layer 2 — pull levers in order.**
1. Heuristic short-circuit: biggest impact on chains where rules cover most inputs (buffr's classifier).
2. Model routing: cheap model first, expensive fallback only when quality demands.
3. Caching: provider prompt cache plus your own exact-match.
4. Output length: cut output budget; concise schemas.
5. Batch: where you can defer (background jobs).

**Layer 3 — buffr-specific moves.**
- Classifier: already heuristic-first (concept 07). No new lever.
- Summarize: shared system prompt across all daily calls → prompt caching (B5.2).
- Interpret: largest output → shorter output budget OR run Haiku for first draft, Sonnet for refinement (B5.3 model routing policy).
- Caption: 4 variants — could batch the 4 calls as one (cost saving) but quality may drop.

```
   Lever applicability to buffr's chains
   ─────────────────────────────────────
   classifier:  heuristic ✓; model routing (Haiku ✓); cache ✗ (one-off inputs)
   summarize:   heuristic ✗; cheap model? maybe; prompt cache ✓
   caption:     heuristic ✗; cheap model? probably no; prompt cache ✓
   expand:      heuristic ✗; cheap model? maybe; prompt cache ✓
   interpret:   heuristic ✗; cheap model ✗ (quality-sensitive); prompt cache ✓;
                shorter output? maybe
```

### Move 3 — The principle

Measure → pull levers in order → re-measure. Don't pull until you know which chain is the cost driver. The order matters because earlier levers compound.

---

## Cost optimization — diagram

```
┌─ Optimization order ───────────────────────────────────────────────────┐
│                                                                        │
│   measure per-chain cost (B1.2)                                        │
│         │                                                              │
│         ▼                                                              │
│   identify highest-cost chain                                          │
│         │                                                              │
│         ▼                                                              │
│   pull levers in order:                                                │
│     1. heuristic-before-LLM (if applicable)                            │
│     2. cheap model first (if quality permits)                          │
│     3. prompt caching (always)                                         │
│     4. shorter output (always)                                         │
│     5. batch (if latency tolerates)                                    │
│         │                                                              │
│         ▼                                                              │
│   re-measure; verify quality preserved                                 │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A (partial) — buffr exercises heuristic-before-LLM (classifier) and model routing (Haiku for classifier, Sonnet for the others).**

**Case B:**
- Prompt caching (`B5.2`)
- Output budget trimming on interpret
- Batch processing (no clear use case for buffr)

Per-chain logging (`B1.2`) is the gate to know which optimization to pull.

---

## Elaborate

### The deeper principle

Order matters because levers compound. Pulling levers blindly produces local wins and global drift.

### Where this breaks down

For low-volume systems (buffr single-user), aggressive cost optimization is over-engineered. The bill is small enough that quality preservation matters more than absolute savings.

### What to explore next

- [`01-llm-foundations/06-token-economics`](../01-llm-foundations/06-token-economics.md) — the measurement gate
- [01-llm-caching](./01-llm-caching.md) — lever 3

---

## Tradeoffs

The breakpoint: optimize when bill is meaningful (>$50/month for buffr-scale apps). Below that, measure but don't sweat.

---

## Tech reference

- **Anthropic prompt caching:** `cache_control: { type: "ephemeral" }`.
- **Model routing:** Haiku 4.5 for fast/cheap; Sonnet 4.6 for quality.

---

## Project exercises

### B5.3 — Model routing policy

- **Exercise ID:** `B5.3`
- **What to build:** document the model-per-chain decisions in `docs/spec.md`; codify in `src/services/ai/config.ts`.
- **Done when:** every chain has a documented model + rationale.
- **Estimated effort:** 1 hour.

---

## Summary

- Five levers, ordered.
- Measure first (`B1.2`).
- Buffr exercises heuristic + model routing today; caching and output trimming are Case B.

---

## Interview defense

**Q [mid]:** What order do you pull cost levers?

**A:** Heuristic-before-LLM first (biggest impact when it applies; cuts the call rate). Model routing second (cheap model when capability is sufficient). Prompt caching third (90% savings on shared prefix). Output length fourth (output costs 3-5× input). Batch fifth (where latency tolerates). The order matters because earlier levers compound — if heuristic short-circuits 70% of calls, the cost of optimizing the LLM path drops 70%.

### One-line anchors

- Five levers, ordered.
- Measure per chain before optimizing.
- Heuristic first; output length last.

---

## Validate

### Quick check
- What's the first lever?
- What enables informed optimization?
- Which buffr chain dominates cost (likely)?
