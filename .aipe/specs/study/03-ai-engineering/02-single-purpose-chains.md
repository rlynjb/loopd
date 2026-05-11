# Single-purpose chains (loopd's only pattern)

**Industry name(s):** Prompt chaining, single-purpose chain, decomposition pattern
**Type:** Industry standard

> Every AI feature is a single LLM call with one job. The model writes JSON. The app parses, validates, and persists. No chains-of-chains, no multi-step plans.

**See also:** → [01-what-an-llm-is](./01-what-an-llm-is.md) · → [08-validation-gate](./08-validation-gate.md) · → [13-ai-features-in-this-app](./13-ai-features-in-this-app.md)

---

## Why care

The instinct when you start building with an LLM is to chain prompts together — "first summarize, then critique the summary, then rewrite based on the critique, then format." That instinct produces systems where a single bad token three calls deep poisons everything downstream, costs five times as much as it needs to, and is impossible to debug because you can't tell which step actually failed. The fix is older than LLMs: give each call exactly one job, validate the output, move on.

Single-purpose chains belong to the same family as Unix pipes, microservices, and pure functions — small components with one responsibility, composed by code that owns the orchestration rather than baked into the components themselves. You've already seen this shape in LangChain's `LLMChain` (one prompt, one parser, one output type), in OpenAI's function-calling endpoints (one schema per call), and in every production system that picked "five small prompts I can monitor" over "one heroic mega-prompt." The next block walks the mechanics.

---

## How it works

Each AI service file owns one job. It builds a system prompt that says exactly what the output shape should be, builds a user prompt with the live data, calls the model once, parses (or cleans, for interpret), validates, and persists (or renders, for interpret).

The 5 chains:
- **summarize** — produces the structured editor data (clip order, trims, filter, mood) + a freeform summary string.
- **caption** — produces 4 tonal voice variants (clean / smoother / reflective / punchy) of one day's text.
- **classify** — picks 1 of 5 thinking modes (todo/idea/knowledge/study/reflect) for one todo line. Was 7 modes pre-2026-05-10.
- **expand** — runs a per-type chain (one of 4 templates: idea/knowledge/study/reflect — `'todo'` is non-expandable) to produce typed JSON expansion of a todo.
- **interpret** — produces a long-form markdown reflection on a journal entry. User-triggered, ephemeral, **markdown out, not JSON**. The only chain whose output is a piece of writing the user reads, not data the app uses.

Caption was *split out* of summarize when the 4-variant prompt was added — caption failures don't fail summarize. Interpret was *added separately* in 2026-05-10 because its output contract (markdown, not JSON) doesn't fit the validate-and-persist pattern of the other 4. Both moves are examples of "single-purpose": each chain should fail independently. The full picture is below.

---

## Single-purpose chains — diagram

```
  ┌──── 5 chains, 5 different jobs ──────────────────────────────────┐
  │                                                                   │
  │   summarize.ts ─── one job: structured editor data + caption      │
  │                    Sonnet 4.6 · gpt-4o · ~1024 tokens out         │
  │                                                                   │
  │   caption.ts ───── one job: 4 tonal voice variants of one day     │
  │                    Sonnet 4.6 · gpt-4o · ~768 tokens out          │
  │                                                                   │
  │   classify.ts ─── one job: pick 1 of 5 thinking modes             │
  │                    (todo / idea / knowledge / study / reflect)    │
  │                    Haiku 4.5 · gpt-4o-mini · ~50 tokens out       │
  │                                                                   │
  │   expand.ts ───── one job per type (idea / knowledge / study /    │
  │                   reflect) — typed JSON expansion                  │
  │                    Sonnet 4.6 · gpt-4o · ~1024 tokens out         │
  │                                                                   │
  │   interpret.ts ── one job: long-form markdown reflection on a     │
  │                   journal entry. User-triggered via modal.        │
  │                    Sonnet 4.6 · gpt-4o · ~1800 tokens out         │
  │                    Output: markdown (NOT JSON), NOT persisted.    │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Chain 1 (summarize):** `src/services/ai/summarize.ts` → `summarize()` L42–L105 — uses `SYSTEM_PROMPT` defined inline; validated by `validate.ts:validateSummary` L12+
**Chain 2 (caption):**   `src/services/ai/caption.ts` → `generateCaption()` L201–L223 — structured `SYSTEM_PROMPT` L24–L100 (4 named voices); validated by `parseAndValidate()` L169–L199
**Chain 3 (classify):**  `src/services/todos/classify.ts` → `classifyTodo()` L90+ — `SYSTEM_PROMPT` L12–L25 (5 modes as of 2026-05-10), no surrounding context (cost optimisation)
**Chain 4 (expand):**    `src/services/todos/expand.ts` → `expandTodo()` L191+ — selects one of 4 system prompts via `getSystemPrompt(meta.type)` from `src/services/todos/expandPrompts.ts:50`; validator `validateExpansion` L77–L142
**Chain 5 (interpret):** `src/services/ai/interpret.ts` → `interpretEntry()` L114–L149 — 32-line `SYSTEM_PROMPT` L19–L50 (longest in the codebase, prescribes markdown structure); validator `cleanMarkdown()` L98–L108 (NOT a JSON schema — strips fences, rejects empty)

```
Pseudocode (the pattern, applied uniformly):
  // 1. Get config
  provider = getProvider()
  apiKey   = getKeyFor(provider)
  if !apiKey: return { error: 'no API key' }

  // 2. Build prompt
  system = SYSTEM_PROMPT_FOR_THIS_JOB
  user   = buildUserPrompt(input)

  // 3. Single call
  raw = provider == 'openai' ? callOpenAI(...) : callClaude(...)

  // 4. Parse + validate
  parsed = extractJson(raw)
  validated = validateAgainstSchema(parsed)
  if !validated: return { error: 'malformed', maybe retry once with stricter prompt }

  // 5. Persist
  saveToSqlite(validated)
  return { ok: true, data: validated }
```

---

## What goes wrong with multi-purpose chains

If a single mega-prompt did "summarize + caption + classify all my todos", a single failure would leave you guessing which sub-task broke. The codebase explicitly avoided this — caption was split out of summarize because conjoined chains fail conjointly.

---

## Elaborate

### Where this pattern comes from
Single-purpose tools are an old Unix value (do one thing, do it well). LangChain and similar tooling popularised both single chains and multi-chain orchestrations; loopd deliberately stays at the single-chain end.

### The deeper principle
**Failures should be local.** A chain that does one thing fails in one way. A chain that does five things fails in 5! ways and the error message is rarely informative.

### Where this breaks down
- Tasks where the cost of N calls exceeds the cost of one bigger call (rare; caching usually closes the gap).
- Tasks where the model's reasoning improves with a single coherent context (sometimes true for complex synthesis; rarely true for the kinds of jobs loopd does).

### What to explore next
- [13-ai-features-in-this-app](./13-ai-features-in-this-app.md) → per-feature prompt + input + output.
- [08-validation-gate](./08-validation-gate.md) → the post-call validator.
- [12-why-no-agents](./12-why-no-agents.md) → the explicit decision against multi-step.

---

## Tradeoffs

We traded "one heroic mega-prompt" for "five small calls with independent failure modes" — pay a bit more in calls, save a lot in debugging time and quality drift.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (5 chains)          │ Alternative (1 mega-prompt)    │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Money            │ 5 calls when all run; ~$0.05   │ 1 call ~$0.04 (slightly cheaper│
│                  │ per full day (Sonnet 4.6 +     │ on token reuse) — savings      │
│                  │ Haiku 4.5 for classify)        │ vanish past 2k output tokens   │
│ Latency          │ chains run in parallel where   │ one ~5-8s call; user waits for │
│                  │ possible; classify ~800ms,     │ everything before anything     │
│                  │ caption ~3s, interpret ~5s     │ renders                        │
│ Failure blast    │ caption fails → summarize OK;  │ any sub-task fails → whole     │
│                  │ classify fails → expand still  │ output is malformed; nothing   │
│                  │ runs on heuristic              │ saves                          │
│ Debugging        │ wrong output → 1 of 5 prompts; │ wrong output → which of N      │
│                  │ replay 1 chain in isolation    │ sub-tasks broke? unrecoverable │
│ Output contract  │ JSON for 4, markdown for       │ either monolithic JSON (rigid) │
│                  │ interpret — each enforced      │ or freeform (no validation)    │
│ Model upgrades   │ swap classify to a cheaper     │ one prompt is hostage to one   │
│                  │ model independently            │ model's behavior               │
│ Prompt drift     │ 5 prompts can drift apart      │ one prompt stays internally    │
│                  │ over time — needs vigilance    │ consistent by construction     │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up cross-chain reasoning at the LLM layer. The model never sees "the summary AND the classifications together" in one prompt, so it can't notice that today's summary contradicts the classification of a todo on the same day. If we wanted that kind of synthesis, we'd have to assemble it in app code by reading both outputs from SQLite and feeding them to a sixth chain — and that sixth chain is exactly the kind of conjoined prompt this pattern exists to avoid.

We also gave up some prompt cohesion. Five prompts means five places where tone, formatting rules, and vocabulary can drift apart. Caption uses four named voices (clean / smoother / reflective / punchy); interpret uses a 32-line markdown template; summarize speaks structured. Keeping them stylistically aligned is manual work — there's no shared "house style" the model enforces.

We paid roughly 5 calls' worth of API cost per full-day generation instead of 1. At solo-dev volumes that's a few cents per day, well under the noise floor. At 10× volume (a thousand users) it's still small; at 10,000× it would push us toward consolidation.

### What the alternative would have cost

A single mega-prompt doing summarize + caption + classify-all-todos + expand-each + interpret would have looked attractive for two reasons: one round-trip, one place to edit the prompt. The hidden cost shows up the first time the prompt fails on edge cases — and it will, because a 2k-token system prompt with five output sections is unwieldy. When it fails, the entire day's AI output fails. The user sees nothing.

We'd also have lost the ability to mix providers. Classify runs on Haiku 4.5 (cheap, fast, good enough for 5-label classification) while summarize and caption run on Sonnet 4.6 (better at structured-and-tonal output). With one chain, every sub-task runs on whichever model the chain targets — over-spending on classify or under-delivering on caption.

The model-upgrade story would have been brutal. Each new Claude or GPT release subtly changes JSON formatting habits; a chain-per-job lets us re-tune one prompt at a time. A mega-prompt forces us to re-validate every sub-task on every model bump.

### The breakpoint

The pattern stops paying off when (a) a feature genuinely needs the model to reason across two outputs in one context — e.g., "draft a vlog plan, critique your own plan, refine it" — at which point a chain-of-chains makes sense, or (b) the API cost of N small calls exceeds the cost of one big call with caching. Provider prompt caching (Anthropic's 90% discount on cached input tokens, ~5min TTL) tilts the math: if we hit ~10× current usage with a stable system prompt, caching closes the cost gap and the single-chain shape stays cheap.

A concrete trigger: the day we add a chain whose output is *only useful in conjunction with another chain's output* (e.g., a "summary critic" that has to see both the summary and the day's prose), we've crossed into multi-step territory. Today no such feature exists.

### What wasn't actually a tradeoff

Splitting `expand.ts` into 4 separate files (one per ExpandableType) was never going to be cleaner — the orchestration shape is identical, only the schema differs. Four duplicated control flows would have been worse than one file with one switch. The duplication-saved beats the abstraction-cost; this is "one chain family" in the budget, not a violation.

### Tech reference (industry pairing)

┌─ @anthropic-ai/sdk ─────────────────────────────────────────────┐
│ Codebase uses:    @anthropic-ai/sdk (claude-sonnet-4-6 for      │
│                   summarize/caption/expand/interpret,            │
│                   claude-haiku-4-5 for classify)                │
│ Why it's here:    the SDK powering each single-purpose chain —  │
│                   one call, one job, one output contract         │
│                                                                  │
│ Leading today:    @anthropic-ai/sdk — adoption-leading, 2026    │
│ Why it leads:     native SDK gives first-class access to prompt  │
│                   caching, JSON output, and tool calling that    │
│                   wrappers sometimes flatten or delay            │
│                                                                  │
│ Runner-up:        Vercel AI SDK                                  │
│                   innovation-leading multi-provider streaming    │
│                   with typed message structures and useChat hook │
└──────────────────────────────────────────────────────────────────┘

---

## Summary

Single-purpose chains is the family of "one LLM call, one job, one output contract" — each chain has a fixed system prompt, a per-call user prompt, and a contract on what it returns. In this codebase five chains do five jobs (`summarize`, `caption`, `classify`, `expand`, `interpret`), and four of them return JSON while `interpret` returns markdown. The constraint that drove it is debuggability and independent failure — caption was split out of summarize when conjoined chains started failing conjointly, and interpret was added separately because its markdown contract didn't fit the validate-and-persist shape. The cost is no cross-chain reasoning at the LLM layer — any "summarize then expand each summary item" orchestration lives in app code, not in a single chain.

Key points to remember:
- Five chains, five jobs — `summarize`, `caption`, `classify`, `expand`, `interpret`. Each is one LLM call.
- Each chain has a fixed output contract: JSON for four, markdown for `interpret`.
- Failures are localised — caption was split from summarize precisely so one chain's wobble doesn't kill the other.
- `expand.ts` is four typed schemas behind one shape (idea/knowledge/study/reflect; `'todo'` is non-expandable) — that's the line drawn for "one chain".
- The cost is no cross-chain reasoning: orchestration logic lives in app code, not in a mega-prompt.

---

## Interview defense

### What an interviewer is really asking
"Why five chains and not one big chain, or a graph?" — they want to see whether I picked single-purpose deliberately or fell into it. Two clues I want to drop early: caption was *split out* of summarize (when the 4-variant prompt got long enough that summarize started failing along with it), and interpret was *added separately* (because its output contract — markdown, not JSON — didn't fit the validate-and-persist shape of the other four). Both moves are evidence I didn't start at single-purpose; I moved here when conjoined chains failed conjointly or when contracts diverged.

### Likely questions

[mid] Q: Walk me through what happens when `expand.ts` is called for a todo of type 'bug'. Where exactly does the chain shape live?
      A: `expand.ts` reads the meta to get the type, then calls `getSystemPrompt('bug')` from `expandPrompts.ts` — that returns the bug-specific schema instruction. It builds a user prompt via `buildContext()`, fires one call (Sonnet or 4o depending on provider), then runs `validateExpansion` against the bug-required fields (`observed`, `expected`, `suspectedCause`, `reproSteps`). If validation fails it retries once with a stricter system prompt; if that fails it returns `{ ok: false, reason: 'malformed' }`. One file owns one job — the type just selects the template.

```
[expand chain flow — type selects template, one call shape]

  expandTodo(todoId)
        │
        ▼  read todo_meta
  meta.type = 'idea' | 'knowledge' | 'study' | 'reflect'
        │
        ▼  switch
  getSystemPrompt(type) ──▶ one of 4 prompt templates
        │
        ▼  buildContext() — surrounding entry text
  single LLM call (Sonnet 4.6 / gpt-4o)
        │
        ▼
  validateExpansion(type, parsed)
        │
        ├─ ok    → persist expanded_md
        └─ fail  → retry once, stricter prompt → if still bad: { ok: false, reason }
```

[senior] Q: Why didn't you keep summarize and caption as one chain? It would've been one call instead of two.
         A: They were one chain originally. The 4-variant caption prompt is the most opinionated in the codebase (`caption.ts:SYSTEM_PROMPT` defines four named voices with body-line examples and universal rules — no "I", no hashtags, no questions). When the caption prompt got long and started failing on edge cases, the structured summary was failing with it — one model wobble killed both outputs. Splitting them meant caption could fail and summarize would still save. The cost is one extra LLM call when both are needed; the benefit is independent failure modes. That's the defining tradeoff of single-purpose.

```
                  Path taken (split)                  Alternative (one mega-chain)
                  ────────────────────                ────────────────────────────
calls per day     2 (summarize + caption)             1 (mega-prompt)
prompt size       small + medium, focused             large; 4 voices + structured shape
caption fails →   summarize still saves               ENTIRE output rejected; nothing saves
summarize fails → caption still attempts on cached    can't even attempt caption — chain dead
cost/day          ~2× small-call cost                 ~1.2× — caching mostly closes the gap
retry shape       retry only the broken chain         re-run everything; pay full cost again
model bump test   2 chains × per-model = 2 fixes      1 prompt × N quirks = combinatorial test
```

[arch] Q: At what point would you collapse multiple chains back into one? Or fan out into a chain-of-chains?
       A: I'd collapse if I could get the same output quality with one prompt and the failure correlation stopped mattering — e.g., if the caption rules got short enough that summarize could absorb them without quality loss. I'd fan out if a feature genuinely needed multi-step reasoning where the output of step 1 had to be reviewed before step 2 — for instance, "draft a vlog plan, critique it, refine it". Today none of the five jobs need that. Each one is a one-shot transformation: text in, JSON or markdown out, done.

```
At 10× volume + 1 critique-style feature:

  ┌─ UI layer ──────────────────────────────────┐
  │ existing 5 chains unchanged                 │
  │ new "vlog plan reviewer" surface            │  ◀── triggers fan-out
  └─────────────────────────────────────────────┘
              │
  ┌─ Chains (single-call) ──────────────────────┐
  │ 5 untouched — function framing holds        │
  │ new feature: draft → critique → refine      │  ◀── multi-step territory
  │ each step is still single-purpose           │
  └─────────────────────────────────────────────┘
              │
  ┌─ Cost layer (prompt caching) ───────────────┐
  │ Anthropic cache hit ≈ 90% discount on input │
  │ tokens (5min TTL) — closes the cost gap     │
  │ between single-chain and N-chain at scale   │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You say "one job per chain", but `expand.ts` actually selects between 4 different system prompts based on type. Isn't that 4 chains masquerading as one?

A: Fair — and yes, in a strict reading it's four chains in one file (one per `ExpandableType` — `idea / knowledge / study / reflect`; `'todo'` is excluded via `Exclude<TodoType, 'todo'>` so plain todos have no expansion shape). The reason I count it as one is that the *shape* is uniform: read meta, pick prompt, single call, validate, persist. The per-type schemas differ but the orchestration is identical. If I extracted four files I'd have four copies of the same control flow with one parameter swapped. The line I drew is "one chain = one call shape with one validation contract". The 'idea' validator and the 'reflect' validator differ in required fields, which is what `validateExpansion` switches on. So I'll grant the criticism: `expand.ts` is the closest thing in the codebase to a chain *family*, and if I added a fifth expandable type it would be a fair moment to ask whether the file should split. With four typed schemas and stable, the duplication-saved beats the abstraction-cost.

```
                  Path taken (1 file, 4 templates)    Suggested (4 separate files)
                  ────────────────────────────────    ────────────────────────────
files             expand.ts (~250 LOC)                expandIdea.ts + expandKnowledge.ts
                                                      + expandStudy.ts + expandReflect.ts
control flow      one switch on meta.type             4× copies of same shape
schema validation validateExpansion(type) switches    4 separate validators, same shape
adding 5th type   add prompt + validator branch       new file + duplicate control flow
duplication cost  zero — one orchestration            ~150 LOC × 3 duplicate copies
when this flips   5th type with truly novel shape     today: not yet; the line is "≥5 types"
debugging         one stack trace, one breakpoint     4 places to set breakpoints
```

### One-line anchors
- "Caption was split out of summarize. That's the test of whether single-purpose pays."
- "One chain, one job, one validation contract."
- "Failures should be local. A chain that does five things fails in 5! ways."
- "`expand.ts` is 4 typed schemas, one shape — that's the line I drew."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain single-purpose chains to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → name 2 of the 5 chain files
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

Product asks for a new feature: extend `caption.ts` so it ALSO detects mood and emits a hashtag list. Two options: (a) augment the SYSTEM_PROMPT to ask for `{ variants, detectedTheme, mood, hashtags }` in one chain, or (b) add a new `detectVibe(date)` chain in a new file. Walk what each costs in failure modes — what does "step 4 returned malformed JSON" mean for caption variants in option (a) vs option (b)? Which would you ship and why?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/caption.ts` L201–L223 to verify the current single-chain shape.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/expand.ts` (the chain *family* with 4 typed schemas — idea/knowledge/study/reflect; ExpandableType excludes 'todo') to support what exists
→ Point to where you'd extract per-type chains into 4 separate files if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — chain count grew from 4 to 5 (Interpret added, with markdown-out contract). Expand types reduced from 6 to 4. Classify modes reduced from 7 to 5. See `14-interpret.md`.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block; bumped Level 2 hint 4→5 chain files; corrected "expand.ts is six prompts" to 4 typed schemas (ExpandableType excludes 'todo'); updated Level 4 alternative count 6→4.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram. Diagram layer-labels skipped (list of 5 sibling chains within the same service layer — no architectural boundaries crossed).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk.
