# Output mode mismatch

**Industry name(s):** Output mode mismatch, type drift, chain-boundary type error
**Type:** Industry standard · Language-agnostic

> Every chain has one output mode declared in its schema. The bug class is chain A returns JSON, chain B expects markdown, parser breaks. Catch it at the boundary, not downstream.

**See also:** → [02-structured-outputs](./02-structured-outputs.md) · → [06-single-purpose-chains](./06-single-purpose-chains.md) · → [07-output-mode-mismatch](./07-output-mode-mismatch.md)

---

## Why care

### Move 1 — The grounded scenario

You have a two-chain pipeline. Chain A summarises an entry; chain B uses that summary to generate a caption. Chain A used to return markdown; you migrated it to return structured JSON last month. Chain B's prompt still says "you will receive a markdown summary, generate a caption based on it." The summary now arrives as `{"text": "Today felt productive...", "mood": "energised"}`. Chain B interpolates the whole object as a string, sees `[object Object]` in some logs and `"{\"text\":\"Today...\"}"` in others, and the captions start sounding off in a way nobody can quite name.

### Move 2 — Name the question the pattern answers

That what-shape-is-this-actually question is what output mode mismatch catches. Not "is the prompt good," not "is the model working" — just *what type does this chain promise to return, what type does the next chain expect, and do they match*. The pattern is two halves: each chain explicitly declares its output mode (markdown, structured-JSON-with-schema, plain-text-classification-label) at the chain definition site; consumers validate at the boundary that the type they got is the type they expected.

### Move 3 — Why answering that question matters

**What breaks without it:** the failure is silent. The model is friendly enough to do *something* with any input — interpolate `[object Object]` into a caption prompt and you'll get a coherent-sounding but garbage-quality caption. Buffr's chains today each declare their output mode implicitly via the TypeScript return type (`Promise<AISummary>`, `Promise<Caption[]>`, `Promise<ThinkingMode>`, etc.). TypeScript catches mismatches at compile time when the consumer is also in TypeScript. The bug class lives in: dynamic interpolations, prompts that consume *another chain's output* as a string instead of as a typed value, and the day a chain's output shape changes and the consumer's prompt isn't updated alongside.

### Move 4 — Concrete before/after

Without explicit output mode tracking:
- Chain A's output type changes from `string` (markdown) to `{text: string, mood: Mood}` (structured)
- TypeScript catches the consumer call site that does `chainB(chainA(entry))` — type error
- But the consumer's PROMPT still says "you will receive markdown" — TypeScript can't see prompt strings
- Code path is fixed; prompt isn't
- Captions get worse silently

With explicit output mode tracking:
- Chain A's signature reads `summarize: AsyncChain<Entry, AISummary>` — mode is part of the type
- Consumer declares `caption: AsyncChain<{entry: Entry, summary: AISummary}, Caption[]>` — input shape is typed
- The PROMPT for caption is generated FROM the typed input (interpolation through a typed template), so a type change forces a prompt re-render
- Or: the prompt explicitly describes the input shape using the schema (the schema is single source of truth, the prompt references it by name)

### Move 5 — The one-line summary

Output mode mismatch is the LLM-pipeline equivalent of a TypeScript any-cast — works until it doesn't, fails silently when it doesn't, debuggable only by reading every chain's prompt to see what it expected.

---

## How it works

### Move 1 — The mental model

Every chain has three modes it can output in: structured (JSON conforming to a schema), markdown (free-form prose with markdown formatting), or scalar (a single typed value like a classification label or a number). The mode is part of the chain's identity — change it and every downstream consumer needs to know.

```
   chain output modes
   ──────────────────
   structured: { ... }       ◄── consumed by code that does .field access
   markdown:   "## ..."      ◄── consumed by code that renders to user as prose
   scalar:     "todo"        ◄── consumed by code that branches on the value
```

The bug class is consumers that treat a structured output as a markdown blob (interpolating an object into a prompt string) or that treat a markdown output as a structured value (regex-extracting a "field" from prose).

### Move 2 — The layered walkthrough

**Layer 1 — declare the output mode in the chain signature.** TypeScript return type is the first line of defense — `summarize: () => Promise<AISummary>` declares structured output; `interpret: () => Promise<string>` declares markdown (or untyped string). The next layer: name the mode explicitly in the chain's API surface so consumers can't ignore it.

```
   buffr's 5 chain return types
   ────────────────────────────
   summarize(date)           → Promise<AISummary>         (structured)
   caption(...)              → Promise<Caption[]>          (structured)
   expand(todo, type)        → Promise<ExpandedTodo>       (structured)
   classify(text)            → Promise<{type: ThinkingMode}>  (structured)
   interpret(text, framing)  → Promise<string>             (markdown)
```

If you're coming from frontend, this is the same as a hook's return type — `useUser()` returns `User`, `useNotifications()` returns `Notification[]`, the consumer can't accidentally treat one as the other because TypeScript enforces it. Concrete consequence: in buffr today, the type system enforces that `caption()`'s consumer doesn't accidentally render the structured `Caption[]` as a string — but it does NOT enforce that the *prompt for caption* correctly describes what it will receive.

**Layer 2 — when chain B's prompt mentions chain A's output, the mention must reference the schema.** This is where TypeScript stops protecting you. Chain B's prompt is a string; the string can say "you will receive a markdown summary" while the actual input is structured JSON, and TypeScript won't catch the lie. The fix: instead of describing the input shape in prose, reference the schema. Either inline (the prompt includes the JSON Schema definition) or by name (the prompt says "you will receive a `AISummary` object — see the schema attached"; the SDK call provides the schema as part of the request).

```
   prompt that lies                   prompt that references schema
   ───────────────                    ─────────────────────────────
   "You will receive a markdown       "You will receive an AISummary object
    summary of the day's entry.       (schema attached). Use its .text and
    Generate a caption based on it."  .mood fields to generate a caption."
                                      (the schema is in the tools/json_schema)
   ↓                                  ↓
   if input type changes:             if input type changes:
     prompt lies                       prompt + schema update together
     captions degrade silently         schema-fail forces the issue
```

If you're coming from frontend, this is the same as JSDoc/TSDoc on a function — describe types by reference to the type, not by re-describing the shape in prose. Boundary: this only works if the schema is the single source of truth. If you redefine the shape in the prompt's prose AND in the schema, they'll drift.

**Layer 3 — application-side type guards at every chain-to-chain boundary.** Even with declared types and schema-referenced prompts, the runtime crossing from "chain A's output" to "chain B's input" is where mismatches surface. A typed wrapper at the boundary catches them: `composeChainAB(input)` parses chain A's output with Zod, validates it matches chain B's input expectation, throws if not.

```
   chain A returns                    chain B expects
   ───────────────                    ───────────────
   { text, mood }                     { text, mood }
        │                                    ▲
        │                                    │
        └─── composeAB(aOutput) ─────────────┘
              type-guards at the boundary
              throws on mismatch
```

### Move 2.5 — Current state vs future state

Buffr today carries the output modes implicitly in TypeScript return types. The 5 chains don't compose into a single pipeline (each is called from different events — see [06-single-purpose-chains](./06-single-purpose-chains.md)), so there's no in-codebase chain-to-chain mismatch to worry about today. The hypothetical Phase B scenario where a chain's output feeds another chain's input (e.g., `summarize` output feeds a new `caption-from-summary` chain) is where this matters.

```
          Now (buffr)                          Later (if chained)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ 5 chains, each called from   │  │ pipeline:                         │
│ different events             │  │   summarize → captionFromSummary  │
│ no chain-to-chain mismatch   │  │ output mode mismatch becomes      │
│ TypeScript enforces consumer │  │ load-bearing                      │
│ types at app boundary        │  │                                   │
└──────────────────────────────┘  └──────────────────────────────────┘
   the bug class doesn't apply       the bug class becomes real
```

What doesn't have to change: the chain functions and their types stay the same. What changes when chains start feeding each other: explicit declaration of input/output modes plus runtime type guards at the boundaries.

### Move 3 — The principle

Type drift at chain boundaries is the LLM-pipeline analog of any-casting in TypeScript — works locally, fails at the boundary, debugs from neither end. The discipline of declaring modes and validating at boundaries is the same discipline as TypeScript's strict mode at module edges.

The full picture is below.

---

## Output mode mismatch — diagram

```
┌─ Chain A ──────────────────────────────────────────────────────────────┐
│  summarize(date) → Promise<AISummary>                                   │
│    mode: structured                                                     │
│    schema: AISummary                                                    │
└──────────────┬─────────────────────────────────────────────────────────┘
               │  aOutput: AISummary
               ▼
┌─ Boundary guard ───────────────────────────────────────────────────────┐
│  composeAtoB(aOutput):                                                  │
│    1. parse aOutput against expected schema (Zod or equivalent)         │
│    2. transform to chain B's input shape                                │
│    3. throw if shape doesn't match                                      │
└──────────────┬─────────────────────────────────────────────────────────┘
               │  bInput: validated shape
               ▼
┌─ Chain B ──────────────────────────────────────────────────────────────┐
│  captionFromSummary(bInput) → Promise<Caption[]>                        │
│    mode: structured                                                     │
│    prompt: references bInput's schema by name, not by prose description │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Buffr's 5 chains all declare typed return values:**

**File:** `src/services/ai/summarize.ts` · **Function:** `summarize(date): Promise<AISummary>` · **Line range:** L43–L188
**File:** `src/services/ai/caption.ts` · **Function:** `caption(...): Promise<Caption[]>` · **Line range:** L1–L223
**File:** `src/services/ai/expand.ts` · **Function:** `expandTodo(...): Promise<ExpandedTodo>` · **Line range:** L1–~L150
**File:** `src/services/ai/classify.ts` · **Function:** `classify(text): Promise<{type: ThinkingMode}>` · **Line range:** L1–L160
**File:** `src/services/ai/interpret.ts` · **Function:** `interpret(text, framing): Promise<string>` · **Line range:** L1–L149

The four JSON chains carry their shape via the TypeScript return type; the interpret chain carries it as a typed string (markdown). No chain consumes another chain's output today; the bug class is dormant in buffr.

---

## Elaborate

### Where this pattern comes from

The bug class is older than LLMs — it's the chain-of-responsibility / pipeline pattern's classic failure mode. Named for the LLM context around 2023 in early LangChain documentation; the structural fix (per-chain typed signatures + boundary validation) is borrowed from TypeScript / pipeline architectures in non-LLM software.

### The deeper principle

The chain boundary is the validation point. Whatever protections exist inside a chain (its own schema, its own prompt) don't propagate to the next chain unless an explicit handoff carries them.

### Where this breaks down

When chains are intentionally loosely coupled (e.g., a chain that returns "any structured output" as raw JSON for downstream agents to interpret), strict mode-tracking gets in the way. Use mode-tracking when the consumer knows exactly what shape to expect; skip when the consumer is itself an agent figuring out the shape at runtime.

### What to explore next

- [02-structured-outputs](./02-structured-outputs.md) — schema validation at the chain's own boundary; mode mismatch extends that to chain-to-chain boundaries.
- [06-single-purpose-chains](./06-single-purpose-chains.md) — when chains compose, the composition is where mode mismatch lives.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Explicit mode + guards    │ Implicit (relying on TS)  │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Setup            │ Boundary guard per        │ Zero                      │
│                  │ chain-to-chain hop        │                           │
│ Failure mode     │ Throws at boundary        │ Silent quality regression │
│ Refactor safety  │ Type change forces        │ Type change works locally,│
│                  │ prompt update             │ breaks consumer's prompt  │
│ Cognitive load   │ One mode-tracking         │ Type system protects code,│
│                  │ convention                │ not prompts               │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Explicit mode tracking costs you a boundary guard per chain-to-chain hop (typed wrapper, Zod parse, throw on mismatch). For buffr today the cost is zero because there are no chain-to-chain hops.

### What the alternative would have cost

Implicit tracking via TypeScript return types covers code-side mismatches. It does NOT cover prompt-side mismatches — the consumer's prompt describing the wrong shape. The cost lands as a silent quality regression that takes weeks to attribute.

### The breakpoint

Mode mismatch becomes load-bearing the moment two chains compose. Buffr is pre-breakpoint; the day a chain takes another chain's output as input, this concept activates.

---

## Tech reference (industry pairing)

### TypeScript return types as the first defense

- **Codebase uses:** every chain in `src/services/ai/` has a typed `Promise<T>` return. TS catches the consumer-side mismatch at compile time.
- **Why it's here:** the cheap version of mode tracking. Free with TypeScript.
- **Leading today:** TypeScript — `adoption-leading` for static typing in JS/TS codebases, 2026.
- **Why it leads:** ubiquitous, free, catches the code-side mismatch automatically.
- **Runner-up:** Python type hints + `mypy --strict` for Python codebases; same shape, different ecosystem.

### Zod (runtime boundary validation)

- **Codebase uses:** Not used in buffr today. Closest thing is `validateAISummary` in `src/services/ai/validate.ts`.
- **Why it's here:** the runtime check that TypeScript can't provide. Without it, mode mismatches at runtime (e.g., model returns wrong shape despite the schema) surface as TypeError downstream.
- **Leading today:** Zod — `adoption-leading` for TypeScript runtime validation, 2026.
- **Why it leads:** schema + type inference in one declaration.
- **Runner-up:** Valibot, ArkType.

---

## Project exercises

### B3.14 — Document each chain's output mode explicitly

- **Exercise ID:** `[B3.14]`
- **What to build:** in `docs/spec.md` (or `docs/ai-chains.md` from [B3.13](./06-single-purpose-chains.md)), add an "Output mode" column to the chain inventory: structured / markdown / scalar. For structured chains, name the schema.
- **Why it earns its place:** sets the convention before chain-to-chain composition lands. Without it, the first composition is a 30-minute archaeology session through the chain files.
- **Files to touch:** `docs/spec.md` or `docs/ai-chains.md`.
- **Done when:** chain inventory table has Output-mode column for all 5 chains.
- **Estimated effort:** <1hr.

---

## Summary

### Part 1 — concept recap

Output mode mismatch is the bug class where chain A returns one shape and chain B's prompt or code expects another, surfacing as silent quality regression rather than a typed error. Buffr's 5 chains each declare typed return values so TypeScript catches the code-side mismatch; the prompt-side mismatch (when a chain's prompt describes the wrong input shape) is dormant because no buffr chain consumes another chain's output today. The constraint forcing this concept activates the moment a pipeline of chains lands. The cost being paid for the current shape is zero — buffr doesn't have chain composition.

### Part 2 — key points to remember

- Every chain declares one output mode: structured, markdown, or scalar.
- TypeScript catches code-side mismatches; it does NOT catch prompt-side mismatches.
- When chain B's prompt mentions chain A's output, reference the schema by name, don't re-describe the shape in prose.
- Runtime guards at chain-to-chain boundaries catch the residual cases TypeScript can't.
- The bug class is dormant in buffr today; it activates the moment any chain consumes another's output.

---

## Interview defense

### What an interviewer is really asking

The interviewer wants to know if you've shipped a pipelined LLM workflow and watched it regress silently. The answer that names "the prompt describing the wrong shape" as the failure mode is the answer of someone who has been there.

### Likely questions

**Q [mid]:** How do you stop chain A and chain B from disagreeing about the data shape?

**A:** Three layers. TypeScript return types catch code-side mismatches at compile time. Schema-referenced prompts catch the prompt-side: chain B's prompt says "you will receive an `AISummary` (schema attached)" instead of "you will receive a markdown summary." Runtime Zod guards at the chain-to-chain boundary catch the residual cases where the model's output doesn't match the schema despite enforcement. The three layers are defense in depth; skipping any one leaves a class of mismatches uncovered.

```
   layer                   catches                       where buffr has it
   ───────                 ──────────                    ──────────────────
   TS return types         code-side mismatch            yes (all 5 chains)
   schema-ref prompts      prompt-side mismatch          no (no composition yet)
   runtime Zod guard       model-emits-wrong-shape       partial (validate.ts)
```

**Q [senior]:** Buffr doesn't have chain-to-chain composition. Why is this concept in the guide?

**A:** Because the bug class activates the moment composition lands, and the right time to learn about it is BEFORE the first composition, not after the first silent regression. Naming the concept now means when the first pipelined chain ships (Phase B scenario, e.g., `summarize → captionFromSummary`), the discipline is already in the team's vocabulary. Without it, the first pipeline ships without a boundary guard and the first silent regression takes a week to diagnose.

### The question candidates always dodge

**Q:** Why isn't TypeScript enough? Strict mode catches type mismatches at compile time.

**A:** TypeScript checks code. It does not check the *prompts that consume the data*. If chain A returns `AISummary` (structured) and chain B's call signature accepts `AISummary` (TS happy), and chain B's prompt is a template literal that interpolates `summary` into a string saying "Given the following markdown summary: ${summary}...", the TypeScript check passes and the prompt is wrong. The interpolation turns the structured object into `[object Object]` or `"{\"text\":\"...\"}"` and the model does something with whichever shape it received. TypeScript catches the call-site; prompts are strings the type system can't read.

### One-line anchors

- Every chain declares one output mode.
- TypeScript catches code-side; not prompt-side.
- Schema-referenced prompts beat shape-described-in-prose prompts.
- The bug class activates at the first chain-to-chain composition.
- Defense in depth: TS types + schema-ref prompts + runtime guards.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the three-layer flow: Chain A (with its output mode + schema), Boundary guard (parse + validate + transform), Chain B (with its input schema reference).

### Level 2 — Explain it out loud

Explain output mode mismatch under 90 seconds.

Checkpoints — did you:
- Name the three modes (structured / markdown / scalar)?
- Name where TypeScript stops protecting you (prompt strings)?
- Name the boundary guard as the runtime check?

### Level 3 — Apply it to a new scenario

A new chain lands in buffr: `tomorrowsPrompts(yesterdaySummary: AISummary) → Promise<string[]>` — generates three suggested journal topics. The chain's prompt currently says "you will receive yesterday's summary as a markdown block."

What's the mismatch? How do you fix it (both the code and the prompt)? Sketch in 3-5 sentences.

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr doesn't need explicit output-mode tracking today; the discipline can wait until the first chain-to-chain pipeline lands."

### Quick check — code reference test

Without opening files:
- Which buffr chain returns markdown (not structured)?
- Where are the structured chains' return types declared?
- Does buffr have any chain-to-chain compositions today?
