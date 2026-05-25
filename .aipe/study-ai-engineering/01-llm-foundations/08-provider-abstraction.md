# Provider abstraction

**Industry name(s):** Provider abstraction, model factory, provider-agnostic chain design
**Type:** Industry standard

> Hide the provider behind a uniform chain interface so swapping (cost, capability, outage) is local — change the factory, not every chain. The abstraction earns its keep the first time you need to A/B two providers on the same call sites.

**See also:** → [01-what-is-an-llm](./01-what-is-an-llm.md) · → [04-structured-outputs](./04-structured-outputs.md) · → [`06-production-serving/05-retry-and-circuit-breaker`](../06-production-serving/05-retry-and-circuit-breaker.md)

---

## Why care

### Move 1 — The grounded scenario

You're debugging buffr's caption chain. Sonnet 4.6 is producing variants that all start with "Today's energy was..." A forbidden-pattern bug, fine — but you also want to know whether GPT-4o has the same convergence. Without abstraction, swapping requires editing every chain file, rewriting the Anthropic SDK calls into raw fetch to OpenAI, re-shaping the tool-calling syntax, re-mapping the response shape. With abstraction, you flip one switch in `config.ts` and re-run the same chain.

### Move 2 — Name the question the pattern answers

That swap-cost question is what provider abstraction answers. Not "which provider is best" (workload-specific); just *what's the cost of moving from one to another, and can I keep it small enough that I do it when I should*. The answer: factor the differences (auth, request shape, response shape, tool-call syntax) into one location; keep the chain calls uniform.

### Move 3 — Why answering that question matters

**What breaks without abstraction:** every chain file has provider-specific SDK calls baked in. Swapping a single chain means rewriting it. Comparing two providers on the same call site means writing two copies of every chain. Buffr today uses Anthropic SDK for Claude calls and raw `fetch` for OpenAI; the abstraction lives at the chain function boundary — each chain has a `provider: 'anthropic' | 'openai'` dispatch at the top, both branches call the same model, the parsed output is identical shape.

### Move 4 — Concrete before/after

Without abstraction:
- Caption chain hard-coded to Anthropic SDK
- "Try with GPT-4o" → 4 hours rewriting one chain
- Mistake-prone (re-implement schema enforcement, retry, parsing)

With abstraction (buffr today):
- `config.ts` `provider` flag flips between `anthropic` and `openai`
- Every chain has a provider-dispatch block: ~6 lines each
- Same Zod validation runs against the parsed result regardless of provider
- "Try with GPT-4o" → 1 minute (toggle flag, restart, re-run)

### Move 5 — The one-line summary

Factor the provider differences (request shape, tool-call syntax, response shape) into one boundary; keep chain code uniform. The abstraction pays for itself the first time you A/B two providers on the same call site.

---

## How it works

### Move 1 — The mental model

```
   ┌─ Your chain code (uniform regardless of provider) ──────────┐
   │                                                              │
   │   const { provider } = getConfig();                          │
   │   const result = await callModel({                           │
   │     provider, model, messages, tool: AISummaryTool           │
   │   });                                                        │
   │   return validate.AISummary(result);                         │
   │                                                              │
   └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌─ Provider dispatch (where the differences live) ────────────┐
   │                                                              │
   │   if provider == 'anthropic'                                 │
   │     → @anthropic-ai/sdk client.messages.create({...})        │
   │     → response.content[0].input                              │
   │                                                              │
   │   if provider == 'openai'                                    │
   │     → fetch(POST /chat/completions, body)                    │
   │     → JSON.parse(response.choices[0].message.tool_calls[0])  │
   │                                                              │
   └──────────────────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — what gets factored out.** Three things: (a) auth and request setup (SDK client vs raw fetch with headers); (b) tool-call syntax (Anthropic `tools` array vs OpenAI `tools` with slightly different shape); (c) response parsing (Anthropic returns tool input under `content[0].input`; OpenAI under `choices[0].message.tool_calls[0].function.arguments` as a JSON string). Everything else — the messages, the schema, the validation — stays the same.

```
   ┌─ Provider-specific (factor out) ──────┐    ┌─ Uniform (keep in chain) ──┐
   │                                       │    │                              │
   │   auth + client setup                 │    │   messages array (shape)      │
   │   tool-call request shape             │    │   tool definition (Zod →      │
   │   response shape                      │    │     JSON Schema)              │
   │   error shape                         │    │   validation                  │
   │   retry semantics                     │    │   logging                     │
   │                                       │    │                              │
   └───────────────────────────────────────┘    └──────────────────────────────┘
```

**Layer 2 — where buffr puts the boundary.** Currently the dispatch is inline at the top of each chain — a 6-line `if (provider === 'anthropic') ... else ...` block. That's the minimum-viable abstraction; it works because there are only 2 providers and 5 chains. If buffr grew to 4 providers or 12 chains, the next refactor would be to extract the dispatch into a single `callModel(provider, model, messages, tool)` helper — same shape, single boundary instead of 5.

```
   buffr's current abstraction shape
   ─────────────────────────────────
   src/services/ai/summarize.ts:  inline dispatch (6 lines)
   src/services/ai/caption.ts:    inline dispatch (6 lines)
   src/services/ai/expand.ts:     inline dispatch (6 lines)
   src/services/ai/classify.ts:   inline dispatch (6 lines)
   src/services/ai/interpret.ts:  inline dispatch (6 lines)
   ──
   total: 30 lines of dispatch across 5 chains
   ──
   future refactor target: extract to callModel() (~50 lines, single boundary)
```

**Layer 3 — what stays NOT abstracted on purpose.** Some provider differences are real and should surface. Cost-per-token is different (Sonnet $3/$15, GPT-4o $2.5/$10). Latency is different (Anthropic typically ~15% slower than OpenAI on equivalent calls). Tool-calling reliability is different (Anthropic stricter; OpenAI occasionally produces tool calls with extra fields). Keep these visible in the cost log and the eval suite — the abstraction is a swap-cost reducer, not a "providers are interchangeable" claim.

```
   What the abstraction does NOT hide
   ──────────────────────────────────
   per-token cost  (different rates)
   p50 latency     (15-20% spread between providers)
   model character (Sonnet vs GPT-4o write differently)
   eval scores     (different chains favor different models)
```

### Move 3 — The principle

Factor the call shape; surface the real differences. The abstraction is a swap-cost reducer, not a "all providers are equal" claim. Swap when you have a reason; the reason should be in the eval data, not the abstraction.

The full picture is below.

---

## Provider abstraction — diagram

```
┌─ Chain code (uniform) ─────────────────────────────────────────────────┐
│                                                                        │
│   summarize(entry, history) →                                          │
│         messages = buildMessages(entry, history)                       │
│         result = await callViaProvider(provider, model, messages,      │
│                                          summaryTool)                  │
│         return validate.AISummary(result)                              │
│                                                                        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                                ▼
┌─ Provider dispatch ────────────────────────────────────────────────────┐
│                                                                        │
│   ┌─ Anthropic ─────────────────────────┐  ┌─ OpenAI ──────────────┐  │
│   │   @anthropic-ai/sdk client            │  │   fetch POST          │  │
│   │   messages.create({                   │  │   /chat/completions   │  │
│   │     model: 'claude-sonnet-4-6',       │  │   { model: 'gpt-4o',  │  │
│   │     messages,                         │  │     messages,         │  │
│   │     tools: [summaryTool]              │  │     tools: [...]      │  │
│   │   })                                  │  │   }                   │  │
│   │   → result.content[0].input           │  │   → choices[0].msg... │  │
│   └───────────────────────────────────────┘  └───────────────────────┘  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A — every chain has a provider-dispatch block.**

**Files:**
- `src/services/ai/config.ts` — the `provider` flag (`'anthropic' | 'openai'`) and the model-per-provider lookup (`getModel(provider, role)`). Role names are chain-aligned (`summarizer`, `captioner`, `classifier`, `expander`, `interpreter`).
- `src/services/ai/summarize.ts` (~L40–L80) — provider dispatch at the top; both branches share the same `validate.AISummary` call after parsing.
- `src/services/ai/caption.ts` (~L50–L100) — same pattern.
- `src/services/ai/expand.ts`, `classify.ts`, `interpret.ts` — same pattern.

The provider has been swapped twice in production history: once to A/B Sonnet vs GPT-4o on summary quality (Sonnet won on tone-tag accuracy; kept it); once to migrate the classifier from `gpt-4o-mini` to Haiku 4.5 for cost (Haiku won by 50% on cost at equivalent accuracy; kept it).

---

## Elaborate

### Where this pattern comes from

The Strategy pattern from GoF (1995) is the structural ancestor — different implementations behind one interface. LangChain (2022) was the first widely-adopted LLM abstraction; LangChain Expression Language (LCEL) is the modern shape. Most production codebases roll their own thin abstraction rather than depend on LangChain.

### The deeper principle

Abstract the things you'll change; surface the things you won't. Abstraction overhead is only worth it where you actually swap.

### Where this breaks down

When you have one provider and don't realistically plan to swap (single-tenant internal tool, locked vendor contract), the abstraction is dead code. When you have many chains all using the same provider, an inline dispatch is fine — abstraction earns its keep when chain count × provider count grows past ~10.

### What to explore next

- [04-structured-outputs](./04-structured-outputs.md) — the schema is the cross-provider contract; the abstraction depends on its uniformity
- [`06-production-serving/05-retry-and-circuit-breaker`](../06-production-serving/05-retry-and-circuit-breaker.md) — the abstraction is where you'd add per-provider retry and circuit-breaker logic
- [01-what-is-an-llm](./01-what-is-an-llm.md) — the function framing is what makes this abstraction natural

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Provider abstraction      │ Hard-coded per chain      │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Swap cost        │ Minutes (toggle flag)     │ Hours per chain           │
│ Code overhead    │ ~6 lines dispatch/chain   │ Zero                      │
│ Hides real       │ No (cost/latency surface  │ N/A                       │
│ differences      │ via logs)                 │                           │
│ Earns its keep   │ When you swap             │ When you never swap       │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### The breakpoint

Add the abstraction the moment you have a second provider, even for one chain. The cost is small; the future swap is free. Don't add it preemptively for one-provider systems.

---

## Tech reference (industry pairing)

### `@anthropic-ai/sdk`

- **Codebase uses:** `@anthropic-ai/sdk` ^0.90.0 — `client.messages.create({...})` for all Claude calls.
- **Why it's here:** SDK-native ergonomics, typed responses, retry built in.

### OpenAI via raw `fetch`

- **Codebase uses:** raw `fetch` POST to `/chat/completions` for OpenAI calls; no OpenAI SDK dependency (one fewer package to keep current).
- **Why it's here:** simpler dependency tree; the OpenAI API shape is stable enough to maintain by hand.

---

## Project exercises

### B1.6 — Provider-swap eval against the 5 chains

- **Exercise ID:** `B1.6`
- **What to build:** run all 5 chains against Claude (Anthropic) and against GPT-4o (OpenAI) on the same 10-input fixture set. Compare outputs side-by-side; document divergences in `docs/spec.md` (which chain has more agreement with which provider, where the providers split).
- **Why it earns its place:** the eval is what the abstraction is for. Without running it, the abstraction is unverified — and provider differences in the wild are the kind of thing that catches teams later.
- **Files to touch:** new eval fixture, a small script in `scripts/` that runs all 5 chains under both providers, the comparison output committed to `docs/`.
- **Done when:** the comparison doc is checked in with per-chain divergence notes; any chain with provider-specific quirks (e.g., GPT-4o being faster on classify but Sonnet better on caption tone) is documented.
- **Estimated effort:** 3 hours.

---

## Summary

### Part 1 — concept recap

Provider abstraction factors the differences (auth, request shape, tool-call syntax, response shape) into one location so chain code stays uniform. Buffr's abstraction is a per-chain inline dispatch (~6 lines) on a `provider` flag in `config.ts`; the dispatch has been used twice in production to swap providers based on eval data. The abstraction is a swap-cost reducer, not a "providers are interchangeable" claim — real differences (cost, latency, model character) stay visible.

### Part 2 — key points to remember

- Factor: request shape, tool syntax, response shape, error shape.
- Keep uniform: messages, schema, validation, logging.
- Swap reasons live in eval data, not the abstraction.
- Inline dispatch is fine until chain count × provider count exceeds ~10.
- Add the abstraction the moment you have a second provider.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks about provider abstraction, they're checking whether you've designed for swap or coded for one provider. Engineers who say "we use Claude" haven't designed for swap; engineers who say "the abstraction lives at this boundary" have.

### Likely questions

**Q [mid]:** What do you factor into the provider abstraction and what stays out?

**A:** Factor: auth, request setup, tool-call syntax, response parsing, error shape. Keep uniform: messages, schema, validation, logging. Don't factor: cost, latency, model character — these are real differences that should surface in eval data, not be hidden. The abstraction reduces swap cost; it doesn't claim providers are equivalent.

**Q [senior]:** When does the abstraction earn its keep?

**A:** The first time you swap. Until then, the abstraction is dead code (~6 lines per chain). The trigger to add it: a second provider, even for one chain. The cost of having it preemptively is low; the cost of not having it when you need to swap is "rewrite every chain that calls a model" — multiplied by chain count.

### One-line anchors

- Factor: request shape, tool syntax, response shape. Keep uniform: messages, schema, validation.
- Real differences (cost, latency, character) stay visible.
- Inline dispatch fine until chains × providers > 10.
- Buffr's been swapped twice; abstraction earned its keep.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the provider-dispatch flow: chain → dispatch → per-provider branch → uniform validation.

### Level 2 — Explain it out loud

Explain in under 60 seconds what the provider abstraction hides and what it surfaces.

### Level 3 — Apply it to a new scenario

A new requirement: add Google Gemini as a third provider option. What changes in buffr's abstraction?

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should drop OpenAI support since the eval shows Claude wins on every chain."

### Quick check — code reference test

Without opening files:
- Where does the `provider` flag live?
- How many chains have inline dispatch?
- What's the breakeven for moving from inline dispatch to a `callModel` helper?
