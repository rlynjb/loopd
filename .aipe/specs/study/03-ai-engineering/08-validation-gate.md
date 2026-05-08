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

---

## Interview defense

### What an interviewer is really asking
"Why a validation gate?" tests whether I treat the LLM as untrusted input. The interviewer wants to see "a prompt is not a contract" as a stated principle, with code references. The candidate who says "I trust the model because I wrote a careful prompt" fails this question. The validators in `validate.ts` exist because prompts drift, models hallucinate keys, and new model versions sometimes return slightly different shapes — all three have happened in this codebase.

### Likely questions

[mid] Q: Where does `validate.ts` actually run in the flow, and what happens on failure for each chain?
      A: After the model call returns, before any DB write. `parseJson` regexes out the `{…}` and `JSON.parse`s — if that throws, returns null. Then per-feature validators run: `validateSummary` (every clipId in clipOrder must exist), `parseAndValidate` for caption (all 4 variants required: clean, smoother, reflective, punchy), `validateExpansion` (per-type required fields). On failure the behaviour differs: caption skips and the structured summary still saves; summarize surfaces the error in `ai_summaries.error`; expand retries once with a stricter system prompt and then gives up returning `{ ok: false, reason: 'malformed' }`; classify skips and the meta row stays at heuristic-or-null type. No malformed output ever reaches SQLite.

[senior] Q: Why a hard gate instead of "fix it up" — for example, fill in missing fields with defaults?
         A: Because filling defaults silently turns model failures into user-visible wrong answers. If `validateSummary` accepted a summary with a `clipOrder` referencing a missing clipId, the editor would render a broken composition with no signal that the model misfired. Hard rejection means "no AI annotation this time" — the user sees the un-annotated state and the chain can be re-fired. The trade is that a *nearly* right output gets thrown out. I'm okay with that because the recovery path is "run it again", which is cheap, and the alternative is silent corruption.

[arch] Q: How does the validation gate interact with model upgrades — say switching Sonnet 4.6 to a future Sonnet 5?
       A: It's the canary. The day a model upgrade returns a slightly different shape — extra field, renamed key, missing optional that used to be there — `validate.ts` catches it before persistence. The retry-with-stricter-prompt in `expand.ts` is a soft mitigation; if the new model consistently fails validation, I'd see it in the error logs and update either the prompt or the schema. The validators are versioned implicitly with the prompt; they're a contract test. Without them, a model upgrade looks like "the app works" until the editor renders something weird.

### The question candidates always dodge
Q: What about prompt injection? You parse the LLM output and write it to your DB. If the user pastes adversarial text into a journal entry, you trust the model output enough to commit it.

A: The validation gate is a *parse* gate, not an injection gate. I check that the JSON is well-formed and matches the schema. If the model returns valid JSON with malicious content (a SQL-injection-shaped string in `summary`, a script tag in `expanded_md`), the validator passes it. In this codebase that's acceptable because the LLM only writes to derived fields — `todo_meta.expanded_md`, `ai_summaries.summary_json`, `caption.variants.*`. Those fields are never executed (markdown rendered, not eval'd), never sent back to the LLM as a system prompt, and never used as SQL. The injection surface in this app is zero. The user is also the only person who can read their own data — single-user phase A. If I added a feature that fed model output back into a system prompt (a "remember this" mode), I'd add a sanitizer at that boundary. If I added multi-user with shared content, I'd sanitize on render. Today neither exists, so the parse gate is the only gate I need.

### One-line anchors
- "A prompt is not a contract. The validator is what enforces the contract."
- "The validation gate is a *parse* gate, not an injection gate."
- "No malformed output ever reaches SQLite. That's the rule."
- "Model upgrades break validators first — that's the canary."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
