# Eval set types

**Industry name(s):** Golden set, adversarial set, regression set, eval suite
**Type:** Industry standard

> Three different kinds of evaluation data exist, and they catch different bugs — picking only one means missing two-thirds of what evals are for.

**See also:** → [36-eval-methods](./36-eval-methods.md) · → [37-llm-as-judge-bias](./37-llm-as-judge-bias.md) · → [38-llm-observability](./38-llm-observability.md)

---

## Why care

You built an eval set of 50 representative inputs, watched your numbers tick upward week-over-week, then shipped a prompt change that — according to the eval — was a slight improvement. The next day a user reported that their classifier output went from sensible to nonsense. Your eval missed it. Why? Because your eval set was all *typical* cases. The change you made degraded the *edge* cases. You had a golden set; you didn't have an adversarial set.

There are three kinds of eval data, and each catches a different category of bug. Golden sets show you *typical-case quality*; adversarial sets show you *worst-case resistance*; regression sets show you *whether you broke something that used to work*. Most teams ship with only golden sets because that's what tutorials show. The pattern is the same shape as unit tests vs integration tests vs property tests in software — each does work the others can't. Here's how the three differ and why you need all three.

---

## How it works

Each eval set type is built differently, evaluated differently, and answers a different question.

### Golden set — "what does typical quality look like?"

A small (20-100), hand-curated set of representative inputs with labels of what the *correct* output looks like. Built by a domain expert picking inputs they consider typical of real usage. Outputs scored via exact match, fuzzy match, rubric, or LLM-judge.

For loopd specifically: 50 representative todos labelled with the correct `type` (todo / idea / knowledge / study / reflect). Run classify, score against labels.

If you're coming from frontend, golden sets are like your component snapshot tests — a known-good baseline you regression-test against.

### Adversarial set — "what does the worst case look like?"

Inputs designed to stress the system: ambiguous edge cases, inputs that look like one type but mean another, inputs that exploit known model biases (sycophancy, refusal, hallucination). Built by a domain expert thinking adversarially: "what would break this?"

For loopd: a 20-input set of borderline todos like "thinking about whether to learn rust" (could be study or reflect or idea), or "build the thing I've been putting off" (todo, but the word "thinking" might confuse classify), or prompt-injection attempts hidden in entry prose.

Adversarial sets are like fuzz tests in software — you generate or hand-craft inputs that probe edge cases, not typical cases.

### Regression set — "did we break something that used to work?"

A growing set of (input, previously-correct-output) pairs from real user reports and past bugs. Built by adding every issue you've fixed to the set. Outputs scored by checking the prior-correct output didn't change.

For loopd: every time a user pushes back ("classify got this wrong" → fix → add the case to the regression set), the regression set grows. Future prompt changes get scored against the entire backlog.

Regression sets are like the bug-fix tests in your test suite — every prior bug becomes a guard.

### Why each is necessary

```
                       Typical     Edge cases    Past bugs
Quality on:            cases       not covered   silently
                                   in golden     reintroduced
                       
Golden set             ✓           ✗             ✗
Adversarial set        ✗           ✓             ✗
Regression set         ✗           Some          ✓

Need all three to catch all three categories.
```

The practical consequence: a team with only a golden set ships an improvement, the average goes up, and some edge case the eval didn't cover regresses. Users find it. The team adds the case to a regression set, which now has 1 row. Over time, the regression set grows; the rate of "user finds it" goes down. That's the discipline.

### Where eval sets go wrong

Three patterns:

1. **Eval set leakage** — the set was used during prompt iteration, so the prompt is overfit to it. Fix: hold out a separate eval set the prompt never sees during iteration.

2. **Wrong granularity** — eval scores at the wrong unit. Per-entry F1 hides per-class failures; aggregate accuracy hides skew on rare classes. Fix: always report per-class metrics for imbalanced data.

3. **Stale sets** — domain shifts (user behavior changes, taxonomy changes), but the eval set doesn't update. Fix: refresh adversarial cases quarterly; add regression cases continuously.

### This is what people mean by "eval is a system, not a number"

The eval score isn't one number; it's a panel of numbers from a panel of sets. Each set answers a different question. Without all three, you've discovered only some of what your evals could tell you. Here's the picture.

---

## Eval set types — diagram

```
Three eval sets, three different jobs

  ┌─ Golden set ────────────────────────────────────────┐
  │  50 representative inputs                            │
  │  Hand-labelled with expected outputs                 │
  │  Job: measure typical-case quality                   │
  │  Metric: F1, accuracy, rubric average                │
  │  Cadence: re-score on every prompt change            │
  │  Growth: ~static (refresh quarterly)                 │
  └──────────────────────────────────────────────────────┘

  ┌─ Adversarial set ───────────────────────────────────┐
  │  20 hand-crafted edge cases                          │
  │  Inputs designed to stress weak points               │
  │  Job: measure worst-case resistance                  │
  │  Metric: pass rate (passed all? failed how?)         │
  │  Cadence: re-score on every prompt change            │
  │  Growth: ~static (add as new failure modes emerge)   │
  └──────────────────────────────────────────────────────┘

  ┌─ Regression set ────────────────────────────────────┐
  │  N (input, prior-correct-output) pairs               │
  │  Built from real user reports + past bugs            │
  │  Job: prevent re-breaking past wins                  │
  │  Metric: pass rate (everything still right?)         │
  │  Cadence: re-score on every prompt change            │
  │  Growth: continuous (add every fix)                  │
  └──────────────────────────────────────────────────────┘

  ┌─ Combined dashboard ────────────────────────────────┐
  │  Golden:      85% → 87% (typical case ↑)            │
  │  Adversarial:  60% → 70% (edge cases ↑)             │
  │  Regression:  100% → 98% (caught 2 regressions)     │
  │                                                      │
  │  Ship: NO — regressions detected                     │
  └──────────────────────────────────────────────────────┘
```

---

## In this codebase

**Status:** Case B — no eval sets today.

The closest existing pattern is manual UAT on the connected Android device (per `rules.md`'s testing section). The plan is `[B3.1]` (build an eval harness), then per-suite sets for each chain and retrieval surface.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, the harness lives in `scripts/eval-harness/` with sub-directories per chain and a fixtures directory per set type)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
The three-set discipline is borrowed from ML eval practice (training/validation/test splits, plus held-out adversarial test sets) and from software testing (unit + property + regression suites). It became important in LLM work around 2023 when production teams started hitting the "the average is fine but bad things still happen" wall.

### The deeper principle
Different bugs surface from different distributions of input. Sampling only typical inputs is sampling for one bug category; sampling adversarially is sampling for another. The eval system must be plural to detect plural bugs.

### Where this breaks down
Building three eval sets has cost. At very small scale (one developer shipping one feature), one golden set might be all the discipline you can afford. The discipline scales with team size and shipping cadence.

### What to explore next
- [36-eval-methods](./36-eval-methods.md) → how to score outputs against eval set labels
- [37-llm-as-judge-bias](./37-llm-as-judge-bias.md) → the rubric-LLM-judge approach for non-exact-match scoring
- ML eval discipline parallels (Phase 2C in the curriculum) → confusion matrices, calibration

---

## Tradeoffs

### Comparison table — eval set strategies for loopd

```
┌─────────────────────────┬──────────────────┬──────────────────┬─────────────────────┐
│ Cost dimension          │ Three sets       │ Golden only      │ No sets             │
├─────────────────────────┼──────────────────┼──────────────────┼─────────────────────┤
│ Catches typical regress.│ Yes              │ Yes              │ No                  │
│ Catches edge-case regr. │ Yes              │ No               │ No                  │
│ Catches past-bug recurr.│ Yes              │ No               │ No                  │
│ Build cost              │ ~100-150 items   │ ~50 items        │ 0                   │
│ Maintenance / quarter   │ Hours            │ Minutes          │ 0                   │
│ Adds to CI              │ Yes              │ Yes              │ N/A                 │
│ Confidence on ship      │ High             │ Medium           │ Low (user reports)  │
└─────────────────────────┴──────────────────┴──────────────────┴─────────────────────┘
```

### Sub-block 1 — what three sets gives up

~100-150 hand-labelled examples (vs ~50 for golden-only), plus continuous regression-set growth as bugs get fixed. For loopd at solo scale this is real effort — a few hours per chain to hand-curate adversarial cases; ongoing discipline to add user-reported issues. The setup investment pays off on the first regression caught.

### Sub-block 2 — what golden-only would cost

Edge-case blindness. Every prompt change ships with confidence that "the eval looks fine" — and some fraction of those changes regress something the eval didn't measure. Users surface the regression; trust in the eval erodes.

### Sub-block 3 — the breakpoint
Single golden set is acceptable while (a) the system has only one user (you), and (b) you can manually UAT enough to catch what eval misses. Past one user, regression set becomes load-bearing.

### What wasn't actually a tradeoff
"No evals, manual UAT only" was acceptable in Phase 1 because loopd was one user. It stops being acceptable the moment a regression hits a real user, because the only signal is their complaint.

---

## Tech reference (industry pairing)

### Custom eval harness in TypeScript/Node

- **Codebase uses:** target plan for `[B3.1]`.
- **Why it's here:** loopd's chains are TypeScript; reusing the same runtime for evals means no context-switching during development.
- **Leading today:** custom eval harness — `adoption-leading` for solo dev teams, 2026.
- **Why it leads:** zero new dependencies; integrates with existing chain code directly.
- **Runner-up:** OpenAI Evals — `innovation-leading` for shared eval format; useful when comparing across providers or sharing with the broader community.

### Langfuse for tracing + eval

- **Codebase uses:** not used today.
- **Why it's here:** self-hosted LLM observability that doubles as an eval platform.
- **Leading today:** Langfuse — `innovation-leading` for self-hosted observability + eval, 2026.
- **Why it leads:** open source, OpenTelemetry-compatible; aligns with loopd's local-first stance better than SaaS alternatives.
- **Runner-up:** LangSmith — `adoption-leading` for managed eval; richer UI; vendor lock-in.

---

## Project exercises

### [B3.1] Build reusable eval harness

- **Exercise ID:** `[B3.1]`
- **What to build:** A `scripts/eval-harness/` directory with sub-modules: a `runEval(dataset, modelUnderTest, metricConfig)` function; a `datasets/` directory with golden / adversarial / regression sub-directories per chain; a `metrics/` directory with `accuracy.ts`, `f1.ts`, `rubricJudge.ts`, `pairwise.ts`.
- **Why it earns its place:** the foundation for every other Phase 3 build item.
- **Files to touch:** new `scripts/eval-harness/` directory; integrates with chain code from `src/services/ai/`.
- **Done when:** the harness runs a tiny smoke-test dataset; outputs are written to `scripts/eval-results/<chain>-<date>.json`.
- **Estimated effort:** `1–2 days`.

### [B3.10] Wire LLM evals into CI

- **Exercise ID:** `[B3.10]`
- **What to build:** A GitHub Action (or local pre-push hook, since loopd has no CI yet) that runs the classify and caption eval suites on every push, and reports the deltas vs the previous run. Block merges if the regression set drops below 100%.
- **Why it earns its place:** evals only catch regressions if they're actually run before merge. Without CI integration, evals decay into "ran once."
- **Files to touch:** new `.github/workflows/eval.yml` (or a `scripts/pre-push.sh`); depends on `[B3.1]`.
- **Done when:** every push triggers the eval; the result is visible in CI logs; a regression causes a non-zero exit.
- **Estimated effort:** `1–4hr`.

---

## Summary

Three eval set types — golden, adversarial, regression — each catch a category of bug the others miss. In loopd this is not yet implemented; `[B3.1]` builds the harness and `[B3.2]` through `[B3.9]` populate per-chain and per-retrieval-surface eval suites with the three set types. The constraint that makes three-set discipline the right call is that "the average is fine but edge cases break" is the dominant failure mode of LLM systems past the prototype stage. The cost being paid is roughly 100-150 hand-labelled examples per chain to bootstrap, plus ongoing regression-set growth as bugs surface.

Key points to remember:
- Golden = typical case; adversarial = edge case; regression = past bug.
- Each set catches what the others miss.
- Ship-gate the regression set; tolerate small swings on the others.
- Eval-set leakage: don't iterate prompts against the eval set you use for shipping.
- Single golden set is fine at solo scale; falls apart at one real user.

---

## Interview defense

### What an interviewer is really asking
"How do you evaluate your LLM features?" tests whether the candidate has eval discipline at all. Follow-up: "what kinds of eval sets?" tests whether they know the three-set pattern.

### Likely questions

  [mid] Q: What kinds of eval sets do you maintain?
  A: Three. A golden set of ~50 representative inputs with hand-labelled expected outputs — measures typical-case quality. An adversarial set of ~20 edge cases designed to stress the system — measures worst-case resistance. A regression set that grows continuously, populated from real user reports and past bugs — prevents re-breaking what used to work. Each catches what the others miss.
  Diagram:
  ```
  golden     →   typical case quality      (F1, accuracy)
  adversarial→   edge case resistance      (pass rate)
  regression →   past-bug guard            (pass rate, must be 100%)
  ```

  [senior] Q: Why three sets instead of one bigger one?
  A: Because they catch different bugs and the right way to monitor them differs. Golden-set scores drift up over time as prompts improve. Adversarial-set scores drift slowly; new failure modes emerge as the model or corpus changes. Regression-set scores should *never* drop below 100% — every regression-set fail is a re-broken bug that needs immediate attention. Lumping them together would lose the distinction between "average went up" and "we re-introduced a known bug" — both important, both deserving separate dashboards.
  Diagram:
  ```
  Picked: three sets, three dashboards     Suggested: one big eval set
  ─────────────────────────────────         ─────────────────────────
  Golden ↑, adversarial steady,             Average goes up
  regression =100%                          (regressions hidden)
  Ship gate: regression must hold           Ship gate: average alone
  ```

  [arch] Q: How does this scale at 10× users?
  A: Two shifts. First, regression sets grow faster — every user-reported bug becomes a regression case. The eval set goes from ~150 items to thousands; eval run-time becomes a real constraint. Mitigation: sample the regression set if it gets too big; always run the most-recent-N + a random sample of older ones. Second, adversarial sets benefit from user-shaped data — log production failures (low-confidence outputs, manual overrides) and recycle them into the adversarial set.
  Diagram:
  ```
  Today (solo)         →  ~150 items, run on every push
  10× users            →  Thousands; sample-then-run
  100× users           →  Dedicated eval pipeline; weekly run
  ```

### The question candidates always dodge
"How do you avoid eval-set leakage?" The honest answer: hold out a separate eval set the prompt never sees during iteration. In practice, the discipline is to have *two* golden sets — a "dev" set you iterate against and a "held-out" set you only evaluate against on the final ship. Skipping this is how teams overfit prompts to their dev set and ship something that scores 90% on dev and 65% in production.

```
Picked: dev + held-out               Suggested: one golden set
─────────────────────────             ──────────────────────
Dev: iterate prompts                  Iterate AND validate on same
Held-out: ship-gate                   Overfit risk
~50 + ~50 items                       ~50 items
Right at discipline level             Right at "MVP" level
```

### One-line anchors
- Three sets, three bugs.
- Golden = typical; adversarial = edge; regression = past.
- Regression must hold at 100%.
- Iterate on dev; ship-gate on held-out.
- Manual UAT works at one user; not past.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and draw the three eval sets side-by-side. Label what each one measures and what cadence each runs at.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the three set types and what each catches, (b) eval-set leakage and how to avoid it, (c) why regression sets ship-gate, (d) loopd's `[B3.1]` plan.

### Level 3 — Apply it to a new scenario
A user reports that a specific todo got mis-classified. You fix the prompt and the classify result is now correct. Without looking, predict what should happen to your eval suites and walk through the new lifecycle.

Open the diagram and check whether your answer matches "Regression set grows continuously."

### Level 4 — Defend the decision you'd change
Today the plan is three sets per chain. If you were starting today with limited time, would you ship golden-only first and skip the others? Defend your answer.

### Quick check — code reference test
- What directory holds the eval datasets?
- What's the regression-set ship gate condition?

Answer: `scripts/eval-harness/datasets/` (target, not yet created). Regression set must score 100% before any prompt change ships.
