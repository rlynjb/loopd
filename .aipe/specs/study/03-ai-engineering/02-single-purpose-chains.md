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
