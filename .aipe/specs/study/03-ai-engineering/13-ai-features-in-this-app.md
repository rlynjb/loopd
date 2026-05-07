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
