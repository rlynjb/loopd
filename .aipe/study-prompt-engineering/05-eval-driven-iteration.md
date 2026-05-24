# Eval-driven prompt iteration

**Industry name(s):** Eval-driven iteration, golden set, regression suite, LLM-as-judge, prompt evaluation
**Type:** Industry standard · Language-agnostic

> A junior iterates by vibes. A senior iterates against a golden set with a regression suite. Hamel Husain's writing is the canonical reference. Without evals, you iterate in circles.

**See also:** → [02-structured-outputs](./02-structured-outputs.md) · → [03-prompts-as-code](./03-prompts-as-code.md) · → [10-self-critique](./10-self-critique.md)

---

## Why care

### Move 1 — The grounded scenario

You tweaked the classifier prompt because the model was misclassifying ambiguous todos. You added one sentence: "When the verb is 'understand' or 'learn', prefer the 'study' label." The next day, the classifier is more accurate on your test todos. You ship. A week later a user reports that their grocery list ("understand which oat milk brand is best") is now classified as `study` instead of `todo`. You added the rule against five examples; you introduced a regression against the thirty examples nobody was tracking.

### Move 2 — Name the question the pattern answers

That am-I-actually-better question is what eval-driven iteration answers. Not "does this prompt produce a good response on this one input I'm testing right now" (vibes) — just *across a representative set of cases I've defined upfront, does my change improve the average score without regressing any specific case*. The pattern is two halves: a golden set (20–50 hand-curated cases with expected outputs) plus a regression suite (production failures added back as test cases forever).

### Move 3 — Why answering that question matters

**What breaks without it:** every prompt iteration is a guess. You add a rule; the eyeball check passes; you ship; six edge cases regress and nobody notices for two weeks. In buffr today, the `classify` chain has a heuristic-first short-circuit (`src/services/todos/heuristicClassify.ts`) that catches the easy cases before the LLM runs — but neither the heuristic nor the LLM has an eval set. A change to either is shipped on developer intuition; the only signal of regression is "I noticed an odd classification while using the app."

### Move 4 — Concrete before/after

Without evals (iterate by vibes):
- Tweak classifier prompt → run on 5 hand-picked todos → eyeball check → ship
- A week later a user reports an edge case that regressed
- You don't know whether your change caused the regression or whether the model itself drifted
- You guess, revert, re-tweak, ship again — cycle takes 1–3 hours of guessing per iteration

With evals (golden set + regression suite):
- Tweak classifier prompt → run against 35-case golden set → diff outputs
- 32 of 35 unchanged; 2 of 35 improved (the cases you targeted); 1 of 35 regressed
- You catch the regression at iteration time, not at production time
- Either revise to fix the regression case or document it as accepted (a "wontfix" that gets added to the regression suite so it's tracked)

### Move 5 — The one-line summary

Eval-driven iteration is the same discipline as having tests before you refactor a function — without the test, you don't know whether your change is improvement or regression, and the model is the function you're refactoring.

---

## How it works

### Move 1 — The mental model

You build two sets and one runner. The golden set is your representative corpus — hand-curated inputs with expected outputs that capture the cases the chain must handle. The regression suite grows over time from production failures, captured back as test cases the moment they happen. The runner executes the chain against both sets, compares outputs to expectations, and reports a score.

```
   eval set                       runner                   report
   ┌────────────────┐             ┌──────────┐             ┌──────────────┐
   │ golden:        │  ─────────► │ run chain│  ─────────► │ score: 32/35 │
   │   35 cases     │             │ on each  │             │ regressions: │
   │ regression:    │  ─────────► │ compare  │             │   case #14   │
   │   12 cases     │             │ to expect│             │ improvements:│
   └────────────────┘             └──────────┘             │   #7, #23    │
                                                            └──────────────┘
```

The score has a single number ("32 of 35 passed") AND a diff per case so regressions are visible by name. The number is for trend tracking; the diff is for actionable feedback.

### Move 2 — The layered walkthrough

**Layer 1 — the golden set.** 20–50 hand-curated cases. Each case is `{input, expected_output, why_this_case_matters}`. Curated, not random — every case is in the set because it exercises something the chain must handle (a class boundary, a known-tricky phrasing, an edge of the domain). The set is version-controlled in the repo (see [03-prompts-as-code](./03-prompts-as-code.md)) alongside the prompt. Hamel Husain's rule: write the eval before iterating the prompt. If you can't write the expected output, you don't actually know what the prompt should produce.

```
   tests/ai/classify-eval.jsonl
   ───────────────────────────
   {"input": "[] follow up on PR review",
    "expected": "todo",
    "why": "verb 'follow up' with clear action = canonical todo"}
   {"input": "[] understand how Postgres RLS interacts with grants",
    "expected": "study",
    "why": "verb 'understand' on a technical concept = canonical study"}
   {"input": "[] understand which oat milk brand to try",
    "expected": "todo",
    "why": "verb 'understand' but on a personal decision = todo, not study"}
   ...
```

If you're coming from frontend, think of this as Storybook fixtures plus snapshot tests: each case is a fixture; the expected output is the snapshot; the runner is the comparator. Concrete consequence: the third case above (the oat milk one) is exactly the kind of regression case that would have caught the "prefer 'study' for verb 'understand'" prompt tweak in iteration instead of in production.

**Layer 2 — the regression suite.** Every production failure becomes a test case. Forever. When a user reports an odd classification, the developer's first move is "add this case to the regression suite with the expected correct output." The runner then includes it on every subsequent iteration. The set only grows; cases never get removed. This is the operational discipline that makes the eval set *valuable over time* — it captures the long tail of cases your golden set won't anticipate.

```
   2026-04-15: production failure
     input: "understand which oat milk"
     produced: "study"
     correct:  "todo"
   ─────►   add to regression suite
   
   tests/ai/classify-regression.jsonl
   ──────────────────────────────────
   {"input": "[] understand which oat milk brand to try",
    "expected": "todo",
    "added_date": "2026-04-15",
    "source": "user report",
    "fixed_in_commit": "<future hash>"}
```

If you're coming from frontend, this is the same shape as adding a failing test for every reported bug before fixing the bug — the test ensures the regression can't silently return.

**Layer 3 — the iteration loop.** You change the prompt → run evals → diff outputs → keep change only if the score improved without regressions. The "diff outputs" step is the load-bearing one: an average-score improvement that hides a specific-case regression is the bug class that eval-driven iteration is supposed to catch.

```
   iteration loop
   ──────────────
   1. write/change prompt
   2. run against golden + regression
   3. diff vs baseline
   4. inspect each diff:
        - improved: good
        - same:     ignore
        - regressed: STOP. either fix the prompt OR document the regression
                    as accepted (and add to regression suite as wontfix)
   5. if no unaccepted regressions: ship + record baseline
   6. if unaccepted regressions: revise prompt + back to step 2
```

If you're coming from frontend, this is `git diff --stat` for the test runner — you don't ship until you've looked at every changed test, not just the summary count. Boundary: don't trust the average. A change that improves 4 cases by a lot and regresses 1 critical case by a little still loses, because production failures from regressed critical cases cost more than the average improvement saves.

**Layer 4 — LLM-as-judge for fuzzy outputs.** Some chains produce outputs that aren't classifier labels — `caption` produces 4 variants of free-form prose; `interpret` produces long-form reflection. You can't string-equality these against expected output. The pattern is LLM-as-judge: a separate evaluator chain reads `(input, output, criteria)` and returns a structured score. Used carefully (the judge model should be at least as capable as the producer model; criteria should be specific not vibes) this gives you a runnable score on subjective outputs.

```
   producer chain          judge chain
   ──────────────          ───────────
   input  ─► caption       (input, output, rubric)  ─► {score: 4/5,
                                                         issues: ["repetitive opening"]}
   the judge's rubric is a prompt itself, version-controlled, evaluated like any other.
```

If you're coming from frontend, this is the same shape as visual regression testing — you can't pixel-diff a freeform render against an expectation, so you compare against a reference and a tolerance. LLM-as-judge is the LLM equivalent. Boundary: LLM-as-judge inherits the judge model's biases. Validate the judge by spot-checking its scores against your own; if it agrees with you 80% of the time you trust its scores; if it agrees 50% of the time you don't.

### Move 2.5 — Current state vs future state

Buffr today has zero eval sets. The 5 chains have heuristic-first short-circuits (which act as ad-hoc tests in production) and the `validate.ts` runtime schema check, but no `tests/ai/*-eval.jsonl` files, no runner, no regression suite. Iteration on the chain prompts happens by editing the chain file, running the app on the device, and checking outputs by eye.

```
          Now (buffr)                          Later (eval-driven)
┌──────────────────────────────┐  ┌───────────────────────────────────┐
│ change prompt                │  │ change prompt                      │
│ run app on device            │  │ run `pnpm eval classify` locally   │
│ check 3-5 outputs by eye     │  │ diff vs baseline                   │
│ ship if "looks good"         │  │ ship if no unaccepted regressions  │
│ regression detection:        │  │ regression detection:              │
│   user reports it            │  │   eval runner catches before ship  │
└──────────────────────────────┘  └───────────────────────────────────┘
   iteration by vibes               iteration by score + diff
```

What doesn't have to change between phases: the chain code itself, the prompts, the SDK calls. What changes is the discipline around iteration — a `tests/ai/` directory, a runner script, a regression file per chain, and the team rule that "no prompt ships without an eval pass."

### Move 3 — The principle

The discipline that separates production LLM work from prototyping is having a way to know whether your change is improvement or regression before users tell you. Evals are that way. Hamel Husain's writing is the canonical reference; if you read one thing on this, read his. The pattern isn't fancy — golden set, regression suite, runner that diffs — but the discipline of doing it on every iteration is what compounds.

The full picture is below.

---

## Eval-driven iteration — diagram

```
┌─ Author layer ──────────────────────────────────────────────────────────┐
│  developer changes prompt                                                │
│    edit: src/services/ai/classify.ts                                     │
│    commit (eventually) tagged with eval-pass + model-version             │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Eval layer (local, pre-ship) ──────────────────────────────────────────┐
│  runner: pnpm eval classify                                              │
│    load golden set:      tests/ai/classify-eval.jsonl                    │
│    load regression set:  tests/ai/classify-regression.jsonl              │
│    run chain on each input                                               │
│    compare to expected output                                            │
│    emit: passed/failed counts + per-case diff                            │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
        ▼             ▼
    ┌────────┐     ┌──────────────────────────┐
    │ no     │     │ regressions found        │
    │ regress│     │   → revise prompt        │
    │   ship │     │   → re-run               │
    └────────┘     │   → accept (document     │
                   │     as wontfix + add to  │
                   │     regression suite)    │
                   └──────────────────────────┘
                            ▲
                            │  production failure → also added here
                            │
┌─ Production layer ──────────────────────────────────────────────────────┐
│  per-call logging (from concept #3)                                      │
│  failure detected by metric or user report                               │
│    → developer triages → adds to regression suite                        │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Buffr's chains:**

**File:** `src/services/todos/heuristicClassify.ts`
**Function / class:** `heuristicClassify(text)`
**Line range:** L1–~L120 — pre-LLM regex-based classification. Acts as an implicit eval surface (its rules ARE assumptions about how todos should classify) but has no test file.

**File:** `src/services/ai/classify.ts`
**Function / class:** `classify(todoText)`
**Line range:** L1–L160 — LLM-based classifier called when heuristic returns low confidence. Zero eval coverage today.

**File:** `src/services/ai/validate.ts`
**Function / class:** `validateAISummary(json: unknown): AISummary`
**Line range:** L1–L137 — runtime schema validator for summarize chain. Catches structural failures but not semantic regressions ("is the summary actually good").

**Aipe's eval surface:** `/Users/rein/Public/aipe/specs/study.md` and the other skill specs serve a similar role to evals — they're hand-curated specifications of what the agent should produce. There's no automated runner against them, but the specs themselves are the closest thing to a golden set the portfolio has.

---

## Elaborate

### Where this pattern comes from

Hamel Husain's writing (`hamel.dev`) is the canonical modern reference for eval-driven LLM iteration; his case studies of production LLM systems explicitly walk through golden-set design, LLM-as-judge calibration, and the regression-suite-from-production-failures discipline. The pattern itself is older — translates the unit-testing discipline of any other software domain onto LLM outputs. The LLM-as-judge variant became practical around 2024 when models got reliable enough that judge agreement with human raters crossed 80%.

### The deeper principle

You don't know if a change is an improvement until you've measured against a representative set. The measurement is what separates iteration-by-vibes from iteration-by-discipline. The set must be representative (golden), and the set must grow with production reality (regression). Skipping either half breaks the discipline.

### Where this breaks down

Chains with intrinsically subjective outputs (`interpret`'s long-form reflection — quality is "did this resonate") are hard to eval reliably even with LLM-as-judge. The pattern still applies but the score is fuzzier; treat as guidance not gospel. Chains in active rapid prototyping (the first week of a new feature) don't need evals yet — premature eval discipline slows the exploration phase. The pattern earns its keep at "this chain is in production and someone depends on its behaviour."

### What to explore next

- [03-prompts-as-code](./03-prompts-as-code.md) — eval sets live in git alongside prompts; the pair (prompt + eval set version) is what regression detection depends on.
- [10-self-critique](./10-self-critique.md) — self-critique is a runtime cousin of LLM-as-judge; both rely on a model evaluating LLM output.
- [02-structured-outputs](./02-structured-outputs.md) — schema-fail rate is one of the first eval metrics to track; trivially measurable and a strong canary.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Eval-driven               │ Iterate by vibes          │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Setup            │ 35-case golden set        │ Zero                      │
│                  │ (~half day) + runner      │                           │
│                  │ (~3 hours) per chain      │                           │
│ Iteration speed  │ 5–10 min per iteration    │ 30 sec per iteration      │
│                  │ (run evals, read diff)    │ (eyeball)                 │
│ Regression catch │ Pre-ship                  │ Post-ship (user reports)  │
│ Cost per call    │ ~$0.01 per eval run       │ Zero                      │
│                  │ (×35 cases)               │                           │
│ Confidence       │ Quantified                │ Anecdotal                 │
│ Onboarding       │ "Run the evals"           │ "Hope you have a feel for │
│                  │                           │ the model"                │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Setting up eval-driven iteration costs you the half-day building the golden set (35 cases is the minimum; each case takes ~10 minutes to write expected output for), three hours building the runner (it's small — load JSONL, run chain per case, diff outputs, emit report), and ongoing time on each iteration to read the diff and triage regressions. For buffr the per-chain cost is roughly a day of focused work; for all 5 chains it's a week.

### What the alternative would have cost

Not having evals costs you every regression that ships to users. The classifier prompt tweak that broke the oat-milk case (illustrative — not yet a real bug in buffr) is the prototype of every unmeasured iteration. The cost of NOT having evals also compounds: each unmeasured iteration leaves you less confident in the chain's behaviour, so you take longer per iteration to "feel out" the model. By month 6 you're spending an hour per iteration on what should be a 5-minute change.

### The breakpoint

Eval-driven iteration is overhead until a chain is in production and any downstream behaviour depends on its outputs. Buffr's `classify` chain crossed that breakpoint when `todo_meta.type` started gating the `expand` schema choice — a regression in classify now cascades to wrong-schema expansion. `summarize` crossed when editor code started rendering the structured summary. `interpret` is the chain that hasn't yet — it produces prose for the user to read, no downstream code consumes it.

---

## Tech reference (industry pairing)

### JSONL for eval cases

- **Codebase uses:** Not present in buffr today. The convention is `tests/ai/<chain>-eval.jsonl` and `tests/ai/<chain>-regression.jsonl` — one line per case, JSON object per line.
- **Why it's here:** the simplest version-controllable format for line-by-line case appending. Each new regression is one `>> file.jsonl` append; git diff shows exactly what was added.
- **Leading today:** JSONL — `adoption-leading` for eval datasets, 2026.
- **Why it leads:** trivially streamable, trivially diffable, every language reads it natively, no parser-version drift.
- **Runner-up:** YAML files per case (more readable, harder to append-only); CSV (only when expected outputs are scalar values); custom DSL (almost never worth it).

### LLM-as-judge

- **Codebase uses:** Not used in buffr today. Would be a small dedicated chain (e.g., `src/services/ai/judge.ts`) calling the same provider as the producer chain but with a rubric prompt.
- **Why it's here:** required for chains with subjective outputs (`caption` variants, `interpret` reflection). String-equality doesn't work; the judge gives a runnable score.
- **Leading today:** OpenAI's `o1` / `o3` models or Anthropic's Claude Opus for judging — `adoption-leading` for high-stakes evaluation, 2026. Frontier reasoning models agree with humans most.
- **Why it leads:** reasoning models inspect outputs more carefully; less likely to give a high score because the output "sounds confident."
- **Runner-up:** Sonnet 4.6 / GPT-4o for judging when the producer model is cheaper (Haiku, GPT-4o-mini); the judge should always be at least as capable as the producer.

---

## Project exercises

### B3.9 — Build a 35-case golden set for the classifier

- **Exercise ID:** `[B3.9]`
- **What to build:** at `tests/ai/classify-eval.jsonl`, write 35 hand-curated cases covering: 5 canonical examples of each thinking-mode label (todo, idea, knowledge, study, reflect, reduce = 30), plus 5 boundary cases that exercise the verb-vs-context ambiguity ("understand X" where X is technical → study; where X is personal → todo). For each case: `{input, expected, why}`.
- **Why it earns its place:** the foundation. Without the golden set, no further eval-driven work is possible. The half-day spent here is the half-day that turns classifier iteration from guessing into measuring.
- **Files to touch:** new `tests/ai/classify-eval.jsonl`.
- **Done when:** the file has 35 entries, hand-reviewed for representativeness; each entry has a `why` line explaining what aspect of the chain it tests.
- **Estimated effort:** 1–4hr.

### B3.10 — Build the runner

- **Exercise ID:** `[B3.10]`
- **What to build:** new `scripts/eval.mjs` that takes a chain name as argument, loads the corresponding eval file, runs the chain on each input (using the existing classify code path), compares to expected, emits a report. Use the existing provider configuration; don't mock the SDK calls (the eval should use the real model the chain uses in production).
- **Why it earns its place:** the runner is what makes the golden set useful. Without it, the cases are documentation; with it, they're tests.
- **Files to touch:** new `scripts/eval.mjs`, optionally a thin `pnpm eval` script entry in `package.json`.
- **Done when:** `node scripts/eval.mjs classify` runs against the golden set and emits a passed/failed report; running it twice in a row produces identical results modulo model nondeterminism (and a `--temperature 0` flag if needed to control for that).
- **Estimated effort:** 1–4hr.

### B3.11 — Add LLM-as-judge for the caption chain

- **Exercise ID:** `[B3.11]`
- **What to build:** new `src/services/ai/judge.ts` exposing `judgeCaption(input, output)` that runs a rubric prompt against the caption output and returns a structured `{score: 1-5, issues: string[]}`. Build a 20-case golden set at `tests/ai/caption-eval.jsonl` (each case has the input entry, no expected output — the judge scores the output). Add to the runner.
- **Why it earns its place:** caption outputs are too subjective for string-equality. LLM-as-judge is the canonical solution. Validates by spot-checking judge scores against developer scores; if agreement is >80%, the judge is trustworthy enough to ship.
- **Files to touch:** new `src/services/ai/judge.ts`, new `tests/ai/caption-eval.jsonl`, extension of `scripts/eval.mjs` to dispatch to the judge for subjective chains.
- **Done when:** running `node scripts/eval.mjs caption` produces per-case scores; manual spot-check on 5 cases shows judge agreement with human rater >= 80%.
- **Estimated effort:** 1–2 days.

---

## Summary

### Part 1 — concept recap

Eval-driven iteration is the discipline of testing prompt changes against a golden set (20–50 hand-curated cases) plus a regression suite (production failures captured back as test cases forever) before shipping — the runner diffs outputs against expectations and fails the iteration if any unaccepted regression appears. Buffr has none of this today: the 5 chains are iterated by editing and eyeballing, with regression detection happening when the developer notices an odd output during personal use. The constraint forcing this concept is that buffr's `classify` chain output now gates downstream `expand` schema choice; a silent classify regression cascades. The cost being paid for the current shape is that iteration speed is fake — feels fast per change, slow on average because every unmeasured iteration leaves the developer less confident and slows the next one.

### Part 2 — key points to remember

- Golden set: 20–50 cases, hand-curated, expected outputs, `why_this_case_matters` field.
- Regression suite: every production failure, captured as a case, forever. Only grows.
- Iteration loop: change → run → diff → keep only if no unaccepted regressions.
- LLM-as-judge for subjective outputs. Judge agreement with humans should be >80% before you trust its scores.
- Hamel Husain on evals is the canonical reference. Read his case studies before designing your own.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you know your prompt change is an improvement," they're testing whether you've shipped an LLM feature and had it regress in production. The answer that names a golden set, a regression suite, an iteration loop with diff inspection, and LLM-as-judge for subjective outputs is the answer of someone who's been on call. The answer that says "we look at the outputs" is the answer of someone who hasn't been on call yet.

### Likely questions

**Q [mid]:** What goes in a golden set vs a regression suite?

**A:** Golden set is your representative corpus — cases you designed upfront to cover the chain's intended behaviour. Each case is chosen because it exercises something specific: a class boundary, a known-tricky phrasing, an edge of the domain. Regression suite is reactive — every production failure becomes a case the moment it's reported. The golden set captures what you knew to test; the regression suite captures what reality taught you to test. Both grow over time (the golden set when you add new chain capabilities, the regression suite when production surprises you), but they grow for different reasons.

```
   golden set                       regression suite
   ──────────                       ────────────────
   designed upfront                 grows from production failures
   captures intended behaviour      captures unexpected behaviour
   stable over chain's life         monotonically grows, never shrinks
   ~20-50 cases at start             could be 100+ after a year
```

**Q [senior]:** Buffr's chains don't have evals. Why hasn't this bit you yet?

**A:** Because buffr is single-user; the only user is the developer, who notices regressions immediately during personal use. That's a working substitute for an eval set at single-user scale — slow, manual, and high-variance, but functional. The breakpoint is Phase B (multi-user), at which point the user count drowns out the developer's personal-use sample. By the time five users report independent classifier weirdness, the developer has shipped three more iterations on top of the regression and the bisect cost is brutal. The other breakpoint is "the chain output gates downstream code" — `classify` already crossed it (gates expand schema); that's the chain to evaluate first.

```
   single user (now)             multi-user (Phase B)
   ─────────────────             ───────────────────
   dev catches regressions       users report regressions
   immediate feedback            delayed feedback (days)
   bisect: 1-2 iterations back   bisect: 5-10 iterations back
   ─────                         ─────
   evals: optional               evals: required
   classify already at breakpoint (downstream consumption)
```

**Q [arch]:** What's the failure mode of LLM-as-judge at scale?

**A:** Three failure modes. (1) The judge inherits the producer model's biases — if both producer and judge are Sonnet, judging is correlated with what Sonnet considers good, not with what users consider good. Fix: use a different family (Claude judging GPT, or vice versa) or escalate the judge to a more capable model than the producer. (2) The judge is calibrated against a rubric that drifts — what "good" meant when you wrote the rubric is what the judge enforces, even if your product's definition of good has shifted. Fix: re-calibrate the rubric quarterly by spot-checking judge scores against developer scores. (3) Cost scales with eval volume — at 35 cases × $0.01/judge call = $0.35 per eval run; at 500 cases × $0.05/judge call (frontier judge) = $25/run; on every CI build that's real money. Fix: run full evals nightly, run a 20-case canary on every iteration.

```
   today (no judge)              scale (judge on every iteration)
   ────────────────              ───────────────────────────────
   no judge cost                 $25 per CI run × 50/day = $1250/day
   no judge bias                 judge bias = producer model bias
                                 (use different model family for judge)
   ─────                         ─────
                                 nightly full eval + per-iter canary
```

### The question candidates always dodge

**Q:** Your eval set is 35 cases. Why not 1,000? Why not 10? What makes 35 right?

**A:** 35 is the floor for "representative of the cases I know about" — each class label gets 5 examples, plus boundary cases. Below ~20 you don't have enough coverage to catch real regressions; above ~100 the maintenance cost (re-reviewing cases when the chain's intended behaviour shifts) starts dominating. The right number isn't fixed; it's "enough to catch the regressions you care about, low enough that you actually maintain it." The candidates who dodge this question give a generic "more is better" — they haven't maintained an eval set through a year of chain iterations and don't know that case staleness is real. The 35-case golden + open-ended regression-suite shape lets you grow the *useful* set (regression) without growing the *maintenance-heavy* set (golden) beyond what you can keep current.

```
   what was picked              what 1000 cases would cost
   ─────────────────            ───────────────────────────
   35 golden + open regression  1000 mixed cases, no distinction
   maintain golden carefully    maintain everything carefully
   ────                         ────
   cost: ~1 day initial         cost: ~1 week initial
   maintenance: hours/quarter   maintenance: ~1 day/quarter forever
   miss-rate: low (35 covers    miss-rate: same (10× cases doesn't
   the cases you know about)    catch unknown unknowns; only the
                                regression suite does)
```

### One-line anchors

- Hamel Husain on evals. Read his case studies before designing your own.
- Golden set: 20–50 hand-curated cases with expected outputs.
- Regression suite: every production failure becomes a case forever.
- Diff outputs per case. Don't trust the average — average improvement hides specific regressions.
- LLM-as-judge for subjective outputs. Validate the judge before trusting its scores.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the four-layer flow: author layer (developer edits prompt), eval layer (runner over golden + regression), the two branches (no-regression → ship; regression → revise or accept), production layer feeding back into the regression suite.

### Level 2 — Explain it out loud

Explain eval-driven iteration to a colleague who asked "we just look at the outputs, why do we need an eval set?" Under 90 seconds.

Checkpoints — did you:
- Distinguish golden set from regression suite?
- Name the iteration loop's diff-per-case requirement (not just average score)?
- Name LLM-as-judge as the option for subjective outputs?

### Level 3 — Apply it to a new scenario

Buffr's `caption` chain produces 4 tonal variants (clean, smoother, reflective, punchy). A new variant ("playful") gets added.

Design the eval strategy: what's the golden set? Can you string-equality the outputs? What's the rubric for LLM-as-judge if you can't? Sketch in 3-5 sentences.

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr should add evals for `classify` (B3.9 + B3.10) before any other prompt-engineering work."

### Quick check — code reference test

Without opening files:
- Which chain is the highest-priority candidate for an eval set?
- Where would the eval files live (path convention)?
- What's the difference between the golden set and the regression suite?
