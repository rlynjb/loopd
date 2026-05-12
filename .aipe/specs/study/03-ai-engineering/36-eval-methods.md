# Eval methods

**Industry name(s):** Eval methods, scoring methods, exact match, fuzzy match, LLM-as-judge, pairwise comparison
**Type:** Industry standard

> Five ways to score an LLM output against expected output, each fitting a different chain's shape.

**See also:** → [35-eval-set-types](./35-eval-set-types.md) · → [37-llm-as-judge-bias](./37-llm-as-judge-bias.md) · → [38-llm-observability](./38-llm-observability.md)

---

## Why care

You have eval data. Now you need to score each output. For a classifier with 5 fixed labels, exact match works fine — was the prediction right? For a chain that returns free-form prose, exact match is meaningless — two correct outputs can differ word-for-word. You need a different scoring method depending on what the chain returns.

Eval methods are the family of approaches for comparing an LLM output to a reference. Each method fits a different output shape — discrete labels, structured JSON, free-form prose. Picking the wrong method gives misleading numbers; picking the right one gives signal. The pattern is the same shape as picking a similarity function in clustering — the choice depends on the data, and picking by reputation gives garbage results. Here's how the five common methods differ and where each fits.

---

## How it works

Five methods, ordered from cheapest to most expensive.

### 1. Exact match — discrete labels

For outputs from a fixed vocabulary (classifier labels, enumerable choices), check if `prediction == label`. Score is per-item 0 or 1. Aggregate as accuracy or per-class F1.

For loopd: the classifier chain. 5 labels (todo, idea, knowledge, study, reflect). For each labelled todo, check if `classify(todo).type === expected_type`.

### 2. Fuzzy match — slight variation

For outputs that should match but might have whitespace, casing, or formatting differences. Levenshtein distance, ROUGE, or n-gram overlap. Pass if score above threshold.

For loopd: not commonly applicable — most chains either return discrete labels or free-form prose where fuzzy match doesn't capture meaning.

### 3. Structured / schema match — JSON contracts

For outputs that should be valid JSON conforming to a schema. Score: passes the validator (yes/no); for graded scoring, field-by-field accuracy on the parsed object.

For loopd: summarize, expand. Each returns a structured JSON object with multiple fields. Score per-field: did `headline` match? did `mood` match? did `clipOrder` match? Aggregate by field and overall.

### 4. Rubric / LLM-as-judge — free-form prose

For outputs that are free-form (captions, interpretations). Define a rubric (3-5 criteria like "fits the mood", "no repetitive phrasing", "specific to the entry"); feed `(input, output, rubric)` to a judge LLM; the judge scores 1-5 per criterion.

For loopd: captions, interpret. Score each output on the rubric; aggregate as per-criterion mean.

### 5. Pairwise comparison — "which is better"

For outputs where the absolute quality is harder to score than the relative quality. Show the judge two outputs (A and B) for the same input; ask which is better. Randomise positions to control for position bias.

For loopd: caption variants (clean vs smoother vs reflective vs punchy). Score by win-rate in pairwise comparisons.

### Where the methods fail

```
Method                    Wrong for                              Bug it produces
────────────────────       ──────────────────────────             ──────────────────────────
Exact match               Free-form prose                        "two correct outputs differ"
                                                                  → 0% accuracy
Fuzzy match               Semantic equivalence                    "totally rephrased correct"
                                                                  → fails
Structured match          Free-form fields inside JSON           Schema passes but content
                                                                  is wrong
Rubric / LLM-judge        Cases with hard ground truth           Wrong by judge's bias
                                                                  (sycophancy, verbosity bias)
Pairwise                  Absolute-quality questions             "A is better than B" but
                                                                  both are bad
```

The practical consequence: every chain in loopd needs the right method picked once, then applied consistently. Mixing methods across runs makes results not-comparable.

### This is what people mean by "the metric is part of the eval"

You don't "have an eval"; you have a chain, an eval set, AND a scoring method. The method is co-equal with the set. A bad method invalidates a good set. Here's the picture of method choice per chain.

---

## Eval methods — diagram

```
Method-to-chain mapping for loopd's 5 chains

  ┌─ Classify ────────────────────────────────────────┐
  │ Output: discrete label (5 values)                 │
  │ Method: exact match → per-class F1                │
  │ Suite:  [B3.2] classify suite                     │
  └────────────────────────────────────────────────────┘

  ┌─ Summarize ───────────────────────────────────────┐
  │ Output: structured JSON (headline, mood, ...)     │
  │ Method: schema validation + per-field             │
  │         + rubric on `summary` text field          │
  │ Suite:  not yet specified                         │
  └────────────────────────────────────────────────────┘

  ┌─ Caption (4 variants) ────────────────────────────┐
  │ Output: 4 free-form strings + theme               │
  │ Method: rubric LLM-judge per variant +            │
  │         pairwise (vs anti-repetition baseline)    │
  │ Suite:  [B3.3] caption suite                      │
  └────────────────────────────────────────────────────┘

  ┌─ Expand ──────────────────────────────────────────┐
  │ Output: structured JSON (per-type schema)         │
  │ Method: schema validation + rubric on prose fields│
  │ Suite:  not yet specified                         │
  └────────────────────────────────────────────────────┘

  ┌─ Interpret ───────────────────────────────────────┐
  │ Output: free-form markdown                        │
  │ Method: rubric LLM-judge                          │
  │ Suite:  [B3.4] interpret suite                    │
  └────────────────────────────────────────────────────┘

  ┌─ RAG retrieval (loopd + aipe) ────────────────────┐
  │ Output: ranked list of doc IDs                    │
  │ Method: hit@k, MRR                                │
  │ Suite:  [B3.5] loopd RAG, [B3.6] aipe RAG         │
  └────────────────────────────────────────────────────┘
```

---

## In this codebase

**Status:** Case B — no eval methods implemented today.

Each method lands in `scripts/eval-harness/metrics/` as a separate function exposed to the harness from `[B3.1]`.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, each method is a function in `scripts/eval-harness/metrics/`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Exact match, fuzzy match, and structured scoring are inherited from classical IR and NLP eval practice (ROUGE, BLEU, etc.). LLM-as-judge emerged around 2023 (Zheng et al., "Judging LLM-as-a-Judge") and is now standard practice for free-form outputs. Pairwise comparison is older still, borrowed from human-preference rating in IR.

### The deeper principle
The metric must fit the output shape. Picking a metric by default ("we use F1") and then forcing every output into it produces misleading numbers. Different outputs deserve different methods.

### Where this breaks down
LLM-as-judge has its own biases (see [37-llm-as-judge-bias](./37-llm-as-judge-bias.md)). For high-stakes evals, a single judge LLM is brittle; using multiple judges and aggregating is more robust.

### What to explore next
- [37-llm-as-judge-bias](./37-llm-as-judge-bias.md) → biases that affect rubric and pairwise scoring
- [35-eval-set-types](./35-eval-set-types.md) → the data the methods score against
- [38-llm-observability](./38-llm-observability.md) → traces support post-hoc scoring of production data

---

## Tradeoffs

### Comparison table — methods compared

```
┌──────────────────────┬────────────┬────────────┬────────────┬────────────────┬────────────┐
│ Cost dimension       │ Exact      │ Fuzzy      │ Schema     │ Rubric LLM     │ Pairwise   │
├──────────────────────┼────────────┼────────────┼────────────┼────────────────┼────────────┤
│ Per-item cost        │ ~0         │ ~0         │ ~0         │ ~$0.0005-0.002 │ ~$0.001    │
│ Per-item latency     │ ~0ms       │ ~0ms       │ ~1ms       │ ~500-2000ms    │ ~500-2000ms│
│ Captures meaning?    │ No (binary)│ Some       │ Field-level│ Yes            │ Yes        │
│ Reproducibility      │ Perfect    │ Perfect    │ Perfect    │ Stochastic     │ Stochastic │
│ Bias risks           │ None       │ None       │ None       │ Multiple       │ Position   │
│ Fits free-form prose │ No         │ Weak       │ No         │ Yes            │ Yes        │
│ Fits discrete labels │ Yes        │ No         │ N/A        │ Yes (overkill) │ N/A        │
└──────────────────────┴────────────┴────────────┴────────────┴────────────────┴────────────┘
```

### Sub-block 1 — what method-per-chain gives up

A unified eval pipeline becomes a multi-method pipeline — each chain's eval has different infrastructure, different costs, different reproducibility. The numbers from one chain aren't directly comparable to another.

### Sub-block 2 — what one-method-for-all would cost

Misleading numbers on at least one chain. Force classify into rubric scoring and you've added latency and stochasticity for no benefit. Force caption into exact match and the eval reports near-0% accuracy because two correct captions never match verbatim.

### Sub-block 3 — the breakpoint
Method choice is largely fixed by output shape — there's not really a "breakpoint" unless the chain's output contract changes. The choice scales with eval volume, not with corpus or user count.

### What wasn't actually a tradeoff
Skipping eval entirely was acceptable at Phase 1 solo scale. Past one user, eval-per-chain becomes load-bearing.

---

## Tech reference (industry pairing)

### LLM-as-judge (rubric)

- **Codebase uses:** target plan for caption, interpret, expand-prose evals.
- **Why it's here:** the only scalable way to evaluate free-form output without a human in the loop on every eval run.
- **Leading today:** GPT-4 / Sonnet 4.6 as judge — `adoption-leading`, 2026.
- **Why it leads:** capable enough to follow a structured rubric reliably; consistent enough for batch eval; well-documented bias patterns to mitigate (see [37-llm-as-judge-bias](./37-llm-as-judge-bias.md)).
- **Runner-up:** human raters — `adoption-leading` for highest-fidelity eval; doesn't scale.

### sklearn / custom F1 / accuracy

- **Codebase uses:** target for classify eval (exact match → per-class F1).
- **Why it's here:** classical metrics that work without a judge.
- **Leading today:** sklearn-style metrics ported to JS — `adoption-leading`, 2026.
- **Why it leads:** deterministic, free, fast, well-understood.
- **Runner-up:** confusion-matrix-only — `adoption-leading` for small-class problems; gives more detail than F1 alone.

---

## Project exercises

### [B3.2] Suite 1 — classify: heuristic vs LLM accuracy + per-type F1

- **Exercise ID:** `[B3.2]`
- **What to build:** ~50 hand-labelled todos with their correct `type`. Run two evals: heuristic-only and LLM-only. Score with exact match → overall accuracy + per-class F1. Compare the two approaches; document the residual cases the heuristic misses that the LLM catches.
- **Why it earns its place:** the heuristic-first pattern's claim ("the heuristic gates 60-70% for free") is measurable here. Numbers from this eval are the interview answer.
- **Files to touch:** `scripts/eval-harness/datasets/classify/golden.json`; `scripts/eval-harness/metrics/f1.ts`.
- **Done when:** the eval runs end-to-end; per-class F1 numbers exist for both heuristic and LLM; the disagreement set is documented.
- **Estimated effort:** `1–4hr`.

### [B3.3] Suite 2 — caption variants: rubric LLM-judge on 30 entries, randomize variant order

- **Exercise ID:** `[B3.3]`
- **What to build:** 30 entries; for each, run the 4-variant caption chain. Rubric: (a) fits the mood, (b) avoids forbidden patterns, (c) doesn't repeat last 5 captions, (d) specific to the entry. Use Sonnet as judge; randomise the order in which variants are presented to control for position bias (see [37-llm-as-judge-bias](./37-llm-as-judge-bias.md)).
- **Why it earns its place:** caption quality is purely subjective; rubric LLM-judge is the only scalable way to measure.
- **Files to touch:** `scripts/eval-harness/datasets/caption/`; `scripts/eval-harness/metrics/rubricJudge.ts`.
- **Done when:** 30 entries × 4 variants are scored on the rubric; per-criterion average is reported; position bias is checked (run twice with reversed order; variance ≤ 5%).
- **Estimated effort:** `1–2 days`.

### [B3.4] Suite 3 — interpret: rubric judge on 20 entries

- **Exercise ID:** `[B3.4]`
- **What to build:** 20 entries; run interpret on each; score with a 3-criterion rubric (insightful / specific / non-generic).
- **Why it earns its place:** interpret is the only chain where the model output is consumed directly by the user. Quality matters most there.
- **Files to touch:** `scripts/eval-harness/datasets/interpret/`.
- **Done when:** 20 outputs scored; per-criterion means are stable on repeat runs.
- **Estimated effort:** `1–4hr` after `[B3.3]` plumbing.

### [B3.5] Suite 4 — loopd RAG retrieval: hit@k, MRR

- **Exercise ID:** `[B3.5]`
- **What to build:** 20-30 (query, expected entry ID) pairs from real loopd usage. Score retrieval by hit@1, hit@5, and MRR.
- **Why it earns its place:** Phase 2A's whole gate — without this eval, the chunking decision, the rerank decision, and the hybrid decision are all guesses.
- **Files to touch:** `scripts/eval-harness/datasets/rag-loopd/`.
- **Done when:** the eval runs against the Phase 2A retrieval pipeline; hit@k and MRR are reported.
- **Estimated effort:** `1–4hr` for the dataset; eval plumbing reuses `[B3.1]` harness.

### [B3.6] Suite 5 — aipe RAG retrieval: precision@k

- **Exercise ID:** `[B3.6]` (cross-project — aipe primary)
- **What to build:** see aipe curriculum.
- **Why it earns its place:** see aipe curriculum.
- **Estimated effort:** see aipe curriculum.

### [B3.7] Suite 6 — aipe end-to-end: pairwise with-RAG vs without-RAG

- **Exercise ID:** `[B3.7]` (cross-project — aipe primary)
- **What to build:** see aipe curriculum.
- **Why it earns its place:** see aipe curriculum.
- **Estimated effort:** see aipe curriculum.

---

## Summary

Five eval methods — exact match, fuzzy match, structured/schema match, rubric LLM-as-judge, pairwise comparison — each fit a different output shape. In loopd this is not yet implemented; the chain-to-method mapping is: classify → exact match + F1; summarize/expand → schema + per-field; caption → rubric + pairwise; interpret → rubric; retrieval → hit@k + MRR. The constraint that makes method-per-chain the right call is that picking one method for all chains forces misleading numbers on at least one. The cost being paid is a multi-method eval pipeline — each chain's metric is different infrastructure.

Key points to remember:
- Exact match: discrete labels. Free, deterministic.
- Schema match: JSON contracts. Free per-field.
- Rubric LLM-judge: free-form prose. Costs ~$0.001-0.002 per item; stochastic.
- Pairwise: relative quality. Same cost as rubric; addresses absolute-scoring weaknesses.
- Method follows output shape. Mismatch produces misleading numbers.

---

## Interview defense

### What an interviewer is really asking
"How do you score your LLM outputs?" tests whether the candidate has picked methods by output shape vs by reputation.

### Likely questions

  [mid] Q: How do you score classify's output vs caption's output?
  A: Classify returns discrete labels (5 values), so exact match works fine — score by per-class F1 against hand-labelled todos. Caption returns 4 free-form prose variants; exact match is meaningless because two correct captions never match verbatim. Caption uses LLM-as-judge with a rubric (mood fit / forbidden patterns / non-repetitive / specific), scored per-criterion. Different output shape, different method.
  Diagram:
  ```
  classify:  prediction ∈ {todo, idea, knowledge, study, reflect}
             → exact match → F1
  
  caption:   variant ∈ free-form string
             → rubric judge → per-criterion average
  ```

  [senior] Q: When does LLM-as-judge mislead?
  A: Three known biases. First, position bias — when comparing A and B pairwise, judges favor whichever is shown first; mitigate by running with reversed order and averaging. Second, verbosity bias — judges favor longer outputs even when shorter is better; mitigate by including "concise" in the rubric. Third, self-preference bias — a judge tends to favor outputs from the same model family; mitigate by using a different model for judging than for generation. For loopd specifically, the caption chain runs on Sonnet and the judge will also be Sonnet — meaning self-preference bias is real and should be acknowledged in the eval report.
  Diagram:
  ```
  Picked: rubric judge w/ mitigations    Suggested: rubric judge naive
  ─────────────────────────────────       ───────────────────────────
  Reversed order check                    Position bias inflates first
  "concise" in rubric                     Verbosity inflates long
  Different judge model where feasible    Self-preference biases scores
  ```

  [arch] Q: How does eval scale at 10× usage?
  A: Two shifts. First, the LLM-judge cost matters — at 30 entries × 4 variants × 4 criteria, you're calling judges ~480 times per eval run. At 10× corpus that becomes ~4800 calls (~$5-10 per full eval). Mitigation: subsample on routine runs; full eval on release candidates only. Second, judge-model latency becomes a constraint; consider Haiku for cheaper batch eval where the quality signal is strong enough.
  Diagram:
  ```
  Today: 30 × 4 × 4 = 480 judge calls per eval (~$1)
  10×:   ~4800 calls (~$10)
  Mitigation: subsample for routine, full for release
  ```

### The question candidates always dodge
"How do you know your judge is reliable?" The honest answer: run the judge against a small set of human-labelled outputs and measure judge-human agreement. If agreement is below ~80%, the judge is too noisy to trust for routine eval. For loopd's caption rubric specifically, a one-time judge-vs-human calibration on 20 outputs is the gate before using the judge for routine runs.

```
Picked: judge-human calibration         Suggested: trust the judge blindly
─────────────────────────────             ─────────────────────────────
20 outputs human-labelled                 No baseline
Agreement ≥ 80% before trusting           Discover judge weirdness in prod
Right at "we're shipping evals"           Right at "we're exploring"
```

### One-line anchors
- The metric must fit the output shape.
- Exact match is cheap; rubric is expensive; both are necessary.
- LLM-judge has biases — mitigate them, don't ignore them.
- Calibrate the judge against humans before trusting it.
- Each chain gets its method once; consistency matters more than perfection.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the chain-to-method mapping for loopd's 5 chains plus retrieval. Justify each pick.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the five methods, (b) why classify uses exact match and caption uses rubric, (c) the three LLM-judge biases, (d) why method must follow output shape.

### Level 3 — Apply it to a new scenario
A new chain is added: it takes a journal entry and emits 3 suggested tags (free-form strings). Without looking, pick the eval method and justify in 3-5 sentences.

Open the comparison table and check whether your pick handles the "discrete-but-not-fixed-vocabulary" middle ground (which doesn't quite fit any single method neatly).

### Level 4 — Defend the decision you'd change
Today the plan uses Sonnet as both producer and judge for caption. If you were starting today, would you use a different model (GPT-4o) as judge? Defend your answer naming one specific failure mode.

### Quick check — code reference test
- What directory holds the metric implementations?
- Which chain uses pairwise comparison?

Answer: `scripts/eval-harness/metrics/` (target, not yet created). Caption (and aipe end-to-end eval `[B3.7]`).
