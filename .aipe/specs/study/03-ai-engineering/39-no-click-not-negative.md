# "No-click is not a negative label"

**Industry name(s):** Implicit feedback caveats, no-click signal interpretation, missing-not-at-random labels
**Type:** Industry standard

> The user didn't tap your suggestion. That's not evidence the suggestion was bad — and treating it that way poisons your eval and your training data.

**See also:** → [35-eval-set-types](./35-eval-set-types.md) · → [37-llm-as-judge-bias](./37-llm-as-judge-bias.md)

---

## Why care

A bakery puts ten pastries in the window each morning and counts which ones get sold. By month's end the owner concludes the four loaves on the bottom shelf are unpopular and stops baking them. A customer overhears and says "I never even noticed those — they're at knee height; I was looking at the counter." Half the "unpopular" loaves were never seen; the rest were seen by people who already had bread at home or were in a rush or planned to come back tomorrow. The pretzel count is real; the unpopular-loaf count is mostly the absence of evidence, not evidence of absence.

The implicit question is "what does it mean when the user did nothing?" The "no-click is not a negative label" caveat is the answer for any system using implicit interaction as relevance signal — inaction has many causes, only one of which is "I judged it irrelevant." Treating absence as negative creates a structural 90/10 class imbalance, bakes in your current presentation policy, and confuses missing data with disagreement. The mitigation ladder is four rungs: precision-only (eval on tapped items), pair-comparison from clicks (A > B, A > C, nothing about B vs C), explicit feedback affordances ("is this helpful?"), and counterfactual propensity-scored evaluation.

**What depends on getting this right:** whether eval numbers reflect quality or sampling bias, and which features can safely use interaction data. For loopd the planned `[B3.5]` retrieval eval uses hand-curated (query, expected_entry_id) pairs precisely to sidestep this trap — every label is intentional, no inference from absence. When `[B2A.8]` related-entries ships, the rail naturally produces click logs; the eval design must declare upfront that untapped entries are unknown, not negative. A future "AI-suggested todos to expand" feature would face the same choice.

Without the caveat:
- Log clicks on the related-entries rail; treat tapped as positive, untapped as negative; feed it as training data
- 90/10 imbalance collapses any classifier toward the majority class; the rail thinks every entry is "irrelevant"
- Bottom-of-list entries never get seen; treating them as negative trains the model to deprioritise them further; positive feedback loop produces worse rails
- Small prompt change → eval jumps 8 points because that week's untapped-items happened to differ; ship the prompt; user-visible quality unchanged

With the caveat:
- `[B3.5]` uses explicit pairs hand-curated by the developer — ~20–30 (query, expected_entry_id) labels; clean signal, no inference
- `[B2A.8]` ships with documented interpretation: "tapped = saw + decided to act; untapped = unknown"; eval measures precision on tapped only, never claims recall
- Future explicit affordance ("is this related? yes/no") collects intentional negatives — class balance is real, labels are honest
- Audit rule: every feature using interaction data writes one paragraph about what no-action means before claiming a quality signal

Implicit feedback is signal AND noise — inaction has many causes, relevance is only one of them.

---

## How it works

The mental model people start with: "if a user clicks/taps, they liked it; if they don't, they didn't." This is wrong in three correlated ways.

### Reason 1: Users don't see what they don't see

A user looking at a list of 10 related entries might tap one — but they probably read only the top 3-4 before deciding. The bottom 6 didn't get a "no" vote; they got no vote at all. Treating those as negatives is treating "didn't scroll that far" as "judged irrelevant."

If you're coming from frontend, this is the same shape as treating the bottom of an infinite-scroll feed as "rejected" when it just wasn't viewed.

### Reason 2: Tapping has costs beyond relevance

Even if a user sees an entry and finds it relevant, they might not tap because:
- Tapping commits them to navigating away.
- They already remember the entry and don't need to re-read.
- The current task doesn't require the related entry, even though it's relevant.

In loopd specifically: the `[B2A.8]` related-entries rail surfaces entries the user MIGHT want to `#tag` to the current thread. A user might agree "yes that's related" but still not tap because they're in the middle of writing a different entry.

### Reason 3: Class imbalance is structural

Users tap maybe 5-20% of shown items in any "related" feature. Treating tap-rate as a quality signal means baseline quality is ~10% — but if you treat untapped as negatives, you've created a 90/10 imbalance in your "training labels." Most ML pipelines on that ratio collapse toward the majority class.

The practical consequence: the no-click data is *missing*, not *negative*. You don't know what the user thought.

### What to do instead

Four mitigations, in increasing order of robustness:

1. **Treat no-click as missing, not negative.** Eval only on the tapped items. Score by "of tapped items, were they semantically related?" — a precision measurement, not a precision/recall measurement.

2. **Pair-comparison.** When the user taps entry A out of {A, B, C}, treat that as "A > B AND A > C" but say nothing about B vs C. This is the "learning to rank from clicks" pattern.

3. **Explicit feedback.** Add a "yes / no" affordance ("was this helpful?"). Users provide low-bias labels; the negative labels are now intended, not inferred.

4. **Counterfactual evaluation.** Use propensity scoring to adjust for which items the user actually saw. Beyond loopd's scope at solo.

For loopd's `[B2A.8]`: option 1 (treat no-click as missing) is the right starting point. Option 3 (add "this is related?" yes/no on each item) is a cheap second step that yields high-quality data quickly.

### This is what people mean by "implicit feedback is partial truth"

User behavior is signal, but it's a noisy and structurally-biased signal. Treating it as ground truth is the bug; treating it as one input among several is the pattern. Here's the picture.

---

## "No-click is not a negative label" — diagram

```
The naive eval (broken)

  User shown: [#347, #289, #401, #156, #234, ...]
  User taps:  [#289]
  
  Naive interpretation:
    Positive: #289
    Negative: #347, #401, #156, #234, ...
                   ↑
            All treated as "not relevant"
            even though many weren't seen,
            and some seen but not tapped for other reasons.

The correct eval

  Positive labels:    #289 (definitely seen, relevant enough to tap)
  Unknown labels:     #347, #401, #156, #234, ... (no inference)
  
  Score: precision on the tapped items
  Don't claim: anything about untapped items
```

```
Mitigation ladder

  ┌─ Mitigation 1: precision-only ─────────────────────┐
  │ Eval: P(tapped item is relevant)                    │
  │ Don't compute recall; don't infer negatives.        │
  └─────────────────────────────────────────────────────┘

  ┌─ Mitigation 2: pair-comparison from clicks ────────┐
  │ User tapped A, saw {A,B,C}. Use as A>B, A>C only.  │
  │ Don't compare B and C.                              │
  └─────────────────────────────────────────────────────┘

  ┌─ Mitigation 3: explicit feedback ──────────────────┐
  │ Add "is this related? yes/no" affordance.          │
  │ Users opt-in to labels; bias drops dramatically.   │
  └─────────────────────────────────────────────────────┘

  ┌─ Mitigation 4: counterfactual eval ────────────────┐
  │ Adjust for what the user saw vs what was shown.    │
  │ Propensity scoring; beyond loopd's scope.          │
  └─────────────────────────────────────────────────────┘
```

---

## In this codebase

**Status:** `learn-only` for loopd (`[C3.7]` is tagged `learn-only` but exercised through Phase 2A's `[B2A.9]` eval design and Phase 3's `[B3.5]` retrieval eval).

The eval design for `[B3.5]` (loopd RAG retrieval) uses explicit (query, expected entry ID) pairs — not click logs. This is exactly the right shape: hand-curated labels avoid the no-click trap entirely.

**File:** *(no implementation today; relevant to the eval design more than the production code)*
**Function / class:** *(not directly applicable)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
The caveat is one of the foundational findings in IR / recommender systems, dating to research on web-search click modeling in the 2000s. The "Interleaving Methods for Search Evaluation" line of work (Radlinski et al.) and the propensity-scored evaluation work (Joachims, Swaminathan) are the canonical references.

### The deeper principle
Implicit feedback is a sample of behavior under a particular presentation policy. Changing the policy changes the feedback. Treating implicit feedback as ground truth bakes in your current presentation choices.

### Where this breaks down
Some signals are clean negatives — a user actively dismisses or downvotes an item. Those are intentional negatives, not absent positives. The trap is specifically about treating absence as negative, not about treating intentional negatives as such.

### What to explore next
- [B3.5] loopd RAG retrieval eval — uses explicit labels, not clicks
- Joachims "Optimizing Search Engines using Clickthrough Data" — the classical reference
- Anthropic's RLHF approach — explicit human-labelled preferences over implicit click data

---

## Tradeoffs

### Comparison table — eval signal sources

```
┌─────────────────────────┬──────────────────┬──────────────────┬─────────────────────┐
│ Cost dimension          │ Explicit labels  │ Click-only       │ Mixed (clicks +     │
│                         │ (target)         │                  │ "is this related?") │
├─────────────────────────┼──────────────────┼──────────────────┼─────────────────────┤
│ Label quality           │ High             │ Low (biased)     │ High on consented   │
│ Volume                  │ Limited          │ Free at scale    │ Limited but growing │
│ Setup effort            │ Hand-curate set  │ Just log         │ Add UI affordance   │
│ Recall measurable       │ Yes              │ No (no negatives)│ Yes (consented neg) │
│ Right at solo scale     │ Yes              │ No (too noisy)   │ Eventually          │
└─────────────────────────┴──────────────────┴──────────────────┴─────────────────────┘
```

### Sub-block 1 — what explicit labels give up

Volume. Hand-curated (query, expected) pairs cap at whatever you'll personally label — maybe 20-50 per chain. Real click data would be much larger.

### Sub-block 2 — what click-only would have cost

A noisy eval. The 90/10 imbalance from treating no-clicks as negatives biases the precision-recall curve so badly that small prompt changes appear as large quality swings — driven by which items happened to be untapped that week, not by real quality.

### Sub-block 3 — the breakpoint
Explicit labels stay sufficient while corpus and user base are small. They become inadequate when (a) you need recall measurement, or (b) you can collect explicit feedback at meaningful volume (the "is this related?" affordance), at which point mixed signal beats either alone.

### What wasn't actually a tradeoff
Treating click data as labelled training data without any correction was never an option for honest eval.

---

## Tech reference (industry pairing)

### Hand-curated label sets

- **Codebase uses:** target for `[B3.5]`.
- **Why it's here:** the only clean signal at small scale.
- **Leading today:** hand-curated — `adoption-leading` for solo eval, 2026.
- **Why it leads:** clean labels; no statistical correction needed; fast to build.

### Pair-comparison from interaction

- **Codebase uses:** not yet — possible future addition once `[B2A.8]` related-entries ships.
- **Why it's here:** the cheapest mitigation that extracts signal from clicks without falsely inferring negatives.
- **Leading today:** learning-to-rank from clicks — `adoption-leading` for production search.

---

## Project exercises

**Status:** `learn-only`. The caveat is embedded into Phase 3's eval-set design philosophy (`[B3.5]`, `[B2A.9]`); there's no dedicated build item.

### Audit any future click-based eval for the no-click trap

- **Exercise ID:** *cross-cutting (preventative)*
- **What to build:** Before any feature uses click data as eval signal — `[B2A.8]` related-entries when it ships, any future recommender — write down what no-click means. If the answer is "user didn't see it" or "user saw it but had other reasons," explicit feedback or paired comparisons are required.
- **Why it earns its place:** the trap is invisible until it bites. A 1-paragraph audit per feature is the cheapest possible prevention.
- **Files to touch:** feature-specific spec docs.
- **Done when:** every feature using interaction data has documented its interpretation of no-action.
- **Estimated effort:** `<1hr` per feature.

---

## Summary

"No-click is not a negative label" is the caveat that implicit user inaction can't be interpreted as a quality signal — the user might not have seen the item, or saw it but had other reasons not to act. In loopd this is `learn-only`; the eval design for `[B3.5]` uses explicit labels to sidestep the trap entirely. The constraint that makes explicit labels the right call is solo-scale corpus + hand-curation feasibility. The cost being paid is volume — you cap at what one person can label.

Key points to remember:
- Inaction ≠ negative judgment.
- Treat no-click as missing, not as negative.
- Recall isn't measurable from clicks alone.
- Explicit feedback ("is this helpful?") yields clean labels cheaply.
- Hand-curated labels beat noisy implicit signal at small scale.

---

## Interview defense

### What an interviewer is really asking
"How do you evaluate a recommender / related-items feature?" tests whether the candidate knows the click-as-negative-label trap.

### Likely questions

  [mid] Q: Why can't you treat untapped items as negative labels?
  A: Three reasons. First, the user might not have seen the item — bottom of the list, didn't scroll. Second, even if they saw it, "not tapped" can mean "I agree it's related but I'm not navigating away right now." Third, the structural imbalance — typical tap rates are 5-20%, meaning treating untapped as negative creates a 90/10 imbalance that breaks most learning approaches. The correct interpretation is missing-not-negative: untapped data is *absent*, not labelled.
  Diagram:
  ```
  User shown: [A, B, C, D, ..., J]
  User taps:  [B]
  
  Wrong: B=positive, A,C,D...J=negative
  Right: B=positive, others=unknown
  ```

  [senior] Q: How does loopd's `[B3.5]` eval avoid this trap?
  A: By using explicit hand-curated (query, expected_entry_id) pairs as the eval source — not click data from production. ~20-30 pairs labelled by the developer based on actual recall expectations: "if I asked this question, this is the entry I expected to find." The signal is clean (every label is intentional), volume is small (capped at hand-labelling capacity), and the trap doesn't apply because there's no implicit-vs-explicit interpretation question. At scale, mixed signal — clicks + an explicit "is this related?" affordance — would become more practical.
  Diagram:
  ```
  Picked: explicit pairs              Suggested: click logs
  ──────────────────────              ──────────────────────
  ~20-30 hand-labelled                ~thousands per week
  Every label intentional              ~90% missing-not-negative
  Right at solo scale                  Right at scale + explicit feedback
  ```

  [arch] Q: At 10× users, what changes?
  A: Two shifts. First, hand-curated labels stop scaling — you can't label 1000 items personally. The fix is collecting explicit feedback ("was this related? y/n" buttons) — opt-in, clean labels, scales with user count. Second, click data becomes more useful via pair-comparison: tapping A out of {A, B, C} is signal that A > B and A > C without claiming B is "negative." Learn-to-rank approaches use this without falling into the trap.
  Diagram:
  ```
  Today (solo)         →  Hand-curated ~20-30 labels
  10× users            →  + explicit "is this helpful?" affordance
  100× users           →  + pair-comparison from clicks (learn-to-rank)
  ```

### The question candidates always dodge
"What about NDCG / MAP / standard ranking metrics — those handle no-click implicitly, right?" The honest answer: those metrics handle clicks-as-relevance but still inherit the position-bias and missing-data problems unless explicitly corrected. Standard NDCG on raw click data is still distorted; the fix is either explicit labels (escape the trap) or propensity-scored NDCG (correct within the trap).

```
Picked: explicit labels              Suggested: NDCG on raw clicks
─────────────────────────             ─────────────────────────────
Clean signal                          Position-biased signal
Caps at hand-curation                 Scales but distorted
Right at small scale                   Wrong at any scale without corr.
```

### One-line anchors
- Missing ≠ negative.
- Inaction has many causes; relevance is only one.
- Implicit feedback is signal AND noise.
- Explicit feedback ("is this helpful?") is cheap and high-quality.
- Hand-curated labels beat noisy implicit at small scale.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the four-step mitigation ladder. Annotate which step `[B3.5]` uses.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) why no-click ≠ negative, (b) the three reasons users skip items, (c) why hand-curated labels work for loopd at solo scale, (d) what changes at 10× users.

### Level 3 — Apply it to a new scenario
A future loopd feature surfaces "AI-suggested todos to expand." Users see 5 suggestions; users tap 1. Without looking, list the three biases at play and propose a clean eval design.

Open the diagram and check whether your design matches mitigation 3 (explicit feedback).

### Level 4 — Defend the decision you'd change
Today the plan is hand-curated labels for `[B3.5]`. If you were starting today, would you ship the explicit "is this related?" affordance from day 1 even at solo scale? Defend your answer.

### Quick check — code reference test
- What kind of label signal does `[B3.5]` use?
- What's the cheapest mitigation that extracts signal from clicks?

Answer: hand-curated (query, expected_entry_id) pairs. Pair-comparison from clicks (mitigation 2) — interpret a tap as "this > others shown together with it" without inferring negatives.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (bakery-window-bottom-shelf scenario → "what does it mean when the user did nothing" pattern naming → bolded "what depends on getting this right" with `[B3.5]` and `[B2A.8]` eval-design stakes → without/with bullets walking click-as-negative vs explicit-labels → one-line "inaction has many causes, relevance is only one" metaphor).
