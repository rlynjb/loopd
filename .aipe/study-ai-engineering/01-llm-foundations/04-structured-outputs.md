# Structured outputs

**Industry name(s):** Structured outputs, tool calling, JSON mode, function calling, typed contracts
**Type:** Industry standard

> Free-text LLM output is unsafe to consume. A schema-constrained output is a typed contract at the LLM boundary — the same discipline TypeScript gives you at a function boundary. The provider returns valid JSON or it errors; either way, no silent parse-time bugs.

**See also:** → [01-what-is-an-llm](./01-what-is-an-llm.md) · → [03-sampling-parameters](./03-sampling-parameters.md) · → [`05-evals-and-observability/02-eval-methods`](../05-evals-and-observability/02-eval-methods.md)

---

## Why care

### Move 1 — The grounded scenario

You're building the `summarize` chain. You ask the model: "Summarize this entry as JSON with `headline`, `narrative`, `tone`, `tags`." The model returns plausible JSON 95% of the time. The other 5%, it returns one of: (a) JSON wrapped in markdown fences (` ```json\n{...}\n``` `), (b) JSON with a trailing comma, (c) JSON preceded by "Here's the summary:", (d) JSON with the wrong field names. Your `JSON.parse()` throws. Your UI gets a runtime error. The bug only surfaces when the model "decides" to be courteous.

### Move 2 — Name the question the pattern answers

That how-do-I-make-LLM-output-safe-to-consume question is what structured outputs answer. Not "how do I prompt the model to return JSON" (insufficient — the model lies about JSON sometimes); the answer is *constrain the output at the API level, not in the prompt*. Modern providers offer tool-calling and JSON-mode APIs that GUARANTEE schema-conformant output (or return an error you can handle).

### Move 3 — Why answering that question matters

**What breaks without the discipline:** every chain that consumes LLM output as a typed object becomes a fragile parser. The 5% failure rate compounds across chains; an end-to-end pipeline with 3 LLM steps has ~14% baseline failure rate just from JSON drift. In buffr, all 4 JSON-output chains (`summarize`, `caption`, `expand`, `classify`) go through `src/services/ai/validate.ts` which Zod-shapes the parsed result; a parse failure throws a typed error, not a silent garbage value. The fifth chain (`interpret`) returns markdown by design and is validated only for non-emptiness.

### Move 4 — Concrete before/after

Without structured outputs (prompt-and-parse):
- "respond only in JSON" in the system prompt
- Works 95% of the time
- 5% of the time, downstream chains crash or get garbage
- Debug: hours per failure mode (every variant of malformed output looks unique)

With structured outputs (provider-enforced schema):
- Pass a Zod or JSON Schema to the provider as a tool definition
- Provider constrains generation to fit the schema OR errors
- Parse always succeeds OR you catch a typed error
- Add `validate.ts` for runtime Zod check (defence in depth — schema enforcement plus contract validation)

### Move 5 — The one-line summary

Free-text output is unsafe; use the provider's structured-output API (tool calling or JSON mode) plus a Zod validator on the parsed result — the schema is the contract, not the prompt.

---

## How it works

### Move 1 — The mental model

```
   ┌────────────────────────────────────────────────────┐
   │ Schema (Zod / JSON Schema / tool definition)       │
   │   { intent: "todo" | "question" | "vent",          │
   │     confidence: number,                            │
   │     tags: string[] }                               │
   └─────────────────────────────┬──────────────────────┘
                                 │  passed to provider
                                 ▼
   ┌────────────────────────────────────────────────────┐
   │ Provider constrains generation to match the schema │
   └─────────────────────────────┬──────────────────────┘
                                 │
                                 ▼
   ┌────────────────────────────────────────────────────┐
   │ Parsed output — typed at runtime, valid by         │
   │ construction (your code: Zod re-validates as       │
   │ defence in depth)                                  │
   └────────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — three ways providers enforce schemas.** Anthropic's tool calling: define a tool with input schema; the model's output is constrained to match. OpenAI's JSON mode: pass `response_format: { type: "json_object" }` for unstructured JSON, or `{ type: "json_schema", schema: {...} }` for typed JSON. Both are stronger than prompt-only ("respond in JSON") because they constrain the model at the token-generation level.

```
   Three levels of "JSON output" safety
   ────────────────────────────────────
   1. Prompt-only  ("respond only in JSON")     →  fails ~5% in production
   2. JSON mode    (provider syntax-constrains) →  fails on edge schemas
   3. Schema mode  (provider type-constrains)   →  fails only on infra errors
```

If you're coming from frontend, this is the same shape as TypeScript types: prompt-only is a runtime comment ("the docs say it returns a User"), JSON-mode is a JSDoc annotation (parses but no type check), schema-mode is a real TypeScript type with a compile-time check.

**Layer 2 — why you still validate after.** Even provider-enforced schemas can occasionally produce surprises — schema constraints with `oneOf` or recursive shapes sometimes confuse the model; provider bugs do happen. A Zod re-validate on the parsed JSON catches the rare drift. In buffr, `validate.ts` re-validates every chain output before returning to the orchestrator — if the chain returns a malformed result, `validate.ts` throws a `ChainValidationError` that the orchestrator handles uniformly (logs, falls back to cached if available, returns a typed error to the UI).

```
   buffr's defence-in-depth pattern
   ────────────────────────────────
   chain call → provider tool-call → JSON output
                                          │
                                          ▼
                                   parse + Zod check
                                   (validate.ts)
                                          │
                                  ┌───────┴────────┐
                                  │                │
                                  ▼                ▼
                               valid           ChainValidationError
                                  │                │
                                  ▼                ▼
                          orchestrator        cached fallback or
                          consumes typed       typed error in UI
                          result
```

**Layer 3 — markdown is its own case.** The `interpret` chain returns markdown, not JSON. There's no schema to enforce. Validation is length-based (non-empty, under a max) and content-based (no `<script>` tags, no obvious prompt-injection markers). The output mode mismatch with the other 4 chains is intentional and contained — `interpret` doesn't feed any downstream chain.

```
   buffr's 5 chains by output mode
   ───────────────────────────────
   summarize  →  JSON (Zod schema)         tool-call enforced
   caption    →  JSON (4-keyed object)     tool-call enforced
   expand     →  JSON (type-varied schema) tool-call enforced
   classify   →  JSON (enum-constrained)   tool-call enforced
   interpret  →  markdown                  length + content checks
```

### Move 3 — The principle

Schema-first prompting plus parser-fail validation is the production discipline. The prompt asks for the output shape; the API enforces it; the validator catches drift. Three layers because each one catches a different bug class.

The full picture is below.

---

## Structured outputs — diagram

```
┌─ Build phase ──────────────────────────────────────────────────────────┐
│                                                                        │
│   Zod schema definition (src/types/ai.ts)                              │
│         │                                                              │
│         ▼                                                              │
│   convert to JSON Schema or Anthropic tool definition                  │
│                                                                        │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │  build-time
                                 ▼
┌─ Call phase ───────────────────────────────────────────────────────────┐
│                                                                        │
│   chain.ts builds messages + tool definition                           │
│         │                                                              │
│         ▼                                                              │
│   provider.messages.create({ tools, tool_choice })                     │
│         │                                                              │
│         ▼                                                              │
│   response.content[0].input  (JSON, constrained by schema)             │
│         │                                                              │
│         ▼                                                              │
│   validate.ts: Zod.safeParse(input)                                    │
│         │                                                              │
│    ┌────┴─────┐                                                        │
│    │          │                                                        │
│    ▼          ▼                                                        │
│  typed     ChainValidationError                                        │
│  result    (caught in compose.ts; fallback to cached)                  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A — every JSON-output chain uses Anthropic tool calling + Zod validation.**

**Files:**
- `src/types/ai.ts` — Zod schemas for every chain's output (`AISummarySchema`, `CaptionVariantsSchema`, `ExpandedTodoSchema`, etc.)
- `src/services/ai/summarize.ts` (~L70–L120) — builds the tool definition from `AISummarySchema`, sends with `tool_choice: { type: "tool", name: "emit_summary" }`
- `src/services/ai/caption.ts` (~L80–L130) — same pattern with `emit_caption_variants` tool
- `src/services/ai/expand.ts` (~L75–L125) — variant: schema switched by `type` parameter (4 distinct schemas)
- `src/services/ai/classify.ts` (~L50–L80) — enum-constrained `type` field plus confidence
- `src/services/ai/validate.ts` — single entry point: `validateAISummary`, `validateCaptions`, etc. — Zod safeParse with typed error class

For OpenAI provider path (when `config.ts` is toggled to `openai`), each chain falls back to `response_format: { type: "json_schema", schema: ... }` — same Zod schema converted to JSON Schema at build time.

---

## Elaborate

### Where this pattern comes from

Tool calling was introduced by OpenAI in 2023 (`function_calling`); Anthropic followed in late 2023 with structured tool use. JSON Schema enforcement at the API level became the production default by mid-2024. Earlier "respond in JSON" prompting is still in many older codebases; it's the marker of pre-2024 production prompt engineering.

### The deeper principle

Type contracts at function boundaries are non-negotiable; that includes the LLM-API boundary. The provider's structured-output API is the closest thing to a `as User` cast that the LLM gives you, and like any cast it deserves a runtime check.

### Where this breaks down

For very simple outputs (a single number, a single label), prompt-only with strict regex parsing is sometimes fine — the overhead of defining a schema isn't worth it. For complex nested outputs with optional fields and unions, schema-mode is the only safe path. The middle ground (small objects with 2-3 fields) is where engineers cut corners and regret it.

### What to explore next

- [03-sampling-parameters](./03-sampling-parameters.md) — schema-enforced outputs are robust to temperature, but high temperature still occasionally produces edge cases the schema lets through
- [`05-evals-and-observability/02-eval-methods`](../05-evals-and-observability/02-eval-methods.md) — schema enforces shape; evals check content quality
- [`02-context-and-prompts/03-prompt-chaining`](../02-context-and-prompts/03-prompt-chaining.md) — chained chains exchange typed objects; the schema is the inter-chain contract

---

## Tradeoffs

```
┌──────────────────┬────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Schema-enforced            │ Prompt-only "respond in JSON"│
├──────────────────┼────────────────────────────┼─────────────────────────────┤
│ Setup            │ Define schema once         │ "respond in JSON" in prompt │
│ Failure rate     │ <1%                        │ ~5%                          │
│ Provider lock-in │ Tool-call API differs by   │ Universal                    │
│                  │ provider (abstract behind  │                              │
│                  │ chain functions)           │                              │
│ Output speed     │ Identical                  │ Identical                    │
│ Cost per call    │ Identical                  │ Identical                    │
└──────────────────┴────────────────────────────┴─────────────────────────────┘
```

### The breakpoint

Use schema-enforced outputs for any chain whose output is consumed by code (parsed, stored in DB, fed to another chain). Use prompt-only output for one-off scripts and exploratory prompts where you read the result yourself. There is no middle ground for production.

---

## Tech reference (industry pairing)

### Zod (TypeScript schema validation)

- **Codebase uses:** `zod` v3.x. Schemas defined in `src/types/ai.ts`. Validated in `src/services/ai/validate.ts`.
- **Why it's here:** single source of truth for both the static TypeScript type and the runtime validator. Convertible to JSON Schema for OpenAI; mappable to Anthropic tool definitions.
- **Leading today:** Zod 3 for TS-first codebases.
- **Why it leads:** small API surface, excellent error messages, no codegen step.

### Anthropic tool calling

- **Codebase uses:** `tool_choice: { type: "tool", name: "..." }` in every chain's `messages.create()` call.
- **Why it's here:** Anthropic's schema-enforcement primitive. Forces the model to call the specified tool with input matching its schema.
- **Leading today:** Sonnet 4.6 and Haiku 4.5 both support tool calling reliably.
- **Runner-up:** OpenAI's `response_format: { type: "json_schema" }` (used when `config.ts` is `openai`).

---

## Project exercises

### B1.1 — Add Zod schemas for every chain's I/O

- **Exercise ID:** `B1.1`
- **What to build:** audit `src/types/ai.ts` and add Zod schemas for any chain I/O that's still loosely typed. Make `validate.ts` the single entry point for all chain output validation (any chain that bypasses validate.ts is a smell). Document the schema-as-contract pattern in `docs/spec.md`.
- **Why it earns its place:** the schema is the contract; an undocumented or partial schema is a contract loophole.
- **Files to touch:** `src/types/ai.ts`, `src/services/ai/validate.ts`, each chain file, `docs/spec.md`.
- **Done when:** every chain output passes through validate.ts; every chain input has a Zod schema; the spec doc describes the pattern.
- **Estimated effort:** 3 hours.

---

## Summary

### Part 1 — concept recap

Free-text LLM output is unsafe to consume; "respond in JSON" prompting fails ~5% of the time in production. The production discipline is schema-enforced output at the provider API (Anthropic tool calling, OpenAI JSON mode) plus a Zod runtime check on the parsed result. Buffr's 4 JSON chains all use Anthropic tool calling + `validate.ts` for defence-in-depth; the 5th chain (`interpret`) returns markdown by design, with length and content checks instead of a schema.

### Part 2 — key points to remember

- Free-text output is unsafe; schema-enforced output is the production default.
- Three layers: schema (definition) → provider enforcement → Zod re-validation.
- Provider tool-calling / JSON-mode APIs constrain at the token level, not just the prompt level.
- Markdown outputs need their own validation shape (length, content), not a JSON schema.
- Any chain output that's consumed by code needs a schema.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you parse LLM output," they're checking whether you've been burned. Engineers who say "JSON.parse with a try/catch" haven't shipped at scale; engineers who say "tool-calling + Zod re-validate" have.

### Likely questions

**Q [mid]:** Why isn't "respond only in JSON" in the system prompt enough?

**A:** Because the model occasionally decides to be courteous — wraps JSON in markdown fences, adds a "Here's the result:" preamble, includes trailing commas. The failure rate is ~5% in production. Provider tool-calling APIs constrain output at the token-generation level — the model is forced to produce tokens that fit the schema or the call errors. In buffr, every JSON chain uses Anthropic's tool calling (or OpenAI's JSON-schema mode when the provider toggle is `openai`). The prompt asks for the shape; the API enforces it; `validate.ts` re-checks at runtime.

**Q [senior]:** Why do you still re-validate with Zod after the provider enforces the schema?

**A:** Defence in depth. Provider enforcement is strong but not perfect — edge schemas (deep unions, recursive types, oneOf with discriminators) sometimes produce drift. Provider bugs happen. The Zod re-validate at `validate.ts` catches the rare miss before it reaches the orchestrator. The cost is one parse-and-check per call, milliseconds. The payoff is that downstream code can rely on the typed result without defensive checks. The validator also gives me typed error messages that I can route uniformly through the orchestrator (cached fallback, UI error state).

```
   Three layers, three bug classes caught
   ──────────────────────────────────────
   schema definition (Zod)          →  catches design bugs at write time
   provider enforcement (tool call) →  catches most generation drift
   runtime validation (validate.ts) →  catches edge-case drift + provider bugs
```

**Q [arch]:** When would you NOT use structured outputs?

**A:** When the output is genuinely free-form prose and consuming it as typed data would lose information. Buffr's `interpret` chain returns markdown — a reflective day-summary — that the user reads. Forcing it into `{ paragraphs: string[], sentiment: ... }` would lose the markdown's structure (lists, emphasis, line breaks) and add no value (no downstream chain consumes the parsed result). The output mode mismatch is intentional and contained: `interpret` is the only markdown chain, and nothing feeds from it.

### The question candidates always dodge

**Q:** What's a structured-output bug you actually shipped?

**A:** Early `expand` chain in buffr used `response_format: { type: "json_object" }` (OpenAI's loose JSON mode, before schema mode was available). The schema lived only in the prompt. On about 3% of calls, the model returned `{ "steps": [...] }` instead of the schema's `{ "items": [...] }`. Downstream parser silently fell back to an empty array; the UI showed "no expansion." I caught it by accident a week later when a user reported "the AI never expands anything for me" — turned out their inputs triggered the wrong-key path more often than typical. Fix: migrated to `response_format: { type: "json_schema", schema: ... }` (and the Anthropic equivalent). Schema mode caught the key drift at the API level.

### One-line anchors

- Schema-enforced output is the production default; prompt-only is pre-2024 hygiene.
- Three layers: schema → provider enforcement → Zod re-validate.
- Markdown is its own case — length + content checks, not a JSON schema.
- Any chain output consumed by code needs a schema.
- Defence in depth catches the rare drift the provider misses.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the three-layer structured-output flow: schema definition → provider enforcement → runtime validation, with a "caught here" label per layer.

### Level 2 — Explain it out loud

Explain in under 60 seconds why prompt-only "respond in JSON" fails ~5% of the time in production.

### Level 3 — Apply it to a new scenario

A new requirement: buffr should classify each todo into a difficulty score (1-5) plus a confidence (0-1). Sketch the Zod schema; explain how `validate.ts` would handle a chain output where the model produces `difficulty: 6` (out of schema bounds).

Reference: cross-check against `src/services/ai/validate.ts` and the existing classifier shape.

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should drop `validate.ts` because the provider's tool calling already enforces the schema; the runtime re-validate is redundant." Why or why not?

### Quick check — code reference test

Without opening files:
- Which file owns the Zod schema for the AISummary type?
- Which buffr chain doesn't use structured outputs?
- What error does `validate.ts` throw on schema mismatch?
