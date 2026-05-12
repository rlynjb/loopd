# Structured outputs

**Industry name(s):** Structured outputs, JSON mode, schema-validated outputs, typed LLM contracts
**Type:** Industry standard · Language-agnostic

> Every chain except `interpret` returns JSON that's parsed and re-validated against a typed contract before the result reaches the database.

**See also:** → [08-validation-gate](./08-validation-gate.md) · → [15-sampling-parameters](./15-sampling-parameters.md) · → [17-anatomy-of-prompt](./17-anatomy-of-prompt.md)

---

## Why care

You ask an LLM for a JSON object. Most of the time, you get one back. Sometimes the model wraps it in a ```json fence. Sometimes it adds a friendly "Here's the JSON you asked for:" preamble. Sometimes it returns valid JSON with one field missing, or one field renamed, or one number where you wanted a string. Every one of those breaks downstream code that did `JSON.parse(response)` and trusted the result.

Structured outputs are the contract pattern at the LLM boundary — the same shape as a TypeScript interface at a function boundary, with one extra step in the middle to handle the model's natural-language flakiness. They belong to the family of "untrusted input, typed contract, validation in between" patterns, alongside form validation in web forms, schema validation in REST APIs, and protocol buffers between services. Wherever the producer can't be fully trusted to honour the contract, the consumer enforces it at the boundary — JSON Schema, Zod, Pydantic, Yup, validateSummary. Here's how that actually works in this codebase.

---

## How it works

A passport-control desk between two countries. The traveller (the LLM) hands over a document; the officer (your validation function) checks each field against the rules; documents that don't match get rejected at the border, not after they're already in the country. Two operations welded together in the naive picture (LLM returns text → you trust it) split apart into three independent operations: ask for structured output, parse what you got, validate against the contract.

### The contract — a typed shape the chain promises to return

Every JSON chain in this codebase has a TypeScript type that names the contract. For the structured summary it's `AISummary` (in `src/types/ai.ts`) with fields like `headline: string`, `mood: 'flat' | 'ok' | 'good' | 'great' | 'fired'`, `clipOrder: string[]`. If you're coming from frontend, this is the same shape as a `Response` type from a `useQuery` hook — the component renders against the type, not against whatever the network returned. The contract is what makes the rest of the codebase typed: the editor reads `summary.mood` and gets autocomplete; the screen renders `summary.headline` and TypeScript catches any wrong access. Practical consequence: a chain that returns a shape outside the contract is rejected at the validation step rather than crashing a screen three layers up.

### The ask — telling the model "return JSON only"

There are two ways to communicate the contract to the model. First, in the **system prompt** — every chain spells out the JSON shape in prose at the end of the system prompt. Look at `summarize.ts`'s system prompt (`prompt.ts` L17–L27): the last paragraph says "Respond with ONLY valid JSON matching this exact shape:" and then literally types the JSON shape with field types. Second, on the **request body** — for OpenAI, every JSON chain sets `response_format: { type: 'json_object' }` (caption.ts L144, classify.ts L57, expand.ts L50). For Anthropic, there's no equivalent flag on the basic Messages API; the prompt is the only contract. If you're coming from frontend, the system-prompt approach is like JSDoc — documentation that tools and humans both read — while the `response_format` flag is like a `Content-Type` header, the formal commitment in the protocol layer. Practical consequence: OpenAI chains get an extra guarantee from the API (the response will always parse as JSON) while Claude chains rely on the prompt + the validation gate to enforce the contract.

### The parse — getting the object out of the response

Even with `response_format: json_object` and a strict prompt, the model can wrap output in markdown fences or add preamble. Every chain runs a defensive parse:

```ts
// caption.ts L170–L177
const jsonMatch = text.match(/\{[\s\S]*\}/);
if (!jsonMatch) return null;
let obj: Record<string, unknown>;
try {
  obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
} catch {
  return null;
}
```

The regex matches "the outermost JSON object" so a response wrapped in `Here's your data: { ... }\n` still parses. Anything that doesn't even have a `{...}` block returns `null` and the chain fails cleanly. If you're coming from frontend, this is the same shape as a try/catch around `JSON.parse(localStorage.getItem(...))` — you can't trust the producer to round-trip valid JSON every time, so you bracket the parse with a fail-safe. Practical consequence: every chain has a "the model returned garbage" path that returns `null` and the caller decides what to do (caption falls back to legacy summary text; summarise returns an error to the screen).

### The validate — checking every field against the contract

After the parse, every field gets checked: type, range, valid enum value, valid reference. `validate.ts:validateSummary` is the longest example — L20 checks `headline` is a string and slices to 100 chars; L22 checks `mood` is one of the five valid values or defaults to `'ok'`; L23 same for `filterPreset`; L26–L36 checks every `clipOrder` ID exists in the known clip set and any missing IDs get appended at the end; L40–L52 clamps every `clipTrims` start/end to the clip's actual duration. The pattern is the same in every chain — `caption.ts:parseAndValidate` L169–L199 checks all four variants are present and the theme is one of six valid values. If you're coming from frontend, this is exactly what `zod.parse(schema, data)` does at the route handler boundary in a tRPC or Hono server — type narrowing the unknown into the typed shape with fallbacks. Practical consequence: a malformed value never reaches the persistence layer. `upsertAISummary(date, JSON.stringify(summary), ...)` is always called with a valid `AISummary` because the validation function is the only producer.

### What `interpret` does differently

`interpret.ts` is the one chain that does NOT use structured outputs. It returns markdown — a long-form essay with `##` headings, blockquotes, bullet lists. The whole point of the chain is human-readable prose; forcing it through a JSON schema would defeat the feature. The validation step that exists (`cleanMarkdown` at L98–L108) just strips an optional outer code fence and checks the response is non-empty. If you're coming from frontend, this is the same difference as a JSON API endpoint vs an HTML-rendering endpoint — the contract is "valid markdown body" rather than "schema-conforming object." Practical consequence: `interpret`'s output is rendered straight to a modal (via `react-native-markdown-display`) and never persisted in a typed column.

This is what people mean by "type your contracts at the LLM boundary." A model that returns natural language is a producer you can't fully trust; the validation step is the same kind of trust boundary as a public API — anyone could be calling it, anyone could send anything, the consumer is responsible for the integrity of the data that gets through. The full picture is below.

---

## Structured outputs — diagram

```
                The flow for every JSON chain in this codebase

  ┌─ Caller (screen / hook / service) ────────────────────┐
  │  await summarize(date) | classify(text) | …           │
  └──────────────────┬────────────────────────────────────┘
                     │ awaits a typed value
                     │
  ┌─ AI chain layer (src/services/ai/* | src/services/todos/*) ─┐
  │                                                             │
  │   1. Build prompt with JSON-shape spec in system            │
  │      buildPrompt() in prompt.ts                             │
  │                                                             │
  │   2. Call provider                                          │
  │      Claude: client.messages.create({ system, messages })   │
  │      OpenAI: fetch(..., { response_format: 'json_object' }) │
  │                                                             │
  │   3. Defensive parse — extract outer {...} regex            │
  │      text.match(/\{[\s\S]*\}/) → JSON.parse()               │
  │                                                             │
  │   4. Validate against the typed contract                    │
  │      validateSummary() | parseAndValidate() | parseClassify │
  │       - field type check                                    │
  │       - enum membership check                               │
  │       - range / cross-reference check                       │
  │       - fallback / default on missing fields                │
  │                                                             │
  │   5. Return typed value (or null + error)                   │
  └──────────────────┬──────────────────────────────────────────┘
                     │ AISummary | CaptionVariantOutput | null
                     ▼
  ┌─ Storage / UI layer ─────────────────────────────────────────┐
  │  upsertAISummary(date, JSON.stringify(summary), model)       │
  │  setSummary(summary)  → screen renders typed fields          │
  └──────────────────────────────────────────────────────────────┘
```

```
              Where the JSON contract is enforced, layer by layer

  ┌─ Prompt layer (in system prompt) ──────────────────────┐
  │  "Respond with ONLY valid JSON matching this shape:"    │
  │  + literal JSON shape with field types                  │
  └─────────────────────────────────────────────────────────┘
                              │ informs model
                              ▼
  ┌─ API layer (request body, OpenAI only) ────────────────┐
  │  response_format: { type: 'json_object' }               │
  │  (Claude has no equivalent — prompt is the contract)    │
  └─────────────────────────────────────────────────────────┘
                              │ provider guarantees JSON parse
                              ▼
  ┌─ Parse layer (every chain) ────────────────────────────┐
  │  Match outermost {...} via regex (handles preamble)    │
  │  JSON.parse() inside a try/catch                       │
  └─────────────────────────────────────────────────────────┘
                              │ obj: Record<string, unknown>
                              ▼
  ┌─ Validation layer (per-chain function) ────────────────┐
  │  validateSummary | parseAndValidate | parseClassifyJson │
  │   - per-field type checks                               │
  │   - enum membership                                     │
  │   - range / cross-reference                             │
  │   - default-on-missing                                  │
  └─────────────────────────────────────────────────────────┘
                              │ typed value
                              ▼
                        Persisted / rendered
```

---

## In this codebase

**Type contracts:**
**File:** `src/types/ai.ts`
**Function / class:** `AISummary`, `CaptionVariantOutput`, `CaptionVariantKey`, `CaptionTheme`, `Interpretation`
**Line range:** see file (the types defined here are what every validation function narrows the model output to).

**Validation function (longest example):**
**File:** `src/services/ai/validate.ts`
**Function / class:** `validateSummary(raw, clipIds, clipDurations)`
**Line range:** L12–L137

**Caption parse + validate:**
**File:** `src/services/ai/caption.ts`
**Function / class:** `parseAndValidate(text)`
**Line range:** L169–L199

**Classifier parse + validate:**
**File:** `src/services/todos/classify.ts`
**Function / class:** `parseClassifyJson(raw)` + the `VALID_TYPES` / `VALID_CONFIDENCES` checks in `classifyTodo`
**Line range:** L74–L83 (parse), L102–L110 (validate)

**JSON-only request flag (OpenAI):**
- `caption.ts` L144 — `response_format: { type: 'json_object' }`
- `classify.ts` L57 — same
- `expand.ts` L50 — same
- `summarize.ts` L25–L36 — NOT set (Claude branch uses no flag; OpenAI summary chain inherits the same call shape and relies on the prompt)

---

## Elaborate

### Where this pattern comes from
Schema validation at trust boundaries predates LLMs by decades — protocol buffers, JSON Schema, Yup, Joi all enforce a typed contract at the point where untrusted data enters a trusted system. The LLM era added one twist: the producer is the model itself, and "the contract" is half in the prompt (instruction) and half in the consumer's validation function (enforcement). OpenAI's `response_format: json_object` and the newer `response_format: json_schema` (with formal schema enforcement on the provider side) are the industry's recognition that the prompt alone is insufficient. Anthropic's tool-use feature gives a similar guarantee via tools-as-schemas.

### The deeper principle
**Two enforcements beat one.** The prompt tells the model what shape you want; the validation function checks it actually came back that way. Most "JSON parsing failed" bugs come from teams that did only one of the two — they trusted the prompt, or they validated without setting `response_format`. Both layers are cheap; only one is enforceable. The Postel principle ("be liberal in what you accept") applies: the validation layer should accept the model's quirks (preamble, fences, extra fields) and produce a valid contract, not error out.

### Where this breaks down
- **Open-ended generation** (interpret.ts) — forcing markdown through a JSON schema would defeat the feature. Use a non-structured chain.
- **High-cardinality output spaces** — if your enum has 200 possible values, the model will sometimes return values not in the enum. At that point either expand the enum or accept fuzzy matching (`hamming distance`, prefix match) in the validator.
- **Streaming output** — you can't validate a partial JSON object mid-stream. Either validate at the end (lose perceived latency) or use a streaming JSON parser like `partial-json` (more complexity).
- **Free-form fields inside structured output** — `headline: string` doesn't constrain content, only type. A schema can validate shape but never quality.

### What to explore next
- [Validation as a hard gate](./08-validation-gate.md) → the deeper version of this concept, scoped to validation-as-defense.
- [Sampling parameters](./15-sampling-parameters.md) → why `temp=0` is the textbook setting for structured outputs.
- [Anatomy of a production prompt](./17-anatomy-of-prompt.md) → where the "Return JSON only" clause lives in the prompt.

---

## Tradeoffs

The codebase enforces structured outputs in two places (prompt + validation) for every chain except `interpret`. That's deliberate: the validation gate downstream catches what the prompt doesn't, and the cost is a per-chain validation function rather than a third-party dependency.

### Comparison table — both costs in one frame

```
┌────────────────────┬────────────────────────────┬────────────────────────────┐
│ Cost dimension     │ Path taken (prompt + hand- │ Alternative (zod schemas + │
│                    │ written validate function) │ tool-use / structured-     │
│                    │                            │ outputs API)               │
├────────────────────┼────────────────────────────┼────────────────────────────┤
│ Dependencies       │ zero new packages          │ +zod (~70KB gzipped)       │
│ Validation lines   │ 137 (validate.ts) + per-   │ ~30 lines: 5 zod schemas + │
│                    │ chain parsers              │ provider tool-use config   │
│ Defensive parse    │ regex + try/catch in every │ provided by the SDK or zod │
│ logic              │ chain                      │                            │
│ Per-field fallback │ explicit (mood defaults to │ would need .catch() on     │
│                    │ 'ok', clipOrder fills      │ every field for same UX    │
│                    │ missing IDs, etc.)         │                            │
│ Field-name drift   │ caught at runtime          │ caught at runtime          │
│ schema-shape drift │ caught at validate time    │ caught at parse time       │
│ Provider lock-in   │ none — every chain works   │ tool-use is provider-      │
│                    │ on every provider          │ specific (Anthropic ≠      │
│                    │                            │ OpenAI tool format)        │
│ Onboarding cost    │ contributor reads          │ contributor reads zod docs │
│                    │ validate.ts to learn the   │ + the schema file          │
│                    │ contract                   │                            │
└────────────────────┴────────────────────────────┴────────────────────────────┘
```

### What we gave up

We gave up declarative type validation. zod would let us write `z.object({ headline: z.string().max(100), mood: z.enum(['flat','ok','good','great','fired']) })` once and get parsing, validation, defaults, and TypeScript inference for free. Instead `validate.ts` re-implements that by hand in 137 lines — `obj.headline.slice(0, 100)`, `VALID_MOODS.includes(obj.mood as string)`, fallback to `'ok'`. The line count is the visible cost; the invisible cost is contributor onboarding (you have to read 137 lines to learn the contract rather than reading one schema file).

We gave up provider-side schema enforcement. OpenAI's newer `response_format: json_schema` (with full schema) and Anthropic's tool-use both let the provider enforce shape at the model layer, not just at the consumer. We use only `response_format: json_object` (loose: any valid JSON object) and rely on our own validator. The cost: a percentage of outputs that pass JSON-parse but fail our shape check, where the strict-schema mode would have caught it at the source.

We gave up a single source of truth for the contract. Right now the contract exists in three places: the TypeScript type (`AISummary`), the prompt text (the JSON shape spelled out at the bottom of the system prompt), and the validation function (`validateSummary`). A change to one without changes to the other two is a silent bug waiting to happen. A zod schema would centralise this.

### What the alternative would have cost

If we had used zod, we'd carry one more dependency (~70KB gzipped — non-trivial on React Native), one more layer in the call chain (`schema.parse(parsed)` between parse and use), and we'd still need a per-chain "what do you do when the schema fails?" path because the model's drift can't be fixed by a stricter parser. For a five-chain codebase the line savings (~100 lines) are real but small; the cognitive overhead of "where is the contract defined?" doesn't disappear, it shifts from `validate.ts` to `schemas/ai.ts`.

If we had used `response_format: json_schema` (OpenAI strict mode), we'd get provider-side enforcement on OpenAI but nothing equivalent on Claude. The codebase would be lopsided — Claude branches relying on prompt + validate, OpenAI branches relying on prompt + schema + validate. Either we double up the enforcement (extra work for both providers) or we accept that Claude is the lower-trust branch and pay the asymmetry cost.

### The breakpoint

Fine until the contract sprawls past ~10 fields per chain with nested objects. At that point the hand-written validator becomes a maintenance hazard — every new field is three places to update, three places to forget. The breakpoint is also event-shaped: the day a contract change ships with the validator updated but the prompt not (or vice versa), the failure pattern is "the model returns what the prompt asks for, the validator rejects it as not-the-new-shape" and the chain silently fails for a release cycle. That's the day to migrate to zod.

### What wasn't actually a tradeoff

`response_format: text` was never a real alternative for the JSON chains — interpret already uses it for the markdown chain; doing the same for summarise/caption/expand/classify would mean parsing free-form prose to extract structure, which is exactly the problem structured outputs solves. The two formats serve different use cases.

---

## Tech reference (industry pairing)

### Hand-written validation (validate.ts)

- **Codebase uses:** `validateSummary` in `src/services/ai/validate.ts` L12–L137; `parseAndValidate` in `caption.ts` L169–L199; `parseClassifyJson` + validity sets in `classify.ts` L74–L110.
- **Why it's here:** zero-dependency typed-contract enforcement at the LLM boundary. The chain's job is to return a typed value; this function is the typed value's producer.
- **Leading today:** zod — `adoption-leading` for TypeScript schema validation, 2026.
- **Why it leads:** the de-facto standard in the TypeScript ecosystem; pairs with tRPC, react-hook-form, Hono, every major server framework; the chained `.transform()` / `.default()` API encodes shape + fallback in one place.
- **Runner-up:** valibot — `innovation-leading` for the same problem at a fraction of the bundle size; tree-shakeable function-style API; gaining adoption in edge-runtime apps.

### OpenAI `response_format: { type: 'json_object' }`

- **Codebase uses:** `body: JSON.stringify({ ..., response_format: { type: 'json_object' }, ... })` in `caption.ts` L144, `classify.ts` L57, `expand.ts` L50.
- **Why it's here:** the loose JSON-mode flag — guarantees the response will be valid JSON without enforcing a specific shape; the codebase's validator handles shape.
- **Leading today:** `response_format: json_schema` (strict mode) — `innovation-leading` for production OpenAI usage, 2026.
- **Why it leads:** server-side schema enforcement — the model literally cannot return a shape that doesn't match; eliminates the parse-but-fail-validate class of bugs entirely.
- **Runner-up:** `response_format: json_object` (what this codebase uses) — `adoption-leading` for "I want JSON but I'll validate shape myself"; lower commitment, broader compatibility with older models.

### Anthropic tool use (alternative path)

- **Codebase uses:** not currently in use.
- **Why it would be here:** Claude's structured-output story is "define a tool with a schema, then tell the model it can only respond by calling that tool" — the schema is enforced provider-side. The codebase opts out and uses prompt-only enforcement on the Claude branch.
- **Leading today:** Anthropic tool use — `adoption-leading` for structured Claude output, 2026.
- **Why it leads:** the only provider-side schema enforcement Anthropic ships; pairs with the `response.content[0].input` field for the parsed object.
- **Runner-up:** prompt-only JSON enforcement (what this codebase uses on Claude) — sustainable for small contracts; the runner-up to tool-use specifically.

---

## Project exercises

### [B1.1] Add Zod schemas for every AI input/output across loopd's 5 chains

- **Exercise ID:** `[B1.1]`
- **What to build:** Replace each hand-rolled validator (`validateSummary`, `parseAndValidate` in caption, `validateExpansion`, `parseClassifyJson`) with a Zod schema per chain. Schemas live in `src/services/ai/schemas/` and are imported by both the chain and the test fixtures. Surface `[C1.12]` output-mode-mismatch issues by making the contract structural rather than spread across prompt prose + TypeScript type + validator function.
- **Why it earns its place:** the named cost in this file's Tradeoffs is "the contract lives in three places and stays in sync only by discipline." Zod schemas collapse it to one place. The interview signal is "I migrated a hand-rolled validator pattern to typed contracts; here's the before-and-after."
- **Files to touch:** new `src/services/ai/schemas/{summary,caption,expansion,classify}.ts`; edit `validate.ts`, `caption.ts`, `classify.ts`, `expand.ts`.
- **Done when:** every JSON chain's parse/validate path goes through a Zod schema; `npx tsc --noEmit` passes; forcing a malformed fixture into `expand`'s one-retry path still rejects cleanly; the catalogue in [13-ai-features-in-this-app.md](./13-ai-features-in-this-app.md) lists the schema file per chain.
- **Estimated effort:** `1–2 days`.

---

## Summary

Structured outputs are typed contracts at the LLM boundary — the model is told via prompt to return JSON matching a specific shape, the response is parsed defensively, and a hand-written validator narrows the parsed object into a TypeScript type with field-level fallbacks. In this codebase every chain except `interpret` follows this pattern: `validate.ts:validateSummary` is the longest validator (137 lines, validates the structured summary contract); `caption.ts:parseAndValidate` validates the 4-variant caption + theme; `classify.ts:parseClassifyJson` validates the classifier's `{type, confidence}` shape. The constraint that shaped this is that the LLM is the producer and the database is the consumer — anything malformed must be rejected before persistence. The cost is that the contract lives in three places (TypeScript type, prompt prose, validator function) and stays in sync only by discipline.

Key points to remember:
- Two enforcements: the system prompt names the JSON shape; the validator checks it came back that way.
- OpenAI chains add `response_format: { type: 'json_object' }` (loose JSON mode); Claude chains rely on the prompt alone.
- Every chain has a defensive parse: outermost `{...}` regex match, try/catch on `JSON.parse()`, null on failure.
- The validator narrows `unknown` to the typed contract with per-field fallbacks (mood defaults to 'ok', clipOrder appends missing IDs, etc.).
- `interpret` is the exception — markdown body, not JSON, by design (long-form prose is the feature).

---

## Interview defense

### What an interviewer is really asking
"Structured outputs" is the test of whether the candidate understands that LLM output is untrusted input. Most engineers writing LLM code for the first time treat the response as a function return value — typed, predictable. The interviewer wants to know whether you've internalised the model as an unreliable producer and built the validation that follows from that. Bonus signal: do you know the difference between the prompt enforcement and the API-level enforcement, and what each one does?

### Likely questions

[mid] Q: Walk me through what happens between calling `summarize(date)` and the `AISummary` showing up on the screen.

A: `summarize.ts` builds the prompt with the JSON shape spec in the system prompt, calls Claude or OpenAI based on the configured provider, and gets back text. The text gets a regex match for the outermost `{...}` block, then `JSON.parse()` inside a try/catch. The parsed object goes to `validateSummary(parsed, clipIds, clipDurations)` which narrows it field-by-field: `headline` to string + 100-char slice, `mood` to one of five valid values or default `'ok'`, `clipOrder` filtered against the known clip IDs with missing ones appended at the end, `clipTrims` clamped to each clip's duration. The returned `AISummary` is what `upsertAISummary()` persists and what the editor screen renders.

```
[summarize() → screen flow]

  summarize()
        │
        ▼
  buildPrompt() — JSON shape in system prompt
        │
        ▼
  callClaude / callOpenAI
        │  text response
        ▼
  text.match(/\{[\s\S]*\}/) → JSON.parse()
        │  unknown object
        ▼
  validateSummary(parsed, clipIds, clipDurations)
        │  AISummary
        ▼
  upsertAISummary() + setSummary(summary)
        │
        ▼
  Editor screen renders typed fields
```

[senior] Q: Why hand-write `validateSummary` instead of using zod?

A: Honest answer: bundle size and pace. zod adds ~70KB on a React Native runtime and would require a refactor to centralise the contracts. The hand-written validators carry the same field-by-field shape, just inlined. The real cost is that the contract lives in three places (type, prompt, validator) and stays in sync only by discipline — that's the drift surface I'd watch for. If the contract grows past ten fields with nesting, zod becomes the right call. Today it's five chains, each ~5–10 fields, and the validator-as-function shape keeps onboarding to one file rather than two.

```
                Path taken (hand-written)              Alternative (zod schemas)
                ──────────────────────────────         ──────────────────────────────
contract sites  3 (TypeScript type + prompt           2 (zod schema + prompt)
                + validator function)
bundle cost     0 KB                                   ~70 KB
sync surface    type ↔ prompt ↔ validator             schema ↔ prompt
                (manual)                               (manual but tighter)
declarative     no                                     yes
field-level     explicit (slice, clamp, fallback)     .max(100) / .default('ok')
fallback
onboarding      one file (validate.ts)                schema file + zod docs
```

[arch] Q: What changes if you went from 5 chains to 50?

A: Three things break. First, hand-written validators become a maintenance hazard — every chain has its own parser, no shared "the model returned `{...}` wrapped in preamble, here's how to find the object" helper. I'd extract that. Second, the contract-in-three-places sync surface gets unmaintainable; I'd move to zod schemas as the single source of truth, with TypeScript types inferred (`z.infer<typeof Schema>`) and the JSON shape generated from the schema for the prompt. Third, OpenAI's strict `response_format: json_schema` becomes worth its weight — provider-side enforcement eliminates the entire "parsed but didn't validate" class of bugs across 50 chains. The Claude branch would still rely on prompt + validate; that asymmetry becomes a real operational cost (some chains harder to debug than others) and may push toward Anthropic tool use.

```
At 50 chains:

  ┌─ Schema layer ──────────────────────────────┐
  │ Single source of truth — zod schemas         │
  │   AISummary, CaptionVariantOutput, …         │
  └─────────────────────────────────────────────┘
                       │
  ┌─ Type layer ───────────────────────────────┐
  │ z.infer<typeof Schema> = AISummary          │  ◀── BREAKS FIRST without zod
  └─────────────────────────────────────────────┘      (3-place drift compounds)
                       │
  ┌─ Prompt layer ─────────────────────────────┐
  │ JSON shape generated from schema             │
  └─────────────────────────────────────────────┘
                       │
  ┌─ API layer ────────────────────────────────┐
  │ OpenAI: response_format: json_schema (strict)│
  │ Claude:  tool use with schema                 │
  └─────────────────────────────────────────────┘
                       │
  ┌─ Validation layer ─────────────────────────┐
  │ schema.parse() — same schema, runtime check  │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You say "the validator backstops sampling drift" — but you also said the classifier runs at default temperature. Doesn't that mean the validator is doing real work catching bad output?

A: Yes — and that's the point I'd own. The validator IS catching real drift; in 0.1–1% of classifier calls the model returns something that doesn't match the schema (extra field, wrong-cased confidence, type as a verb instead of a noun) and `parseClassifyJson` returns `null`. The caller treats that as "leave the meta row at `type='todo'`, classifier_confidence=null and try again later." That's a graceful failure path the user never sees. If I'd set `temp=0`, the gate would be near-silent — but the gate would still exist, because temperature-zero doesn't guarantee schema conformance, it only makes drift unlikely. The two layers compose. Removing one increases the load on the other; removing both is what produces the "we ran a JSON.parse on the response and the app crashed" bug class.

```
                Path taken (default temp + validator)   Alternative (temp=0 + validator)
                ──────────────────────────────          ──────────────────────────────
classifier      drift in ~0.1–1% of calls               drift in <0.01% of calls
drift rate
validator       silently rejects bad output and         silently rejects bad output and
behaviour       returns null                            returns null
user-visible    none (rare miss leaves classifier_      none
result          confidence=null, retries later)
gate as silent  yes — does real work catching drift     yes — backstops the remaining
backstop                                                 long-tail drift
both layers     still required                          still required
ship cost       0 (already shipped)                     2 characters per chain
```

### One-line anchors
- "Structured outputs is the contract pattern at the LLM boundary — prompt asks, validator enforces."
- "Two enforcements beat one — the prompt names the shape, the validator checks it came back that way."
- "`response_format: json_object` guarantees the response parses; the validator guarantees it matches the contract."
- "Every chain in this codebase except `interpret` is structured; `interpret` is markdown by design."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the "every JSON chain in this codebase" flow from memory: caller → AI chain layer (prompt → call → parse → validate → return) → storage / UI layer.

Open the file. Compare.

✓ Pass: your diagram has the five steps inside the AI chain layer (prompt, call, parse, validate, return) and the typed return type at the boundary.
✗ Fail: re-read the "How it works" section, wait 10 minutes, try again.

### Level 2 — Explain it out loud
Explain structured outputs to an imaginary colleague who just asked "why don't you just `JSON.parse()` the LLM response?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific function? → `validate.ts:validateSummary` (or `caption.ts:parseAndValidate`)
- Say what would go wrong without the validator?
- Name the tradeoff (hand-written vs zod) in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

You're adding a sixth chain — a `tagline` generator that returns `{ tagline: string, emoji: string, color: 'red' | 'blue' | 'green' }`. Walk what each layer of structured outputs requires: the TypeScript type, the prompt's JSON shape spec, the request body flag (or absence of it on Claude), the parse step, the validator. What's the fallback on a missing `color` field? What's the fallback on a `color` value not in the enum?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/validate.ts` L20–L24 to verify the patterns you proposed match the existing chains.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you hand-write the validators or use zod? Why or why not? If you'd change it, what would the migration cost?"

Reference the actual code:
→ Point to `src/services/ai/validate.ts` L12–L137 to support what exists (the 137-line hand-written approach)
→ Point to where a zod schema file would live (`src/services/ai/schemas.ts`) if you chose the alternative

There is no right answer. The point is specificity. "zod is industry standard" is vague; "the 137 lines of validate.ts collapse to ~30 lines of zod schemas but cost ~70KB on the runtime" is specific.

### Quick check — code reference test
Without opening any files, answer:
- Which file holds the validator for the structured summary?
- Which line range does it cover?
- Which chain in this codebase deliberately does NOT use structured outputs, and why?

Then open `validate.ts` and `interpret.ts` to verify.

✓ Pass: you named `validate.ts:validateSummary` (L12–L137) and identified `interpret.ts` as the markdown exception.
✗ Fail on lines: that's fine. File and function names are what matter.
