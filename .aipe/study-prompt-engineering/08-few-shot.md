# Few-shot prompting

**Industry name(s):** Few-shot prompting, in-context learning, exemplar-based prompting
**Type:** Industry standard · Language-agnostic

> Three to five good examples beat twenty mediocre ones. Examples constrain output more than instructions do. Use for classifiers and format-sensitive tasks; skip for open-ended generation.

**See also:** → [01-anatomy](./01-anatomy.md) · → [02-structured-outputs](./02-structured-outputs.md) · → [13-forbidden-patterns](./13-forbidden-patterns.md)

---

## Why care

### Move 1 — The grounded scenario

You're writing a classifier prompt. You list the labels: `todo, idea, knowledge, study, reflect`. You add an instruction: "respond with one of these labels." You test on five inputs — works great. You ship. A week later you check the classifier's distribution: 30% of outputs are `'todo-item'`, `'idea-note'`, `'STUDY'`, or `'study (knowledge)'` — variations on the labels that don't match any of the five you listed. The instruction is clear; the model is choosing differently anyway. You add three example input/output pairs to the prompt. The distribution snaps to the five labels. The same instruction now works.

### Move 2 — Name the question the pattern answers

That instruction-isn't-enough question is what few-shot answers. Not "how do I phrase the instruction more clearly" — just *demonstrate the shape with examples, because the model attends to demonstrated patterns more reliably than to described rules*. The pattern is small: include 3–5 input/output pairs in the prompt before the user's actual request; the model uses the pairs as the canonical demonstration of what the response should look like.

### Move 3 — Why answering that question matters

**What breaks without it:** classifiers invent new labels, formatters drift to whatever shape the model prefers, schemas get filled with creative variants. In buffr today, `classify` would benefit from explicit few-shot examples — the prompt currently lists labels and trusts the model to pick from them, which works in tests and may drift in production. The expand chain's typed schemas (4 variants for idea / knowledge / study / reflect) are formatted via [02-structured-outputs](./02-structured-outputs.md)'s schema enforcement, which is the strongest version of "show the shape" — the schema literally constrains valid outputs.

### Move 4 — Concrete before/after

Without few-shot (instruction-only classifier):
- Prompt: "Classify into one of: todo, idea, knowledge, study, reflect"
- Tests pass on 5 hand-picked inputs
- Production distribution shows ~30% drift to label variants
- Diagnosis: "the instruction should be clearer" — endless prompt tweaking
- Real fix: add 3–5 examples; drift drops to <1%

With few-shot:
- Prompt: instruction + 5 input/output pairs covering label diversity
- Tests pass on the same 5 hand-picked inputs (now eval set per [05-eval-driven-iteration](./05-eval-driven-iteration.md))
- Production distribution holds within the five labels
- The model has a canonical demonstration; it copies the shape

### Move 5 — The one-line summary

Few-shot is the prompt equivalent of TypeScript's enum — describing what's valid with words is less constraining than showing what's valid with examples; the examples ARE the constraint.

---

## How it works

### Move 1 — The mental model

Few-shot examples are demonstrations of input/output pairs that the model uses as the canonical pattern for what its response should look like. They go in the prompt before the user's actual request. The model attends to the demonstrated shape strongly — more strongly than to described instructions.

```
   prompt with few-shot
   ┌───────────────────────────────────────┐
   │ system: "You are a classifier..."      │
   │ examples:                              │
   │   Input: "..."  → Output: "todo"       │
   │   Input: "..."  → Output: "study"      │
   │   Input: "..."  → Output: "reflect"    │
   │ user: "Classify: {currentTodo.text}"   │  ← model copies the example shape
   └───────────────────────────────────────┘
```

The number that matters is 3–5: enough examples to demonstrate the diversity of the label space, few enough not to bloat the prompt (each example consumes tokens — see [04-token-budgeting](./04-token-budgeting.md)).

### Move 2 — The layered walkthrough

**Layer 1 — examples constrain more than instructions.** This is the empirically-documented property of in-context learning: a model shown three examples of "input → label" copies the label format more reliably than a model told "use these labels in this format." The mechanism is attention: the example is RIGHT THERE in the context window, immediately preceding the user's request; the instruction is earlier in the prompt and competes with whatever other text precedes it.

```
   instruction alone                  + few-shot examples
   ─────────────────                  ────────────────────
   "Classify into: A, B, C"           "Classify into: A, B, C
                                       
                                       Input: 'foo'  → A
                                       Input: 'bar'  → B
   ↓                                   Input: 'baz'  → C"
   model drifts ~30%                   ↓
   (label variants, formatting drift)  model drifts <1%
                                       (copies the format demonstrated)
```

If you're coming from frontend, this is the same shape as a TypeScript enum vs a `string` with a comment listing allowed values — the enum enforces; the string-with-comment hopes. Concrete consequence: buffr's `classify` prompt would benefit from 5 example pairs covering each thinking mode + 1-2 boundary cases.

**Layer 2 — 3–5 examples is the sweet spot.** Fewer than 3: not enough diversity to demonstrate the label space; the model treats them as edge cases rather than canonical examples. More than 5: the examples consume context tokens (see [04-token-budgeting](./04-token-budgeting.md)), provide diminishing returns on accuracy, and start interacting with each other in ways that make iteration harder. The number isn't magic; it's empirically what most production engineers converge on. 20 mediocre examples lose to 5 good examples; the discipline is curating the small set, not piling on the large one.

```
   coverage as a function of example count
   ────────────────────────────────────────
   1 example:    1 case demonstrated; model treats as edge case
   3 examples:   pattern emerges; ~80% of behaviour set
   5 examples:   diversity covered; ~95% of behaviour set
   10 examples:  diminishing returns; +2% accuracy, +800 tokens
   20 examples:  noise; some examples contradict in subtle ways
```

If you're coming from frontend, this is the same shape as Storybook stories — 3–5 stories per component capture the meaningful states; 20 stories per component is unmaintained sprawl.

**Layer 3 — when NOT to use few-shot.** Open-ended generation tasks where the desired output is "creative" or "varied" — adding examples constrains the model toward the example shape, which is what you want for classifiers (constrained) and wrong for generation (you wanted variety). Buffr's `interpret` chain (long-form reflection) would be worse with few-shot examples; the chain's job is to produce reflection that fits the user's writing voice, and few-shot examples would push toward the example writer's voice instead. The `caption` chain produces 4 variants and explicitly wants format consistency within a variant but variety across variants — few-shot examples per variant make sense (3–5 per variant of what "clean tone" looks like); examples mixing variants would confuse the model.

```
   classifier (use few-shot)         open-ended generation (skip few-shot)
   ─────────────────────────         ────────────────────────────────────
   inputs are diverse                inputs are diverse
   outputs are constrained           outputs are creative
   examples = demonstration of shape examples = creative ceiling
   3-5 examples ideal                examples constrain variety
                                     skip; use system-prompt rules instead
```

**Layer 4 — the interaction with structured output.** When you're using [02-structured-outputs](./02-structured-outputs.md), few-shot examples become especially powerful because the example can BE the JSON form itself. The model sees `Input: "..." → Output: {"type": "todo", "confidence": "high"}` and learns the exact JSON shape AND the label distribution AND the field semantics simultaneously. Structured output enforces the shape; few-shot demonstrates the values.

```
   few-shot + structured output
   ────────────────────────────
   tools: [{ name: 'classify', input_schema: { type, confidence } }]
   user message includes:
     Examples:
       Input: "[] follow up on PR review"
       Output: {"type": "todo", "confidence": "high"}
       Input: "[] understand RLS"
       Output: {"type": "study", "confidence": "high"}
     Now classify: {currentTodo}
   
   model gets:
     - the schema (enforces shape)
     - examples (demonstrates label choice + confidence calibration)
   payoff: stronger constraint with both pieces working together
```

### Move 2.5 — Current state vs future state

Buffr's chains today use few-shot inconsistently. The `expand` chain's 4 typed schemas (idea / knowledge / study / reflect) act as structured-output enforcement with implicit per-schema demonstration via the schema itself. `classify` does not currently include explicit input/output examples in its prompt — it lists labels and trusts the model. `caption` includes some example phrasings as part of its variant rotation rules but not as canonical input/output pairs.

```
          Now (buffr)                          Later (few-shot landed)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ classify: instruction-only   │  │ classify: instruction + 5 examples│
│ expand: schema enforces      │  │ expand: schema + 2 examples per   │
│ caption: rotation rules only │  │   type                            │
│                              │  │ caption: 3 examples per variant   │
└──────────────────────────────┘  └──────────────────────────────────┘
   ~30% potential drift             ~1% drift; eval-measurable
```

What doesn't have to change: the schemas, the chain functions, the SDK calls. What changes: each chain's prompt gains a `Examples:` block with 3–5 input/output pairs, eating ~300-500 tokens of context per chain.

### Move 3 — The principle

Demonstration beats description. Whatever you want the model to do, show it 3–5 times in the prompt; the model copies the shape it sees more reliably than the shape it's told. The principle generalises beyond LLMs — it's the same reason design systems use components and stories instead of prose style guides.

The full picture is below.

---

## Few-shot — diagram

```
┌─ Prompt construction (per call) ────────────────────────────────────────┐
│                                                                          │
│  [SYSTEM] role + rules + label list                                      │
│  [CONTEXT] per-call data                                                 │
│  [FEW-SHOT EXAMPLES]                                                     │
│    Input: "..."  →  Output: "..."         ◄── example 1                  │
│    Input: "..."  →  Output: "..."         ◄── example 2                  │
│    Input: "..."  →  Output: "..."         ◄── example 3                  │
│    Input: "..."  →  Output: "..."         ◄── example 4                  │
│    Input: "..."  →  Output: "..."         ◄── example 5                  │
│  [USER REQUEST]                                                          │
│    Now classify: {currentInput}                                          │
│                                                                          │
└──────────────┬──────────────────────────────────────────────────────────┘
               │  model attends to: examples > instructions > other context
               ▼
┌─ Provider ──────────────────────────────────────────────────────────────┐
│  generates output matching the demonstrated shape                        │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Schema enforcement (if structured output) ─────────────────────────────┐
│  example shape ≈ schema shape → high agreement                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**File:** `src/services/ai/classify.ts` · **Function:** `classify(todoText)` · **Line range:** L1–L160
The prompt currently lists labels but doesn't include canonical input/output examples. The natural place to add few-shot examples is between the label list and the user request — 5 examples covering each thinking mode would land here.

**File:** `src/services/ai/expand.ts` · **Function:** `expandTodo(todo, type)` · **Line range:** L1–~L150
Per-type expansion is structured-output enforced (4 schemas). Few-shot examples per type would strengthen the chain — 2 example expansions per type × 4 types = 8 examples; significant token cost but high reliability gain on type-specific tone.

**File:** `src/services/ai/caption.ts` · **Function:** `caption(...)` · **Line range:** L1–L223
The 4 variants (clean / smoother / reflective / punchy) each want format consistency within and variety across. The current prompt encodes the variants via instructions; few-shot examples (3 per variant) would make the tonal distinction sharper.

---

## Elaborate

### Where this pattern comes from

In-context learning emerged as the surprise capability of GPT-3 (2020) — the model could perform tasks it hadn't been explicitly trained on by seeing a few examples in the prompt. The pattern was named in the original paper as "few-shot prompting" to distinguish from zero-shot (no examples) and from fine-tuning (modify the model itself). The practical 3-5-examples-is-the-sweet-spot finding came out of production engineers iterating in the 2023-2024 window; not strict science, but industry consensus.

### The deeper principle

Demonstration is constraint. Showing the model 3 valid outputs constrains it more than describing 3 rules. The same principle underlies a lot of teaching: showing 3 worked examples beats lecturing about 3 abstract rules.

### Where this breaks down

Open-ended generation tasks (creative writing, long-form reflection) — examples constrain the model toward the example shape; you wanted variety. Tasks where the input space is so diverse that 5 examples don't cover it — at that point, fine-tune the model on a larger dataset or accept that few-shot is one technique among several.

### What to explore next

- [02-structured-outputs](./02-structured-outputs.md) — few-shot + structured output is the strongest constraint; each reinforces the other.
- [01-anatomy](./01-anatomy.md) — few-shot examples are one of the four prompt sections; they have a place in the anatomy.
- [13-forbidden-patterns](./13-forbidden-patterns.md) — sometimes the demonstrated pattern is what TO avoid; few-shot can include negative examples.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Few-shot (3–5 examples)   │ Instruction-only          │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Token cost       │ +300–500 tokens per call  │ Zero                      │
│ Drift rate       │ <1%                       │ 5–30% depending on task   │
│ Iteration cost   │ Update examples + rerun   │ Tweak instruction         │
│                  │ evals                     │                           │
│ Onboarding       │ Examples ARE the spec     │ Spec is in the prose       │
│ Output variety   │ Constrained (good for     │ Less constrained (good for│
│                  │ classifiers)              │ generation)               │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Few-shot costs tokens. 3-5 examples × ~50-100 tokens each = ~300-500 tokens per call, paid every call. For buffr's `classify` chain (Haiku, ~$0.0001/call), the per-call cost rises ~50% but stays well under $0.001. For `caption` (Sonnet) the absolute cost is higher; still negligible at single-user volume.

### What the alternative would have cost

Instruction-only prompts drift in production. For classifiers, the drift surfaces as label variants (~30% in the worst case); for format-sensitive chains, as schema-fail rate (caught by structured outputs, but still costs retries). The cost of NOT having few-shot is paid in regression incidents, not in tokens.

### The breakpoint

Few-shot is correct from the start for any classifier or format-sensitive chain. The breakpoint to STOP using it is when output variety matters — open-ended generation tasks where the chain's job is to be creative. There, few-shot becomes a creative ceiling.

---

## Tech reference (industry pairing)

### In-context examples as part of the user message

- **Codebase uses:** Not used consistently in buffr today. The natural shape is an `EXAMPLES:` block within the user message, between context and the user request.
- **Why it's here:** the demonstration mechanism that the model attends to most strongly.
- **Leading today:** in-context examples (inline in the user message) — `adoption-leading` for short-prompt few-shot, 2026.
- **Why it leads:** simplest possible shape; no SDK feature dependency; portable across providers.
- **Runner-up:** synthetic assistant-turn examples (`{role: 'user'} {role: 'assistant'}` × N) — works on chat-completion APIs that distinguish roles; slightly more model-compliant but harder to version-control because the structure lives in the messages array, not as a single string.

---

## Project exercises

### B3.15 — Add 5 few-shot examples to buffr's `classify` chain

- **Exercise ID:** `[B3.15]`
- **What to build:** in `src/services/ai/classify.ts`, add an `EXAMPLES:` block to the prompt with 5 input/output pairs: 1 for each thinking mode (todo, idea, knowledge, study, reflect — pick the simplest canonical case for each). Format consistently with the user request that follows. Verify against the eval set from [B3.9](./05-eval-driven-iteration.md) that label drift drops.
- **Why it earns its place:** the single highest-leverage change to the classifier short of full structured-output enforcement. ~300 tokens added per call; measurable accuracy gain.
- **Files to touch:** `src/services/ai/classify.ts`.
- **Done when:** eval pass rate (from [B3.10](./05-eval-driven-iteration.md)) on the 35-case golden set improves; if pre-baseline was ~28/35, post-baseline should be ≥32/35.
- **Estimated effort:** 1–4hr.

### B3.16 — Document the per-variant tone with examples in `caption`

- **Exercise ID:** `[B3.16]`
- **What to build:** in `src/services/ai/caption.ts`, for each of the 4 variants (clean / smoother / reflective / punchy), include 2 example captions that demonstrate the variant's tone. Format as `Variant: clean\n  Input: "..."  →  Output: "..."`. Verify via LLM-as-judge ([B3.11](./05-eval-driven-iteration.md)) that variant adherence improves.
- **Why it earns its place:** caption is the chain most sensitive to tonal drift; examples ARE the tone spec.
- **Files to touch:** `src/services/ai/caption.ts`.
- **Done when:** LLM-as-judge agreement on "this variant matches the requested tone" improves measurably over baseline.
- **Estimated effort:** 1–2 days (mostly writing the example captions in each tone).

---

## Summary

### Part 1 — concept recap

Few-shot prompting demonstrates the desired output shape with 3–5 input/output pairs in the prompt; examples constrain the model more reliably than instructions do, so the pattern is essential for classifiers and format-sensitive chains and damaging for open-ended generation. Buffr's `classify` chain currently uses instructions without examples (potential drift to label variants); `expand` uses structured-output schema enforcement (which is the structural equivalent); `caption` uses tonal rules without per-variant examples. The constraint forcing this concept is that production classifiers drift without demonstrated examples — the instruction-only shape works in tests and degrades in production. The cost being paid for the current shape is token-free but reliability-poor.

### Part 2 — key points to remember

- 3–5 examples is the sweet spot. More buys diminishing returns; fewer doesn't demonstrate the diversity.
- Examples constrain more than instructions. The model attends to demonstrated patterns more strongly than to described rules.
- Skip few-shot for open-ended generation (`interpret`); use for classifiers and format-sensitive tasks (`classify`, `caption`).
- Few-shot + structured output is the strongest combination — schema enforces the shape, examples demonstrate the values.
- Per-variant examples (caption's 4 tones × 2-3 each) make tonal distinctions sharper than per-variant rules.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you stop a classifier from drifting," they're testing whether you've shipped a classifier and watched it drift. The answer that names few-shot examples as the structural fix is the answer of someone who has been there. The answer that says "we tweak the prompt" is the answer of someone still iterating.

### Likely questions

**Q [mid]:** Why use few-shot instead of just listing the rules clearly?

**A:** Because the model attends to demonstrated patterns more reliably than to described rules — empirically documented since GPT-3, holds across providers. An instruction says "use these five labels"; a few-shot example shows "Input X → Label A" five times. The model copies the demonstrated shape with ~1% drift; the instruction alone drifts to label variants ~30% of the time in production. The cost is ~300-500 tokens per call; the payoff is reliability that doesn't depend on the model's day.

```
   instruction                       + few-shot
   ────────────                      ──────────
   ~30% drift                        <1% drift
   0 token cost                      +300-500 tokens per call
   degrades with model updates       holds across model updates
```

**Q [senior]:** Buffr's `classify` chain has no few-shot examples. Why hasn't it drifted enough to force the fix?

**A:** Because the heuristic short-circuit (`heuristicClassify`) catches the ~70% of cases that are unambiguous before the LLM runs. The LLM only sees the ~30% of ambiguous cases — where drift on label variants is more visible, but the volume is low. Single-user, ~30 ambiguous calls per day, the drift hasn't been visible enough to force the fix. At Phase B (multi-user) the drift becomes visible at scale — at 1000 users × ~30 ambiguous calls = 30,000 LLM classifier calls per day, 30% drift = 9000 mislabelled todos per day. The breakpoint is multi-user.

**Q [arch]:** What happens to few-shot effectiveness at 10× the prompt complexity?

**A:** Few-shot effectiveness degrades when the prompt is so long that the examples get lost-in-the-middle (see [04-token-budgeting](./04-token-budgeting.md)). At 10× complexity (longer system prompts, more context, more rules), the position of the few-shot block matters more — keep it at the end, immediately before the user request, where the model's attention is strongest. If the examples land in the middle of a 50K-token prompt, they lose effectiveness despite being structurally correct.

### The question candidates always dodge

**Q:** When does adding more examples HURT classification accuracy?

**A:** When the additional examples contradict each other in subtle ways. Going from 5 to 15 examples sounds like "more demonstration = better"; in practice, the 6th-15th examples often introduce inconsistencies the curator didn't notice (the model treats this as ambiguity and drifts), or they push the prompt over a token budget that triggers truncation, or they overrepresent one label class (which biases the model toward that label). The discipline isn't "more examples"; it's "5 curated, consistent examples that cover the label space cleanly." Adding a 6th example without thinking is more likely to hurt than help.

### One-line anchors

- 3–5 examples. More buys diminishing returns; fewer doesn't demonstrate diversity.
- Examples > instructions. Demonstration beats description.
- Skip few-shot for open-ended generation; use for classifiers.
- Few-shot + structured output is the strongest combination.
- Position matters at long prompts — examples at the end, before the user request.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the prompt-construction flow: system + context + few-shot + user request → provider → generated output matching the demonstrated shape.

### Level 2 — Explain it out loud

Explain few-shot prompting in under 90 seconds.

Checkpoints — did you:
- Name 3–5 as the sweet spot and explain why?
- Name a case where few-shot is wrong (open-ended generation)?
- Name the interaction with structured outputs?

### Level 3 — Apply it to a new scenario

A new chain lands in buffr: `extractMood(entry: string) → Promise<Mood>` where Mood is one of: energised, contemplative, tired, scattered, focused.

Design the few-shot block: how many examples? Which moods do you cover? Where in the prompt do the examples go? What's the risk if you accidentally curate examples that all skew "energised"?

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr's `classify` chain is fine without few-shot examples because the heuristic short-circuit catches ~70% of cases."

### Quick check — code reference test

Without opening files:
- Which buffr chain would benefit most from explicit few-shot examples?
- Which buffr chain should NOT use few-shot examples?
- Where in the prompt anatomy do few-shot examples live?

---
Updated: 2026-05-29 — aligned the heuristic short-circuit rate (`heuristicClassify`) from "80%" to "~70%" in the two interview-defense references, for consistency with the study-system-design-dsa and study-ai-engineering guides (the figure is an unmeasured back-of-envelope estimate). Left the unrelated "~80% of behaviour set" few-shot-coverage figure unchanged.
