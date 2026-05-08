# How this codebase uses AI specifically

> Per-feature: prompt shape, input, output. The four chains, each one-job.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [03-context-window](./03-context-window.md) · → [04-provider-abstraction](./04-provider-abstraction.md) · → [08-validation-gate](./08-validation-gate.md)

---

## Quick summary
- **What:** four features — day summarize, 4-variant caption, todo classify, todo expand. Each maps to one chain in `src/services/ai/` or `src/services/todos/`.
- **Why here:** quick reference for the prompt shapes, input contracts, output JSON shapes. Read this when you want to know "what does the model actually see for X?"
- **Tradeoff:** this is a snapshot — when prompts change, this file should be re-checked.

---

## Features overview

```
  ┌────────────────────┬──────────────────┬─────────────────────────────────────┐
  │ Feature            │ Pattern          │ Why this pattern                     │
  ├────────────────────┼──────────────────┼─────────────────────────────────────┤
  │ Day summarize      │ Single chain     │ one job: structured editor JSON     │
  │                    │ Sonnet/4o        │ + freeform summary text             │
  │ 4-variant caption  │ Single chain     │ one job: 4 tonal voices of one day  │
  │                    │ Sonnet/4o        │ with theme detection                 │
  │ Todo classify      │ Heuristic + LLM  │ heuristic catches obvious; Haiku/   │
  │                    │ Haiku/4o-mini    │ mini handles the rest cheaply       │
  │ Todo expand        │ Per-type chain   │ 6 typed schemas: idea / bug /        │
  │                    │ Sonnet/4o        │ question / decision / knowledge /   │
  │                    │                  │ content. Each schema is a different │
  │                    │                  │ system prompt with its own JSON     │
  │                    │                  │ shape. The TYPE selects the chain.  │
  └────────────────────┴──────────────────┴─────────────────────────────────────┘
```

---

## Per feature: prompt shape, input, output

```
  Day summarize
  ─────────────
  System: "You are an editor for a daily-vlog app. Read the day's
           entries, clip list, and habits. Output a single JSON object:
           { summary, mood, clipOrder[], clipTrims[], filterPreset, ... }"
  Input:  buildPrompt(entries, allClips, allHabits, date)
  Output: AISummary JSON, validated by validate.ts:validateSummary
          (checks every clipId in clipOrder exists, trims fit clip duration, etc.)

  4-variant caption
  ─────────────────
  System: SYSTEM_PROMPT in caption.ts (the most opinionated prompt in the codebase).
          Specifies four named voices (clean / smoother / reflective / punchy)
          with example body lines for each, plus universal rules
          (no "I"/"you"/"we"; no hashtags; no questions; no platitudes).
  Input:  { date, rawLog[], recentCaptions?, mood?, themeHint? }
  Output: { variants: { clean, smoother, reflective, punchy }, detectedTheme }
          All four required; partial output treated as malformed.

  Todo classify
  ─────────────
  System: "Classify into one of seven thinking modes:
           todo / idea / bug / question / decision / knowledge / content.
           Output ONLY {"type":"<mode>","confidence":"high|medium|low"}"
  Input:  the todo text alone — no surrounding context (cost optimization)
  Output: { type, confidence, model }

  Todo expand (per type)
  ──────────────────────
  System: getSystemPrompt(meta.type) — one of 6 templates
          (e.g., for 'bug': "Output {observed, expected, suspectedCause, reproSteps[]}")
  Input:  todo text + entry text + sibling todos + last 3 days of entries
          + cached summaries (from buildContext)
  Output: TodoExpansion union — validated against per-type required fields,
          serialized to markdown by serializeExpansion, persisted to
          todo_meta.expanded_md
```

---

## In this codebase

- `src/services/ai/summarize.ts` → day summarize.
- `src/services/ai/caption.ts` → 4-variant caption (with the most opinionated SYSTEM_PROMPT).
- `src/services/todos/classify.ts` → classify.
- `src/services/todos/expand.ts` → expand, with `getSystemPrompt(type)` selecting one of 6 per-type chains in `expandPrompts.ts`.
- `src/services/todos/expandSerialize.ts` → expansion → markdown for `expanded_md`.
- `src/services/ai/validate.ts` → all schema validators.

---

## Elaborate

### Where this pattern comes from
The "per-feature spec sheet" approach is borrowed from API design — each endpoint gets its own request/response contract, and the docs are organised around the contract, not the code.

### The deeper principle
**The prompt is the contract.** Just like an API spec, the prompt + the JSON shape define what the feature commits to. Treat changes to either as a contract change.

### Where this breaks down
- A snapshot file like this rots fast when prompts change. Treat it as a starting point, not the truth.
- The actual prompts are in source — `caption.ts`'s SYSTEM_PROMPT is the most opinionated one and worth reading directly.

### What to explore next
- Read the actual `SYSTEM_PROMPT` in each file. They're more concrete than this summary.
- [02-single-purpose-chains](./02-single-purpose-chains.md) → the pattern these all follow.
- [08-validation-gate](./08-validation-gate.md) → how each output is checked.

---

## Tradeoffs

- **One chain per feature** — gives: clear contracts, independent failure. Costs: shared prompt logic must live in helpers.
- **Per-type expand sub-chains** — gives: each type can have a specific schema. Costs: 6 system prompts to maintain.
- **No surrounding context for classify** — gives: cheap per-call. Costs: classify can't disambiguate based on context the user wrote in the same entry.

---

## Interview defense

### What an interviewer is really asking
On the per-feature reference page, the interviewer is testing whether I can move from "I built four AI features" to "I can defend each prompt + input + output contract specifically". They want concrete details: what system prompt does caption use, what fields does validateExpansion check for 'bug', what's the model choice and why per chain. Hand-wavy "we summarise the day" answers fail this question.

### Likely questions

[mid] Q: Walk me through `caption.ts`'s SYSTEM_PROMPT — what does it actually constrain?
      A: It's the most opinionated prompt in the codebase. It defines four named voices (clean / smoother / reflective / punchy) with example body lines for each, plus universal rules: no "I"/"you"/"we", no hashtags, no questions, no platitudes. It takes `{ date, rawLog[], recentCaptions?, mood?, themeHint? }` as input and demands `{ variants: { clean, smoother, reflective, punchy }, detectedTheme }` — all four variants required; partial output is treated as malformed by `parseAndValidate`. The opinionation matters because caption output is the most user-visible AI artifact: bad voice consistency would be obvious every day. The 4-variant shape lets the user pick rather than locking them into one tone.

[senior] Q: Why Sonnet 4.6 for summarize/caption/expand but Haiku 4.5 for classify? Walk me through the model-choice reasoning.
         A: Cost and task complexity. Summarize, caption, and expand all produce ~1024-token structured JSON with real reasoning content — clip orderings, tonal voice variants, typed expansions with multiple required fields. Sonnet at ~$0.04/call earns its keep on output quality. Classify is a 7-class label problem with ~50 tokens out — Haiku 4.5 (or gpt-4o-mini on the OpenAI side) handles it cheaply. The cost asymmetry is roughly 50×: Sonnet calls are dollars per heavy day if I let them rip, Haiku calls are cents. The model choice mirrors the value asymmetry — caption quality matters per-day, classify accuracy matters per-todo and the heuristic already filters half.

[arch] Q: How would you redesign these four features if cost dropped 100× — say Sonnet at $0.0004/call?
       A: I'd merge less, not more. The current splits exist because of failure isolation (caption split out of summarize) and cost pressure (no surrounding context for classify). At 100× cheaper, I'd send classify the surrounding entry text — accuracy goes up at no real cost. I'd drop the heuristic gate because it stops paying back. I might add a new feature like "weekly synthesis" that today would be too expensive to run automatically. The single-chain shape stays — that's about debuggability and failure isolation, not cost — but the inputs grow.

### The question candidates always dodge
Q: Your "per-feature spec" reads like documentation — but documentation rots fast. How do you keep this in sync with the actual prompts in `caption.ts` and `expandPrompts.ts`?

A: I don't, automatically. The doc warns the reader at the top: "this is a snapshot — when prompts change, this file should be re-checked", and the truth lives in source. The honest answer is that doc drift is real and I haven't built tooling to prevent it. The two mitigations are: one, the prompt-shape summaries here are deliberately *abstract* — I describe what the prompt enforces, not the exact wording, so small phrasing tweaks don't break the doc; two, I point readers to read `caption.ts:SYSTEM_PROMPT` and `expandPrompts.ts:getSystemPrompt` directly because those are concrete and authoritative. If I were running a team, I'd add a snapshot test that hashes the SYSTEM_PROMPT constants and fails CI when they change without a doc update — forcing the conversation. Solo dev, I rely on remembering to revisit. That's a real fragility and I'd rather name it than pretend the doc is auto-true.

### One-line anchors
- "Four chains, four jobs, four contracts."
- "Sonnet for output quality, Haiku for cheap labels. The model mirrors the value."
- "Caption is the most user-visible artifact — that's why its prompt is the most opinionated."
- "The doc is a snapshot. The prompt files are the truth."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
