# LLM-as-judge bias

**Industry name(s):** LLM-judge bias, position bias, verbosity bias, self-preference bias
**Type:** Industry standard

> LLM-as-judge is cheap but biased. Three known biases: position (prefers first variant), verbosity (prefers longer), self-preference (prefers outputs from same model family). Design around each.

**See also:** → [02-eval-methods](./02-eval-methods.md) · → [01-eval-set-types](./01-eval-set-types.md) · → [`01-llm-foundations/08-provider-abstraction`](../01-llm-foundations/08-provider-abstraction.md)

---

## Why care

### Move 1 — The grounded scenario

You eval buffr's 4 caption variants using Claude as the LLM-judge. The judge consistently rates variant 1 highest. You check — variant 1 is `clean`; the rubric says clean should usually be the runner-up to punchy. Why is the judge biased toward variant 1? Position bias: the judge sees variants 1-2-3-4 in order; it favours the first regardless of content.

### Move 2 — Name the question the pattern answers

That is-the-judge-actually-judging question is what bias awareness answers. Not "should I use LLM-as-judge" (cost says yes); just *which biases will distort the scores, and how do I mitigate them*.

### Move 3 — Why answering that question matters

**What breaks without bias mitigation:** scores are confidently wrong. The eval reports "variant 1 wins" when reality is "the judge prefers position 1."

### Move 4 — Concrete before/after

Without mitigation:
- Variants 1-4 evaluated in fixed order
- Variant 1 wins 70% of the time regardless of content
- Eval is biased; ship decisions based on misleading scores

With mitigation:
- Randomize order per evaluation
- Use a different model family as judge
- Penalize length in rubric or cap variant length
- Variant 1's win rate matches its actual quality

### Move 5 — The one-line summary

Three biases (position, verbosity, self-preference); three mitigations (randomize order, cap or include length in rubric, cross-family judging).

---

## How it works

### Move 1 — The mental model

```
   ┌─ Position bias ───────────────────────────────┐
   │  Judge prefers whichever variant appears       │
   │  first. Fix: randomize order per evaluation.   │
   └────────────────────────────────────────────────┘

   ┌─ Verbosity bias ──────────────────────────────┐
   │  Judge prefers longer responses. Fix: cap     │
   │  length or include length as a rubric         │
   │  dimension.                                    │
   └────────────────────────────────────────────────┘

   ┌─ Self-preference ─────────────────────────────┐
   │  Judge prefers outputs from the same model    │
   │  family. Fix: use a different model family     │
   │  as judge than the one being judged.           │
   └────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — position bias.** When judging multiple variants in a list, the judge over-weights the first (or last) position. Mitigation: randomize order per evaluation; if A is judged against B, also judge B against A; aggregate.

**Layer 2 — verbosity bias.** Longer responses are rated higher (more thorough-looking). Mitigation: cap response length before judging, OR include length as a scored dimension so the rubric explicitly counts it.

**Layer 3 — self-preference.** Claude judges Claude outputs more favourably than GPT outputs (and vice versa). Mitigation: cross-family judging. For buffr, when evaluating Claude-produced captions, use GPT as the judge; when evaluating GPT-produced classifications, use Claude.

```
   Cross-family judging
   ────────────────────
   chains run on Claude → judge with GPT-4o
   chains run on GPT-4o → judge with Claude
   removes self-preference bias
```

### Move 3 — The principle

LLM-as-judge is cheap but biased; design around each bias explicitly; the scores are useful when bias is mitigated, misleading when it isn't.

---

## Judge bias — diagram

```
┌─ Biases and mitigations ───────────────────────────────────────────────┐
│                                                                        │
│   Bias                  Mitigation                                     │
│   ────                  ──────────                                     │
│   Position              Randomize order per evaluation                 │
│                         (or: judge A vs B AND B vs A)                  │
│                                                                        │
│   Verbosity             Cap response length OR include length          │
│                         as a rubric dimension                          │
│                                                                        │
│   Self-preference       Cross-family judging:                          │
│                         Claude-produced  → GPT judges                  │
│                         GPT-produced     → Claude judges                │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not run LLM-as-judge today.**

When `B3.3` and `B3.4` ship (caption rubric, interpret rubric), the mitigations above are mandatory: randomize variant order per evaluation; use GPT-4o as judge for Claude-produced outputs.

---

## Elaborate

### Where this pattern comes from

Zheng et al. 2023 "Judging LLM-as-a-Judge" documented position, verbosity, self-preference biases. Hamel Husain's writing reinforces the mitigations.

### The deeper principle

Any automated scorer has biases; explicit awareness + mitigation is the discipline. The biases don't go away; they get designed around.

### Where this breaks down

For very rare-failure cases, the biases are dominated by other noise — mitigating them doesn't move the score. For frequent comparisons, the biases compound.

### What to explore next

- [02-eval-methods](./02-eval-methods.md) — LLM-as-judge is one of the methods
- [`01-llm-foundations/08-provider-abstraction`](../01-llm-foundations/08-provider-abstraction.md) — cross-family judging needs the abstraction

---

## Tradeoffs

The breakpoint: every LLM-as-judge eval needs the three mitigations. Without them, scores aren't trustworthy.

---

## Tech reference

- **Mitigation pattern:** randomize, cap/score length, cross-family.

---

## Project exercises

### B3.3 — Caption rubric with mitigations

- **What to build:** the caption rubric judge randomizes variant order; uses GPT-4o as judge (Claude-produced captions); includes length as a rubric dimension.
- **Done when:** judge scores are stable across runs; bias mitigations verified.
- **Estimated effort:** included in B3.3.

---

## Summary

- Three biases: position, verbosity, self-preference.
- Three mitigations: randomize, cap/score length, cross-family.
- LLM-as-judge is useful when biased-aware.

---

## Interview defense

**Q [mid]:** Why does cross-family judging matter?

**A:** Self-preference bias — Claude rates Claude-produced outputs higher than GPT-produced ones (and vice versa). Same-family judging produces inflated scores that don't survive shipping. Cross-family judging removes the bias; you get scores that reflect output quality, not which model produced it.

### One-line anchors

- Three biases: position, verbosity, self-preference.
- Three mitigations: randomize, length-aware rubric, cross-family.
- Mandatory for every LLM-as-judge eval.

---

## Validate

### Quick check
- What's the mitigation for position bias?
- Which model should judge buffr's Claude-produced captions?
- What's verbosity bias and how do you mitigate it?
