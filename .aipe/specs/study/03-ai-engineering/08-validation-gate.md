# Validation as a hard gate

**Industry name:** Output validation, schema gate, structured output
**Type:** Industry standard · Language-agnostic

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
- **caption** — skip; the structured summary still saves. The chain emits `{ variants: { clean, smoother, reflective, punchy }, detectedTheme }` and on success `summarize.ts:91–92` persists those as `summary_json.variants` and `summary_json.variantsTheme` — note the theme key is *renamed* on persistence (`detectedTheme` → `variantsTheme`), not pass-through; the variants object is pass-through.
- **expand** — retry once with a stricter system prompt (`"Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema."`). After that, give up and return `{ ok: false, reason: 'malformed' }`.
- **summarize** — skip; surface error in `ai_summaries.error` for the next render.
- **classify** — skip; the meta row stays at heuristic-or-null type.
- **interpret** — different shape entirely: validation is `cleanMarkdown` (11 lines), which strips an outer ``` fence and rejects empty/whitespace-only output as `'malformed'`. There is no schema, no JSON parse, no per-field check. The model is trusted to follow the prompt's structural suggestions; tone or section drift slips through. The user is the integrity check (they see the modal output and dismiss it if wrong).

---

## In this codebase

**Summary validator:**     `src/services/ai/validate.ts` → `validateSummary()` L12+ — checks every clipId in `clipOrder` exists, trims fit clip duration, etc.
**Caption validator:**     `src/services/ai/caption.ts` → `parseAndValidate()` L169–L199 (with `normalizeVariant()` L158–L167) — checks all 4 variants present
**Expand validator:**      `src/services/todos/expand.ts` → `validateExpansion()` L77–L142 — per-type required fields (4 types now: idea/knowledge/study/reflect). One-retry pattern with stricter prompt on second attempt
**Interpret "validator":** `src/services/ai/interpret.ts` → `cleanMarkdown()` L98–L108 — 11 lines, strips outer ``` fences, rejects empty/<20-char output. Plus the input-side guards `MIN_TEXT_LENGTH = 20` (L16) and `MAX_INPUT_CHARS = 2000` (L17, applied via `truncateTail` L58–L61).
**Caller:**                `src/services/ai/summarize.ts` → `summarize()` L42–L105 calls `validateSummary` and persists or surfaces error in `ai_summaries.error`

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

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the validation gate to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/ai/validate.ts:validateSummary` (or `:validateExpansion`)
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

Sonnet returns a caption response that is structurally valid JSON `{ variants: { clean, smoother, reflective }, detectedTheme }` — but the `punchy` variant is missing entirely. What does `parseAndValidate` do — return the partial result, throw, fail soft? What's persisted to `ai_summaries`? What does the user see on the dashboard? Then: same response shape happens for `validateSummary` if `clipOrder` references a clipId that doesn't exist — what's the recovery path?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/caption.ts` L169–L199 and `src/services/ai/validate.ts` L7–L110 to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/validate.ts` (the hard-rejection contract) to support what exists
→ Point to where a "fill defaults on partial output" alternative would land (likely a new merger in each validator) if you chose the alternative

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
Updated: 2026-05-10 — added interpret's cleanMarkdown gate + input-side guards as the 5th validation flow (markdown out, no schema). See `14-interpret.md`.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block; added persistence-key mapping for caption (`detectedTheme` → `summary_json.variantsTheme` at summarize.ts:91–92; `variants` is pass-through to `summary_json.variants`).
