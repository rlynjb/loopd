# Single-purpose chains (loopd's only pattern)

> Every AI feature is a single LLM call with one job. The model writes JSON. The app parses, validates, and persists. No chains-of-chains, no multi-step plans.

**See also:** → [01-what-an-llm-is](./01-what-an-llm-is.md) · → [08-validation-gate](./08-validation-gate.md) · → [13-ai-features-in-this-app](./13-ai-features-in-this-app.md)

---

## Quick summary
- **What:** four chains, four jobs — `summarize`, `caption`, `classify`, `expand`. Each is a single LLM call with a fixed system prompt + a per-call user prompt + a JSON output contract.
- **Why here:** easier to debug (one chain fails, you know which job failed), easier to test (one expected JSON shape per chain), cheaper (only run what you need).
- **Tradeoff:** no cross-chain reasoning. If a feature needs "summarize then expand each summary item," you'd write the orchestration in app code, not in a single chain.

---

## Single-purpose chains — diagram

```
  ┌──── 4 chains, 4 different jobs ──────────────────────────────────┐
  │                                                                   │
  │   summarize.ts ─── one job: structured editor data + caption      │
  │                    Sonnet 4.6 · gpt-4o · ~1024 tokens out         │
  │                                                                   │
  │   caption.ts ───── one job: 4 tonal voice variants of one day     │
  │                    Sonnet 4.6 · gpt-4o · ~768 tokens out          │
  │                                                                   │
  │   classify.ts ─── one job: pick 1 of 7 thinking modes             │
  │                    Haiku 4.5 · gpt-4o-mini · ~50 tokens out       │
  │                                                                   │
  │   expand.ts ───── one job per type (idea/bug/question/decision/   │
  │                   knowledge/content) — typed JSON expansion       │
  │                    Sonnet 4.6 · gpt-4o · ~1024 tokens out         │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

---

## How it works

Each AI service file owns one job. It builds a system prompt that says exactly what the JSON shape should be, builds a user prompt with the live data, calls the model once, parses, validates, and persists.

The 4 chains:
- **summarize** — produces the structured editor data (clip order, trims, filter, mood) + a freeform summary string.
- **caption** — produces 4 tonal voice variants (clean / smoother / reflective / punchy) of one day's text.
- **classify** — picks 1 of 7 thinking modes for one todo line.
- **expand** — runs a per-type chain (one of 6 templates) to produce typed JSON expansion of a todo.

Caption was *split out* of summarize when the 4-variant prompt was added — caption failures don't fail summarize. That split is itself an example of "single-purpose": each chain should fail independently.

---

## In this codebase

- `src/services/ai/summarize.ts` — uses `SYSTEM_PROMPT` from `summarize.ts`, validated by `validate.ts`.
- `src/services/ai/caption.ts` — uses the most opinionated SYSTEM_PROMPT in the codebase (4 named voices).
- `src/services/todos/classify.ts` — minimal prompt; no surrounding context (cost optimisation).
- `src/services/todos/expand.ts` — selects one of 6 system prompts via `getSystemPrompt(meta.type)`.

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
- **JSON output contract** — gives: parse + validate is mechanical. Costs: prompt must be very explicit; one model upgrade can break the shape.
- **Caption split from summarize** — gives: caption errors don't lose the structured summary. Costs: two calls instead of one when both are needed.

---

## Interview defense

### What an interviewer is really asking
"Why four chains and not one big chain, or a graph?" — they want to see whether I picked single-purpose deliberately or fell into it. The clue I want to drop early: caption was *split out* of summarize. That's evidence I didn't start here; I moved here when conjoined chains failed conjointly.

### Likely questions

[mid] Q: Walk me through what happens when `expand.ts` is called for a todo of type 'bug'. Where exactly does the chain shape live?
      A: `expand.ts` reads the meta to get the type, then calls `getSystemPrompt('bug')` from `expandPrompts.ts` — that returns the bug-specific schema instruction. It builds a user prompt via `buildContext()`, fires one call (Sonnet or 4o depending on provider), then runs `validateExpansion` against the bug-required fields (`observed`, `expected`, `suspectedCause`, `reproSteps`). If validation fails it retries once with a stricter system prompt; if that fails it returns `{ ok: false, reason: 'malformed' }`. One file owns one job — the type just selects the template.

[senior] Q: Why didn't you keep summarize and caption as one chain? It would've been one call instead of two.
         A: They were one chain originally. The 4-variant caption prompt is the most opinionated in the codebase (`caption.ts:SYSTEM_PROMPT` defines four named voices with body-line examples and universal rules — no "I", no hashtags, no questions). When the caption prompt got long and started failing on edge cases, the structured summary was failing with it — one model wobble killed both outputs. Splitting them meant caption could fail and summarize would still save. The cost is one extra LLM call when both are needed; the benefit is independent failure modes. That's the defining tradeoff of single-purpose.

[arch] Q: At what point would you collapse multiple chains back into one? Or fan out into a chain-of-chains?
       A: I'd collapse if I could get the same output quality with one prompt and the failure correlation stopped mattering — e.g., if the caption rules got short enough that summarize could absorb them without quality loss. I'd fan out if a feature genuinely needed multi-step reasoning where the output of step 1 had to be reviewed before step 2 — for instance, "draft a vlog plan, critique it, refine it". Today none of the four jobs need that. Each one is a one-shot transformation: text in, JSON out, done.

### The question candidates always dodge
Q: You say "one job per chain", but `expand.ts` actually selects between 6 different system prompts based on type. Isn't that 6 chains masquerading as one?

A: Fair — and yes, in a strict reading it's six chains in one file. The reason I count it as one is that the *shape* is uniform: read meta, pick prompt, single call, validate, persist. The per-type schemas differ but the orchestration is identical. If I extracted six files I'd have six copies of the same control flow with one parameter swapped. The line I drew is "one chain = one call shape with one validation contract". The 'bug' validator and the 'idea' validator differ in required fields, which is what `validateExpansion` switches on. So I'll grant the criticism: `expand.ts` is the closest thing in the codebase to a chain *family*, and if I added a seventh type it would be a fair moment to ask whether the file should split. With six and stable, the duplication-saved beats the abstraction-cost.

### One-line anchors
- "Caption was split out of summarize. That's the test of whether single-purpose pays."
- "One chain, one job, one validation contract."
- "Failures should be local. A chain that does five things fails in 5! ways."
- "`expand.ts` is six prompts, one shape — that's the line I drew."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
