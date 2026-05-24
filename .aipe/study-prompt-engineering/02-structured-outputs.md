# Structured outputs via tool calling and schemas

**Industry name(s):** Structured outputs, JSON mode, tool calling, function calling, schema-constrained generation
**Type:** Industry standard · Language-agnostic

> Declare a schema, let the provider enforce it, validate the parse at the boundary, retry with a stricter system prompt on schema fail. "Respond only in JSON" inside the prompt text is not how this is done in 2026.

**See also:** → [01-anatomy](./01-anatomy.md) · → [07-output-mode-mismatch](./07-output-mode-mismatch.md) · → [05-eval-driven-iteration](./05-eval-driven-iteration.md)

---

## Why care

### Move 1 — The grounded scenario

You have a `fetch()` returning what should be a JSON object. The endpoint is "respond with `{type: 'todo' | 'idea' | ...}`." Your code does `JSON.parse(response)` and pulls `.type`. Most calls succeed. Roughly 1 in 200 fails — `JSON.parse` throws because the response is ``` ```json\n{"type": "todo"}\n``` ```. The model wrapped its perfectly-correct JSON in a markdown code fence because it was being polite. Your parser doesn't know about markdown, so the chain explodes. You add `.replace(/```json|```/g, '').trim()` and ship the fix. Two weeks later a different chain fails — same root cause, different parser file.

### Move 2 — Name the question the pattern answers

That parse-or-die question is what structured outputs answer. Not "how do I ask for JSON nicely," not "how do I prompt-engineer the model into compliance" — just *how do I get the model to emit data my code can consume, and what do I do when it doesn't.* The answer is two things together: a provider-enforced schema at the SDK boundary (so the model is structurally prevented from emitting code-fence-wrapped JSON), plus a validate-and-retry loop in your application code (so when something still slips through, you catch it and retry with a stricter prompt instead of crashing).

### Move 3 — Why answering that question matters

**What breaks without it:** every chain in buffr that returns typed data — `classify` returns `{type: ThinkingMode}`, `summarize` returns the structured `AISummary` shape, `expand` returns a typed expansion schema per mode — silently relies on the model being courteous about JSON formatting. The day the provider ships a new model version that's been RLHF'd to use markdown fences more liberally, every one of those chains regresses. I've shipped six production features that depend on structured output. Every one of them broke at least once because someone added "and please be concise" or "and use markdown formatting" to a prompt that was relying on schema mode. The model started returning schema-conformant JSON inside a markdown code fence as a courtesy. Parser broke. Here's what I do now.

### Move 4 — Concrete before/after

Without structured outputs (prompt asks for JSON, parser hopes for the best):
- Chain ships, succeeds 99.5% of the time in eval
- Production launch — 0.5% × ~10k calls/day = 50 parser failures/day silently logged
- Three months later, model upgrade — fence rate jumps to 8%
- 800 failures/day, all silent, surfaces as "the AI feature is broken for some users"
- Hotfix: regex to strip fences, ships in 2 hours, technical debt forever

With structured outputs (schema declared in SDK call, parser validated, retry on fail):
- Chain declares its output schema at the SDK call site (`tools: [{name, schema}]` on Anthropic; `response_format: { type: 'json_schema', json_schema }` on OpenAI)
- Provider enforces — no code fence possible, no extra prose, no missing field
- Application code parses the typed result, validates with Zod at the boundary
- On schema fail (rare but possible — provider bugs exist): one retry with `instruction: 'previous output failed schema validation; emit only the schema'`
- Log schema-fail rate to metrics; alert if it crosses 0.1%

### Move 5 — The one-line summary

Structured outputs are TypeScript's compiler check, but for LLM responses — declare the shape, let the toolchain enforce it, fail loudly when something doesn't match.

---

## How it works

### Move 1 — The mental model

The schema lives in the SDK call alongside the prompt, not inside the prompt text. The provider's serving layer parses it and constrains the model's token generation to only produce tokens that yield valid output under the schema. Your code receives a `result` object with a typed field; you validate it once at the application boundary and then trust the type for the rest of the call site.

```
   prompt + schema
   ┌──────────────────────────────┐
   │ messages: [system, user]     │
   │ tools: [{ name, schema }]    │   ◄── schema lives HERE,
   │                              │       not in prompt text
   └──────────┬───────────────────┘
              │  provider-side: constrained generation
              ▼
   ┌──────────────────────────────┐
   │ result.tool_calls[0].input   │   ◄── already-parsed object
   │   { type: 'todo' }           │       matching the schema
   └──────────────────────────────┘
              │  app-side: Zod validate at boundary
              ▼
   ┌──────────────────────────────┐
   │ const { type } = parsed;     │
   └──────────────────────────────┘
```

The boundary between "provider promises schema conformance" and "application trusts the shape" is one Zod parse. Everything inside that boundary is typed; everything outside is `unknown`.

### Move 2 — The layered walkthrough

**Layer 1 — declare the schema in the SDK call.** On Anthropic, this is a `tools` array on `messages.create()` — each tool has a name, a description, and an input schema. The model is instructed (by the SDK, not by you) to "respond by calling one of these tools." On OpenAI, it's `response_format: { type: 'json_schema', json_schema: { strict: true, schema: {…} } }` — strict mode is the recent (2024) addition that gives provider-side enforcement; without `strict: true` it's a hint, with it it's a guarantee. On Google's Gemini, it's `responseSchema` on the generation config. Same idea, three flavours.

```
   Anthropic tool call shape           OpenAI json_schema response_format
   ┌─────────────────────────────┐    ┌──────────────────────────────────┐
   │ tools: [{                   │    │ response_format: {                │
   │   name: 'classify',         │    │   type: 'json_schema',            │
   │   description: '...',       │    │   json_schema: {                  │
   │   input_schema: {           │    │     name: 'classify',             │
   │     type: 'object',         │    │     strict: true,                 │
   │     properties: { ... },    │    │     schema: { type: 'object', ...}│
   │     required: ['type']      │    │   }                               │
   │   }                         │    │ }                                 │
   │ }],                         │    │                                   │
   │ tool_choice: { type: 'any'} │    │                                   │
   └─────────────────────────────┘    └──────────────────────────────────┘
```

If you're coming from frontend, think of this as defining a Zod schema and passing it to a typed `fetch` wrapper — the schema declaration is data the wrapper consumes to enforce the response shape. Concrete consequence: the model literally cannot emit `"todo"` as a raw string when the schema says `{type: 'todo'}` — the provider's sampler is constrained to only produce tokens that keep the JSON parse valid.

**Layer 2 — application-side validation with a runtime parser.** The provider's schema enforcement is strong but not infallible. Strict-mode failures still happen (provider bugs; edge cases with deeply nested schemas; the schema and the prompt disagreeing in subtle ways). The defense is a Zod (TypeScript), Pydantic (Python), or equivalent parse at the application boundary:

```
   raw response
        │
        ▼  JSON.parse (with try/catch — the 0.01% case)
   parsed: unknown
        │
        ▼  ClassifyOutputSchema.parse(parsed)   ← Zod
   typed: { type: ThinkingMode }
        │
        ▼  use confidently downstream
```

If you're coming from frontend, this is the same shape as runtime input validation on a form: `useForm` enforces shape at the API level; `zodResolver` enforces shape at the application level; both are defense-in-depth. Boundary: don't skip the Zod parse just because the provider promised the schema. The day the provider has an outage and falls back to a degraded model, the schema-enforcement guarantee weakens; your Zod parse is what surfaces the failure as a typed exception instead of a downstream `TypeError`.

**Layer 3 — retry-on-schema-fail with a stricter system prompt.** When the provider's schema enforcement does fail (rare), the application catches the Zod throw and retries the call with one added instruction: "your previous output failed schema validation. Emit only the JSON schema specified; do not wrap in markdown; do not add explanation." This is the production-vs-demo split: a demo handles the happy path; production has a retry policy.

```
   attempt 1: schema fail (e.g., 0.05% of calls)
        │
        ▼  catch Zod throw
   attempt 2: same prompt + "STRICT: emit only the schema, no prose, no code fences"
        │
        ▼  most retries succeed (~95% of fails)
        ▼  remaining 5% — log + alert + fall back to heuristic
```

Boundary: don't infinite-retry. Max two attempts. If both fail, fall back to whatever your chain's non-LLM path is (heuristic classifier, default value, surface to user). A retry loop that retries forever turns a 0.01% failure into a runaway cost incident.

### Move 2.5 — Current state vs future state

In buffr today, the 5 chains use a mixture of approaches. `classify` and the JSON-emitting chains (`summarize`, `caption`, `expand`) ask for JSON in the prompt text and `JSON.parse` the response — no provider-side schema enforcement, no Zod validation, no retry. `interpret` is markdown-out by design (no schema at all). The chain that would benefit most from strict structured outputs is `summarize`, where the typed `AISummary` shape is consumed by editor code that assumes its fields exist.

```
          Now (buffr)                         Later (refactored)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ summarize.ts                 │  │ summarize.ts                     │
│   prompt: "respond as JSON…" │  │   tools: [{ name, input_schema }]│ ←
│   const text = await call()  │  │   const { input } = result       │
│   const json = JSON.parse(t) │  │   const typed =                  │ ←
│   return json as AISummary   │  │     AISummarySchema.parse(input) │
│                              │  │   if (parse fails) retry strict  │ ←
│                              │  │   return typed                   │
└──────────────────────────────┘  └──────────────────────────────────┘
   schema implied in prompt           schema enforced + validated
   parser hopes for the best          retry on fail
```

The schema definition (the `AISummary` TypeScript type + the implicit JSON shape) didn't have to change between phases — what changes is *where* the shape is enforced. Today: in the prompt's words. Future: in the SDK call's structured-output config.

### Move 3 — The principle

Structured outputs aren't a feature you bolt on for typed safety — they're the application of "fail at the boundary, not downstream" to LLM responses. The same principle every typed system honours: validate when the data crosses from untrusted (model output) to trusted (your code), and from then on, the type system carries the weight. Prompts that ask politely for JSON are the LLM-era equivalent of accepting unvalidated request bodies and hoping for the best.

The full picture is below.

---

## Structured outputs — diagram

```
┌─ App layer ─────────────────────────────────────────────────────────────┐
│  Caller                                                                  │
│    │                                                                     │
│    ▼  classify(todoText)                                                 │
│  classify chain                                                          │
│    │                                                                     │
└────┼─────────────────────────────────────────────────────────────────────┘
     │
     ▼  schema + prompt in SDK call
┌─ Provider boundary ─────────────────────────────────────────────────────┐
│  Anthropic / OpenAI / Google                                             │
│    constrained generation                                                │
│    enforces schema at token-sampling layer                               │
│    returns {tool_calls[0].input} or {response_format-validated obj}      │
└────┼─────────────────────────────────────────────────────────────────────┘
     │
     ▼  parsed object (already JSON, already schema-conformant)
┌─ Validation boundary ───────────────────────────────────────────────────┐
│  ClassifyOutputSchema.parse(input)        ← Zod / Pydantic               │
│    happy path: typed result                                              │
│    schema fail: throw                                                    │
└────┼─────────────────────────────────────────────────────────────────────┘
     │
     ├─ happy path ──▶ return typed result
     │
     ▼  schema fail path
┌─ Retry layer ───────────────────────────────────────────────────────────┐
│  attempt 2: same prompt + "STRICT: emit only schema"                     │
│  attempt 3+: NONE — fall back to heuristic or default                    │
│  log schema-fail rate                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**File:** `src/services/ai/summarize.ts`
**Function / class:** `summarize(date)`
**Line range:** L43–L188 — prompt asks for JSON in text, response is `JSON.parse`'d directly, no schema in SDK call, no Zod, no retry

**File:** `src/services/ai/classify.ts`
**Function / class:** `classify(todoText)`
**Line range:** L1–L160 — same shape; `response_format: { type: 'json_object' }` is set on the OpenAI branch (weak enforcement), nothing on the Anthropic branch

**File:** `src/services/ai/validate.ts`
**Function / class:** `validateAISummary(json: unknown): AISummary`
**Line range:** L1–L137 — manual validator (not Zod). Closest thing buffr has to a parse-at-boundary; runs after `JSON.parse` on the summarize chain's output. Throws on shape mismatch.

The pattern is incomplete: `summarize` has the boundary validator but no schema in the SDK call and no retry. `classify` has neither. `interpret` is markdown-out so the question doesn't apply.

---

## Elaborate

### Where this pattern comes from

OpenAI shipped JSON mode (response_format: 'json_object') in late 2023; it constrained the response to *be* valid JSON but didn't enforce a schema. Strict-mode `json_schema` shipped in August 2024 — that's when the provider-enforced-schema story actually worked. Anthropic's tool calling has carried strict schemas from launch (early 2024); it was always the cleaner shape. The pattern of "schema in SDK call + Zod at boundary + retry on fail" is what production engineers converged on across the 2024–2025 window, after enough JSON-fence bugs and prompt-only-JSON regressions.

### The deeper principle

Validate at the boundary, trust the type system afterward. Same principle as Postgres CHECK constraints, TypeScript at the API edge, form validators with Zod resolvers. The model is an untrusted producer; the schema is the contract; the parse is the enforcement; everything downstream gets to act as if the shape is real.

### Where this breaks down

Open-ended generation (`interpret` in buffr — long-form markdown reflection) has no shape to constrain. Tightly constrained schemas can lower output quality for creative tasks because the sampler is biased toward token sequences that keep the schema valid, even when the freer phrasing would have been better. Use structured outputs when the consumer is code; skip them when the consumer is a human reading prose.

### What to explore next

- [05-eval-driven-iteration](./05-eval-driven-iteration.md) — schema-fail rate is one of the first metrics to put on the dashboard. Tracking it is how you catch provider regressions before users do.
- [07-output-mode-mismatch](./07-output-mode-mismatch.md) — when chain A returns structured output and chain B expects markdown, this is the pattern that catches it at the validation boundary.
- [13-forbidden-patterns](./13-forbidden-patterns.md) — schema-enforced outputs eliminate one entire class of forbidden patterns (no need to say "don't start with 'As an AI'" if the schema doesn't have a free-text field).

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Structured outputs        │ Prompt asks for JSON      │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Setup cost       │ Schema declaration per    │ Zero — one prompt line    │
│                  │ chain (~20 lines)         │                           │
│ Failure mode     │ Loud (Zod throw at        │ Silent (parse-and-pray;   │
│                  │ boundary)                 │ fences hide in prod)      │
│ Model-bump risk  │ Schema enforcement holds  │ New model's prose habits  │
│                  │ across versions           │ break the parser          │
│ Output quality   │ Constrained sampling      │ Free generation           │
│                  │ (slight cost on creative) │                           │
│ Retry strategy   │ Stricter prompt on fail   │ Regex-and-pray; manual    │
│                  │ + bounded attempts        │ hotfixes per failure mode │
│ Provider lock-in │ Schema syntax differs     │ Plain text — portable     │
│                  │ per provider (medium)     │ (low)                     │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Setting up structured outputs costs you the schema declaration per chain — for buffr's `summarize` chain, that's roughly 60 lines of JSON Schema describing the `AISummary` shape (the structured summary + the 4 variant captions + their theme). Once written, the schema lives next to the prompt; every chain change re-validates against it. On the OpenAI branch you eat slightly higher first-token latency in strict mode because the provider is constraining the sampler. On Anthropic, the tool-calling shape requires `tool_choice: { type: 'any' }` (or naming the specific tool) and the response comes back in `result.content[].type === 'tool_use'` — a navigation cost the first time you write it.

### What the alternative would have cost

The "prompt asks for JSON, parser hopes" approach (buffr's current shape) has zero setup cost. The cost lands as silent failures in production — every model version bump risks 10x'ing your parse-failure rate, and each new failure mode (markdown fences, leading prose, trailing prose, unicode quote characters) requires a separate regex hotfix. By the time you've shipped four such hotfixes, you've spent more engineering time than the schema declaration would have cost in the first place, AND you have technical debt in the form of "the parse-cleanup pipeline" that nobody understands end-to-end.

### The breakpoint

Fine when the consumer of the output is a human (markdown reflection, free-form prose). Not fine the moment another code path consumes the output and assumes structure — at that point a schema-fail in production becomes either a `TypeError` upstream or, worse, a silent missing-field that the consumer treats as the default. The breakpoint is "is any code path going to do `.fieldName` on this?" If yes, schema. If no, JSON-mode-or-prose is fine.

### What wasn't actually a tradeoff

"Just use a more permissive parser." A parser that handles markdown-fence-wrapped JSON, leading prose, trailing apologies, smart quotes, and all the other failure modes is essentially re-implementing JSON.parse with model-specific patches. The cost of maintaining it scales with the number of model behaviours you've encountered, and there's no end to that list. Schema enforcement at the provider sidesteps the whole class of problems.

---

## Tech reference (industry pairing)

### Anthropic tool calling

- **Codebase uses:** Not used in buffr today. The 5 chains use `messages.create()` without `tools`; structured output is via "respond in JSON" prompt instructions.
- **Why it's here:** would be the natural fit for `summarize`, `classify`, `caption`, `expand` — anywhere typed output is consumed by code.
- **Leading today:** Anthropic tool calling with strict input schemas — `adoption-leading`, 2026.
- **Why it leads:** has been strict from launch; schema enforcement is at the sampling layer; tool-choice modes (`auto`, `any`, named tool) give precise control over when the model can choose to emit prose vs structured output.
- **Runner-up:** OpenAI strict `json_schema` mode — equally strong since 2024-08; slightly different shape (`response_format` instead of `tools`) but identical enforcement.

### Zod (TypeScript runtime validation)

- **Codebase uses:** Not used in buffr today. The closest thing is `validateAISummary()` in `src/services/ai/validate.ts` — a hand-written validator that throws on shape mismatch.
- **Why it's here:** the application-side parse at the validation boundary; turns `unknown` into typed `AISummary` (or throws). Pairs with structured outputs as defense-in-depth.
- **Leading today:** Zod — `adoption-leading` for TypeScript runtime validation, 2026.
- **Why it leads:** schema + type inference in one declaration; chain of `.parse` / `.safeParse` / `.transform`; massive ecosystem (zod-to-openapi, hookform-resolvers).
- **Runner-up:** Valibot — `innovation-leading` for tree-shakeable / bundle-size-sensitive contexts; ArkType — `innovation-leading` for runtime-typed-DSL ergonomics.

---

## Project exercises

### B3.3 — Add a strict `tools` schema to buffr's `summarize` chain

- **Exercise ID:** `[B3.3]`
- **What to build:** in `src/services/ai/summarize.ts`, add a `tools: [{ name: 'emit_summary', description, input_schema }]` array to the Anthropic `messages.create()` call. The `input_schema` is the existing `AISummary` type translated to JSON Schema. Set `tool_choice: { type: 'tool', name: 'emit_summary' }`. Parse the result from `result.content[].type === 'tool_use'` instead of `JSON.parse(text)`. Mirror the change on the OpenAI branch with `response_format: { type: 'json_schema', json_schema: { strict: true, schema, name } }`. Keep the existing `validateAISummary()` call as the boundary parse.
- **Why it earns its place:** turns the chain from "polite asks for JSON" to "provider-enforced typed output." The summarize chain is the highest-value place to land this — its output is consumed by editor code that assumes the shape.
- **Files to touch:** `src/services/ai/summarize.ts`, `src/services/ai/validate.ts` (no change unless you want to swap to Zod).
- **Done when:** the chain runs end-to-end on the device, produces output identical to before, and the SDK call no longer requests JSON in the prompt text (the prompt becomes about *what* to summarize, not *how to format* the response).
- **Estimated effort:** 1–4hr.

### B3.4 — Add schema-fail retry + metrics

- **Exercise ID:** `[B3.4]`
- **What to build:** wrap the Zod / `validateAISummary` parse in a try/catch. On the first throw, retry the SDK call with one added system-level instruction: `STRICT: your previous output failed schema validation. Emit only the schema; no prose, no markdown.` Cap at one retry. Log every schema-fail to a `sync_meta`-style counter (or a dev-console aggregate) so you can track the rate. Surface in the cloud-sync settings screen as "AI schema-fail rate (last 24h)."
- **Why it earns its place:** the difference between "ship structured outputs" and "ship structured outputs in production." The metric is what tells you when a model upgrade has silently regressed your chain — before users see it.
- **Files to touch:** `src/services/ai/summarize.ts`, possibly a new `src/services/ai/metrics.ts` helper, `app/settings/cloud-sync.tsx` for the surface.
- **Done when:** force a fail (temporarily corrupt the schema to mismatch the prompt instructions), observe the retry firing in logcat, observe the counter incrementing.
- **Estimated effort:** 1–2 days.

---

## Summary

### Part 1 — concept recap

Structured outputs are the application of "fail at the boundary, not downstream" to LLM responses — declare a schema at the SDK call, let the provider enforce it via constrained generation, validate the parse at the application boundary with Zod (or Pydantic), and retry once with a stricter system prompt on schema fail. Buffr today asks for JSON in prompt text and runs `JSON.parse` directly; the only application-side validator is `validateAISummary` in `summarize.ts` and even that runs without provider-side enforcement underneath. The constraint forcing this concept is that buffr's typed-output chains (`summarize`, `classify`, `expand`) have consumers that assume the shape, so a single schema-fail in production becomes a `TypeError` or, worse, a silent missing field. The cost being paid for the current shape is that every model upgrade carries hidden regression risk: a new model's prose habits (more markdown fences, more "Sure, here's…" prefaces) can break the parser overnight.

### Part 2 — key points to remember

- The schema lives in the SDK call, not in the prompt text. "Respond only in JSON" inside the prompt is the 2023 shape; strict-mode tools / json_schema is the 2026 shape.
- The application-side Zod (or Pydantic) parse is the second line of defense — provider enforcement is strong but not infallible.
- One retry on schema fail, with a stricter instruction. Two failures means fall back to the non-LLM path; infinite retry is a cost incident.
- Log the schema-fail rate. It's the canary metric for provider regressions.
- Don't use structured outputs for human-consumed prose (`interpret`). Use them everywhere code reads the output.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you get reliable JSON out of an LLM," they're separating people who've shipped from people who've prototyped. The prototype answer is "ask for JSON in the prompt, parse the response." The production answer names provider-side schema enforcement, application-side validation, and a retry policy — and gives a specific bug (markdown code fences, or the `Sure, here's…` preface, or the trailing-comma-after-the-last-field) that the production approach prevents.

### Likely questions

**Q [mid]:** Why isn't it enough to say "respond only in JSON" in the prompt?

**A:** Two reasons. First, the model's training is biased toward being helpful and conversational; "respond only in JSON" competes with "Sure, here's the JSON you asked for: \`\`\`json\n{...}\n\`\`\`" — and the second pattern wins often enough to break the parser. Second, you have no signal when it fails — `JSON.parse` throws once, you regex-fix it, you ship, the next failure mode (a different model emitting `// here's the result` as a JS-style comment before the JSON) catches you in a month. Schema in the SDK call removes the failure mode at the sampling layer; the model literally can't emit tokens that would invalidate the schema.

```
   prompt-only "respond in JSON"        schema in SDK call (strict)
   ─────────────────────────────        ───────────────────────────
   model emits text                     sampler constrained to valid JSON
   parser optimistic                    response IS JSON, typed
   silent failures (~1% in prod)        schema fails surface as Zod throws
   regex patches forever                one retry policy, then fallback
```

**Q [senior]:** Buffr's `summarize` chain currently uses prompt-asks-for-JSON. Why haven't you migrated it to strict structured outputs?

**A:** Same answer as the anatomy file — the cost hasn't bit hard enough yet. Buffr is single-user, the summarize chain runs at most once per date, and the existing `validateAISummary()` throws loudly enough on shape mismatch that the few failures get noticed manually. The breakpoint is when the chain becomes multi-user (Phase B), at which point a single silent schema-fail affecting one user's summary becomes invisible to everyone else, and the metric "AI summary schema-fail rate" needs to exist on a dashboard. That's also when the retry policy starts mattering — at one summary per day per user, 0.1% schema-fail rate is one failure per ~1000 user-days; at 100 users it's a failure every 10 days. Fine. At 10,000 users it's a failure every two hours — not fine.

```
   single-user (now)              multi-user (Phase B)
   ─────────────────              ────────────────────
   summarize × 1/day              summarize × N users/day
   schema-fail observable         schema-fail invisible per user
   fix in next session            metric on dashboard required
   ─────                          ─────
   prompt-asks-for-JSON: OK       strict schema + retry + metric: required
```

**Q [arch]:** What happens to your schema strategy at 10× scale when latency-sensitive chains start hitting the provider's strict-mode overhead?

**A:** Strict mode has measurable first-token-latency overhead on some providers (OpenAI ~50–150ms extra; Anthropic basically nothing). At 10× scale you start caring about that. The right move at that point is to bifurcate: keep strict schema for chains whose consumer needs typed output (summarize, classify, expand); switch the latency-sensitive ones to JSON-mode without strict and accept the schema-fail-rate cost, mitigating with a heavier application-side parse + retry budget. The architecture change is that the "structured output policy" becomes per-chain, not global. The layer that breaks first at 10× isn't structured outputs themselves — it's the chain selector deciding whether strict mode is worth the latency hit per call.

```
   today                           10× scale
   ─────                           ─────────
   structured: everywhere          structured: typed-consumer chains only
   (or nowhere, in buffr's case)   JSON-mode: latency-sensitive chains
                                   policy decision per chain
                                   ─────
                                   breaks first: latency budget on
                                   high-throughput chains under strict mode
```

### The question candidates always dodge

**Q:** Your retry policy is "one retry with a stricter prompt." Why not retry three times? Why not retry zero times?

**A:** Zero retries means every schema-fail is a user-visible error. The cost of one retry is one extra API call (latency-doubling for the failing case, ~0.1% of calls); the benefit is catching ~95% of the genuine failures. Two retries adds a third call to the failing 0.005% — diminishing returns, and the second retry usually fails for the same structural reason as the first (the provider's failure modes correlate within a session). Three retries is just a cost incident waiting to happen: if a model bug makes EVERY response fail-then-fail-then-fail, you've tripled your provider bill in the failure mode. The cap at one is the production answer; the right number isn't 1 vs 3, it's "one, then fall back to the non-LLM path." The fallback is the part most candidates skip — what does the chain return when both attempts fail? A heuristic answer? A default value? An error surfaced to the user? Naming the fallback is the difference between "retry policy" and "retry decoration."

```
   what was picked              what 3 retries would cost
   ─────────────                ─────────────────────────
   1 retry + fallback           3 retries + (no fallback?)
   bounded cost: 2× max         worst case: 4× provider bill
   fallback handles 0.005%      worst case: still surfaces error
   ─────                        ─────
   retry isn't decoration       infinite retry == cost incident
   the fallback is the answer   the fallback is still missing
```

### One-line anchors

- The schema lives in the SDK call, not the prompt text.
- One retry on schema fail. Then fall back. Never infinite-retry.
- Track schema-fail rate as a canary metric — it's how you catch provider regressions before users do.
- Don't constrain prose with a schema. Reflection-style outputs need free generation.
- Defense-in-depth: provider schema + application Zod parse + retry budget + fallback. Skip any layer at your peril.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the four-layer flow: App → Provider boundary (schema-constrained generation) → Validation boundary (Zod / equivalent) → either return typed result OR fall through to the Retry layer (one stricter retry, then fallback). Label every box and every arrow.

### Level 2 — Explain it out loud

Explain structured outputs to a colleague who just asked "how do you get reliable JSON out of an LLM?" Under 90 seconds.

Checkpoints — did you:
- Name where the schema lives (SDK call, not prompt text)?
- Name the application-side parse with Zod (or equivalent)?
- Name what happens on schema fail (one retry + fallback)?

### Level 3 — Apply it to a new scenario

A new requirement lands: buffr's `expand` chain needs to support a `code_explainer` variant — given a code snippet in a `study`-mode todo, return a structured `{ summary, key_concepts: string[], related_topics: string[] }` payload.

Without looking at the file: where does the schema for `code_explainer` live? Where does the parse-and-validate happen? What does the chain do if validation fails? Sketch the full pipeline in 3–5 sentences.

Then open `src/services/ai/expand.ts` and compare your design to how the existing expand variants are structured.

### Level 4 — Defend the decision you'd change

The current "prompt asks for JSON, parser hopes" approach in buffr is debt that hasn't bit yet. Defend or oppose the position: "wait until Phase B (multi-user) to migrate to strict structured outputs; the cost-of-doing-it now exceeds the cost-of-deferring."

Reference the code:
- Point to `src/services/ai/summarize.ts` for the current parse-and-pray shape.
- Point to `src/services/ai/validate.ts` to argue that buffr already has the validation boundary, just missing the provider-enforcement layer.

### Quick check — code reference test

Without opening any files:
- Which buffr chain is the most natural candidate for strict schema enforcement?
- What's the existing application-side validator called?
- What output-shape does the `interpret` chain emit (and why is it the exception to all of this)?
