# Sampling parameters

**Industry name(s):** Temperature, top-p (nucleus sampling), top-k, sampling control
**Type:** Industry standard · Language-agnostic

> The knob that decides whether two identical prompts return the same text twice — only the `interpret` chain tunes it explicitly; every other chain runs on the provider's default.

**See also:** → [01-what-an-llm-is](./01-what-an-llm-is.md) · → [16-structured-outputs](./16-structured-outputs.md) · → [14-interpret](./14-interpret.md)

---

## Why care

Open the OpenAI Playground in your browser and look at the right-hand panel. There's a `temperature` slider going from 0 to 2. At 0, the model produces the same answer every time you hit "Submit" on the same prompt — deterministic, reproducible, boring. Slide it to 1 and the answer shifts each run — sometimes the same opening, sometimes a different framing. Slide it to 2 and the output drifts into nonsense after a sentence or two. Same model, same prompt, same weights — but the slider decides which response comes out of the API on any given moment. The Anthropic Workbench has the same slider in the same place.

That slider is what sampling parameters are. Not a knob on the model — a knob on the *sampling step* that runs in front of the model's output, deciding how greedy the next-token pick is. Naming the dial separately from the model is what makes "two identical prompts returned different answers" a tractable fact rather than a mystery.

**What depends on getting this right:** the reproducibility of every chain, especially the ones that should be deterministic. Both Anthropic and OpenAI default to `temperature=1` if no value is passed. Four of the five chains in `src/services/ai/` pass no `temperature`, so `summarize`, `caption`, `classify`, and `expand` all run at the silent default of 1. Only `interpret.ts` L14 declares `const TEMPERATURE = 0.7` and passes it to both Claude and OpenAI — the conventional "creative but coherent" setting for a chain whose output is the artifact the user reads. The gap is `classify` — the chain that picks 1 of 5 modes (`todo/idea/knowledge/study/reflect`) for `todo_meta.type`. At `temperature=1`, the same ambiguous todo text can plausibly return `idea` one run and `knowledge` the next; nothing in the codebase notices because `classifier_confidence='haiku'` doesn't track which label was picked first. The fix is two lines per branch (`temperature: 0` in the Claude SDK call and the OpenAI fetch body) — no schema change, no migration, no contract change.

Without explicit sampling control:
- `classify` runs at `temperature=1`; the same `[] thinking about onboarding` returns `idea` Monday and `knowledge` Tuesday
- "AI is inconsistent" is the only diagnosis available; replay shows the same prompt produced different labels
- Caption variance (which is the feature) and classifier variance (which is the bug) are conflated under one silent default

With explicit sampling control:
- `classify.ts` and `summarize.ts` pass `temperature: 0` — deterministic 5-mode pick, deterministic JSON shape
- `caption.ts` passes `temperature: 0.7` — tonal variance across the four variants is the feature, not a bug
- `interpret.ts` keeps its existing `TEMPERATURE = 0.7` (creative but coherent for the markdown reflection)

Sampling is half the LLM function — same model, same prompt, different dial, different output.

---

## How it works

The OpenAI Playground's temperature slider sits next to the chat input. At 0, the model is locked to the single most-likely next token at every step; at 2 it's drawing from a much wider pool and sometimes picking the long shot. The model's behaviour feels different at each setting — same prompt, same weights, but the sampling step in front of the output changes what comes out. Two operations welded together in the LLM-as-function picture (predict probabilities → emit one token) split apart into two independent decisions: the model produces a distribution, sampling picks from it.

The split in one picture:

```
   prompt
       │
       ▼
   ┌───────────────────────────────────────────┐
   │ MODEL (the weights — same every call)      │
   │                                             │
   │ outputs a probability distribution over     │
   │ the entire vocabulary:                      │
   │                                             │
   │   "Paris"     → 0.92                        │
   │   "Lyon"      → 0.04                        │
   │   "the"       → 0.02                        │
   │   "Marseille" → 0.01                        │
   │   ...                                       │
   └─────────────────┬─────────────────────────┘
                     │
                     ▼
   ┌───────────────────────────────────────────┐
   │ SAMPLER (the dials — vary per call)         │
   │                                             │
   │ temperature, top_p, top_k decide how to    │
   │ pick ONE token from the distribution:       │
   │                                             │
   │   temp = 0   → always pick the highest:     │
   │                  "Paris"                    │
   │   temp = 1   → sample from distribution:    │
   │                  "Paris" 92%, "Lyon" 4%...  │
   │   temp = 2   → flatten + sample:            │
   │                  "Paris" 60%, anything 40%  │
   └─────────────────┬─────────────────────────┘
                     │
                     ▼
              chosen token

   the model is deterministic given the prompt;
   sampling makes the API call non-deterministic.
```

The four sub-sections below trace temperature itself, the silent default trap, the one chain that tunes it, what the codebase doesn't use, and the Phase A → intended-state gap.

### Temperature — the variance dial

The model emits a probability distribution over the entire vocabulary at every step. Temperature is a scalar that gets divided into the logits before the softmax — `temp=0` collapses the distribution onto the single highest-probability token (greedy decoding); `temp=1` leaves it untouched; `temp=2` flattens it so unlikely tokens get a real chance. If you're coming from frontend, you've used `Math.random()` and you've seen it produce different values on each call — temperature is the parameter that says "how much of that randomness do I want in the model's choice." Practical consequence: classify the same input twice at `temp=0` and you get the exact same JSON object both times; classify the same input at `temp=1` and the model might pick `idea` once and `knowledge` the next time when both were plausible. Boundary: temperature only matters when the model is uncertain. On a "what is 2+2" prompt, the top token is `4` by such a wide margin that even `temp=2` returns `4`.

Same prompt under three temperatures:

```
   prompt: "Classify '[] thinking about onboarding' — return JSON"

   model's probability distribution at the .type field:
     "idea"       → 0.42
     "knowledge"  → 0.38
     "reflect"    → 0.12
     "todo"       → 0.05
     "study"      → 0.03

   temp = 0 (greedy):
     run 1: "idea"        ◄── always the top one
     run 2: "idea"
     run 3: "idea"
     → deterministic

   temp = 1 (default):
     run 1: "idea"        ◄── ~42% chance
     run 2: "knowledge"   ◄── ~38% chance
     run 3: "idea"
     → varies

   temp = 2 (flattened):
     run 1: "reflect"     ◄── unlikely tokens get a real chance
     run 2: "study"
     run 3: "idea"
     → drifts toward nonsense
```

When the model is uncertain, temperature controls how often you see the second-best choice; on highly-confident inputs, even `temp=2` returns the top token.

### Default temperatures — the silent setting

Both Anthropic and OpenAI default to `temperature=1` if you don't pass one. This is the trap. The SDK call looks like this:

```ts
client.messages.create({
  model: CLAUDE_MODEL,
  max_tokens: 50,
  system: SYSTEM_PROMPT,
  messages: [{ role: 'user', content: text }],
  // ← no temperature: defaults to 1
});
```

If you're coming from frontend, this is like calling `setTimeout(fn)` without a duration — the function runs at the default of zero, not at a value you chose. Practical consequence: every classifier call, every caption call, every summarise call in this codebase runs at `temperature=1` because the SDK call doesn't pass `temperature`. The model is free to vary its output on identical inputs. Boundary: this is fine for chains that *should* vary (captions, summaries), but it is a real gap for the classifier — same todo text could plausibly classify as `idea` one run and `knowledge` the next, and the user wouldn't see anything is wrong.

### `interpret` — the one chain that tunes it

`src/services/ai/interpret.ts` L14 declares `const TEMPERATURE = 0.7;` and passes it to both Claude and OpenAI. This is the only file in the codebase that explicitly sets temperature. The choice of 0.7 — slightly below the default — is the conventional "creative but coherent" setting; high enough that two interpretations of the same journal entry feel meaningfully different, low enough that the model doesn't lose the thread. In React terms, this is like wrapping a component in `useMemo` only for the one path where memo'd behaviour matters — every other chain accepts the default and gets the provider's "balanced" setting whether they wanted it or not.

What every chain passes today, vs what they should:

```
   chain         today (silent default)        intended            why
   ──────────    ────────────────────────      ──────────────      ─────────────────
   summarize     temperature: undefined         temp: 0            JSON validity:
                 → uses provider default 1                          deterministic
                                                                    structured output
   caption       temperature: undefined         temp: 0.7          tonal variance
                 → uses provider default 1                          across 4 variants
                                                                    is the FEATURE
   classify      temperature: undefined         temp: 0            5-mode label pick
                 → uses provider default 1                          should be
                                                                    deterministic
   expand        temperature: undefined         temp: 0            per-type JSON
                 → uses provider default 1                          schema; structured
                                                                    output
   interpret     TEMPERATURE = 0.7  ◄── only    temp: 0.7          "creative but
                 file with explicit setting     (unchanged)         coherent" for
                                                                    markdown reflection

   fix: four edits (one constant + one ...args spread per branch
   in each chain). no schema change, no migration, no contract change.
```

interpret is the only chain that's already at the intended setting; the other four are silently riding the default.

### What the codebase doesn't use

`top_p` (nucleus sampling — keep only the smallest set of tokens whose cumulative probability hits p) and `top_k` (keep only the top k tokens) are both available on both providers and both omitted in every chain. The defaults — typically `top_p=1` (no nucleus filter) on OpenAI, no top-p/top-k on Anthropic by default — are what you get. Practical consequence: every chain runs with full vocabulary access, modulated only by the default temperature. For a solo single-user app this is fine; production systems serving thousands of users typically combine `temp=0.7 + top_p=0.9` to control variance without locking the model entirely.

The three sampling dials and where each one fits:

```
   dial        what it does                     buffr uses    when to add
   ──────────  ──────────────────────────       ──────────    ──────────────────
   temperature divides logits before softmax;   yes (one      always — every
               higher = more randomness         chain;        chain should set
                                                others use    this explicitly
                                                default)
   top_p        keep smallest set of tokens     no             when temp > 0.5 and
   (nucleus    whose cumulative probability                    you want to filter
   sampling)   reaches p (typically 0.9)                       out the long tail
                                                                of unlikely tokens
   top_k        keep only the top-k tokens by   no             when you want a
                probability (typically 40)                      hard cap on the
                                                                pool — less common
                                                                than top_p

   for solo scale + four small chains, just setting temperature
   per chain is enough. top_p and top_k are tunings to reach for
   when temperature alone doesn't control variance the way you want.
```

Temperature is the one dial worth setting in every chain; the other two are reach-for-when-you-need-them.

### Move 2.5 — Current state vs intended

**Now (Phase A):** four of five chains run at provider default temperature (=1). One (`interpret`) sets `temp=0.7`. The classifier, which arguably should be `temp=0` for deterministic 5-mode output, currently is not.

**Later:** the right shape is `temp=0` on the classifier (deterministic 5-mode pick), `temp=0` on the structured summary (JSON validity), `temp=0.7` on captions (tonal variance is the feature), `temp=0.7` on interpret (already set). The cost of the migration: four new constants and four edits — `client.messages.create({ ..., temperature: 0 })` and `body: { ..., temperature: 0 }` in both branches of each chain. No schema change, no migration, no contract change. The fact that this hasn't been done yet is a real bug-shaped gap, not a stylistic one.

Phase A (now) vs intended-state, side by side:

```
            Phase A (today)                          Intended
   ┌──────────────────────────────────────┐    ┌──────────────────────────────────────┐
   │ summarize      temp = 1 (default)     │    │ summarize      temp = 0  (new)         │
   │                non-deterministic       │    │                deterministic JSON      │
   │                                        │    │                                       │
   │ caption         temp = 1 (default)     │    │ caption         temp = 0.7  (new)      │
   │                non-deterministic        │    │                tonal variance is      │
   │                                        │    │                the feature             │
   │                                        │    │                                       │
   │ classify        temp = 1 (default)     │    │ classify        temp = 0  (new)        │
   │                same input, different    │    │                deterministic 5-mode    │
   │                label across runs        │    │                pick                   │
   │                                        │    │                                       │
   │ expand          temp = 1 (default)     │    │ expand          temp = 0  (new)        │
   │                JSON-shape drift          │    │                deterministic per-     │
   │                                        │    │                type schema             │
   │                                        │    │                                       │
   │ interpret       TEMPERATURE = 0.7  ✓   │    │ interpret       TEMPERATURE = 0.7  ✓   │  unchanged
   └──────────────────────────────────────┘    └──────────────────────────────────────┘

   migration cost:
     4 chains × 2 branches × ~2 lines  =  ~16 LOC total
     no schema change, no migration, no contract change.
```

A real bug-shaped gap, not a stylistic one — the fix is contained to four files.

This is what people mean by "sampling is half the function." The model weights are what most of the engineering effort goes into; the sampling parameters are what most of the production tuning goes into. A model at the wrong temperature is the same model giving you the wrong UX. The full picture is below.

---

## Sampling parameters — diagram

```
                        Same model, same prompt, different sampling

      Input: "Classify: 'study transformers paper'"
                              │
                              ▼
              ┌───────────────────────────────┐
              │  LLM produces probabilities    │
              │  over the whole vocabulary     │
              │                                │
              │    study      → 0.42           │
              │    knowledge  → 0.38           │
              │    idea       → 0.12           │
              │    reflect    → 0.05           │
              │    todo       → 0.03           │
              └─────────┬─────────────────────┘
                        │
       ┌────────────────┼────────────────┐
       ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ temp = 0     │ │ temp = 1     │ │ temp = 2     │
│ (greedy)     │ │ (default)    │ │ (flat)       │
│              │ │              │ │              │
│ always picks │ │ samples from │ │ samples from │
│ "study"      │ │ original     │ │ flattened    │
│ (top token)  │ │ distribution │ │ distribution │
│              │ │              │ │              │
│ same input → │ │ 42% study    │ │ ~20% each    │
│ same output  │ │ 38% knowl    │ │ (rare tokens │
│ every time   │ │ 12% idea     │ │  get chances)│
└──────────────┘ └──────────────┘ └──────────────┘
       │                │                │
       ▼                ▼                ▼
   deterministic    moderately       creative /
   reproducible     variant          unreliable
   (classifiers,    (captions,       (rarely the
   structured       summaries)       right call)
   outputs)
```

```
                Where each buffr chain currently sits

  ┌─ Provider default (temperature = 1) ────────────────────┐
  │  classify.ts        — should be 0 (deterministic 5-mode)│
  │  summarize.ts       — could be 0 (schema-bound JSON)    │
  │  caption.ts         — fine at default (wants variance)  │
  │  expand.ts          — could be 0 (typed JSON)           │
  └─────────────────────────────────────────────────────────┘

  ┌─ Explicitly tuned ──────────────────────────────────────┐
  │  interpret.ts L14   — TEMPERATURE = 0.7 (creative prose)│
  └─────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Tuned chain (only one):**
**File:** `src/services/ai/interpret.ts`
**Function / class:** `callClaude()`, `callOpenAI()` (both pass `temperature: TEMPERATURE` where `TEMPERATURE = 0.7` at L14)
**Line range:** L14, L63–L74 (Claude branch), L76–L93 (OpenAI branch)

**Untuned chains (provider default = 1):**
- `src/services/ai/summarize.ts` L12–L40 — no `temperature` passed
- `src/services/ai/caption.ts` L123–L154 — no `temperature` passed
- `src/services/todos/classify.ts` L38–L67 — no `temperature` passed
- `src/services/todos/expand.ts` L34–L52 — no `temperature` passed

---

## Elaborate

### Where this pattern comes from
Temperature comes from statistical mechanics, where it controls the spread of a Boltzmann distribution. The same equation that describes how energy distributes across particles at different physical temperatures is the one that softmax uses to convert logits to probabilities. The hotter the system, the flatter the distribution. The neural-network field borrowed the word and the math wholesale — Hinton's 2015 paper on distillation popularised "temperature" as a knob for softmax outputs in deep learning, and the LLM era inherited it intact.

### The deeper principle
**Variance is a tunable, not an accident.** Most engineers treat LLM output as "the model is non-deterministic" without realising the non-determinism is a parameter they're already setting (implicitly, via the default). Once you see sampling as a separate stage from the model, you stop being surprised when outputs vary and start designing the variance you want.

### Where this breaks down
- **Below temp=0**: not a real setting (probabilities can't go negative). Use seed-based determinism if available.
- **Above temp=2**: most providers cap; the distribution gets so flat that the model emits gibberish.
- **For tool-call output**: the structure has to be valid JSON regardless of temperature; high temp is more likely to break the schema. Set temp=0 for structured outputs unless you have a specific reason.
- **For streamed long-form**: high temp can lose coherence mid-stream — the model "forgets" what it was saying. `0.7` is the empirical ceiling for prose.

### What to explore next
- [Structured outputs](./16-structured-outputs.md) → why structured chains should run at temp=0.
- [Anatomy of a production prompt](./17-anatomy-of-prompt.md) → the system-prompt half of the variance equation.
- [Validation as a hard gate](./08-validation-gate.md) → the runtime check that catches when sampling drift breaks the schema.

---

## Tradeoffs

The codebase relies on provider defaults for four of five chains and tunes one. That is a deliberate decision for `interpret` (the warmth matters) and a drift-by-omission decision for the other four. The cost is small per call but cumulative across the runtime.

### Comparison table — both costs in one frame

```
┌────────────────────┬────────────────────────────┬────────────────────────────┐
│ Cost dimension     │ Path taken (defaults +     │ Alternative (explicit temp │
│                    │ one tuned chain)           │ per chain)                 │
├────────────────────┼────────────────────────────┼────────────────────────────┤
│ Code lines added   │ 1 constant + 2 lines in    │ 1 constant + 2 lines × 5   │
│                    │ interpret.ts               │ chains = ~15 lines         │
│ Classifier         │ "study" today could be     │ temp=0 → same input always │
│  determinism       │ "knowledge" tomorrow       │ same output                │
│ Schema-break risk  │ default temp=1 → JSON      │ temp=0 → schema fails are  │
│  on structured     │ failures are possible      │ near-zero                  │
│  chains            │                            │                            │
│ Caption variance   │ default temp=1 → real      │ temp=0.7 → real variance,  │
│                    │ variance (matches need)    │ slightly more controlled   │
│ Onboarding cost    │ "why does this classify    │ "temp=0 lives at the top   │
│                    │  differently each time?"   │  of each file" — readable  │
│ Migration cost     │ already shipped            │ ~30 minutes of edits, no   │
│                    │                            │ tests to update            │
└────────────────────┴────────────────────────────┴────────────────────────────┘
```

### What we gave up

We gave up determinism on the classifier. The same todo text could classify as `idea` one run and `knowledge` the next when the model's confidence is split between two modes — the user wouldn't see the disagreement (they only see the latest result), but the data is shakier than the file naming suggests. Specifically: any todo where the model's top two probabilities are within ~10% of each other is at the mercy of default sampling.

We gave up cheap schema-failure protection on the structured chains. The validation gate (`validate.ts`) catches malformed JSON downstream, but a `temp=0` setting would make malformed JSON near-impossible at the source. Today the model can emit `"clipOrder": [clip-0]` (unquoted) once in a hundred calls; at `temp=0` the same model would emit `"clipOrder": ["clip-0"]` every time because the quote-character is the highest-probability next token in a JSON context.

What we got back: code that looks like the SDK examples in the docs. New contributors see the SDK call shape they recognise without an extra parameter they have to understand. For a solo-dev app where the validation gate handles the rare bad output, that's a real win.

### What the alternative would have cost

If we had set `temp=0` on every structured chain at the start, the code would carry an extra constant + two extra lines per chain (~15 total). Onboarding wouldn't have suffered — the parameter is well-known. The classifier would have been more reliable from day one. The cost is essentially zero; we paid an attention cost (every chain author has to remember the parameter exists) we did not need to pay.

If we had set `top_p=0.9` alongside, the chains would have an extra dimension of variance control. For a single-user app this is overkill — nucleus sampling shines when serving heterogeneous traffic where some queries want determinism and others want variance. buffr's traffic is one user's chains, each with one job.

### The breakpoint

Fine until a classifier failure becomes visible to the user — e.g., the same todo classified differently across re-runs causes the `expand` chain to call a different per-type prompt and the user sees inconsistent expansion output. At that point the right move is to set `temp=0` on `classify.ts` first (highest determinism need, smallest call) and audit the other chains incrementally. Also fine until the user reports "the AI summary mood field flipped between two re-runs" — that's the validation gate masking a sampling drift that should have been prevented at the source.

### What wasn't actually a tradeoff

`top_k` was never a real alternative — it caps the candidate set by hard count rather than cumulative probability, and on a vocabulary of ~50k tokens with a long-tail distribution, choosing `k=40` is essentially the same as nucleus sampling at `p=0.95` but with worse behavior on rare tokens. Modern LLM tuning standardised on temperature + top_p; top_k is a legacy parameter from earlier text-gen models.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk

- **Codebase uses:** `@anthropic-ai/sdk` ^0.90.0 calling `client.messages.create()` in `interpret.ts` L66 (passes `temperature: 0.7`) and in `summarize.ts`/`caption.ts`/`classify.ts`/`expand.ts` (no `temperature` passed → default = 1).
- **Why it's here:** the typed SDK for Anthropic's Messages API; carries the request shape that includes `temperature`, `top_p`, `top_k` as optional parameters on every call.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading` for Anthropic API access, 2026.
- **Why it leads:** first-party SDK from Anthropic; typed across every model parameter (`temperature` is a `number` in the type); ships alongside model updates with parameter additions on day one.
- **Runner-up:** raw `fetch` to `api.anthropic.com/v1/messages` — what `interpret.ts`'s OpenAI branch uses for parity; sacrifices type safety for one fewer dependency.

### OpenAI Chat Completions API (via raw fetch)

- **Codebase uses:** raw `fetch('https://api.openai.com/v1/chat/completions', { body: JSON.stringify({ ..., temperature: 0.7 }) })` in `interpret.ts` L77 (passes temperature) and others (no temperature passed → default = 1).
- **Why it's here:** the alternate provider; chosen for raw `fetch` rather than the SDK to avoid carrying both `openai` and `@anthropic-ai/sdk` packages on a React Native runtime where bundle size matters.
- **Leading today:** OpenAI's Chat Completions API — `adoption-leading`, 2026.
- **Why it leads:** the original "messages array + temperature + response_format" shape every other provider mimics; tooling support across every framework is widest here.
- **Runner-up:** OpenAI's Responses API (newer, structured around tools) — `innovation-leading` for agent-shaped workloads; buffr doesn't use agents so it sticks with Chat Completions.

---

## Project exercises

### [B1.3] Temperature variance per caption variant (sampling experiment)

- **Exercise ID:** `[B1.3]`
- **What to build:** Verify the existing `recentCaptions` anti-repetition pattern works on the 4-variant caption chain (it was built for legacy single captions), then introduce *deliberate* temperature variance per variant — e.g., `clean=0.5`, `smoother=0.7`, `reflective=0.9`, `punchy=1.1` — and measure how often each variant repeats yesterday's phrasing. The experiment turns "we use default sampling" into a documented sampling policy with evidence.
- **Why it earns its place:** the only chain in buffr that actually has user-noticeable variance pressure is caption. Every other chain has a structured output the user doesn't read as prose. This is the one place where temperature *should* matter — and right now it's running on autopilot.
- **Files to touch:** `src/services/ai/caption.ts` (read existing `recentCaptions` plumbing, then add per-variant temperature in the call payload); new `scripts/measure-caption-repetition.mjs` for the eval.
- **Done when:** per-variant temperature is configurable (constants at top of `caption.ts`), the script measures repetition rate against last-5-captions across 30 entries, and the result either confirms current defaults are fine or motivates a change with numbers.
- **Estimated effort:** `1–4hr` for the wiring, `1–2 days` end-to-end with the eval script.

---

## Summary

Sampling parameters — temperature, top-p, top-k — control how greedy the LLM is when picking each next token from the probability distribution the model produces. In this codebase, only `interpret.ts` tunes them (L14: `TEMPERATURE = 0.7` for prose warmth); every other chain accepts the provider's default of `temperature=1` and runs at full vocabulary access. The constraint that shaped this is bandwidth — a solo dev iterates faster on prompt content than on sampling parameters, and the validation gate catches downstream schema drift either way. The cost is that the classifier could in principle pick different modes for the same todo on different runs, and the structured chains run hotter than their typed contracts strictly need.

Key points to remember:
- Temperature divides logits before softmax; `temp=0` is greedy/deterministic, `temp=1` is the provider default, `temp>1` flattens the distribution.
- Only `interpret.ts` L14 explicitly sets temperature in this codebase; the other four chains run on the provider default.
- For schema-bound chains (classifier, structured summary, expand), `temp=0` is the textbook setting — currently a documented gap.
- `top_p` and `top_k` are both unused; the codebase relies on temperature alone.
- The validation gate (`validate.ts`) backstops every JSON chain regardless of sampling, which is why the gap hasn't caused visible bugs yet.

---

## Interview defense

### What an interviewer is really asking
"Sampling parameters" is the test of whether the candidate understands LLMs as a system or just as an API. Anyone can call `client.messages.create()`; few can name what changes when you set `temperature=0`. The interviewer wants to know: do you treat the LLM as a black-box function, or do you understand that the function is two stages (probabilities → sampling) and that the second stage is yours to control? The bonus signal is whether you've thought through the implications for your specific chains.

### Likely questions

[mid] Q: What does `temperature=0` actually do?

A: It collapses the model's probability distribution to its mode — at every step the model picks the single highest-probability token rather than sampling from the distribution. The mathematical mechanism is that temperature divides the logits before softmax; as temperature approaches 0, the softmax output approaches a one-hot vector on the top token. The practical effect is deterministic output: same prompt twice, same response twice. The provider default is 1 (no scaling), which is why the same prompt returns different responses without explicit tuning.

```
[temperature → distribution shape]

  logits:  [3.2, 2.8, 1.1, 0.4]
              │
              ▼  divide by temperature
              │
  temp=0:  → argmax → pick token 0
  temp=1:  → [3.2, 2.8, 1.1, 0.4]   → softmax → sample
  temp=2:  → [1.6, 1.4, 0.55, 0.2]  → softmax → flatter → sample
```

[senior] Q: Why didn't you set `temp=0` on the classifier from the start?

A: Honest answer: it wasn't a decision; it was an omission. The SDK call signature in the docs doesn't include `temperature` in the basic example, so the chain was written without it and the provider default (1) silently took effect. The validation gate downstream catches schema breaks, which masked the gap — the classifier returns one of five valid types whether or not it's deterministic. The right move is `temp=0` on the classifier and a comment naming why. The cost is two characters; the benefit is "same todo always classifies the same way." I'd ship that fix before fixing anything else in the AI layer.

```
                Path taken (provider default)        Alternative (explicit temp=0)
                ──────────────────────────────       ──────────────────────────────
classifier      temp=1 (provider default)            temp=0 (explicit)
determinism     same todo could pick different       same todo always picks same
                modes on re-classify                  mode on re-classify
schema break    rare (validation gate catches)       near-zero
code lines      0 added                              1 constant + 2 call-site lines
discovery cost  bug surfaces only via user            never surfaces
                noticing inconsistent expand
```

[arch] Q: How would the sampling story change if buffr grew to serve 10,000 users with personalised chains?

A: At single-user scale, every chain is a one-shot call with no contention; defaults are mostly fine. At 10k users, three things change. First, you'd want `temp=0` on every chain that has a typed output to make malformed JSON a non-event (each malformed response is now a user-visible bug, not a developer console warning). Second, you'd combine `temp=0.7 + top_p=0.9` on creative chains to control the tail — `temp=0.7` alone can still pick implausible tokens; `top_p=0.9` truncates the unlikely tail. Third, you'd add per-chain telemetry on output-distribution diversity (caption-text similarity, classifier-type entropy) so a sampling regression shows up before the user reports it.

```
At 10,000 users / day:

  ┌─ UI layer ─────────────────────────────────┐
  │ unchanged                                   │
  └─────────────────────────────────────────────┘
                       │
  ┌─ AI service layer ─────────────────────────┐
  │ EVERY chain explicit:                       │
  │   classifier   temp=0                       │
  │   summarize    temp=0                       │
  │   caption      temp=0.7, top_p=0.9          │
  │   expand       temp=0                       │
  │   interpret    temp=0.7, top_p=0.9          │
  └─────────────────────────────────────────────┘   ◀── BREAKS FIRST without explicit settings
                       │                              (silent schema drift surfaces as
  ┌─ Telemetry layer ──────────────────────────┐      user-visible inconsistency)
  │ NEW: per-chain output-diversity histogram   │
  │ alerts on distribution shift                │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You say the classifier should be `temp=0` but isn't. What's actually broken right now because of that?

A: Honestly: nothing the user has reported. The classifier returns one of five valid types, the validation gate catches any malformed JSON, the `user_overridden_type` lock makes the worst case (a wrong classification on a key todo) user-recoverable in one tap. The cost is invisible to the user and small in absolute terms — a fraction of close-call todos getting a different mode on re-classify. It's the kind of bug that exists in the code shape but doesn't exist in the experience. I track it because if traffic ever grows enough that the same todo gets re-classified repeatedly by a future feature, that fraction becomes a visible regression. Today it isn't worth the test plan to deploy; the day it is, the fix is two characters.

```
                Path taken (no explicit temp=0)      Alternative (explicit temp=0)
                ──────────────────────────────       ──────────────────────────────
user visible    none today                           none today
data shape      same row could carry different       same row always carries same
                type on re-classify if not           type on re-classify
                user-locked
recoverability  user_overridden_type fixes any       n/a — wouldn't happen
                wrong call in one tap
test surface    rare cases hard to reproduce         deterministic — easy to test
ship cost       0 (already shipped)                  2 characters + reviewer attention
deferred cost   nonzero if re-classify becomes       0
                a hot path
```

### One-line anchors
- "Sampling is half the LLM function — the model produces probabilities, sampling picks the token."
- "Provider default is `temp=1`; if you don't pass `temperature`, you've picked a number — just not deliberately."
- "Only `interpret.ts` tunes sampling in this codebase; that's a deliberate choice for one chain and a drift-by-omission for four."
- "The classifier should be `temp=0` and isn't — known gap, two-character fix, no user-visible bug yet."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the "same model, same prompt, different sampling" diagram from memory: the probability distribution coming out of the model, three temperature branches (0, 1, 2), and what each branch produces.

Open the file. Compare.

✓ Pass: your diagram shows the probability distribution + three temperature branches with the correct sampling behavior at each.
✗ Fail: re-read the "How it works" section, wait 10 minutes, try again.

### Level 2 — Explain it out loud
Explain sampling parameters to an imaginary colleague who just asked "why does my classifier return a different answer sometimes?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file? → `src/services/todos/classify.ts` (and `interpret.ts` as the contrasting case)
- Say what the provider default is and what setting would fix it?
- Name the tradeoff (defaults are fine until they aren't) in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user runs `expand` on the same todo three times in a row. The expansion text is slightly different each time. The user files a bug saying "the AI gives me different answers." What's happening at the sampling layer? What two changes would you make — one in `expand.ts`, one in the prompt itself — to make the output more stable without locking it entirely?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/expand.ts` L34–L52 and verify that no `temperature` is currently set.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you accept the provider default on the classifier? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/classify.ts` L41–L46 (Claude branch) and L51–L62 (OpenAI branch) to support what exists
→ Point to `src/services/ai/interpret.ts` L14, L66–L74 to show the contrasting explicit-temperature pattern

There is no right answer. The point is specificity. "Defaults are fine" is vague; "the classifier should be temp=0 and here's the two-line change" is specific.

### Quick check — code reference test
Without opening any files, answer:
- Which file in this codebase explicitly sets temperature?
- What value does it set?
- What temperature do all the other chains run at?

Then open `interpret.ts` and verify.

✓ Pass: you named `interpret.ts`, value `0.7`, and identified that others run at the provider default (=1).
✗ Fail: that's a sign this concept hasn't fully landed yet — re-read the "Default temperatures" sub-section.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (kitchen-counter-radio-with-tuning-dial scenario → "the dial is the sampling step in front of the output" pattern naming → bolded stakes pivot to four chains running silent provider default `temperature=1`, only `interpret.ts` L14 setting `TEMPERATURE = 0.7`, and `classify` as the temp=0 gap → before/after bullets on silent-default vs explicit-per-chain → one-line "sampling is half the LLM function" metaphor).

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care + How it works to anchor on real software (replaced kitchen-counter-radio + radio-dial analogies with the OpenAI Playground temperature slider and Anthropic Workbench).

---
Updated: 2026-05-14 — v1.32.0 pass: R1 no-op (anchors at level-3 — OpenAI Playground + Anthropic Workbench are vendor-provided developer surfaces, acceptable). Added Move 1 mnemonic diagram (model + sampler split with three temp settings) + 4 Move 2 sub-section diagrams: same-prompt-three-temperatures token-distribution walked, current-vs-intended temperature per chain, three-sampling-dials comparison table, Phase A vs intended side-by-side. Total: 5 new diagrams.
