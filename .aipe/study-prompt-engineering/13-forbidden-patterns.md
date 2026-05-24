# Forbidden patterns and rotating formulas

**Industry name(s):** Forbidden patterns, rotating formulas, anti-patterns, output diversity controls
**Type:** Industry standard · Language-agnostic

> LLMs converge on phrasings. Every output from the same chain sounds the same. Enumerate forbidden openings, rotate formulas, ban specific phrases. Use for any generative chain run repeatedly for the same user.

**See also:** → [01-anatomy](./01-anatomy.md) · → [08-few-shot](./08-few-shot.md) · → [05-eval-driven-iteration](./05-eval-driven-iteration.md)

---

## Why care

### Move 1 — The grounded scenario

You ship a chain that generates 4 caption variants per journal entry. The first day it's delightful — varied, idiomatic, surprises you a little. Three weeks later you notice that every variant 2 starts with "As you reflect on…" and every variant 4 starts with "In the quiet moments after…". You didn't change the prompt. The model is converging on its preferred phrasings for those slots, and the user is reading the same opening day after day. The captions don't feel personal anymore; they feel like AI-generated mad-libs.

### Move 2 — Name the question the pattern answers

That every-output-sounds-the-same question is what forbidden patterns answer. Not "is the prompt clever," not "is the model varied" (it isn't — left to its own devices) — just *enumerate the phrasings you've watched it converge on, ban them by name, and rotate among acceptable alternatives*. The pattern is reactive: you watch outputs in production, notice the convergence, add the converged phrasings to a forbidden-patterns list in the system prompt, ship.

### Move 3 — Why answering that question matters

**What breaks without it:** generative chains run repeatedly for the same user produce monotonous output that feels generated rather than authored. In buffr today, the `caption` chain produces 4 tonal variants per entry; without forbidden-pattern enforcement, the model converges on slot-specific openings within weeks. Users notice; the captions stop feeling personal. The summarize chain has the same risk (every summary opens with "Today felt…" or "It was a day of…"); interpret has the same risk at higher stakes (the interpretive frame becomes formulaic).

### Move 4 — Concrete before/after

Without forbidden patterns:
- Caption variant 2: "As you reflect on today's choices..."
- Caption variant 2: "As you reflect on the small wins..."
- Caption variant 2: "As you reflect on the conversations..."
- (Same opening across 3 weeks)
- User: "the AI captions all sound the same"

With forbidden patterns + rotation:
- System prompt: "FORBIDDEN OPENINGS: 'As you reflect', 'In the quiet', 'Today brought', 'Looking back'. Use varied openings; do not repeat the same opening structure across the 4 variants."
- Caption variant 2 (day 1): "Today's small wins quietly stacked up..."
- Caption variant 2 (day 2): "Three threads ran through your day..."
- Caption variant 2 (day 3): "The conversation about X kept echoing..."
- User: "the captions feel varied"

### Move 5 — The one-line summary

Forbidden patterns are the LLM equivalent of CSS resets — explicit declarations that prevent the model from defaulting to its preferred-but-monotonous output style.

---

## How it works

### Move 1 — The mental model

The model has training-distribution preferences for phrasings. For any output slot (caption opening, summary lead, classifier rationale), some phrasings are statistically more probable than others; the model defaults to those. The forbidden-patterns block in the system prompt is a list of phrasings to NOT use, plus optionally a list of acceptable alternatives to rotate among.

```
   without forbidden patterns
   ──────────────────────────
   model output: defaults to high-probability phrasings
                 e.g., "As you reflect on..." (top-3 for reflective tone)
   over N calls: convergence visible to the user
   
   with forbidden patterns
   ───────────────────────
   system prompt includes: "FORBIDDEN: 'As you reflect on'..."
                           "Use varied openings; rotate among alternatives"
   model output: avoids the named phrasings
                 reaches deeper into the distribution
   over N calls: variety preserved
```

### Move 2 — The layered walkthrough

**Layer 1 — enumerate forbidden openings (and other patterns).** The discipline is reactive: watch production outputs, notice convergence, name the converged phrasings. The forbidden list grows over time. Don't try to anticipate forbidden patterns; you'll guess wrong. Wait for the convergence to surface, then add to the list.

```
   forbidden-pattern enumeration (over time)
   ─────────────────────────────────────────
   week 1: chain ships, no forbidden list
   week 3: notice "As you reflect on" appearing in variant 2 repeatedly
           → add to forbidden list
   week 5: notice "In the quiet moments" appearing in variant 4 repeatedly
           → add to forbidden list
   week 8: notice "Three things stood out" appearing in summary chain
           → add to forbidden list (different chain)
```

If you're coming from frontend, this is the same shape as a `:not()` selector in CSS or a deny-list filter — describe what NOT to do, the rest is allowed. Concrete consequence: the list lives in the chain's system prompt (or in a shared forbidden-patterns module that all chains include).

**Layer 2 — rotating formulas (the constructive alternative).** Banning phrasings without giving the model alternatives often produces awkward output — the model knows what NOT to say, doesn't have a clear path to what TO say. The fix is to enumerate rotating alternatives: "for the opening, choose from one of these patterns: question, observation, specific image, time reference. Do not repeat the same pattern across the 4 variants in one call."

```
   forbidden-only (incomplete)            forbidden + rotation
   ────────────────────────                ─────────────────────
   "Do not start with 'As you reflect'"    "Do not start with 'As you reflect'.
                                            Choose opening style from:
                                              - a question
                                              - a specific image
                                              - a time reference
                                              - a direct observation
                                            Do not use the same style across
                                            variants in one call."
   model: avoids forbidden;                model: avoids forbidden,
   defaults to next-most-probable          rotates intentionally
   phrasing (still converges)
```

If you're coming from frontend, this is the same shape as a design system's "use one of these spacing tokens" rule — banning ad-hoc values is partial; providing the curated alternatives is what makes the system work.

**Layer 3 — when this matters.** Generative chains run repeatedly for the same user. Buffr's `caption` (4 variants per entry, daily-ish), `summarize` (daily), `interpret` (on-demand but per-entry) all qualify. Single-use chains (a one-off `extractKeywords` call) don't need forbidden patterns — the user sees one output, not a series. Classifiers and structured outputs are immune (the output is a typed value, not free prose; phrasing convergence doesn't apply).

```
   needs forbidden patterns                doesn't need them
   ────────────────────────                ─────────────────
   caption (repeated per entry)            classify (typed label)
   summarize (repeated per day)            extractTodos (structured list)
   interpret (repeated per entry)          validate (yes/no output)
   chatbot replies (repeated per user)
   email subject generation (repeated)
```

**Layer 4 — rotation across calls vs within a call.** Buffr's caption chain produces 4 variants per CALL — rotation needs to apply within the call (variants 1-4 should differ from each other) AND across calls (variant 2 today should differ from variant 2 yesterday). The system prompt addresses both: "across the 4 variants, use different opening patterns" + "do not repeat phrasings from recent calls" (the second is harder to enforce because the model doesn't have access to its own history; the workaround is to include a "recent openings" list in the per-call context).

### Move 2.5 — Current state vs future state

Buffr's `caption` chain HAS some forbidden-pattern enforcement today — there's a rotation rule for variants. The exact state of forbidden lists in the chain prompts is something to audit. The other generative chains (`summarize`, `interpret`) likely don't enforce forbidden patterns. The discipline that matures over time is: production observation → forbidden-list growth → eval-coverage of "no forbidden patterns" → ship.

```
          Now (buffr)                          Later (full discipline)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ caption: partial rotation     │  │ caption: forbidden + rotation     │
│   enforcement                 │  │   + eval check (no forbidden     │
│ summarize: no forbidden       │  │   openings in 50 sample outputs) │
│ interpret: no forbidden       │  │ summarize: forbidden + rotation   │
│ classify/expand: N/A (typed)  │  │ interpret: forbidden + rotation   │
│                              │  │ shared forbidden module imported  │
│                              │  │   into every generative chain     │
└──────────────────────────────┘  └──────────────────────────────────┘
   partial; reactive growth          systematic; eval-enforced
```

### Move 3 — The principle

The model has a voice; left alone, that voice converges on its preferred phrasings. The discipline is to actively shape the output distribution by naming what's banned and what to rotate among. The principle generalises: any system with a distribution over outputs needs explicit constraints to maintain diversity, because the default is convergence.

The full picture is below.

---

## Forbidden patterns — diagram

```
┌─ Production observation ────────────────────────────────────────────────┐
│  developer notices: "every variant 2 starts with 'As you reflect'"      │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Forbidden-list growth ─────────────────────────────────────────────────┐
│  add "As you reflect" to the chain's forbidden-openings list             │
│  + enumerate acceptable alternative styles                                │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ System prompt construction ────────────────────────────────────────────┐
│  ...                                                                     │
│  FORBIDDEN OPENINGS:                                                     │
│    - "As you reflect on"                                                 │
│    - "In the quiet moments"                                              │
│    - "Today brought"                                                     │
│  Use varied openings. Choose from: question, image, time, observation.   │
│  Do not repeat opening style across the 4 variants in one call.          │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Eval enforcement ──────────────────────────────────────────────────────┐
│  in the eval set, include cases checking "no forbidden patterns in       │
│  output"                                                                  │
│  LLM-as-judge or regex check: does output contain any forbidden phrase?  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**File:** `src/services/ai/caption.ts` · **Function:** `caption(...)` · **Line range:** L1–L223
The caption chain has some rotation enforcement built into the prompt for the 4 variants. The exact forbidden-pattern list state is unclear without inspection; the chain WOULD benefit from a maintained list.

**File:** `src/services/ai/summarize.ts` · **Function:** `summarize(date)` · **Line range:** L43–L188
No forbidden patterns. Run repeatedly (once per day), so risks convergence on summary openings.

**File:** `src/services/ai/interpret.ts` · **Function:** `interpret(entryText, framing)` · **Line range:** L1–L149
No forbidden patterns. Run repeatedly per-entry, so risks convergence on interpretive openings.

**File:** `src/services/ai/classify.ts` · **Function:** `classify(text)` · **Line range:** L1–L160 — N/A (typed label output, no phrasing to forbid)

**File:** `src/services/ai/expand.ts` · **Function:** `expandTodo(...)` · **Line range:** L1–~L150 — typed schema output; some free-text fields could carry forbidden patterns inside them but the structural format is constrained.

---

## Elaborate

### Where this pattern comes from

The pattern is empirical, surfacing in the production-LLM scene in 2023-2024 as engineers shipped generative chains and watched them converge. No canonical reference paper; the discipline is folk-knowledge from production engineers. Hamel Husain's writing touches on it; the rotating-formulas naming convention is common in caption-generation and chatbot-reply systems.

### The deeper principle

Output distributions converge unless actively constrained. The model is doing Bayesian-ish sampling weighted toward training-distribution likelihood; high-likelihood phrasings dominate without intervention. The intervention is naming the high-likelihood phrasings and steering the model toward lower-likelihood-but-still-good alternatives.

### Where this breaks down

Chains with high natural variance (interpretive long-form where the model branches widely on every call) need less forbidden-pattern discipline; the convergence is slower and the discipline overhead may not earn its keep. Classifier and structured-output chains don't need it (the output isn't free prose). One-off generative chains (run once per install) don't need it (user doesn't see the convergence).

### What to explore next

- [05-eval-driven-iteration](./05-eval-driven-iteration.md) — the eval set should include "no forbidden patterns in output" as a checked criterion.
- [08-few-shot](./08-few-shot.md) — few-shot examples can be the rotation alternatives (each example demonstrates one of the acceptable patterns).
- [01-anatomy](./01-anatomy.md) — forbidden-patterns list lives in the system prompt (the constants section), not in user message.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Forbidden + rotation      │ No enforcement            │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Token cost       │ +50-200 tokens per call   │ Zero                      │
│                  │ (the list grows)          │                           │
│ Output variety   │ Maintained                │ Convergence within weeks  │
│ Iteration burden │ Reactive list growth      │ None                      │
│                  │ (~1 hr per addition)      │                           │
│ Eval surface     │ +1 criterion per chain    │ Subjective ("feels off")  │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Forbidden-pattern enforcement costs tokens (the list lives in the system prompt, growing over time as new patterns surface) and ongoing engineering time (every observed convergence is a new addition to the list). For buffr's caption chain at single-user volume the cost is trivial; for high-volume generative chains the token cost scales linearly with prompt size.

### What the alternative would have cost

No enforcement costs output variety — generative chains run repeatedly for the same user converge on phrasings; users notice within weeks; the AI starts feeling generic. The cost is paid in user perception rather than tokens.

### The breakpoint

For any chain that runs repeatedly for the same user AND produces generative (free-prose) output, forbidden patterns are necessary. The breakpoint is "this chain has run >20 times for one user; the user has noticed repetition." For chains that run rarely or whose output is structured, skip.

---

## Tech reference (industry pairing)

### Forbidden-patterns list as system-prompt convention

- **Codebase uses:** Buffr's `caption.ts` has partial rotation rules; no shared forbidden-patterns module across chains today.
- **Why it's here:** the structural place forbidden patterns belong — system section per [01-anatomy](./01-anatomy.md), constant across calls.
- **Leading today:** explicit forbidden lists in system prompts — `adoption-leading` for generative chains, 2026.
- **Why it leads:** simplest possible shape; works across providers; auditable in prompt source.
- **Runner-up:** logit biasing (provider-side suppression of specific tokens) — `innovation-leading`, provides stronger enforcement but limited to phrase-level not pattern-level; few production engineers use it.

---

## Project exercises

### B3.21 — Audit and add forbidden patterns to buffr's generative chains

- **Exercise ID:** `[B3.21]`
- **What to build:** for `caption`, `summarize`, and `interpret`, sample 30 production outputs each. Identify any phrasings that appear in >5 of the 30 outputs. For each repeated phrasing, add to a forbidden-patterns block in the chain's system prompt. For `caption` specifically, enumerate the 4 acceptable opening patterns (question / image / time / observation) and require rotation across variants.
- **Why it earns its place:** structural fix for the convergence problem. Once added, output variety is maintained until the next convergence surfaces; then iterate.
- **Files to touch:** all three chain files; potentially a shared `src/services/ai/forbiddenPatterns.ts` if the list grows enough to share across chains.
- **Done when:** the chains' system prompts include forbidden-patterns blocks; new outputs (manual spot-check on 5 per chain) show varied openings.
- **Estimated effort:** 1–4hr.

### B3.22 — Add forbidden-pattern check to the eval suite

- **Exercise ID:** `[B3.22]`
- **What to build:** in the eval runner from [B3.10](./05-eval-driven-iteration.md), add a check per generative chain: regex against the chain's forbidden-patterns list, flag any output that contains a forbidden phrase. Optionally extend to LLM-as-judge ([B3.11](./05-eval-driven-iteration.md)) for fuzzy pattern detection ("does this output start with a generic AI-style opening?").
- **Why it earns its place:** makes the forbidden-patterns discipline enforceable. Without the eval check, the patterns are added then forgotten; with it, regressions are caught at iteration time.
- **Files to touch:** `scripts/eval.mjs` (extend with forbidden-pattern checking).
- **Done when:** eval runner flags forbidden-pattern hits; CI gates ship on zero forbidden-pattern hits.
- **Estimated effort:** 1–4hr.

---

## Summary

### Part 1 — concept recap

Forbidden patterns and rotating formulas are explicit constraints in the system prompt that prevent the model from converging on its training-distribution-preferred phrasings; the discipline is reactive (watch production outputs, notice convergence, add to the forbidden list) and pairs with enumerated rotation alternatives so the model has a clear path to varied output. Buffr's `caption` chain has partial rotation enforcement; `summarize` and `interpret` have none, despite being generative chains run repeatedly per user. The constraint forcing this concept is that users notice when generated outputs sound the same week-over-week. The cost being paid for the current shape is paid in user perception — "the captions all sound similar" is a real complaint at multi-week timescales.

### Part 2 — key points to remember

- LLMs converge on phrasings. Default behaviour is monotonous output for any chain run repeatedly.
- The discipline is reactive: production observation → forbidden-list growth → rotation enforcement.
- Forbidden-only is incomplete; pair with enumerated rotation alternatives.
- Apply to generative chains run repeatedly for the same user; skip for structured outputs and one-off calls.
- The list lives in the system prompt (constants section per [01-anatomy](./01-anatomy.md)); eval suite checks for hits.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you stop generated outputs from sounding the same," they're testing whether you've shipped a generative LLM feature and watched it converge. The answer that names forbidden patterns + rotation + eval enforcement is the answer of someone who's been there. The answer that says "we tweak temperature" is the answer of someone who hasn't.

### Likely questions

**Q [mid]:** Why does the model converge on the same phrasings?

**A:** Because the model's sampling is weighted toward training-distribution-likely tokens. For any output slot (caption opening, summary lead), some phrasings are statistically more probable than others; without intervention, the model defaults to those. The convergence isn't a bug — it's the model doing what it's trained to do. The discipline of forbidden patterns is the intervention that shapes the distribution toward varied output.

```
   default behaviour                       with forbidden patterns
   ──────────────────                      ───────────────────────
   sample top-probability tokens           sample below the forbidden zone
   high-likelihood phrasings dominate      varied phrasings sampled
   user sees convergence within weeks      user sees variety maintained
```

**Q [senior]:** Buffr's `caption` chain has partial rotation; `summarize` and `interpret` have none. Why hasn't this been a priority?

**A:** Because buffr is single-user and the user is the developer. The developer reads their own captions every day; if convergence happens, the developer notices within weeks and adds to the forbidden list (reactive discipline). For `summarize` and `interpret`, the developer reads them less frequently, so convergence is less visible. The breakpoint is Phase B: at multi-user scale, the developer can't read every user's outputs, so production observation becomes "users report repetitive captions." The fix lands cheaper if pre-emptive than if reactive at multi-user scale.

**Q [arch]:** What happens to forbidden-pattern enforcement at 100× the call volume?

**A:** Two scaling concerns. (1) The list grows. As more patterns are observed, the system prompt grows — at some point you cross token-budget thresholds (see [04-token-budgeting](./04-token-budgeting.md)). Fix: prune outdated patterns periodically (some patterns the model stops defaulting to as you train it away from them via the prompt). (2) Observation cost. At 100× volume, manual sampling-and-noticing doesn't scale; you need automated pattern detection (LLM-as-judge or n-gram analysis on production outputs) to surface new convergences. Architecture answer at scale: pattern-detection runs nightly on a sample of production outputs; new patterns get auto-suggested to the engineer for review; engineer approves additions to the forbidden list. The discipline is the same; the operation gets automated.

### The question candidates always dodge

**Q:** Why can't you just raise temperature to get more variety?

**A:** Because temperature increases variance but doesn't address convergence on the model's preferred phrasings — it just makes the model occasionally pick the 2nd-most-probable phrasing instead of the most-probable one. At low-medium temperature (0.5-0.8), the model still gravitates toward training-distribution favourites; the variety you get is "minor word substitutions in the same template," not "structurally different output." At high temperature (>1.0) you start getting incoherent outputs as the sampling reaches into the long tail. Forbidden patterns are structural — they remove specific phrasings from the eligible distribution entirely, forcing the model to reach into alternatives. Temperature changes how broadly the model samples; forbidden patterns change WHAT it can sample. Different tools for different problems.

```
   what was picked                what raising temperature would do
   ───────────────                ─────────────────────────────────
   forbidden patterns + rotation  raise temperature
   structural removal of bad      probabilistic re-weighting
   phrasings from eligible set    
   ─                              ─
   maintains coherence            high temp → incoherence
   targeted intervention          coarse intervention
   compounds with eval check      no eval check possible (still
                                  outputs forbidden patterns sometimes)
```

### One-line anchors

- LLMs converge on phrasings. Default behaviour is monotonous.
- The discipline is reactive: observe → enumerate → ban + rotate.
- Apply to generative chains run repeatedly for the same user.
- Forbidden-only is incomplete; pair with enumerated alternatives.
- Eval enforcement is what makes the discipline stick.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the four-layer flow: production observation → forbidden-list growth → system-prompt construction → eval enforcement.

### Level 2 — Explain it out loud

Explain forbidden patterns and rotating formulas in under 90 seconds.

Checkpoints — did you:
- Name why LLMs converge on phrasings?
- Name that forbidden-only is incomplete without rotation alternatives?
- Name eval enforcement as what makes the discipline stick?

### Level 3 — Apply it to a new scenario

A new feature ships: buffr generates a weekly "in case you missed it" digest that recaps the week's notable entries.

This is a generative chain run weekly for each user. What forbidden patterns might emerge? What rotation alternatives would you provide? Sketch in 3-5 sentences.

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr should run [B3.21] now even at single-user scale, because the per-week observation cost is low and the cost of retrofitting at Phase B is high."

### Quick check — code reference test

Without opening files:
- Which buffr chains need forbidden-pattern enforcement?
- Which buffr chains don't (and why)?
- Where in the prompt anatomy does the forbidden-patterns block live?
