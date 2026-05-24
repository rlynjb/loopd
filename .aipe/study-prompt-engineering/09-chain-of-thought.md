# Chain-of-thought (CoT)

**Industry name(s):** Chain-of-thought (CoT), step-by-step reasoning, reasoning prompts
**Type:** Industry standard · Language-agnostic

> Helps multi-step problems. Wastes tokens on simple lookups. Frontier models do CoT internally now; the explicit prompt is less necessary than it was, but still helps cheaper models.

**See also:** → [06-single-purpose-chains](./06-single-purpose-chains.md) · → [02-structured-outputs](./02-structured-outputs.md) · → [04-token-budgeting](./04-token-budgeting.md)

---

## Why care

### Move 1 — The grounded scenario

You're prompting a model to decide whether a habit was completed today based on the day's journal entry. The entry says "went for a long walk, didn't really exercise though" and your habit is "30 minutes of exercise." The answer is "no" — but reaching it requires noticing the verb "didn't" applies to the habit, not to the walk. You add "think step by step" to the prompt and the model now reasons through it explicitly: "the user mentions walking but explicitly excludes it from exercise; the habit specifies 30 minutes; the entry doesn't specify duration of any other activity; conclusion: no." Accuracy on that class of input goes from ~70% to ~95%. You ship the change globally. Three weeks later your classifier latency has doubled and your cost per chain has tripled, because you also added "think step by step" to the chain that decides "is this todo a `study` or a `knowledge`" — a one-shot lookup that doesn't need reasoning.

### Move 2 — Name the question the pattern answers

That when-does-reasoning-help question is what CoT answers. Not "always think step by step" — just *for inputs where the answer requires multiple sub-conclusions, prompt the model to externalise the reasoning before giving the answer; for inputs where the answer is a direct lookup, don't.* The pattern is per-chain, not global.

### Move 3 — Why answering that question matters

**What breaks without it:** multi-step reasoning chains (decision tasks, judgment calls, multi-criterion classification) get the wrong answer because the model is asked to jump to a conclusion without intermediate steps. Conversely, applying CoT globally costs tokens on every chain — `classify` would suddenly emit reasoning prose for every classification, doubling token cost and latency for ~zero accuracy gain on the easy cases (which is most cases). In buffr today, no chain uses explicit CoT prompting; chains that could plausibly benefit (`interpret` for nuanced reflection, `decide` if buffr had one) operate on the model's intrinsic reasoning.

### Move 4 — Concrete before/after

Without CoT (hard task, model jumps to conclusion):
- Prompt: "Did the user complete the 30-minute exercise habit today? Entry: ..."
- Model: "Yes" or "No" — sometimes wrong on ambiguous cases (~30% error rate)
- Diagnostic: the model isn't shown the reasoning steps, so it can't be checked

With CoT (hard task, externalised reasoning):
- Prompt: "Think step by step before answering. Did the user complete the 30-minute exercise habit?"
- Model: "Step 1: the user mentions walking. Step 2: the user explicitly says 'didn't exercise.' Step 3: walking is not the habit. Step 4: no exercise mentioned. Answer: no."
- Error rate drops to ~5%; you can audit the reasoning when it fails

With CoT (easy task, externalised reasoning unnecessary):
- Prompt: "Think step by step before classifying. What thinking mode is this todo: 'understand RLS'?"
- Model: "Step 1: the verb is 'understand'. Step 2: 'understand' typically maps to learning. Step 3: 'RLS' is a technical concept. Step 4: classify as study. Answer: study."
- Same accuracy as without CoT, but 4× the tokens emitted and ~4× the latency

### Move 5 — The one-line summary

Chain-of-thought is per-task overhead — load-bearing for multi-step reasoning, wasted on direct lookups, and increasingly redundant on frontier models that reason internally anyway.

---

## How it works

### Move 1 — The mental model

CoT is a prompt instruction that says "before giving the final answer, externalise the reasoning steps." The model emits the reasoning as part of its response; the final answer comes after. The mechanism is that LLMs predict the next token based on prior context — including the prior tokens THEY just generated. Reasoning tokens prime more accurate final-answer tokens by anchoring the model's attention on relevant intermediate conclusions.

```
   without CoT (direct prediction)
   ─────────────────────────────
   prompt: "Did the user exercise?"
   model:  "yes"  ← jumps to answer
   
   with CoT (reasoning-first)
   ─────────────────────────────
   prompt: "Think step by step. Did the user exercise?"
   model:  "Step 1: ... Step 2: ... Step 3: ...
            Therefore: no"  ← reasoning tokens prime the final answer
```

The reasoning tokens cost real money — they're billed like any other output tokens. The trade is accuracy on hard tasks for cost on every task. Use per-chain, not globally.

### Move 2 — The layered walkthrough

**Layer 1 — when CoT helps.** Multi-step reasoning tasks: decision chains that require combining multiple facts, judgment calls with multiple criteria, multi-hop classifications where the label depends on relationships between input components. The empirical rule: if a smart-human-being-rushed gets the answer wrong by skipping a step, the model benefits from CoT.

```
   CoT helps                                CoT doesn't help
   ─────────                                ─────────────────
   "did user complete habit X?"             "what label is this string?"
   "is this entry interesting enough        "what's the verb in this sentence?"
    to surface tomorrow?"                   "is this JSON valid?"
   "given context, would the user           
    prefer caption A or B?"                 (direct lookup or one-step)
```

If you're coming from frontend, this is the same shape as choosing whether a React component needs `useEffect` or can derive state from props directly — overhead pays off for genuinely effectful flows, wastes cycles on derivations. Concrete consequence in buffr: `interpret` (long-form reflection on a journal entry) benefits from intrinsic CoT (the model reasons internally); `classify` (single-label lookup) does not benefit from explicit CoT.

**Layer 2 — when CoT hurts.** Direct-lookup tasks and high-volume classification chains. The cost is token spend AND latency — both compound at scale. Adding "think step by step" to a classifier that runs ~30,000 times per day at multi-user scale means emitting ~50 reasoning tokens per call × 30,000 = 1.5M extra output tokens per day, paid to the provider for ~zero accuracy gain.

```
   "think step by step" applied globally
   ─────────────────────────────────────
   classify chain: +50 tokens × N calls/day × $0.000125/1k = ~$0.20/day extra
                   no accuracy gain
   caption chain:  +200 tokens × M calls/day × $0.005/1k = ~$5/day extra
                   marginal quality gain (debatable)
   interpret chain: built into the chain's purpose
                    real benefit
```

If you're coming from frontend, this is the same as adding `useMemo` to every component — looks like a perf win, costs more in re-render budget than it saves.

**Layer 3 — the modern caveat: frontier models reason internally now.** Claude Sonnet 4+, GPT-4o+, OpenAI o1/o3 do CoT as part of their inference loop without being asked. The explicit "think step by step" prompt instruction is less load-bearing than it was in 2023 because the model does it anyway on hard tasks. Where the explicit instruction still helps: cheaper / older models (Haiku, GPT-4o-mini) which don't reason as deeply by default, and tasks where you want to AUDIT the reasoning (the reasoning tokens become part of the output for inspection).

```
   2023 era                          2026 era
   ────────                          ────────
   "think step by step" was          frontier models do CoT internally
   load-bearing on GPT-3.5/4         "think step by step" mostly redundant
                                     on Sonnet 4+ / GPT-4o+
   add to ~every reasoning prompt    add only when:
                                       - using cheap models
                                       - auditing reasoning matters
                                       - explicit reasoning tokens
                                         in output are wanted
```

**Layer 4 — the interaction with structured outputs.** When you want both reasoning AND a structured answer, the reasoning goes in a `thinking` (or `reasoning`) field of the structured output schema, NOT in free-form prose before the final answer. The schema enforces the structure: model emits `{thinking: "...", answer: "..."}` — reasoning is captured but doesn't interfere with downstream parsing.

```
   freeform CoT before answer                  structured CoT in schema
   ──────────────────────────                  ────────────────────────
   "Step 1: ... Step 2: ...                    {
    Answer: yes"                                 "thinking": "Step 1: ...",
                                                 "answer": "yes"
   ↓                                            }
   parser has to extract                        ↓
   "Answer: yes" from prose                     parsed as typed object
   regex-fragile                                fields accessed directly
                                                reasoning available for audit
```

### Move 2.5 — Current state vs future state

Buffr today uses zero explicit CoT prompting. Modern Sonnet 4.6 / GPT-4o do enough internal reasoning that the chains work without the instruction. The chain that could plausibly benefit from explicit CoT is `interpret` — but interpret's job IS the reasoning (it's the output, not the means), so CoT is redundant. A future chain that would benefit: a hypothetical `decideIfWorthSurfacing(entry, todos, history) → Promise<{surface: boolean, reasoning: string}>` — a multi-criterion judgment call where surfacing the reasoning matters for both accuracy and user-facing transparency.

```
          Now (buffr)                          Later (hypothetical)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ no explicit CoT              │  │ no explicit CoT for the 5 current │
│ chains work because models   │  │ chains (model reasons internally) │
│ reason internally             │  │ a new judgment chain might use   │
│                              │  │ structured CoT:                   │
│                              │  │   {thinking, answer}              │
└──────────────────────────────┘  └──────────────────────────────────┘
   correct for current chains        per-chain decision, never global
```

What doesn't have to change: the current chains. What changes if a multi-step judgment chain ships: that ONE chain uses structured-CoT in its output schema; the others remain CoT-free.

### Move 3 — The principle

CoT is per-task overhead with real cost. Apply where the task needs it; skip where it doesn't. The modern frontier-model context shifts the discipline from "should I use CoT" to "the model does it anyway; when do I need to make it explicit so I can audit it." Both questions have the same answer: per-chain, never global, based on whether reasoning matters for accuracy or auditability.

The full picture is below.

---

## Chain-of-thought — diagram

```
┌─ Task classification ───────────────────────────────────────────────────┐
│  is this a multi-step reasoning task?                                    │
│    yes → CoT helps                                                       │
│    no  → CoT wastes tokens                                               │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
       ┌───────┴────────┐
       │                │
       ▼                ▼
   ┌──────────┐    ┌────────────┐
   │ direct   │    │ multi-step │
   │ lookup   │    │ reasoning  │
   └──────────┘    └─────┬──────┘
   skip CoT              │
                         ▼
              ┌─────────────────────────┐
              │ model choice            │
              │   frontier? → intrinsic │
              │   cheaper? → explicit   │
              └─────┬───────────────────┘
                    │
                    ▼
              ┌─────────────────────────┐
              │ output shape            │
              │   prose ok? → freeform   │
              │   structured? → CoT in   │
              │     schema's "thinking"  │
              │     field                │
              └─────────────────────────┘
```

---

## In this codebase

**Buffr's 5 chains, CoT usage:**

**File:** `src/services/ai/summarize.ts` — does not use explicit CoT. The model reasons internally to produce the structured summary; the reasoning isn't externalised in the output.

**File:** `src/services/ai/caption.ts` — does not use explicit CoT. The 4 tonal variants are direct generations.

**File:** `src/services/ai/expand.ts` — does not use explicit CoT. The 4 per-type schemas direct the model toward the expansion shape; reasoning is implicit.

**File:** `src/services/ai/classify.ts` — does not use explicit CoT. Direct-lookup classifier; CoT would waste tokens.

**File:** `src/services/ai/interpret.ts` — does not use explicit CoT. The chain's OUTPUT is the reasoning (long-form reflection); no need to externalise it as a separate step.

The pattern in buffr is "rely on the frontier model's intrinsic reasoning." If a future chain needs auditable judgment, structured-CoT (with a `thinking` field) is the right shape.

---

## Elaborate

### Where this pattern comes from

The Wei et al. 2022 "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models" paper named the technique and provided empirical evidence that intermediate reasoning steps improved accuracy on multi-step problems. The "think step by step" magic phrase came from Kojima et al. 2022 ("Large Language Models are Zero-Shot Reasoners"), showing that the prompt alone (without exemplars) elicits the behaviour. Frontier-model intrinsic CoT (o1/o3, Claude's extended thinking) productionised the pattern as a model capability rather than a prompt instruction in 2024-2025.

### The deeper principle

Reasoning happens; the question is whether you externalise it. External reasoning gives you (a) better accuracy on hard tasks at the cost of tokens, (b) auditability for free, (c) traceable failure modes when the model gets it wrong. Internal reasoning (frontier-model default) gives you the accuracy without the auditability. Choose per-task.

### Where this breaks down

When CoT instructions get blindly added globally without per-task evaluation, the cost compounds (every chain pays for reasoning it doesn't benefit from). When the model gets reasoning RIGHT but the final answer extraction is regex-fragile (the cost of freeform CoT before a final answer). When the task is too complex for CoT alone — at some point you need to decompose into single-purpose chains instead (see [06-single-purpose-chains](./06-single-purpose-chains.md)).

### What to explore next

- [02-structured-outputs](./02-structured-outputs.md) — when you want both reasoning AND a typed answer, structured CoT (reasoning in a field) is the shape.
- [06-single-purpose-chains](./06-single-purpose-chains.md) — when CoT isn't enough, decompose into a pipeline of single-purpose chains.
- [10-self-critique](./10-self-critique.md) — the runtime cousin of CoT; ask the model to evaluate its OWN reasoning before committing to an answer.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Explicit CoT (per chain)  │ Rely on intrinsic CoT     │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Token cost       │ +50-200 tokens per call   │ Zero extra                │
│ Latency          │ +1-3s per call            │ Same as non-CoT           │
│ Auditability     │ Reasoning in output       │ Black box                 │
│ Accuracy on hard │ Better on cheaper models  │ Equivalent on frontier    │
│ tasks            │                           │                           │
│ Cost compounded  │ Per-call × N/day          │ Zero                      │
│ on easy tasks    │                           │                           │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Adding explicit CoT to a chain costs ~50-200 tokens per call (the reasoning emitted before the answer) plus ~1-3 seconds of latency (time to generate those tokens). At single-user scale: small. At Phase B scale: real money if applied to a high-volume chain.

### What the alternative would have cost

Skipping CoT on a chain that needed it (a multi-step judgment task on a cheap model) costs accuracy. Adding it globally costs tokens on every chain. The per-chain decision is the right shape; both extremes cost more than the targeted application.

### The breakpoint

For frontier models (Sonnet 4+, GPT-4o+), the breakpoint where explicit CoT becomes necessary is "the chain consistently gets multi-step inputs wrong by skipping a step." For cheaper models (Haiku, 4o-mini), the breakpoint is lower — explicit CoT helps for any non-trivial reasoning task.

---

## Tech reference (industry pairing)

### Anthropic extended thinking

- **Codebase uses:** Not used in buffr today. Available on Claude Sonnet 4.6 via the `thinking` parameter in `messages.create()`.
- **Why it's here:** the modern shape of "explicit reasoning" — the model thinks, the thinking is returned in a separate `thinking_blocks` field, the final response is the answer.
- **Leading today:** Anthropic extended thinking — `innovation-leading` for auditable reasoning, 2026.
- **Why it leads:** native integration; reasoning tokens billed separately and visible in the response; integrates cleanly with structured outputs.
- **Runner-up:** OpenAI o1 / o3 — `innovation-leading` for reasoning-heavy tasks; reasoning is hidden from the response (just visible in usage stats), so less auditable.

---

## Project exercises

### B3.17 — Audit which buffr chains might benefit from structured CoT

- **Exercise ID:** `[B3.17]`
- **What to build:** add an "Eval: would structured CoT help" column to the chain inventory (from [B3.13](./06-single-purpose-chains.md)). For each chain, run 5 hard inputs both with and without CoT and compare accuracy. Document the per-chain verdict.
- **Why it earns its place:** stops the next contributor from blindly adding "think step by step" globally. Naming the per-chain answer makes the discipline visible.
- **Files to touch:** `docs/spec.md` or `docs/ai-chains.md`.
- **Done when:** chain inventory has per-chain CoT verdict ("not needed" / "useful" / "load-bearing"); 5-input comparison documented per chain.
- **Estimated effort:** 1–2 days.

---

## Summary

### Part 1 — concept recap

Chain-of-thought is a prompt instruction that asks the model to externalise its reasoning steps before giving the final answer; helps multi-step reasoning tasks (especially on cheaper models) and wastes tokens on direct lookups. Frontier models (Sonnet 4+, GPT-4o+) reason internally without being asked, so the explicit "think step by step" instruction matters less than it did in 2023 — except when you want the reasoning visible for audit. Buffr today uses no explicit CoT; the chains rely on intrinsic reasoning from Sonnet 4.6, which works because none of the 5 chains require auditable multi-step judgment. The cost being paid for the current shape is zero — the discipline matches the task.

### Part 2 — key points to remember

- Per-chain, never global. Apply CoT where the task benefits; skip where it doesn't.
- Frontier models reason internally now. The explicit prompt is less load-bearing than in 2023.
- When you want both reasoning AND a typed answer, put reasoning in a `thinking` field of the structured output, not in freeform prose.
- The original paper is Wei et al. 2022; the "think step by step" prompt is from Kojima et al. 2022.
- Cost compounds at scale — global "think step by step" is expensive on high-volume chains.

---

## Interview defense

### What an interviewer is really asking

The interviewer wants to know if you've calibrated CoT against actual chain economics. The answer that names per-chain decisions plus the frontier-model intrinsic-reasoning caveat is the answer of someone who's tuned chains in production. The answer that says "always add think step by step" is 2023 wisdom that costs money in 2026.

### Likely questions

**Q [mid]:** Why doesn't buffr's classifier use chain-of-thought?

**A:** Because classification is a direct lookup, not multi-step reasoning. The model reads the todo text and outputs one of 6 labels — there's no chain of intermediate conclusions that needs externalising. Adding "think step by step" would emit ~50 reasoning tokens per call for ~zero accuracy gain on Sonnet 4.6. At single-user volume the cost is trivial; at Phase B volume it's real money. The per-chain decision is "skip CoT for classifiers."

```
   classify with CoT                   classify without CoT (current)
   ─────────────────                    ──────────────────────────────
   prompt: "think step by step,         prompt: "classify into one of: ..."
            classify into one of: ..."  model: "study"
   model: "Step 1: ... Step 2: ...     ─
           Answer: study"               output tokens: ~5
   output tokens: ~50                   accuracy: same (Sonnet 4.6)
   accuracy: same                       cost: 10× less
```

**Q [senior]:** Frontier models reason internally now. Is explicit CoT ever load-bearing in 2026?

**A:** Three cases. (1) Cheaper models that don't reason as deeply — Haiku, GPT-4o-mini benefit from explicit CoT on tasks where Sonnet 4.6 wouldn't. (2) Tasks where you want to AUDIT the reasoning — the reasoning tokens become part of the response, available for inspection or display to users. (3) Tasks where you want to reuse the reasoning — structured CoT with a `thinking` field lets downstream code consume both the reasoning and the answer. For all-Sonnet-4.6 buffr-style codebases doing direct chains, explicit CoT is mostly obsolete.

```
   when explicit CoT earns its place
   ─────────────────────────────────
   cheap model + non-trivial task
   audit requirement (regulatory, debug, user-facing transparency)
   structured CoT (reasoning consumed downstream)
   
   when it doesn't
   ─────────────────
   frontier model + direct lookup
   frontier model + multi-step reasoning where intrinsic CoT works
```

**Q [arch]:** What happens to CoT cost at 100× the call volume?

**A:** Tokens compound. A chain that emits ~50 reasoning tokens per call × 100× volume = 5000× more reasoning tokens than baseline. At Sonnet pricing this is real money. The architecture answer is per-chain audit (per [B3.17](./09-chain-of-thought.md)) — chains that don't need CoT shouldn't pay for it. The architecture also forces a model-choice decision: if a chain genuinely benefits from CoT, it may be cheaper to switch from "Sonnet with CoT" to "Haiku with explicit CoT" — the cheaper model with more reasoning often beats the expensive model with no reasoning.

### The question candidates always dodge

**Q:** "Think step by step" was the canonical 2023 magic phrase. Is it still magic on Sonnet 4.6?

**A:** Mostly no. On Sonnet 4.6 and GPT-4o, the phrase produces marginal accuracy lift on multi-step tasks (the model would have reasoned similarly without it) and significant token cost (the model now emits the reasoning verbatim). The magic that survives is two-shot: (1) explicit "think step by step" still triggers more verbose reasoning, which matters when you want to AUDIT or display the reasoning; (2) the prompt's framing as a multi-step problem still helps the model break down complex inputs. The candidates who dodge this question keep adding "think step by step" globally because it worked in 2023; the production engineers in 2026 audit per-chain whether it earns its tokens.

### One-line anchors

- Per-chain, never global.
- Frontier models reason internally. Explicit CoT is for cheap models, audit, or structured downstream consumption.
- Reasoning in a `thinking` field, not in freeform prose before the answer.
- "Think step by step" was 2023 magic; mostly redundant on Sonnet 4.6.
- Cost compounds at scale. Per-chain decisions save money.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the task-classification flow: is this multi-step reasoning? → model choice (frontier vs cheap) → output shape (prose vs structured `thinking` field).

### Level 2 — Explain it out loud

Explain chain-of-thought in under 90 seconds.

Checkpoints — did you:
- Name when CoT helps vs hurts?
- Name the frontier-model intrinsic-reasoning shift?
- Name structured CoT as the way to combine reasoning with typed answers?

### Level 3 — Apply it to a new scenario

A new chain lands in buffr: `shouldSurfaceTomorrow(entry, recentHistory) → Promise<{surface: boolean, reasoning: string}>` — multi-criterion judgment about whether a journal entry's themes are worth re-surfacing as a prompt tomorrow.

Should this chain use explicit CoT? If yes, freeform or structured? Why? Sketch in 3-5 sentences.

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr's 5 chains are all CoT-free. The default for ANY new chain should be CoT-free unless explicit testing shows it improves accuracy on the chain's eval set."

### Quick check — code reference test

Without opening files:
- Which buffr chain's OUTPUT is essentially the reasoning (no need for explicit CoT)?
- What's the structured-CoT shape (which field name)?
- Is Sonnet 4.6's intrinsic reasoning called "extended thinking" by Anthropic or by OpenAI?
