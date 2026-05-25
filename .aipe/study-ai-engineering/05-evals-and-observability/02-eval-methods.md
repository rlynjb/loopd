# Eval methods

**Industry name(s):** Exact match, fuzzy match, rubric, LLM-as-judge, pairwise, human eval
**Type:** Industry standard

> Six methods on a cheap-to-expensive ladder. Pick by output mode: exact match for classifiers; fuzzy for generated text where wording varies; rubric for quality; LLM-as-judge for scalable rubric; pairwise for variant comparison; human for highest signal.

**See also:** → [01-eval-set-types](./01-eval-set-types.md) · → [03-llm-judge-bias](./03-llm-judge-bias.md) · → [`01-llm-foundations/04-structured-outputs`](../01-llm-foundations/04-structured-outputs.md)

---

## Why care

### Move 1 — The grounded scenario

You want to eval buffr's caption chain. Output is text — 4 variants. What's "correct"? Exact match doesn't work (each call produces slightly different wording). Fuzzy match doesn't capture tone. Rubric ("rate the caption on tone, structure, accuracy 1-5") works — but who scores 30 captions? An LLM-as-judge can score at scale; humans are higher signal but slow.

### Move 2 — Name the question the pattern answers

That how-do-I-score question is what eval methods answer. Not "what's the right method" (depends on output mode); just *what's the cheap-to-expensive ladder, and which rung matches my output shape*.

### Move 3 — Why answering that question matters

**What breaks without method-by-output-shape:** scoring with the wrong method gives misleading numbers. Exact-match on generated text always fails (variants always differ). Rubric without judge bias awareness inflates scores.

### Move 4 — Concrete before/after

Wrong method (exact match on captions):
- "Today I shipped auth" ≠ "Today auth went out"
- Score: 0% match, but they mean the same thing
- Useless

Right method (rubric with LLM-as-judge):
- Score each caption on tone (1-5), structure (1-5), accuracy (1-5)
- LLM-as-judge gives consistent scores at scale
- Useful

### Move 5 — The one-line summary

Cheap-to-expensive ladder: exact match → fuzzy → rubric → LLM-as-judge → pairwise → human. Match method to output shape.

---

## How it works

### Move 1 — The mental model

```
   ┌──────────────────────┬──────────────────────────┐
   │ Method               │ When to use              │
   ├──────────────────────┼──────────────────────────┤
   │ Exact match          │ Classifiers, structured  │
   │                      │ outputs, IDs             │
   ├──────────────────────┼──────────────────────────┤
   │ Fuzzy match          │ Generated text where     │
   │                      │ wording varies but       │
   │                      │ semantics shouldn't      │
   ├──────────────────────┼──────────────────────────┤
   │ Rubric (criteria-    │ Quality of generated     │
   │ based)               │ text on dimensions       │
   ├──────────────────────┼──────────────────────────┤
   │ LLM-as-judge         │ Scalable rubric eval     │
   │                      │ Cheap, but biased        │
   ├──────────────────────┼──────────────────────────┤
   │ Pairwise             │ "Is A better than B?"    │
   │                      │ for comparing variants   │
   ├──────────────────────┼──────────────────────────┤
   │ Human eval           │ Highest signal, lowest   │
   │                      │ scale                    │
   └──────────────────────┴──────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — exact match.** For classifiers and structured outputs. Compare output to expected by `===`. Reports accuracy, precision/recall, F1.

**Layer 2 — fuzzy match.** Substring match, embedding cosine, ROUGE/BLEU scores. Useful when wording varies but semantics shouldn't. Limited for "is this caption good" because good captions vary.

**Layer 3 — rubric and LLM-as-judge.** Rubric defines scoring criteria ("Score 1-5 on tone, structure, accuracy"). Human or LLM scores against the rubric. LLM-as-judge scales but has biases (concept 03). Use a different model family as judge than the one being judged.

```
   buffr's planned eval methods per suite (Phase 3)
   ────────────────────────────────────────────────
   classifier:    exact match → per-type F1
   caption:       LLM-judge rubric (tone, structure, anti-repetition)
   interpret:     LLM-judge rubric (depth, accuracy, reflection)
   RAG:           hit@k, MRR (rank-based)
```

**Layer 4 — pairwise.** "Given A and B, which is better?" Useful for comparing variants (old prompt vs new prompt). Randomize order to avoid position bias.

**Layer 5 — human eval.** Highest signal but lowest scale. Use sparingly — to calibrate the LLM-as-judge, or for final go/no-go before shipping a major change.

### Move 3 — The principle

Match method to output shape; combine for stronger signal. Exact for classifiers; rubric for generated content; human for calibration.

---

## Eval methods — diagram

```
┌─ Choosing the method ──────────────────────────────────────────────────┐
│                                                                        │
│   output mode of the chain                                             │
│         │                                                              │
│         ├── classifier / enum                                          │
│         │   → exact match → F1, precision, recall                      │
│         │                                                              │
│         ├── structured output (JSON)                                   │
│         │   → field-level exact match                                  │
│         │                                                              │
│         ├── generated text (variants, prose)                           │
│         │   → rubric + LLM-as-judge                                    │
│         │                                                              │
│         ├── retrieval (ranked list)                                    │
│         │   → hit@k, MRR, NDCG                                         │
│         │                                                              │
│         └── compare two prompt versions                                │
│             → pairwise judge                                           │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not run any eval methods today.**

`validate.ts` checks parse shape (Zod), not output quality. Phase 3 `B3.1` builds the eval harness; `B3.2`–`B3.7` are the per-suite implementations using the methods listed above.

---

## Elaborate

### The deeper principle

Method must match output mode. The cheap-to-expensive ladder lets you scale with what's economical at the current stage.

### Where this breaks down

For prototype phase, manual eyeballing beats any formal method. Build the harness only when the chain ships.

### What to explore next

- [03-llm-judge-bias](./03-llm-judge-bias.md) — how LLM-as-judge can mislead
- [01-eval-set-types](./01-eval-set-types.md) — what you score against

---

## Tradeoffs

The breakpoint: pick the cheapest method that gives useful signal. Don't reach for human eval when LLM-as-judge would do.

---

## Tech reference

- **Classifier scoring:** scikit-learn's classification_report.
- **LLM-as-judge:** any chat model; usually a different family than the one being judged.
- **Pairwise:** random A/B order; LLM picks; tally wins.

---

## Project exercises

### B3.3 — Caption variants rubric

- **Exercise ID:** `B3.3`
- **What to build:** rubric LLM-judge for 30 entries × 4 variants; score on tone, structure, anti-repetition; randomize variant order to avoid position bias.
- **Done when:** scores are reproducible; the harness flags regressions.
- **Estimated effort:** 4 hours.

---

## Summary

- Six methods on a cheap-to-expensive ladder.
- Match method to output mode.
- LLM-as-judge scales but is biased.
- Buffr: Case B; Phase 3 build target.

---

## Interview defense

**Q [mid]:** Why use LLM-as-judge instead of exact match?

**A:** Exact match doesn't work for generated text — the same captions can have many wordings that are equally good. Rubric scoring with an LLM as the judge captures semantics at scale: humans rate 10 captions; an LLM rates 1000 against the same rubric for $0.02. Cheaper and faster; the tradeoff is bias (concept 03), which you mitigate with cross-model judging and randomized order.

### One-line anchors

- Method matches output mode.
- Exact match: classifiers. LLM-judge: generated text.
- Human eval: highest signal, lowest scale.

---

## Validate

### Quick check
- Which method for buffr's classifier?
- Which method for buffr's captions?
- Which method for RAG retrieval?
