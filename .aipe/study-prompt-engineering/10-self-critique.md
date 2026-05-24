# Self-critique and self-consistency

**Industry name(s):** Self-critique, self-consistency, reflection, two-pass generation
**Type:** Industry standard · Language-agnostic

> Ask the model to evaluate its own output and revise, or run the prompt N times and vote. 2–5× the cost for one extra step of reliability. Use on high-stakes outputs, low-trust classifiers, content that's hard to manually review.

**See also:** → [05-eval-driven-iteration](./05-eval-driven-iteration.md) · → [09-chain-of-thought](./09-chain-of-thought.md) · → [02-structured-outputs](./02-structured-outputs.md)

---

## Why care

### Move 1 — The grounded scenario

You have a chain that rewrites a user's journal entry — fixes typos, smooths grammar, preserves the user's voice. Most rewrites are fine. Some are subtly wrong: the model adds a sentence the user didn't write ("which made the day feel productive"), or changes the user's word choice in a way that flattens their voice ("frustrated" becomes "annoyed"). The user notices and is annoyed; they have to manually undo. You're a user-data feature; trust matters; the failure mode is "the user feels their writing was altered without permission."

### Move 2 — Name the question the pattern answers

That am-I-sure-about-this question is what self-critique answers. Not "make the model better at the task" — just *after the model produces an output, ask it (or another model) to evaluate the output against criteria, and revise if needed.* The pattern is two halves: self-critique (one model generates, the same or another evaluates + revises) and self-consistency (run the same prompt N times, take the most common answer).

### Move 3 — Why answering that question matters

**What breaks without it:** high-stakes outputs ship with the failure rate of a single LLM call (typically 1-10% on tricky cases). For low-stakes outputs that's fine; for outputs the user trusts as authoritative (rewrites, summaries published as canonical, classifier decisions that gate downstream behaviour), 1-10% failure is too high. Buffr today has no self-critique: every chain ships its first response. The chain most exposed to this is a hypothetical "rewrite the user's entry" feature (not yet built); current chains have lower stakes per-output (a bad caption variant is one of 4, a bad summary is regenerated next session, a bad classification surfaces as a sort artifact).

### Move 4 — Concrete before/after

Without self-critique (rewrite chain ships single response):
- User asks for a rewrite of their entry
- Chain produces a rewrite that adds a sentence the user didn't write
- User notices, manually undoes
- Trust degrades; user stops using the feature

With self-critique (rewrite chain reviews its own output):
- Chain produces rewrite 1
- Same chain runs again with prompt: "review this rewrite for additions, voice preservation, factual accuracy. If issues, revise."
- Chain catches its own added sentence; revises
- Final output ships
- Cost: 2× the tokens, 2× the latency, ~10× the reliability on the failure modes the critic prompt names

### Move 5 — The one-line summary

Self-critique is the LLM equivalent of "ask a colleague to look at this before you ship it" — costs an extra pass; catches the obvious mistakes the original author missed.

---

## How it works

### Move 1 — The mental model

After a chain produces its output, a second LLM call evaluates the output against criteria and either returns "looks good" or proposes revisions. The second call's prompt names what to look for explicitly (no "is this good in general" — always "is this voice-preserving, did it add content not in the original, are there factual additions"). The revision is structured: the critic returns `{issues: string[], revised_output: string | null}`.

```
   single-pass                          self-critique
   ───────────                          ─────────────
   prompt → output                       prompt → output1
                                         critique-prompt(output1) →
                                           {issues, revised}
                                         return revised || output1
```

The critic can be the same model as the producer (cheaper, faster, inherits some blind spots) or a different/stronger model (more expensive, catches more issues, doesn't inherit the producer's failures).

### Move 2 — The layered walkthrough

**Layer 1 — self-critique (one extra call).** After the producer chain emits output, a critic chain reads `(original_input, output, criteria)` and emits `{issues: string[], revised_output: string | null}`. If issues are empty, ship the original output; if issues exist, ship the revised output. The criteria must be specific: "did the rewrite add any sentences not in the original" beats "is this a good rewrite."

```
   self-critique flow
   ──────────────────
   1. produce: rewrite(entry) → rewrite1
   2. critique: critic(entry, rewrite1, criteria) →
        { issues: ["added sentence about productivity"],
          revised_output: rewrite2 }
   3. ship rewrite2 (or rewrite1 if no issues)
```

If you're coming from frontend, this is the same shape as a `useDeferredValue` plus a validation pass — the deferred update gives you a chance to catch errors before the final value commits. Concrete consequence: the critic prompt is its own version-controlled artefact ([03-prompts-as-code](./03-prompts-as-code.md)) with its own eval set ([05-eval-driven-iteration](./05-eval-driven-iteration.md)); you iterate the critic separately from the producer.

**Layer 2 — self-consistency (N calls, vote on the answer).** Run the same prompt N times (typically N=3 or N=5), collect the outputs, take the most-common answer (for classifiers) or pick the highest-rated by a separate scorer (for generative outputs). Works best for tasks with a definite answer (classification, structured judgment); doesn't work for tasks where variety is valued (caption variants).

```
   self-consistency for classifier
   ──────────────────────────────
   classify(text) → "study"
   classify(text) → "study"
   classify(text) → "knowledge"   ← outlier
   classify(text) → "study"
   classify(text) → "study"
   vote: "study" (4 of 5)
   ship: "study"
```

If you're coming from frontend, this is the same shape as a retry-with-jitter that compares results — but in self-consistency, all the runs happen and you VOTE rather than picking the first successful one. Boundary: self-consistency only works when temperature > 0; at temperature 0 you'd get the same answer every time.

**Layer 3 — when the extra cost is worth it.** High-stakes outputs (the user's data is being modified, the output is consumed as authoritative). Low-trust classifiers (the chain's accuracy is borderline and a regression is costly). Content that's hard to manually review (long-form generation where a human reviewer can't catch every issue). For buffr's 5 chains today, none of these conditions strongly apply — captions are visibly multiple variants the user picks from; summaries are regenerated session-to-session; classifications surface as sort artifacts not gating decisions; expansions are explicit user requests where the user judges value.

```
   high-stakes (self-critique worth it)    low-stakes (skip)
   ─────────────────────────────────       ────────────────
   rewrite user's content                   caption variants (user picks)
   classify with high-cost mistake          summarize (regenerable)
   judgment outputs (worth surfacing?)      expand (user-initiated)
   diagnoses, recommendations               classify (low blast radius)
```

**Layer 4 — diminishing returns and producer blind spots.** A model critiquing its own output has the same blind spots that produced the output — if the producer didn't see that a fact was hallucinated, the same model as critic often misses it too. Mitigation: use a stronger or different-family model for the critic (Claude critiquing GPT, or vice versa). The diminishing-returns problem is structural — self-critique catches obvious errors well, subtle errors less well, deeply-aligned errors not at all.

```
   what self-critique catches reliably         what it misses
   ───────────────────────────────────         ──────────────
   format violations                            subtle factual hallucinations
   instruction violations                       (model believes them)
   added unsolicited content                    deep biases shared by model
   length issues                                 family
   tone drift                                   the producer's "preferred"
                                                phrasing the critic also prefers
```

### Move 2.5 — Current state vs future state

Buffr today uses zero self-critique. No chain runs a second pass. The chains' failure modes today are low-stakes per the analysis above, so the absence is correct. A future high-stakes chain (the hypothetical rewrite chain) would land with self-critique from day one.

```
          Now (buffr)                          Later (rewrite chain ships)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ 5 chains, no self-critique   │  │ 5 chains unchanged                │
│ low-stakes per output        │  │ + rewriteEntry chain with         │
│                              │  │   self-critique built in:         │
│                              │  │   - produce rewrite                │
│                              │  │   - critic checks against         │
│                              │  │     additions/voice/facts         │
│                              │  │   - revise or pass through        │
└──────────────────────────────┘  └──────────────────────────────────┘
   correct for current chains        per-chain decision; gated by stakes
```

### Move 3 — The principle

Self-critique is "ask a colleague to review before you ship" applied to LLM output. The cost is real (2-5× the tokens), the benefit is real (catches obvious mistakes the producer missed), and the limit is structural (a single model's blind spots aren't fixed by asking the same model again). Use where the stakes warrant; skip where they don't.

The full picture is below.

---

## Self-critique — diagram

```
┌─ Producer chain ────────────────────────────────────────────────────────┐
│  produce(input) → output_v1                                              │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Critic chain (same or different model) ────────────────────────────────┐
│  critique({                                                              │
│    original_input,                                                       │
│    output_v1,                                                            │
│    criteria: ['no added content', 'voice preserved', 'facts correct']    │
│  }) → { issues: string[], revised_output: string | null }                │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
       ┌───────┴────────┐
       │                │
       ▼                ▼
   ┌──────────┐    ┌─────────────────────┐
   │ no issues│    │ issues found         │
   │ ship v1  │    │ ship revised_output  │
   └──────────┘    │ log issues to metrics│
                   └─────────────────────┘
```

---

## In this codebase

**Buffr's 5 chains: none use self-critique today.** All 5 chains ship single-pass outputs.

**File:** `src/services/ai/summarize.ts` — single-pass. Regenerable next session if wrong.
**File:** `src/services/ai/caption.ts` — single-pass × 4 variants. User picks.
**File:** `src/services/ai/expand.ts` — single-pass. User-initiated, judges value.
**File:** `src/services/ai/classify.ts` — single-pass. Heuristic short-circuit catches obvious cases.
**File:** `src/services/ai/interpret.ts` — single-pass. User-initiated; modal-only output.

Per-chain stakes are low enough that adding self-critique would 2× the cost for marginal benefit. A future chain that rewrites user content directly (changes `entries.text` based on AI suggestion) would land with self-critique from day one — that's the chain most exposed to the failure mode.

---

## Elaborate

### Where this pattern comes from

Self-consistency was introduced in Wang et al. 2022 ("Self-Consistency Improves Chain of Thought Reasoning in Language Models") — sample N outputs, take the majority answer. Self-critique / reflection was popularised by Madaan et al. 2023 ("Self-Refine") — single model generates and iteratively refines its own output. Both are practical techniques in 2024-2025 production with the cost ladder being the gating factor on adoption.

### The deeper principle

Reliability is purchased in extra passes. A single-pass output has the failure rate of a single LLM call; an N-pass output has the failure rate of N independent passes voted (which, for independent failures, drops to roughly (failure_rate)^N — though the assumption of independence is the wobbly part).

### Where this breaks down

When the critic shares the producer's blind spots — the same model often makes the same mistakes regardless of which role you assign it. Mitigation: cross-family critic (Claude critiques GPT). When the cost of N extra passes exceeds the cost of an occasional failure — at low-stakes outputs, self-critique is over-engineering.

### What to explore next

- [05-eval-driven-iteration](./05-eval-driven-iteration.md) — LLM-as-judge is the runtime cousin of self-critique; same shape, different consumer.
- [09-chain-of-thought](./09-chain-of-thought.md) — CoT reasons in one pass; self-critique reasons across two passes. Different cost/benefit ratios.
- [02-structured-outputs](./02-structured-outputs.md) — the critic's output (`{issues, revised}`) is itself a structured output; same schema discipline applies.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Self-critique             │ Single-pass               │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Token cost       │ 2× (single critic)        │ 1×                        │
│                  │ N× (self-consistency)     │                           │
│ Latency          │ 2× (sequential critic)    │ 1×                        │
│ Reliability      │ ~10× on obvious errors    │ baseline                  │
│ Blind spots      │ Same as producer (mostly) │ Producer's blind spots    │
│ Setup            │ Critic prompt + criteria  │ Zero                      │
│ Failure surface  │ Critic can introduce new  │ One source of failure     │
│                  │ errors during revision    │                           │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Self-critique costs you 2× the tokens and 2× the latency. For a chain running ~30 times per day in buffr today: trivial. For a chain at 100× volume: real money + real latency on every call. The setup cost is one critic prompt (with its own version-controlled file, its own eval set) and a way to combine producer + critic outputs in the application code.

### What the alternative would have cost

Single-pass outputs on high-stakes chains pay in trust regressions. For buffr's current chains the stakes are low enough that single-pass is correct. For the hypothetical rewrite chain, single-pass would surface as "the AI changes my writing without permission" complaints — paid in user trust, not in tokens.

### The breakpoint

Self-critique earns its keep when the cost-of-failure exceeds 2× the cost-of-call. For low-stakes outputs (buffr's current 5 chains), failure cost is low and 2× compute isn't justified. For high-stakes outputs (rewrites, diagnoses, recommendations), failure cost is high and 2× compute pays for itself in the first prevented incident.

---

## Tech reference (industry pairing)

### Two-pass producer/critic (application-level)

- **Codebase uses:** Not implemented in buffr. The shape would be a chain that calls itself (or a sibling critic chain) after the initial output.
- **Why it's here:** the highest-leverage reliability technique for high-stakes outputs.
- **Leading today:** application-level two-pass — `adoption-leading` for high-stakes LLM outputs, 2026.
- **Why it leads:** no framework dependency; transparent in the codebase; per-chain decision.
- **Runner-up:** Anthropic's extended thinking + reflection in one call (`adoption-leading` for reasoning-heavy tasks); LangChain's "self-ask" chains (`innovation-leading`, more framework, more abstraction).

---

## Project exercises

### B3.18 — Build a self-critique helper

- **Exercise ID:** `[B3.18]`
- **What to build:** new `src/services/ai/critique.ts` exposing `critique<T>(originalInput, output, criteria) → Promise<{issues: string[], revised: T | null}>`. Generic over the output type. Implementation: call the same model with a critic prompt that takes the original input, the output, and a list of criteria; structured output returns issues + optional revised value.
- **Why it earns its place:** the foundation. Without the helper, every chain that wants self-critique re-implements the pattern. The helper makes self-critique a one-line addition per chain.
- **Files to touch:** new `src/services/ai/critique.ts`.
- **Done when:** the helper exists with TypeScript generics; manual test confirms it produces issues + revised output for an intentionally-flawed input.
- **Estimated effort:** 1–4hr.

---

## Summary

### Part 1 — concept recap

Self-critique runs a second LLM call to evaluate the producer's output against named criteria, returning issues + optionally a revised output; self-consistency runs the same prompt N times and votes. Both purchase reliability at the cost of 2-5× tokens and latency. Buffr today uses neither — all 5 chains ship single-pass outputs because the per-chain stakes are low (captions are user-picked variants, summaries are regenerable, classifications have low blast radius). The constraint that forces this concept activates when a chain modifies user content directly or produces outputs the user trusts as authoritative; the hypothetical rewrite chain is the canonical example. The cost being paid for the current shape is zero because no current chain crosses the stakes threshold.

### Part 2 — key points to remember

- 2-5× cost for one extra step of reliability. Per-chain decision based on stakes.
- Producer and critic share blind spots when they're the same model. Cross-family critic catches more issues.
- Self-consistency (vote across N runs) for classifiers; self-critique (revise) for generative outputs.
- Buffr's current chains don't earn self-critique. A future rewrite chain would.
- The cost is real (tokens + latency). Apply where stakes warrant; skip elsewhere.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you make LLM outputs more reliable," they're testing whether you've ever shipped a chain whose failure cost outweighed its compute cost. The answer that names per-chain stakes assessment and the 2× cost tradeoff is the answer of someone who's calibrated. The answer that says "always self-critique" is the answer of someone who hasn't paid the compute bill.

### Likely questions

**Q [mid]:** What's the difference between self-critique and self-consistency?

**A:** Self-critique is two passes with different roles — producer generates, critic evaluates and revises. Self-consistency is N passes with the same role — generate N times, vote (or pick by score). Self-critique works for generative outputs (rewrites, summaries) where the critic can name specific issues; self-consistency works for tasks with definite answers (classifiers, structured judgments) where voting is meaningful. They're complementary, not competing.

```
   self-critique                    self-consistency
   ──────────────                   ────────────────
   2 passes, different roles        N passes, same role
   "review this, revise if needed"  "do this N times, vote"
   for generative outputs           for definite-answer tasks
   2× cost                          N× cost (typically 3-5)
```

**Q [senior]:** Buffr's chains don't use self-critique. Are you sure none of them warrant it?

**A:** Per-chain: `summarize` is regenerable (next session reproduces it; user can't see version A vs B as a regression). `caption` produces 4 variants and the user picks one; user-judged at the consumption point. `expand` is user-initiated and the user judges the result. `classify` has the heuristic short-circuit catching obvious cases; remaining 20% are LLM-classified with low blast radius. `interpret` is modal-only; user reads and dismisses. None of these have the "AI modifies user content authoritatively" failure mode that self-critique exists to prevent. The day a chain ships that DOES rewrite `entries.text` or otherwise authoritatively modify user state, self-critique lands with it.

**Q [arch]:** At 100× the call volume, does your self-critique strategy scale?

**A:** The 2× cost scales linearly with volume. At 100× volume on a high-stakes chain, you're paying for 100× the compute of a self-critiqued chain vs 100× of a single-pass chain — the multiplier is the same. The architectural concern at scale isn't whether self-critique is affordable; it's whether the criteria the critic checks against are still load-bearing. Some failure modes get baked out by model improvements over time (newer models hallucinate less, drift less); the criteria you're checking today may be obsolete in 18 months. Periodic re-evaluation: is the critic still catching issues that the producer would have shipped, or is it adding cost for catches the producer wouldn't have made anyway?

### The question candidates always dodge

**Q:** Self-critique with the same model often shares the same blind spots as the producer. Is that fundamental or fixable?

**A:** Mostly fundamental, partially fixable. Fundamental: the same model's training distribution shapes both the producer's failures and the critic's blindness; deeply-aligned errors (the model "believes" the hallucinated fact) don't get caught regardless of how you frame the critic's role. Partially fixable: explicit criteria help (the critic is prompted to check specific properties, which biases it to look for those issues even if it wouldn't have flagged them spontaneously). Cross-family critic (different provider) catches more independent failures because the blind spots are less correlated. The candidates who dodge this question oversell self-critique as a general reliability technique; the production engineers calibrate it per-chain and accept the residual failure rate as the cost of single-model self-critique.

### One-line anchors

- 2× tokens for one extra step of reliability.
- Per-chain decision based on stakes.
- Producer + critic share blind spots when they're the same model.
- Self-critique for generative outputs; self-consistency for classifiers.
- Cross-family critic catches independent failures.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the two-pass flow: producer chain → critic chain (consuming input, output, criteria) → branch on issues (ship original or ship revised).

### Level 2 — Explain it out loud

Explain self-critique vs self-consistency in under 90 seconds.

Checkpoints — did you:
- Name the difference (different roles vs same role)?
- Name a use case for each (rewrite vs classifier)?
- Name the shared-blind-spots limit?

### Level 3 — Apply it to a new scenario

A new chain lands in buffr: `summariseWeek(entries: Entry[]) → Promise<string>` — produces a one-paragraph reflection on the week, surfaced as the dashboard header.

Does this chain warrant self-critique? What about self-consistency? What criteria would the critic check against? Sketch in 3-5 sentences.

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr should add self-critique to the `caption` chain — captions are user-facing and a bad variant in the 4 is wasted compute."

### Quick check — code reference test

Without opening files:
- Does any buffr chain currently use self-critique?
- Which buffr chain has built-in single-call reliability via a heuristic short-circuit?
- What's the structure of a critic's output (the typical field names)?
