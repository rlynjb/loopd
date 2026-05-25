# Sampling parameters

**Industry name(s):** Sampling, temperature, top-p, top-k, nucleus sampling
**Type:** Industry standard

> Sampling parameters control how the model picks the next token from the probability distribution. Same model, same prompt, different temperature → different output. Wrong temperature is one of the most common LLM bugs (deterministic chains shipped at 0.7; creative chains shipped at 0).

**See also:** → [04-structured-outputs](./04-structured-outputs.md) · → [01-what-is-an-llm](./01-what-is-an-llm.md) · → [`ai-features-in-this-codebase`](../ai-features-in-this-codebase.md)

---

## Why care

### Move 1 — The grounded scenario

You're building buffr's classifier. You want it to deterministically route todos into one of 7 thinking-mode types. Same todo text → same type, every time. You ship `temperature: 0.7` because that's the default in the Anthropic SDK example you copied. Three days later a user reports: "I typed `[] book flight` yesterday, it was classified as `errand`; I typed the exact same thing today, classified as `task`." Same input, different output. The classifier looks broken, but the model is doing exactly what `temperature: 0.7` told it to: sample from the distribution with natural variation.

### Move 2 — Name the question the pattern answers

That same-input-different-output question is what sampling parameters answer. Not "how do logits work internally" (academic); just *what knobs do I have to control how stable or variable the output is*. The two main knobs: `temperature` (how sharply to favor the highest-probability token) and `top-p`/`top-k` (how many candidate tokens to consider at all).

### Move 3 — Why answering that question matters

**What breaks without the discipline:** classifiers that should be deterministic produce different outputs on identical inputs (bug); creative chains stuck at temperature=0 produce identical outputs every call (also bug, less obvious). In buffr, the `classify` chain runs at `temperature: 0.0` so the same todo always gets the same type — verified by the test suite. The `caption` chain runs with deliberate per-variant temperature variance (`clean=0.4`, `smoother=0.5`, `reflective=0.6`, `punchy=0.85`) because the *point* of 4 variants is that they're different. Picking the wrong temperature for a chain produces either inconsistent classifiers or homogeneous "variants."

### Move 4 — Concrete before/after

Without temperature discipline (default everywhere):
- Classifier at temperature=0.7 → user reports "same input, different label"
- Caption variants all at temperature=0.7 → variants converge in tone
- Debug: weeks (the model isn't broken; the parameter is)

With temperature discipline (per-chain decision):
- Classifier at temperature=0.0 → reproducible
- Caption variants at staggered temperatures → distinct
- Decision documented in `src/services/ai/config.ts` or the chain itself
- Debug when something drifts: minutes

### Move 5 — The one-line summary

Temperature=0 for anything that must be reproducible (classifiers, structured outputs, parsers); temperature 0.3–0.5 for stable generation; temperature 0.7–1.0+ for deliberately varied output. Picking by default instead of per chain is the bug.

---

## How it works

### Move 1 — The mental model

```
   Same prompt, different temperatures
   ──────────────────────────────────

   distribution over next token (model's raw output):
     "the"  → 0.42
     "a"    → 0.28
     "this" → 0.15
     "an"   → 0.08
     ...

   temperature=0   →  always pick "the"      (most probable)
   temperature=0.7 →  usually "the", sometimes "a" or "this"
   temperature=1.5 →  flatter distribution; more variety
```

`top-p=0.9` keeps tokens until their cumulative probability hits 0.9 (nucleus sampling); `top-k=40` keeps only the 40 most likely. Both bound the pool the model can sample from.

### Move 2 — The layered walkthrough

**Layer 1 — what temperature does mechanically.** Temperature is a divisor on the model's logits before the softmax. Temperature=1 leaves the distribution as-is. Temperature<1 sharpens it (peaks get peakier). Temperature>1 flattens it (everything gets more equal). Temperature=0 isn't technically valid (divide by zero) — providers special-case it to mean "always pick argmax," producing fully deterministic output.

```
   ┌─ Deterministic ──────────────────────────────────────┐
   │   temperature = 0                                     │
   │   same prompt → same output, every call               │
   │   use for: classifiers, structured extraction,         │
   │            anything that must reproduce                │
   └───────────────────────────────────────────────────────┘

   ┌─ Stable generation ──────────────────────────────────┐
   │   temperature = 0.3 – 0.5                             │
   │   minor variation between calls, same "shape"         │
   │   use for: structured prose where slight rewordings   │
   │            are OK (buffr's summarize chain)            │
   └───────────────────────────────────────────────────────┘

   ┌─ Creative ───────────────────────────────────────────┐
   │   temperature = 0.7 – 1.0                             │
   │   natural variation; rarely picks unusual tokens       │
   │   use for: caption variants, exploratory generation    │
   └───────────────────────────────────────────────────────┘

   ┌─ Wild ───────────────────────────────────────────────┐
   │   temperature > 1.0                                   │
   │   unusual tokens, sometimes incoherent                │
   │   use for: brainstorming, divergent ideation;          │
   │            rarely shipped to production                │
   └───────────────────────────────────────────────────────┘
```

**Layer 2 — what top-p and top-k do.** Both bound the candidate pool *before* sampling. `top-k=40` says "only consider the 40 most likely tokens at this step." `top-p=0.9` says "consider tokens until their cumulative probability reaches 0.9." Top-p adapts to the distribution shape (confident steps consider fewer tokens; ambiguous steps consider more), which is why nucleus sampling is the modern default. Both are usually left at provider defaults; the knob engineers actually turn is temperature.

```
   Two ways to bound the pool
   ──────────────────────────

   top-k = 40 (hard cap):
     pool = first 40 tokens by probability
     same pool size regardless of distribution

   top-p = 0.9 (adaptive):
     pool = smallest set whose probabilities sum to 0.9
     small pool when distribution is sharp; large when flat
```

**Layer 3 — practical rules.** Three failure modes to recognise. (1) Classifier at temperature>0: outputs drift on identical inputs — user-visible bug. (2) Structured-output chain at temperature>0: occasional invalid JSON because the model picked a less-likely token mid-structure — parse failure. (3) Variant generator at temperature=0: every "variant" is identical because temperature=0 is deterministic per call but ALSO returns the same token sequence on the same input.

```
   Failure modes by parameter choice
   ─────────────────────────────────
   classifier at t>0          →  inconsistent labels
   structured output at t>0   →  occasional parse failures
   variant generator at t=0   →  variants are identical
   creative chain at t=0      →  bland, repetitive prose
```

### Move 3 — The principle

Temperature is a per-chain decision, not a default. Match the temperature to what the chain is for: reproducible output → 0; stable generation → low; deliberately varied output → high. Document the choice in code.

The full picture is below.

---

## Sampling parameters — diagram

```
┌─ One chain call ───────────────────────────────────────────────────┐
│                                                                    │
│   model produces logits per possible next token                    │
│                          │                                         │
│                          ▼                                         │
│           ┌──────────────────────────────┐                         │
│           │ apply temperature (divisor)  │  sharpens or flattens   │
│           └──────────────┬───────────────┘                         │
│                          │                                         │
│                          ▼                                         │
│           ┌──────────────────────────────┐                         │
│           │ apply top-k or top-p filter  │  bounds the pool        │
│           └──────────────┬───────────────┘                         │
│                          │                                         │
│                          ▼                                         │
│           ┌──────────────────────────────┐                         │
│           │ sample one token             │  weighted random        │
│           └──────────────┬───────────────┘                         │
│                          │                                         │
│                          ▼                                         │
│              append to output; repeat for next token               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

   ┌─ Buffr's per-chain temperature decisions ─────────────────────┐
   │   classify   →  0.0    (deterministic — same todo, same type)  │
   │   summarize  →  0.3    (stable structured JSON)                │
   │   expand     →  0.5    (moderate variation in expansion)       │
   │   interpret  →  0.7    (reflective prose; some flair)          │
   │   caption    →  per-variant: 0.4 / 0.5 / 0.6 / 0.85            │
   └────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A — temperature is set per chain in `src/services/ai/`.**

**Files:**
- `src/services/ai/classify.ts` — `temperature: 0.0` (line ~50). Deterministic classifier.
- `src/services/ai/summarize.ts` — `temperature: 0.3` (line ~55). Stable structured JSON; minor wording variation between calls on the same day is acceptable (the cache makes calls per-day infrequent anyway).
- `src/services/ai/expand.ts` — `temperature: 0.5` (line ~60). Moderate variation in expansion steps; same expand request on the same todo should produce similar-but-not-identical results.
- `src/services/ai/interpret.ts` — `temperature: 0.7` (line ~45). Reflective prose; meant to feel different on re-read.
- `src/services/ai/caption.ts` — per-variant temperature: clean=0.4, smoother=0.5, reflective=0.6, punchy=0.85 (line ~70 in the variant loop). The deliberate spread is what keeps the 4 variants tonally distinct from each other.

`top-p` and `top-k` are at provider defaults across all 5 chains. No chain has needed to tune them.

---

## Elaborate

### Where this pattern comes from

Temperature as a sampling parameter dates to softmax-based language models from the 2010s; nucleus sampling (top-p) was introduced by Holtzman et al. in 2019. Modern provider defaults converged on `temperature=1.0, top-p=1.0` for general use; engineering practice settled on per-task temperature tuning by ~2023.

### The deeper principle

When a system has a randomness knob, leaving it at the default for all use cases is the bug. Some use cases want determinism; some want variety; the knob exists because the choice is task-specific.

### Where this breaks down

For very small models or older models, temperature tuning matters more (the model's distribution is "rougher" and small changes shift output significantly). For frontier models in 2026 (Sonnet 4.6, GPT-4o), temperature 0.3 and 0.5 are often hard to distinguish in practice — the model's underlying distribution is already sharp enough that low temperatures all produce similar output. The classifier-temperature=0 vs creative-temperature=0.7 distinction still matters; the 0.3-vs-0.5 distinction often doesn't.

### What to explore next

- [04-structured-outputs](./04-structured-outputs.md) — schema-constrained outputs reduce the cost of mid-range temperatures (the schema catches drift)
- [10-self-critique-and-self-consistency](#) — self-consistency uses high temperature + voting to extract more reliable answers from variable models (not implemented in buffr)
- [`02-context-and-prompts/03-prompt-chaining`](../02-context-and-prompts/03-prompt-chaining.md) — temperature interacts with chaining: a high-temperature first step amplifies through every downstream call

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Tune per chain            │ One default everywhere       │
├──────────────────┼───────────────────────────┼──────────────────────────────┤
│ Code complexity  │ One line per chain        │ Zero                         │
│ Bug class        │ None if matched to task   │ Classifiers drift; variants  │
│                  │                           │ converge; structured outputs │
│                  │                           │ occasionally fail            │
│ Debug speed      │ Decision is in code       │ "Why is it doing that?"      │
│ Cost / latency   │ Identical                 │ Identical                    │
└──────────────────┴───────────────────────────┴──────────────────────────────┘
```

### The breakpoint

Tune per chain whenever the chain has a clear character (classifier, variant generator, reflective prose, structured extractor). Skip tuning for one-off exploratory prompts during development. Document the chosen temperature in code with a one-line comment naming WHY.

---

## Tech reference (industry pairing)

### Anthropic SDK `temperature` parameter

- **Codebase uses:** `temperature: number` passed in the `messages.create()` call options in every chain in `src/services/ai/`. Per-chain values listed above.
- **Why it's here:** the provider's primary knob for output stability.
- **Leading today:** Sonnet 4.6 with explicit per-chain temperature.
- **Why this leads:** the per-chain default discipline is the modern shape — providers no longer pretend "0.7" is a sensible global default.
- **Runner-up:** OpenAI uses identical parameter naming and semantics; switching providers via `src/services/ai/config.ts` preserves the per-chain settings.

---

## Project exercises

### B1.3 — Verify caption anti-repetition + document temperature variance

- **Exercise ID:** `B1.3`
- **What to build:** add an assertion test that the 4 caption variants produced for the same day are pairwise distinct (no two variants share more than 70% token overlap), and document the per-variant temperature choice in `src/services/ai/caption.ts` as a comment naming the design intent.
- **Why it earns its place:** the per-variant temperature is the load-bearing reason variants stay distinct; an undocumented design decision is one tweak away from collapsing into homogeneity.
- **Files to touch:** `src/services/ai/caption.ts` (comment), new test fixture.
- **Done when:** the assertion runs against a 10-day fixture set; comments in caption.ts explain why each variant uses its chosen temperature.
- **Estimated effort:** 1 hour.

---

## Summary

### Part 1 — concept recap

Sampling parameters control how the model picks each token from its output distribution. Temperature is the primary knob: 0 for deterministic, low for stable, high for varied. Top-p and top-k bound the candidate pool; usually left at provider defaults. Buffr uses per-chain temperatures: 0 for the classifier, 0.3 for summary, 0.5 for expansion, 0.7 for interpretation, staggered 0.4–0.85 for caption variants. The discipline is per-chain choice, not one default.

### Part 2 — key points to remember

- Temperature = 0 for reproducibility (classifiers, parsers, structured outputs).
- Temperature 0.3–0.5 for stable generation.
- Temperature 0.7+ for deliberately varied output.
- Variant generators need per-variant spread or variants converge.
- Document the temperature choice in code; default-everywhere is the bug.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "what temperature do you use," they're checking whether you've thought per-task or are running defaults. Engineers who tune per chain produce systems that behave as the spec says; engineers who don't ship inconsistent classifiers and homogeneous variants.

### Likely questions

**Q [mid]:** Why is temperature=0 the right choice for buffr's classifier?

**A:** Because the user expects "same todo, same label." Anything above 0 produces drift on identical inputs — `[] book flight` classified as `errand` today, `task` tomorrow — which surfaces as a "the AI is broken" user complaint. The classifier is the one chain where reproducibility is the spec; temperature 0 is the implementation that delivers it.

**Q [senior]:** Buffr's caption chain uses 4 different temperatures for 4 variants. Why not just use temperature=1 for all four?

**A:** Because the model's underlying distribution is sharp enough that temperature=1 on the same prompt produces variants that drift in *content* (sometimes the model picks a less-likely fact) without much drift in *tone*. The four-variant feature is meant to give the user tonal range, not factual range. Tuning temperature per variant — 0.4 for `clean`, 0.85 for `punchy` — varies how aggressive the variant is at picking unusual phrasings while keeping the content stable. The spread is the feature.

```
   Temperature spread shapes tone, not content
   ───────────────────────────────────────────
   variant=clean    t=0.4   →  "today I shipped the auth flow"
   variant=smoother t=0.5   →  "I got the auth flow shipped today"
   variant=reflective t=0.6 →  "today's win: the auth flow is live"
   variant=punchy   t=0.85  →  "auth flow done. ship it."
```

**Q [arch]:** When would you reach for `top-p` or `top-k` instead of just temperature?

**A:** Rarely. Top-p and top-k bound the candidate pool *before* sampling — useful when you want to keep diversity but rule out pathological tokens that the model occasionally surfaces in long-tail probability. In practice, for frontier models in 2026, the long tail is well-behaved enough that temperature alone covers most use cases. I'd reach for top-p<1.0 if I saw the model producing occasional bizarre tokens at high temperature; for buffr's caption chain at temperature=0.85, I haven't seen that.

### The question candidates always dodge

**Q:** Have you ever shipped the wrong temperature and what happened?

**A:** Yes. Early buffr classifier was at `temperature: 0.7` because I copied the SDK example. Within a week I noticed the same todo being classified differently across days — `[] write up postmortem` had been `task`, then `creative`, then `task` again. Re-ran the same prompt 10 times against a test fixture and got 4 different labels. Fixed by dropping to `temperature: 0.0`. The fix was one line; the diagnosis took half an afternoon because I'd assumed the model was being "smart" rather than that the parameter was wrong.

### One-line anchors

- Temperature = 0 for reproducibility; rises with desired variety.
- Per-chain decision, never one default.
- Top-p and top-k bound the pool; usually defaults are fine.
- Variant generators need temperature spread, not one shared temperature.
- Wrong temperature is one of the most common LLM bugs; fix is trivial, diagnosis isn't.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the sampling pipeline: logits → temperature scaling → top-p/top-k filter → weighted sample → next token, with example temperature values labeled (0, 0.3, 0.7).

### Level 2 — Explain it out loud

Explain in under 60 seconds why a classifier needs temperature=0 and a variant generator needs a temperature spread.

### Level 3 — Apply it to a new scenario

A new requirement: buffr should generate 3 "writing prompts" each morning to seed the day's journal entry. Pick a temperature (or temperatures) and justify. Cross-check by reading `src/services/ai/caption.ts` line ~70 — the structurally similar variant loop.

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should drop classifier temperature to make room for confidence scoring — the model can't communicate uncertainty if temperature=0." Why or why not?

### Quick check — code reference test

Without opening files:
- What temperature does buffr's `classify` chain use?
- What temperatures do the 4 caption variants use?
- What's the symptom if you ship a classifier at temperature=0.7?
