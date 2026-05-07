# Validation as a hard gate

> Every callsite parses and *re-validates* the LLM output before writing to SQLite. The model is treated as untrusted input, even when its instructions are explicit.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [11-failure-modes](./11-failure-modes.md)

---

## Quick summary
- **What:** parse JSON → validate against schema → persist or reject. One retry on validation failure (with a stricter prompt), then give up.
- **Why here:** prompts drift. Models hallucinate keys. New model versions sometimes return slightly different JSON shapes. Validators catch all three.
- **Tradeoff vs runtime types:** TypeScript types don't enforce at runtime. The validators are the runtime guards.

---

## Validation gate — diagram

```
  LLM raw output (string)
         │
         ▼
   parseJson — regex out the {…}, JSON.parse
         │
         ├─ throws → null
         ▼
   validate per-type schema (validate.ts / validateExpansion / parseAndValidate)
         │
         ├─ missing required field → null
         ├─ type out of allowed enum → null
         ▼
   persist
         │
         ├─ if null AFTER first call → caption-style: skip; expand-style: retry once with stricter system prompt
```

---

## How it works

The output of every LLM call is treated like input from an untrusted client. The first step is `parseJson`: regex out the `{…}` substring (in case the model added a preamble), `JSON.parse`. If that throws, return `null`.

The second step is per-feature validation: `validateSummary` checks every clipId in `clipOrder` exists; `validateExpansion` checks the per-type required fields; `parseAndValidate` for caption checks all 4 variants present.

If validation fails, the behaviour depends on the feature:
- **caption** — skip; the structured summary still saves.
- **expand** — retry once with a stricter system prompt (`"Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema."`). After that, give up and return `{ ok: false, reason: 'malformed' }`.
- **summarize** — skip; surface error in `ai_summaries.error` for the next render.
- **classify** — skip; the meta row stays at heuristic-or-null type.

---

## In this codebase

- `src/services/ai/validate.ts` → `validateSummary()`, `parseAndValidate()` for the caption variants.
- `src/services/todos/expand.ts` → `validateExpansion()` and the one-retry pattern (line ~243).
- `src/services/ai/summarize.ts` → calls `validateSummary` and persists or surfaces error.

---

## Elaborate

### Where this pattern comes from
"Validate the boundary" is the classic API design rule — never trust input from outside your trust boundary. The LLM is outside the trust boundary even when you wrote its prompt; that's the insight.

### The deeper principle
**A prompt is not a contract.** The model agrees with the prompt the same way a junior dev agrees with a code review — most of the time, with errors. The validator is what enforces the contract.

### Where this breaks down
- Validators that are too strict reject benign variations (the model added a `null` field). Use Zod-style optional fields liberally.
- Validators that are too lax let through garbage. The trade-off is between tolerance for model variation and confidence in the persisted shape.

### What to explore next
- [02-single-purpose-chains](./02-single-purpose-chains.md) → the chain shape that the validator lives at the end of.
- [11-failure-modes](./11-failure-modes.md) → what happens after validation fails.

---

## Tradeoffs

- **Hard validation gate** — gives: SQLite always holds well-shaped data. Costs: a model output that's *almost* right gets rejected.
- **One retry then give up** — gives: bounded cost on bad responses. Costs: occasional features just don't run; user gets "couldn't expand."
- **Parse + validate split** — gives: each step has a single failure mode. Costs: two functions to maintain per chain.
