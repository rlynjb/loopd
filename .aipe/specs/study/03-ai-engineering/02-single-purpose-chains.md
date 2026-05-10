# Single-purpose chains (loopd's only pattern)

> **Industry term:** Single-step chain / one-shot LLM call *(industry standard — LangChain)*

> Every AI feature is a single LLM call with one job. The model writes JSON. The app parses, validates, and persists. No chains-of-chains, no multi-step plans.

**See also:** → [01-what-an-llm-is](./01-what-an-llm-is.md) · → [08-validation-gate](./08-validation-gate.md) · → [13-ai-features-in-this-app](./13-ai-features-in-this-app.md)

---

## Quick summary
- **What:** five chains, five jobs — `summarize`, `caption`, `classify`, `expand`, `interpret`. Each is a single LLM call with a fixed system prompt + a per-call user prompt + an output contract (JSON for 4, markdown for interpret).
- **Why here:** easier to debug (one chain fails, you know which job failed), easier to test (one expected output shape per chain), cheaper (only run what you need).
- **Tradeoff:** no cross-chain reasoning. If a feature needs "summarize then expand each summary item," you'd write the orchestration in app code, not in a single chain.

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

## How it works

Each AI service file owns one job. It builds a system prompt that says exactly what the output shape should be, builds a user prompt with the live data, calls the model once, parses (or cleans, for interpret), validates, and persists (or renders, for interpret).

The 5 chains:
- **summarize** — produces the structured editor data (clip order, trims, filter, mood) + a freeform summary string.
- **caption** — produces 4 tonal voice variants (clean / smoother / reflective / punchy) of one day's text.
- **classify** — picks 1 of 5 thinking modes (todo/idea/knowledge/study/reflect) for one todo line. Was 7 modes pre-2026-05-10.
- **expand** — runs a per-type chain (one of 4 templates: idea/knowledge/study/reflect — `'todo'` is non-expandable) to produce typed JSON expansion of a todo.
- **interpret** — produces a long-form markdown reflection on a journal entry. User-triggered, ephemeral, **markdown out, not JSON**. The only chain whose output is a piece of writing the user reads, not data the app uses.

Caption was *split out* of summarize when the 4-variant prompt was added — caption failures don't fail summarize. Interpret was *added separately* in 2026-05-10 because its output contract (markdown, not JSON) doesn't fit the validate-and-persist pattern of the other 4. Both moves are examples of "single-purpose": each chain should fail independently.

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

- **Single-purpose chains** — gives: easy debugging, independent failure modes, cheap. Costs: no cross-chain reasoning.
- **JSON output contract (4 chains)** — gives: parse + validate is mechanical. Costs: prompt must be very explicit; one model upgrade can break the shape.
- **Markdown contract (interpret only)** — gives: long-form prose the user reads. Costs: no schema validation; tone drift only visible to the user, not catchable post-call.
- **Caption split from summarize** — gives: caption errors don't lose the structured summary. Costs: two calls instead of one when both are needed.
- **Interpret kept separate from summarize** — gives: failure independence + a different output contract per chain. Costs: prompts can drift apart over time; no shared "reflection" logic.

---

## Interview defense

### What an interviewer is really asking
"Why five chains and not one big chain, or a graph?" — they want to see whether I picked single-purpose deliberately or fell into it. Two clues I want to drop early: caption was *split out* of summarize (when the 4-variant prompt got long enough that summarize started failing along with it), and interpret was *added separately* (because its output contract — markdown, not JSON — didn't fit the validate-and-persist shape of the other four). Both moves are evidence I didn't start at single-purpose; I moved here when conjoined chains failed conjointly or when contracts diverged.

### Likely questions

[mid] Q: Walk me through what happens when `expand.ts` is called for a todo of type 'bug'. Where exactly does the chain shape live?
      A: `expand.ts` reads the meta to get the type, then calls `getSystemPrompt('bug')` from `expandPrompts.ts` — that returns the bug-specific schema instruction. It builds a user prompt via `buildContext()`, fires one call (Sonnet or 4o depending on provider), then runs `validateExpansion` against the bug-required fields (`observed`, `expected`, `suspectedCause`, `reproSteps`). If validation fails it retries once with a stricter system prompt; if that fails it returns `{ ok: false, reason: 'malformed' }`. One file owns one job — the type just selects the template.

[senior] Q: Why didn't you keep summarize and caption as one chain? It would've been one call instead of two.
         A: They were one chain originally. The 4-variant caption prompt is the most opinionated in the codebase (`caption.ts:SYSTEM_PROMPT` defines four named voices with body-line examples and universal rules — no "I", no hashtags, no questions). When the caption prompt got long and started failing on edge cases, the structured summary was failing with it — one model wobble killed both outputs. Splitting them meant caption could fail and summarize would still save. The cost is one extra LLM call when both are needed; the benefit is independent failure modes. That's the defining tradeoff of single-purpose.

[arch] Q: At what point would you collapse multiple chains back into one? Or fan out into a chain-of-chains?
       A: I'd collapse if I could get the same output quality with one prompt and the failure correlation stopped mattering — e.g., if the caption rules got short enough that summarize could absorb them without quality loss. I'd fan out if a feature genuinely needed multi-step reasoning where the output of step 1 had to be reviewed before step 2 — for instance, "draft a vlog plan, critique it, refine it". Today none of the five jobs need that. Each one is a one-shot transformation: text in, JSON or markdown out, done.

### The question candidates always dodge
Q: You say "one job per chain", but `expand.ts` actually selects between 6 different system prompts based on type. Isn't that 6 chains masquerading as one?

A: Fair — and yes, in a strict reading it's six chains in one file. The reason I count it as one is that the *shape* is uniform: read meta, pick prompt, single call, validate, persist. The per-type schemas differ but the orchestration is identical. If I extracted six files I'd have six copies of the same control flow with one parameter swapped. The line I drew is "one chain = one call shape with one validation contract". The 'bug' validator and the 'idea' validator differ in required fields, which is what `validateExpansion` switches on. So I'll grant the criticism: `expand.ts` is the closest thing in the codebase to a chain *family*, and if I added a seventh type it would be a fair moment to ask whether the file should split. With six and stable, the duplication-saved beats the abstraction-cost.

### One-line anchors
- "Caption was split out of summarize. That's the test of whether single-purpose pays."
- "One chain, one job, one validation contract."
- "Failures should be local. A chain that does five things fails in 5! ways."
- "`expand.ts` is six prompts, one shape — that's the line I drew."

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
- Name the specific file or function?  → name 2 of the 4 chain files
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
→ Point to `src/services/todos/expand.ts` (the chain *family* with 6 system prompts) to support what exists
→ Point to where you'd extract per-type chains into 6 separate files if you chose the alternative

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
