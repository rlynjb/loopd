# Drill — eval design: LLM-as-judge for the classify chain
## buffr's load-bearing gap, made hands-on

```
competency:   evals & observability — eval set + LLM-as-judge bias
raises:       L0 → L2 (with stretch to L3 once the judge is debiased + held to a regression set)
curriculum:   B3.1 (build the smallest eval that catches the failure you fear most)
              + B3.2 (LLM-as-judge with explicit rubric and known biases named)
study ref:    .aipe/study-ai-engineering/05-evals-and-observability/01-eval-set-types.md
              .aipe/study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md
              .aipe/study-testing/06-testing-ai-features.md (the testing-side framing)
```

## 1. BUILD — the naive version (the rep starts here)

**File to create:** `tests/evals/classify.eval.ts`. Naive shape: feed each candidate line through `classify(line, ctx)`, ask a second LLM ("judge") if the classification was correct, score 1–5. Average. Report.

```ts
// tests/evals/classify.eval.ts — the naive version
import { classify } from '../../src/services/ai/classify';
import { callJudge } from './_judge';

const GOLD = [
  { line: '- [ ] call dentist', expected: 'todo' },
  { line: 'idea: a journal that knows what you wrote yesterday', expected: 'idea' },
  { line: 'I keep thinking about the way React fiber schedules work', expected: 'reflect' },
  { line: 'Studied PostgREST docs today — schema must be exposed in dashboard', expected: 'study' },
  { line: 'TIL: pg_dump --schema=buffr does what I expected', expected: 'knowledge' },
  // ... ~20 hand-labeled cases
];

async function main() {
  let agree = 0;
  for (const item of GOLD) {
    const got = await classify(item.line, { date: '2026-06-03' });
    const judgeScore = await callJudge({
      task: 'Rate how correct this classification was, 1 (wrong) to 5 (perfect)',
      line: item.line,
      classification: got,
    });
    if (judgeScore >= 4) agree++;
  }
  console.log(`agreement: ${agree}/${GOLD.length}`);
}
main();
```

**The L1 claim this builds toward:** "I have an eval set + judge that scores classify agreement on hand-labeled gold." That's already an L1 lift. But the drill's point is to break this version on purpose and earn L2.

## 2. INDUCE — the specific failure that proves the naive judge is biased

The induced failure: **find a case where the judge scores a worse classification higher than a better one**. Concretely:

| Input line | Better classification (gold) | Worse classification (induced) | Judge says |
|---|---|---|---|
| "Studied PostgREST docs today" | `study` (correct) | `knowledge` (wrong) | likely calls `knowledge` "perfect" because it's more *confidently worded* and "knowledge" sounds more declarative |
| "I keep thinking about how fiber schedules work" | `reflect` | `study` | judge over-rewards "I" prose as study-shape |
| "- [ ] call dentist" | `todo` | `idea` with verbose rationale ("the classifier reasoned that calling implies a future action…") | judge rewards length |

**The cause:** the naive judge has three known biases (`study-ai-engineering/05/03-llm-as-judge-bias.md`):

1. **Verbosity bias** — longer-rationale outputs score higher even when wrong.
2. **Confidence bias** — outputs phrased with certainty ("clearly knowledge") outrank tentative-but-correct ones.
3. **No rubric** — the prompt "rate 1–5" carries no anchored definition of what 3 vs 4 means, so the judge's distribution skews to the middle and is unstable across runs.

The forced-failure test: pair each gold input with both `classify(line)` output AND a synthetic verbose-but-wrong alternative. If the judge ever scores the wrong-but-verbose output ≥ the correct-but-terse output, the naive eval is busted. This will fire — biases are real.

## 3. DIAGNOSE — symptom → hypotheses → isolated cause

**Symptom:** the average agreement number is moderately stable (~70-80%) but disagrees with the gold labels on a *predictable subset* of cases — the long-rationale ones.

**Hypotheses to walk in order (resist jumping to the fix):**

| Hypothesis | Test | Outcome |
|---|---|---|
| H1: classify is itself bad | Compare classify's output to gold directly, without judge | Agreement on gold-only is X% |
| H2: judge is bad on specific classes | Per-class agreement rate | Reveal which classes the judge confuses |
| H3: judge has verbosity bias | Pair verbose-wrong vs terse-correct; check judge preference | Likely confirms bias |
| H4: judge has confidence bias | Pair confident-wrong vs hedged-correct; check judge preference | Likely confirms bias |
| H5: 1–5 scale is unanchored | Re-run judge on identical inputs; measure variance across runs | Variance > 0.5 on the 1–5 scale across reruns → unanchored scale |

The isolated cause is almost always **a combination of H3 + H5** for LLM-as-judge: unanchored scales let the judge default to "this is well-written" rather than "this is correct."

This is the L2 rep. You broke the eval on purpose, hypothesized, isolated, named the cause in the vocabulary the field uses (verbosity/confidence/anchored-scale). The diagnosis IS the rep — not the fix.

## 4. FIX + REJECT — the fix and the alternative rejected

**The fix (two moves):**

1. **Anchored rubric, not unanchored 1–5.** Replace "rate 1–5" with a four-criterion rubric per class: "is the classification in the closed set `todo|idea|knowledge|study|reflect`? does it match the *primary* semantic intent of the line? does it survive the recognition test (would a human labeler agree)? does it avoid the dominant bias trap (treating verbosity as correctness)?" Each criterion is a `pass/fail`; agreement = all-pass.
2. **Few-shot anchors for the judge.** Three exemplar judgments inside the judge's prompt: a correct-and-terse case it should rate `pass`, a wrong-but-verbose case it should rate `fail`, a correct-and-verbose case it should rate `pass`. The anchors carry the rubric, not just illustrate it.

```ts
// the fix; tests/evals/_judge.ts
const RUBRIC = `
You are evaluating a classification of a journal-entry line.
The classification is correct iff ALL four criteria hold:
  C1: it is one of: todo, idea, knowledge, study, reflect.
  C2: it matches the PRIMARY semantic intent of the line, not a secondary nuance.
  C3: a human reviewer would assign the same label.
  C4: it does not reward verbosity. A verbose-but-wrong classification is FAIL.

Three anchor cases:
- Line: "- [ ] call dentist"  Class: "todo"  Verdict: PASS (terse, correct).
- Line: "Studied PostgREST today"  Class: "knowledge"  Verdict: FAIL (this is STUDY, not knowledge — primary intent is the act of studying).
- Line: "I keep thinking about React fiber"  Class: "reflect"  Verdict: PASS (verbose but correct intent).

Now judge: Line: {line}  Class: {got}  Verdict: PASS or FAIL.
`;
```

**The alternative rejected — and why:** the obvious alternative is "add a stronger model as the judge" (Opus over Sonnet, say). **Reject this.** Three reasons:

1. The bias is shape-driven (verbosity/confidence), not capacity-driven; a stronger judge with the same unanchored prompt exhibits the same biases.
2. Cost: judge calls run per gold-item per CI run. Multiplying judge cost without removing the bias makes the eval *more expensive without making it more correct.*
3. It hides the discipline. The L3 signal is "I anchored the judge to a rubric and proved the bias was the gating issue," not "I bought my way out with a bigger model."

The second alternative rejected: **exact-match-only** against gold labels (no judge). Reject because (a) the gold set is small (~20-50 hand-labeled cases — the right size for a buffr-scale eval), and (b) exact-match misses borderline-correct calls that humans would accept. The rubric'd judge handles borderline correctly; exact-match treats them as failures and drives the metric down for the wrong reason.

## 5. EVAL — the measurement that proves the fix

The eval that earns L2 (and stretches toward L3):

**Setup:**
- **Gold set**: ~30 hand-labeled `(line, gold_class)` pairs. Include 5 hard cases per class. Include 3 induced-bias-trap cases per class (verbose-wrong + terse-correct + identical-intent-different-verbosity).
- **Anti-bias regression set**: a held-out 10-case set where verbosity and correctness are deliberately decoupled. The judge's agreement on this set is the *bias-resistance* metric — separate from the overall agreement.
- **Two judges**: the rubric'd judge (the fix) and the unanchored judge (the broken naive version). Both run against the gold set + regression set.

**Numbers to report:**

```
                            naive judge    rubric'd judge
overall agreement            ~70%           ~88%
bias-trap regression          ~50%          ~95%
inter-run variance           >0.5 levels   <0.1 levels
LLM cost per eval run        $0.X          $0.X (similar)
```

The numbers will vary by run. The *shape* won't: bias-trap regression jumping from ~50% to ~95% is the headline. That is the proof.

**The eval-as-regression discipline:** save the bias-trap cases as `tests/evals/classify.bias-trap.json`. Re-run on every prompt change. If bias-trap regression drops below 90%, fail CI. This converts the eval from "I ran it once" to "I defend the number permanently" — and that is the rung from L2 to L3.

**Provenance:** B3.1 (smallest eval that catches the failure you fear), B3.2 (LLM-as-judge with explicit rubric + known biases named). The drill is exactly the B3.1+B3.2 pair, instantiated against `src/services/ai/classify.ts`.

## 6. WAR STORY — the sentence you couldn't say before

> "I built an LLM-as-judge eval for the classify chain. The naive version had verbosity bias and unanchored 1–5 scales — it gave high scores to confident-but-wrong outputs. The signal that nailed it was a hand-built bias-trap regression set where I deliberately paired verbose-wrong against terse-correct: agreement on that subset was 50% with the naive judge, 95% with a four-criterion anchored rubric and three few-shot anchors. The fix wasn't a stronger judge model — same bias, more cost. I kept the bias-trap set as a CI regression so the metric stays defended; cache-hit-rate stays measurable because cached classifications pass through unchanged."

— 90 seconds spoken. Names the failure mode in the field's vocabulary (verbosity bias / unanchored scale). Names what was rejected and why (bigger model — same bias). Closes with the regression discipline (the L3 hint).

---

**To complete this drill:** do steps 1–6 in code. Steps 1–2 in one sitting (build the naive eval, induce the bias). Step 3 the next sitting (diagnose without jumping). Step 4 the same sitting (write the rubric + few-shot prompt; commit). Step 5 once the rubric is in place (run both judges; capture the numbers; save the regression set). Step 6 written last, in your voice — if you can't write it, the rep isn't finished.

**One concrete commit you can make tonight:** `tests/evals/classify.gold.json` with 10 hand-labeled cases drawn from your own recent entries. Even before any judge code lands, that file is the substrate for everything else.
