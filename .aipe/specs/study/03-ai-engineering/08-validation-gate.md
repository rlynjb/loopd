# Validation as a hard gate

**Industry name(s):** Output validation, schema gate, structured output
**Type:** Industry standard · Language-agnostic

> Every callsite parses and *re-validates* the LLM output before writing to SQLite. The model is treated as untrusted input, even when its instructions are explicit.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [11-failure-modes](./11-failure-modes.md)

---

## Why care

A model will return malformed JSON, invent a field you didn't ask for, drop a required field, or quietly switch from an array to an object — and it will do all of this on a prompt that worked yesterday. Every system that writes LLM output to a database without checking it first eventually has a row that crashes a render two weeks later, and nobody can figure out why. The model is producing text; the only thing standing between that text and your storage layer is a parse + a check.

The validation gate treats every model output as untrusted input — the same way you'd treat a JSON payload from a public API. It belongs to the family of "parse, don't validate" patterns: convert the raw output into a strongly-typed value at the boundary, reject anything that doesn't conform, and never let unchecked data into the core of the system. You've already seen this shape in Zod or Pydantic schemas at HTTP boundaries, in JSON Schema validators on webhooks, in OpenAI's "structured outputs" mode that constrains the model to a schema at decode time, and in Instructor / Outlines / LangChain output parsers that retry on validation failure. The next block walks the mechanics.

---

## How it works

A border-control officer who stamps passports. Whatever the traveller says, the officer checks the paperwork against the rules — name on the form, photo matches, dates valid, visa in the right column. If the paperwork passes, the traveller comes in; if not, the traveller is sent back. The model is the traveller, the validators are the officer, and the persistence layer is the country. Untrusted input never gets stamped without the officer's check. If you're coming from frontend, this is the same shape as treating LLM output like user-submitted form data — never paste it into your application state without parsing and validating it first, exactly the way you wouldn't paste a `<form>` POST body into your DB.

### Step 1 — `parseJson`: extract the JSON, fail closed if malformed

Every chain that returns JSON runs `parseJson(text)` first. The function regex-matches the first `{…}` substring (in case the model wrapped the JSON in a prose preamble like `"Sure! Here's the JSON: { ... }"`), then runs `JSON.parse` on the substring. If either step fails, it returns `null` — the chain treats that as a parse failure and short-circuits. Think of it like a typed form's `parse()` step that returns `Either<Error, T>` — the parse outcome is the contract; downstream code only sees the success branch. Concrete consequence: Claude returns `"Here are the variants: {\"clean\": \"...\", \"smoother\": ...}"`. `parseJson` regexes the substring `{...}`, parses it, returns the typed object. If Claude had returned `"I can't generate captions today."`, the regex finds no JSON, returns `null`, the chain skips and the UI shows the previous variants (or an empty state). Boundary: the regex is greedy — if the model emits nested JSON or unbalanced braces, the extract may grab the wrong substring. The parser then throws and the chain fails closed.

### Step 2 — per-feature schema validators

After `parseJson`, each chain runs its own validator: `validateSummary` checks every `clipId` in `clipOrder` exists in the input; `validateExpansion` checks the per-type required fields match the discriminated union; `parseAndValidate` for caption checks all 4 variants are present. The validators are hand-written (not Zod, not Ajv) — small enough that a library wouldn't add value. Think of it like the same shape as a typed React form's per-field check before submit — "is this field present, is it the right shape, does it cross-reference correctly to other inputs." Concrete consequence: `summarize.ts` gets back a JSON object claiming `clipOrder: ["c1", "c2", "c3"]`, but the input only had clips `c1` and `c2`. `validateSummary` catches the unknown id `c3`, returns failure. The chain skips persistence; the UI shows the previous summary or an error state. Boundary: the validators trust the JSON parser to have produced typed data — if a future migration changes the schema, validators have to be updated in lockstep, or the safety net silently widens.

### The per-feature failure policy

The behaviour on a validation failure depends on the chain — there's no one-size-fits-all retry/skip policy. Naming the policy per chain is part of the integrity contract:

- **caption** — skip on failure; the structured summary still saves. The variants column stays at its previous value (or empty).
- **expand** — retry once with a stricter system prompt: `"Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema."` If the retry also fails, give up and return `{ ok: false, reason: 'malformed' }`.
- **summarize** — skip; surface error in `ai_summaries.error` for the next render.
- **classify** — skip; the meta row stays at heuristic-or-null type.

If you've worked with React Query mutations that have different `retry` strategies per mutation, this is the same shape — the retry policy is part of each chain's design, not a global default. Concrete consequence: a user with intermittent malformed expand outputs gets one automatic retry per failed call (the model often succeeds on the second try with the stricter prompt); a user with malformed caption outputs sees the variants stay stale until the next successful run. Both outcomes are deliberate. Boundary: too many retries inflate cost and latency; too few retries make the chain fragile. One retry on expand is the empirical sweet spot for this codebase.

### The interpret exception — markdown can't be schema-validated

`interpret` returns markdown, not JSON. Its validator is `cleanMarkdown` (11 lines): strip an outer triple-backtick fence if present, reject empty/whitespace-only output as `'malformed'`. There's no schema, no JSON parse, no per-field check. The model is trusted to follow the prompt's structural suggestions (e.g. "produce four sections: Observations, Patterns, Questions, A Next Step"), but tone or section drift slips through. The user is the integrity check — they see the modal output and dismiss it if wrong. If you're coming from frontend, this is the same shape as a textarea input that doesn't enforce structure — you can validate length and presence, but you can't validate "the user made a coherent argument." Concrete consequence: a malformed interpret output (missing sections, wrong tone) reaches the UI; the user reads it, decides it's not useful, closes the modal. There's no cached row to corrupt. Boundary: this works because interpret's output is ephemeral — there's no downstream consumer that would break on a malformed reflection. A future feature that *caches* interpret outputs would need a stronger validator.

This is what people mean by "treat the model as an untrusted client." Every LLM application that has ever shipped a feature without this discipline has eventually had the model return something that broke the consumer — a missing field, a numeric value as a string, a list with the wrong cardinality. The validation gate is what keeps the model's stochasticity from leaking into the application's invariants. Every form-handling backend ever written has the same discipline at the boundary; the only thing new here is recognising that "the model" is just another untrusted source. The full picture is below.

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

We traded "nearly-right outputs go to SQLite" tolerance for a hard parse-and-validate gate — never letting malformed model output reach storage, and accepting that almost-right answers get thrown away.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (hard gate)         │ Alternative (fill defaults /   │
│                  │                                │ soft accept)                   │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Money            │ ~1 wasted call per drift event │ 0 wasted calls — but downstream│
│ ($/call)         │ (~$0.04 on Sonnet/expand);     │ "render broken comp" bugs each │
│                  │ retry only on expand           │ cost dev hours to track down   │
│ Latency          │ 1 extra retry on expand (~3s); │ no retry latency; instant fail │
│                  │ skip otherwise                 │ surfaces only when user reads  │
│ Quality          │ no malformed data in SQLite;   │ ~1-3% of rows carry shape bugs │
│ (% correct)      │ recovery = re-fire             │ (default-filled, half-parsed); │
│                  │                                │ silent corruption              │
│ Failure mode     │ loud + bounded — caption skips,│ silent — wrong clipOrder       │
│                  │ expand returns malformed       │ renders broken editor; user    │
│                  │ reason; user sees nothing wrong│ doesn't know why               │
│ Debugging        │ wrong row → wrong validator    │ wrong row → 4 possible causes  │
│                  │ rule; one place to fix         │ (parser, default-filler,       │
│                  │                                │ model drift, race)             │
│ Cognitive load   │ "parse, then validate, then    │ "parse, fix-up, then trust" —  │
│                  │ persist" — uniform across 5    │ where does fix-up logic live   │
│                  │ chains                         │ for each chain?                │
│ Model upgrades   │ validators are the canary —    │ model drift slips through;     │
│                  │ Sonnet 5 schema drift fails    │ surfaces as user-visible bugs  │
│                  │ loudly                         │ weeks later                    │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up the ability to accept "nearly-right" outputs. When the model returns a caption with 3 of 4 variants present and `parseAndValidate` rejects it, the user sees no caption variants that day — the structured summary still saves, but the 4-variant strip on the dashboard is empty. The model produced 75% of the right answer; we threw all of it away. In aggregate this is rare (~1-3% of caption calls drift), but it does happen and the recovery is "try again tomorrow" not "use the partial."

We pay for an extra LLM call on every expand validation failure. The one-retry-with-stricter-prompt pattern in `expand.ts` adds ~$0.04 and ~3s of latency on each retry — affordable at single-user volume but real at scale. Caption, summarize, and classify don't retry: when they fail validation, the chain silently skips and the user gets no AI annotation for that event. That's the deliberate asymmetry — retry budget tracks user intent (expand is button-fired; others are automatic).

The interpret chain is the deliberate exception: its "validator" is the 11-line `cleanMarkdown`, not a schema. We accept that the model can drift into clinical language, that emoji H2 headings can become plain `##` headings, that the structural template can flatten — all of which slip through `cleanMarkdown` because the user is the integrity check, not the app. The cost is no canary on `interpret.ts` model upgrades; we'd notice degradation only by reading the modal output.

### What the alternative would have cost

A "fill defaults on partial output" path would have meant deciding what to do when each required field was missing. For caption, what's a default `punchy` variant? For summarize, what's a default `clipOrder` if the model returned an empty array? Every default is a product decision masquerading as a fallback — and the choice "use whatever default" is the choice "let the user see the default and assume the AI worked." That's silent corruption: the editor renders a "summary" that's mostly empty, the user doesn't know why, and the bug is invisible until they ask a question we can't answer.

The deeper cost is observability. With a hard gate, model drift surfaces immediately — a Sonnet upgrade that returns a slightly different shape fails `validateSummary` on the next call, the error lands in `ai_summaries.error`, and the dev (me) notices the next time I look. With soft-fill defaults, the same drift quietly renders broken UI for weeks until a user complains. The validators are the canary; turning them into a fix-up layer would silence the canary.

Cross-cutting: where does the fix-up logic live? Each chain has different required fields, different default shapes, different consumers. The defaulting code would either live in each validator (5 places to update on schema change) or in a shared `fillMissingFields(schema, partial)` utility (which is just another validator with a different return shape). Neither is simpler than the current "parse, validate, skip" pattern.

### The breakpoint

The pattern flips the day the cost of "missed annotation" exceeds the cost of "silent corruption". Concrete trigger shapes: an AI annotation becomes load-bearing (the editor refuses to render without it), the user pays for an AI feature where "couldn't generate" feels like a broken product, or the rate of validation failures climbs past ~5% — at which point retry-once isn't enough and we'd need either prompt-tuning, a more reliable model, or graceful fallback to a simpler shape.

Today the pattern works because every AI feature is *advisory*: missing classify → row stays at `type='todo'`, missing caption → no variants strip, missing expand → user sees the "couldn't expand" UI and re-fires. The day any of those failures becomes user-visible *as a failure* (not just as missing annotation), we'd need a different recovery path. None of them are today.

A secondary trigger: model upgrades that consistently fail the current validators. If Sonnet 5 changes its JSON shape and `validateSummary` rejects 30% of calls, the right answer is to update the schema, not to relax the gate. The gate is the canary, not the bottleneck.

### What wasn't actually a tradeoff

JSON Schema vs hand-rolled validators wasn't a real choice for this codebase. The validators are 30-100 LOC each (`validateSummary` L12+, `validateExpansion` L77–L142, `parseAndValidate` L169–L199) and each one knows its chain-specific rules (clipId-exists, all-four-variants-present, per-type-required-fields). Standardizing on JSON Schema would mean importing a runtime validator (Zod, ajv) and translating each chain's rules into schema files — same logic, more indirection, no portability gain because the validators aren't shared across services.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk / Claude Sonnet 4.6

- **Codebase uses:** `@anthropic-ai/sdk` (`callClaude` in `summarize.ts`, `caption.ts`, `expand.ts`, `interpret.ts`).
- **Why it's here:** the validator gate runs on every LLM output; Anthropic SDK is the primary provider.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling that wrappers sometimes flatten or delay.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures and `useChat` hook.

---

## Project exercises

### [B1.1] Add Zod schemas for every AI input/output across loopd's 5 chains

- **Exercise ID:** `[B1.1]`
- **What to build:** Replace each hand-rolled validator (`validateSummary`, `parseAndValidate` in caption, `validateExpansion`, `cleanMarkdown`) with a Zod schema per chain. Schemas live in `src/services/ai/schemas/` and are imported by both the chain and the test fixtures.
- **Why it earns its place:** typed contracts are the difference between "we validate" and "we have a single source of truth for what each chain returns." Surfaces output-mode-mismatch issues (C1.12) by making the contract structural rather than ad-hoc.
- **Files to touch:** new `src/services/ai/schemas/{summary,caption,expansion,interpret,classify}.ts`; edit `src/services/ai/validate.ts`, `caption.ts`, `expand.ts`, `interpret.ts`, `classify.ts`.
- **Done when:** every chain's parse/validate path goes through a Zod schema; `npx tsc --noEmit` passes; running the existing `expand` retry-on-failure path under a forced-malformed fixture still rejects cleanly.
- **Estimated effort:** `1–2 days`.

---

## Summary

The validation gate is the "parse, don't validate" pattern applied to LLM output — every model response is treated as untrusted input, parsed into a strongly-typed value at the boundary, and rejected if it doesn't match the schema. In this codebase the gate lives in `validate.ts` (`validateSummary`), `caption.ts` (`parseAndValidate`), `expand.ts` (`validateExpansion`), and `interpret.ts` (`cleanMarkdown`) — each chain owns its own validator and persistence only happens after it passes. The constraint that drove it is that prompts drift, models hallucinate keys, and new model versions sometimes return slightly different JSON shapes — TypeScript types don't enforce at runtime, so the validators are the runtime guards. The cost is that a model output that's *almost* right gets rejected, and on the second failure the feature just doesn't run that time.

Key points to remember:
- Parse JSON, then validate against schema, then persist — never the other way around.
- One retry with a stricter prompt on validation failure for expand; the other chains skip on failure.
- A prompt is not a contract. The validator is what enforces the contract.
- The cost is a nearly-right output gets thrown out; the win is no malformed data ever reaches SQLite.
- Interpret's "validator" is 11 lines of `cleanMarkdown` because the consumer is the user, not the app.

---

## Interview defense

### What an interviewer is really asking
"Why a validation gate?" tests whether I treat the LLM as untrusted input. The interviewer wants to see "a prompt is not a contract" as a stated principle, with code references. The candidate who says "I trust the model because I wrote a careful prompt" fails this question. The validators in `validate.ts` exist because prompts drift, models hallucinate keys, and new model versions sometimes return slightly different shapes — all three have happened in this codebase.

### Likely questions

[mid] Q: Where does `validate.ts` actually run in the flow, and what happens on failure for each chain?
      A: After the model call returns, before any DB write. `parseJson` regexes out the `{…}` and `JSON.parse`s — if that throws, returns null. Then per-feature validators run: `validateSummary` (every clipId in clipOrder must exist), `parseAndValidate` for caption (all 4 variants required: clean, smoother, reflective, punchy), `validateExpansion` (per-type required fields). On failure the behaviour differs: caption skips and the structured summary still saves; summarize surfaces the error in `ai_summaries.error`; expand retries once with a stricter system prompt and then gives up returning `{ ok: false, reason: 'malformed' }`; classify skips and the meta row stays at heuristic-or-null type. No malformed output ever reaches SQLite.

```
[validate.ts flow — uniform across 4 JSON chains]

  LLM call returns string
        │
        ▼  parseJson — regex {...}, JSON.parse
  parsed object | null
        │
        ├─ null → SKIP (caption) | log + error (summarize) |
        │        retry once stricter (expand) | SKIP (classify)
        │
        ▼  per-feature validator (validateSummary / parseAndValidate /
           validateExpansion / cleanMarkdown for interpret)
        │
        ├─ schema fails → same chain-specific recovery as above
        │
        ▼  persist to SQLite (ai_summaries / todo_meta / etc.)
```

[senior] Q: Why a hard gate instead of "fix it up" — for example, fill in missing fields with defaults?
         A: Because filling defaults silently turns model failures into user-visible wrong answers. If `validateSummary` accepted a summary with a `clipOrder` referencing a missing clipId, the editor would render a broken composition with no signal that the model misfired. Hard rejection means "no AI annotation this time" — the user sees the un-annotated state and the chain can be re-fired. The trade is that a *nearly* right output gets thrown out. I'm okay with that because the recovery path is "run it again", which is cheap, and the alternative is silent corruption.

```
                  Path taken (hard gate)              Alternative (fill defaults)
                  ─────────────────────               ──────────────────────────
nearly-right      thrown away — re-fire is recovery   accepted with defaults filled
output            ($0.04 cost)
SQLite content    always well-shaped                  ~1-3% rows carry shape bugs
user signal       "no annotation this time" —         "annotation present but wrong" —
                  visible absence                     invisible corruption
failure surface   loud — appears immediately on call  silent — surfaces weeks later
                                                      as user-visible UX bug
debugging         wrong row → wrong validator rule    wrong row → 4 causes (parser,
                  (one place to fix)                  default-filler, drift, race)
recovery cost     ~$0.04 per re-fire                  dev-hours per silent bug found
                                                      after the fact
model-upgrade     canary fires loudly                 canary disabled — drift slips
sensitivity                                           through silently
```

[arch] Q: How does the validation gate interact with model upgrades — say switching Sonnet 4.6 to a future Sonnet 5?
       A: It's the canary. The day a model upgrade returns a slightly different shape — extra field, renamed key, missing optional that used to be there — `validate.ts` catches it before persistence. The retry-with-stricter-prompt in `expand.ts` is a soft mitigation; if the new model consistently fails validation, I'd see it in the error logs and update either the prompt or the schema. The validators are versioned implicitly with the prompt; they're a contract test. Without them, a model upgrade looks like "the app works" until the editor renders something weird.

```
At model-upgrade day (Sonnet 4.6 → Sonnet 5):

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — editor reads ai_summaries       │
  └─────────────────────────────────────────────┘
              │
  ┌─ Validators (validateSummary / Expansion) ──┐
  │ rejects schema-drifted output IMMEDIATELY   │  ◀── CANARY FIRES FIRST
  │ ai_summaries.error fills up                 │     (loud, before any
  │ logs surface "Sonnet 5 returns 'clip_order' │      data is persisted)
  │ instead of 'clipOrder'" or similar          │
  └─────────────────────────────────────────────┘
              │
  ┌─ Persistence (SQLite) ──────────────────────┐
  │ stays clean — no malformed rows enter store │
  │ recovery: update validator OR prompt         │
  │ until validation rate is healthy again       │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: What about prompt injection? You parse the LLM output and write it to your DB. If the user pastes adversarial text into a journal entry, you trust the model output enough to commit it.

A: The validation gate is a *parse* gate, not an injection gate. I check that the JSON is well-formed and matches the schema. If the model returns valid JSON with malicious content (a SQL-injection-shaped string in `summary`, a script tag in `expanded_md`), the validator passes it. In this codebase that's acceptable because the LLM only writes to derived fields — `todo_meta.expanded_md`, `ai_summaries.summary_json`, `caption.variants.*`. Those fields are never executed (markdown rendered, not eval'd), never sent back to the LLM as a system prompt, and never used as SQL. The injection surface in this app is zero. The user is also the only person who can read their own data — single-user phase A. If I added a feature that fed model output back into a system prompt (a "remember this" mode), I'd add a sanitizer at that boundary. If I added multi-user with shared content, I'd sanitize on render. Today neither exists, so the parse gate is the only gate I need.

```
                  Path taken (parse-only gate)        Suggested (also-sanitize gate)
                  ───────────────────────────         ──────────────────────────────
what gate checks  shape: JSON well-formed +           shape + content: deny-list
                  schema fields present               regexes for HTML, SQL,
                                                      system-prompt injection
injection surface zero today — model output goes to:  same fields, additionally
                  - markdown-rendered (never eval'd)  scrubbed
                  - never sent back as system prompt
                  - never used as SQL parameter
sanitizer cost    0 LOC                               ~30-50 LOC per chain + tuning;
                                                      brittle to bypass
false-reject rate 0                                   non-zero — sanitizer rejects
                                                      legitimate user content that
                                                      pattern-matches injection
phase-A fit       single user, no shared content —    over-engineering for the
                  no audience to be injected into     current threat model
when this flips   multi-user shared content,          add sanitizer at the consumer
                  OR model-output-as-system-prompt    boundary, not as a parse gate
                  feature ships
```

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
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (border-officer metaphor opening / 4 layered sub-sections — parseJson extract, per-feature validators, per-chain failure policy, interpret exception — each with frontend bridges and concrete consequences / principle paragraph on treating the model as an untrusted client).
