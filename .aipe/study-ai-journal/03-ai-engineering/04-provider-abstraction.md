# Provider abstraction — read on every call, no shared interface

**Industry name(s):** Strategy pattern, Adapter pattern, Provider pattern
**Type:** Industry standard · Language-agnostic

> Each callsite branches on `'claude' | 'openai'`. Same prompts, same JSON contract, different SDK calls.

**See also:** → [01-system-design/11-provider-abstraction](../01-system-design/11-provider-abstraction.md) · → [02-single-purpose-chains](./02-single-purpose-chains.md)

---

## Why care

You've got two third-party services that both produce the same logical output — two LLM vendors that both return text completions from a prompt, say. Option one: define `interface AIProvider { call(prompt): Promise<string> }` and write `ClaudeProvider` and `OpenAIProvider` classes implementing it. Option two: write each call site as a `switch (provider)` with two branches, each branch using its vendor's native SDK directly, with the surrounding code (prompt builder, response parser, validator, persistence) shared. The first option looks cleaner on paper. The second option leaves room for each vendor's native features — Anthropic's prompt caching, OpenAI's `response_format: json_object` — without flattening them through an interface that grows knobs every time one vendor adds a capability the other doesn't have. Same shape as React Native's `.ios.ts` / `.android.ts` resolution: two thin per-platform implementations behind one import path, no shared interface trying to unify them.

Provider abstraction in this codebase is option two. Not a unified interface that pretends both vendors are identical, not a wrapper class that flattens their quirks — just a thin choice at each call site, with everything upstream (the prompt) and everything downstream (the JSON shape, the validator) shared. Naming the pattern this way is what lets a codebase outlive any single vendor's API.

**What depends on getting this right:** the ability to swap providers without rewriting features, and the ability to use each provider's native strengths (Anthropic's tool calling, OpenAI's `response_format: json_object`) without leaking that into the rest of the codebase. `src/services/ai/config.ts:getProvider()` reads `'claude' | 'openai'` from SecureStore on every call. Each chain (`summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts`, `interpret.ts`) has a `switch (provider)` with two branches — Claude via `@anthropic-ai/sdk`'s `client.messages.create`, OpenAI via raw `fetch` to `/v1/chat/completions`. Both return a string. The rest of the chain — `extractJsonFromText`, `validate.ts`, `upsertAISummary` — is shared. Collapse that into a "unified AIProvider class" and the day OpenAI ships JSON-mode or Anthropic ships a new tool-use grammar, you're either rewriting the interface for everyone or hiding the new capability behind a flag the wrapper doesn't expose.

Without provider abstraction at the call site:
- One `AIProvider` class promises `call(prompt): Promise<string>` and hides the quirks
- OpenAI ships `response_format: json_object`; the wrapper either ignores it or grows a knob every caller has to know about
- Caption chain wants the JSON-mode discount; either everyone pays the wrapper-rewrite tax or caption forks the wrapper

With per-call-site abstraction:
- `caption.ts` has a 15-LOC `switch (provider)` — Claude branch reads `response.content[0].text`; OpenAI branch sets `response_format` and reads `choices[0].message.content`
- Validators, persistence, prompt templates stay shared; `validate.ts` runs the same regardless
- Adding a third provider is mechanical — copy the switch arm, normalise to a string, the tail doesn't change

Thin abstractions over thick differences — the contract is stable, the transport varies, the suitcase keeps flying.

---

## How it works

A `switch (provider)` block inside each chain function is the canonical pattern. The branches don't share an interface — each one uses its vendor's native SDK or API directly, returns a string, and lets the rest of the chain (prompt builder upstream, parse/validate/persist downstream) run unchanged. Same shape as React Native's `.ios.ts` / `.android.ts` resolution at the bundler level — two implementations behind one import path, picked at call time, no shared interface contract dragging them down.

The shape in one picture:

```
   AI service caller (summarize / caption / classify / expand / interpret)
                              │
                              │  await getProvider()
                              ▼
   ┌────────────────────────────────────────────────────────┐
   │ switch (provider) {                                     │
   │   case 'claude':                                        │  ◄── branch 1
   │     await client.messages.create({ … })                  │     Claude SDK
   │     return response.content[0].text                      │     (typed)
   │                                                          │
   │   case 'openai':                                        │  ◄── branch 2
   │     await fetch('api.openai.com/v1/chat/completions',    │     raw fetch
   │       { method: 'POST',                                  │     + response_format
   │         body: JSON.stringify({                           │
   │           response_format: { type: 'json_object' }, … }) │
   │       })                                                 │
   │     return data.choices[0].message.content               │
   │ }                                                        │
   └─────────────────────────┬──────────────────────────────┘
                             │  both branches return a string
                             ▼
              extractJsonFromText → validate.ts → database.ts
              (shared tail; same code regardless of which branch ran)
```

The four sub-sections below trace the config that picks the branch, the two branches in detail, the shared tail, and the table of what stays vs what changes when you swap providers.

### The config — `getProvider()` + per-provider keys from SecureStore

`src/services/ai/config.ts` exposes `getProvider()` (returns `'claude'` or `'openai'`) and `getApiKey(provider)`. Both read from `expo-secure-store` (Android Keystore-backed). The reads are async but cheap; the first call hits the keystore, subsequent calls hit memory. If you're coming from frontend, this is the same shape as a feature-flag context that decides which API client a query targets — `useApi(provider)` returns the right client and the consumer doesn't care. Concrete consequence: every AI service file starts with `const provider = await getProvider(); const apiKey = await getApiKey(provider);`. The user changes provider in Settings → AI; the next AI call picks up the new value via the next `getProvider()` read. Boundary: this assumes the key was set during onboarding; if the user opens an AI feature without configuring keys, the call throws and the UI shows an "AI not configured" hint.

The config module and how every chain starts:

```
   src/services/ai/config.ts
   ─────────────────────────────────────────────────────────
   async function getProvider(): Promise<'claude' | 'openai'>
     // expo-secure-store read (Android Keystore-backed)

   async function getApiKey(provider): Promise<string>
     // expo-secure-store read per provider key

   Every AI chain starts the same way:
     const provider = await getProvider();
     const apiKey   = await getApiKey(provider);

   ┌─────────────────────────────────────────────┐
   │ first call:    keystore read ~5ms            │
   │ subsequent:    memory cache ~0.01ms          │
   │ user toggles provider in Settings:           │
   │   next getProvider() returns the new value   │
   └─────────────────────────────────────────────┘
```

One named module owns key access; changing storage backends (env var, server-side fetch) means editing one file.

### The branch — Claude SDK vs raw fetch to OpenAI

Every AI service has the same structure: a `switch (provider)` with two branches. The Claude branch calls `@anthropic-ai/sdk`'s typed `client.messages.create({...})`. The OpenAI branch builds a `fetch` to `https://api.openai.com/v1/chat/completions` with hand-crafted JSON, including `response_format: { type: 'json_object' }` (Claude doesn't have that knob, so the Claude branch has to extract JSON from prose). Think of it like a typed adapter pattern at the call site — same input shape going in, same string shape coming out, two different transports. Concrete consequence: in `summarize.ts`, the Claude branch builds `messages: [{role: 'user', content: prompt}]` and reads `response.content[0].text`. The OpenAI branch builds the equivalent prompt with `response_format: json_object`, POSTs, reads `response.choices[0].message.content`. Both branches return a string; the caller can't tell which provider produced it. Boundary: the abstraction is at the *call site*, not in a shared interface — every chain has its own `switch`, every chain pays the ~10-LOC duplication cost, and adding a third provider means touching all five chains.

The two branches side by side, each using its provider's native shape:

```
   switch (provider) {

     case 'claude':                          case 'openai':
       const res = await                       const res = await fetch(
         client.messages.create({                'https://api.openai.com/v1/...',
           model: 'claude-sonnet-4-6',           { method: 'POST',
           messages: [{                            headers: { Authorization, ... },
             role: 'user',                          body: JSON.stringify({
             content: prompt                          model: 'gpt-4o',
           }]                                          messages: [...],
         });                                            response_format: {
       return res.content[0].text;                        type: 'json_object'
                                                         }
                                                       })
                                                     }
                                                   );
                                                   const data = await res.json();
                                                   return data.choices[0]
                                                              .message.content;
   }
            │                                         │
            └────────────────┬────────────────────────┘
                             ▼
                       returns a string
                       (caller can't tell which branch ran)
```

Adding a third provider = one new `case` arm in each chain (~10 LOC × 5 chains = ~50 LOC). The cost is paid once per provider.

### The shared tail — parse, validate, persist (one path)

After both branches return their string, the rest of every chain is shared: extract JSON (`JSON.parse` or a regex extractor for Claude's prose-wrapped JSON), validate against a schema (`src/services/ai/validate.ts`), persist to SQLite via `database.ts` helpers, return. If you're coming from React Query, this is the same shape as a mutation's `onSuccess` — the transport produced the data; now the standard write-and-cache path takes over. Concrete consequence: `caption.ts` calls Claude, gets `'{"variants":{"clean":...}}'` wrapped in prose, runs `extractJsonFromText` to recover the object, runs `parseCaptionVariants` to lift it into a typed shape, persists via `upsertAISummary(date, summary)`. If the same call had hit OpenAI, the wrapper is missing (JSON-mode returns clean JSON), but the rest is identical. Boundary: the validate step is the safety net — a model that returns malformed JSON throws at validate, the chain reports the failure, the persist step never runs. The shared tail keeps each chain's domain logic in one place.

The shared tail pipeline:

```
   string output from either branch
              │
              ▼
   ┌──────────────────────────────────────┐
   │ extractJsonFromText                   │  ◄── Claude may wrap in
   │   regex / JSON.parse on cleaned       │     markdown fences;
   │   string                              │     OpenAI returns clean
   │       ▼                                │
   │ src/services/ai/validate.ts            │  ◄── schema check
   │   typed validator per chain           │     reject malformed loudly
   │       ▼                                │
   │ database.ts helper                     │  ◄── single-funnel write
   │   upsertAISummary / etc.               │     bumps updated_at +
   │                                        │     schedulePush()
   └──────────────────────────────────────┘
              │
              ▼
   row in SQLite; cloud sync trips ~5s later
   (caller can't tell which provider produced the value)
```

One pipeline, two transports, identical post-processing.

### What stays vs what changes when you swap providers

| Stays the same | Changes |
| --- | --- |
| Prompts | Model identifier (`claude-sonnet-4-6` vs `gpt-4o`) |
| Output JSON shape | API client (`@anthropic-ai/sdk` vs `fetch`) |
| Validators (`validate.ts`) | Response parsing path (`content[0].text` vs `choices[0].message.content`) |
| Persistence (`database.ts`) | Token-cost math (per-provider pricing) |

If you've ever swapped a database driver behind an ORM and noticed how little of the calling code needed to change, this is the same shape. The abstraction holds because the *contract* (string in, string out, JSON shape downstream) is stable; the *transport* is what varies. Concrete consequence: the codebase swapped from Claude to OpenAI mid-2026 for one chain (caption) when JSON-mode landed. The change was ~15 LOC in `caption.ts` — adding the OpenAI branch, plumbing the `response_format`. No prompt rewrites, no persistence changes, no validator changes. Boundary: this only stays clean as long as the providers' contracts can be normalised at the response-parsing layer. If a future provider's response shape is wildly different (e.g. streaming-only, function-calling-first), the abstraction either grows knobs or splits into two abstractions.

This is what people mean by "thin abstractions over thick differences." The temptation is to wrap a divergent set of APIs behind a unified interface — `class AIProvider { async call(prompt): Promise<string> }` — but the interface itself becomes the surface area that breaks when one provider adds a feature the other doesn't have. The codebase trades a little duplication (`switch (provider)` in five files) for the freedom to use each provider's native shape. Every codebase that ever survived a vendor's major version bump or a vendor swap has some version of this discipline: keep the wrapper thin enough to rewrite, keep the callers naive enough to not depend on its quirks. The full picture is below.

---

## Provider abstraction — diagram

```
┌─ Service layer (AI callsites) ──────────────────────────────────────┐
│  Each callsite (summarize / caption / classify / expand / interpret)│
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─ Config layer (SecureStore-backed) ─────────────────────────────────┐
│                       ┌──────────────────┐                          │
│                       │  ai/config.ts    │                          │
│                       │  getProvider()   │ ← reads SecureStore:     │
│                       │  getXxxKey()     │   'claude' | 'openai'    │
│                       └──────────┬───────┘                          │
└──────────────────────────────────┼──────────────────────────────────┘
                                   │
                         ┌─────────┴─────────┐
                         ▼                   ▼
                provider == 'claude'   provider == 'openai'
                         │                   │
┌─ Provider / network layer ──────┼───────────────────┼───────────────┐
│                                 ▼                   ▼               │
│                       Anthropic SDK          raw fetch              │
│                       models.create({...})   /v1/chat/completions   │
│                                              response_format:       │
│                                              json_object            │
└─────────────────────────────────┼───────────────────┼───────────────┘
                                  │                   │
                                  └─────────┬─────────┘
                                            ▼
                                 string of model output
                                            │
                                            ▼
┌─ Service layer (parse/validate) ────────────────────────────────────┐
│                 caller-specific parser + validator                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Why no `BaseChatModel` interface

The two providers' APIs are different enough that a unified interface either lies (gluing OpenAI's `response_format: json_object` over Claude's looser shape) or constrains both to the lowest common denominator. The codebase chose explicit branches per callsite — 5 chains × 2 providers = 10 explicit branch arms (summarize, caption, classify, expand, interpret), but each one can use the optimal API for that provider.

```
Per-call branches (all 5 callsites follow this exact shape):

  callClaude(apiKey, system, user):
    client = new Anthropic({ apiKey })
    r = client.messages.create({
      model: 'claude-sonnet-4-6',  // or claude-haiku-4-5 for classify
      max_tokens: ...,
      system,
      messages: [{ role: 'user', content: user }],
    })
    return r.content[0].text

  callOpenAI(apiKey, system, user):
    r = fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, ... },
      body: { model: 'gpt-4o', max_tokens: ..., response_format: { type: 'json_object' },
              messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
    })
    return r.choices[0].message.content
```

**One subtlety:** OpenAI's `response_format: 'json_object'` forces JSON; Claude doesn't have that option, so the prompts say "Output ONLY a JSON object — no preamble, no markdown" and the parser strips ` ```json ` fences defensively.

---

## In this codebase

**Provider read:**   `src/services/ai/config.ts` → `getProvider()` L9–L12, `getAnthropicKey()` + `getOpenAIKey()` L18–L40 (whole file is L1–L50)
**Branch sites (5):** `src/services/ai/summarize.ts:summarize()` L42–L105 (helpers `callClaude` L12–L22, `callOpenAI` L24–L40), `caption.ts:generateCaption()` L201–L223, `src/services/todos/classify.ts:classifyTodo()` L90+, `expand.ts:expandTodo()` L191+, `src/services/ai/interpret.ts:interpretEntry()` L114–L149 (helpers `callClaude` L63–L74, `callOpenAI` L76–L93) — each carries the explicit `provider == 'openai' ? callOpenAI : callClaude` branch
**Toggle:**          `app/settings/ai.tsx` writes the new provider name to SecureStore — next AI call picks it up live
**Default:**         `claude` — Anthropic SDK gets the canonical path; OpenAI is the maintained alternate via raw `fetch` to `/v1/chat/completions` (with `response_format: json_object` for the JSON chains; interpret omits it because it wants markdown out)

---

## Elaborate

### Where this pattern comes from
LangChain's `BaseChatModel` is the unified-interface alternative. It works for the lowest common denominator. Buffr chose the opposite — explicit branches that stay honest about what each SDK can do.

### The deeper principle
**Honest duplication beats dishonest abstraction.** When the abstraction lies (papering over real differences), every reader has to remember the differences anyway. Writing the branch out makes the differences visible.

### Where this breaks down
- Adding a third provider triples the branch shape. At ~5 providers, the unified interface starts to win.
- Cross-cutting features (token counting, streaming, retries) have to land in both branches.

### What to explore next
- [01-system-design/11-provider-abstraction](../01-system-design/11-provider-abstraction.md) → the architectural framing.
- LangChain `BaseChatModel` → the unified-interface alternative.

---

## Tradeoffs

We traded a tidy `BaseChatModel` interface for 10 explicit branch arms that honestly reflect what each SDK can do — and got the freedom to use provider-specific features (OpenAI's `response_format: json_object`, Anthropic's prompt caching) without papering over differences.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (explicit branches) │ Alternative (BaseChatModel)    │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Provider-features│ OpenAI: response_format=json   │ lowest common denominator —    │
│ used             │ Anthropic: SDK + prompt rules  │ no json_object, no caching     │
│                  │ Both: each uses its strengths  │ knob, no provider-specific tool│
│ Vendor lock-in   │ low — swap models by changing  │ low at API level, but features │
│                  │ branch; live-switch in settings│ tied to interface shape        │
│ Cross-cutting    │ token counting / streaming /   │ one place to add a feature; 5  │
│ features         │ retries land in 10 places      │ chains pick it up for free     │
│ Cognitive load   │ grep `provider === 'claude'`   │ one interface, two impls — but │
│                  │ — uniform 20-line pair per     │ readers must remember the      │
│                  │ chain                          │ provider quirks anyway         │
│ Adding 3rd       │ 15 branch arms, 5 dup-pairs    │ one new implementor — abstract │
│ provider         │ → abstraction starts to win    │ pays back at N=3               │
│ Failure mode     │ loud — wrong branch → wrong    │ silent — abstraction lies, JSON│
│                  │ SDK call, stack trace clear    │ parsing fails downstream       │
│ Live switching   │ SecureStore read per call;     │ same — interface still reads   │
│                  │ next call sees new provider    │ config per call               │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up a single place to add cross-cutting features. If we want token counting, request retries, streaming, or per-provider rate-limit handling, those have to land in 10 branch arms (5 chains × 2 providers). Today none of those features exist in this codebase, which is why the cost is theoretical. The day we add streaming for caption output (a real product question — users would see the variants type out), we'll write the streaming logic twice — once for Anthropic's `client.messages.stream`, once for OpenAI's SSE response parsing. Two implementations, one feature.

We also pay a SecureStore read per AI call to resolve provider + key. SecureStore is fast (Android Keystore-backed) but not free — probably ~1-5ms each. On a network call that already costs 800ms-5s, this is below the noise floor. The benefit is that the user can switch providers in `app/settings/ai.tsx` and the next call picks it up live — no restart, no app-state reset.

### What the alternative would have cost

A `BaseChatModel` interface looks like the right move from the outside — one method, two implementations, callers stay simple. The hidden cost is what the interface *can't* express. OpenAI's `response_format: { type: 'json_object' }` enforces JSON server-side; Anthropic doesn't have an equivalent (we ask in the prompt and strip ``` ```json ``` fences defensively). A unified `chat(system, user, options)` interface either ignores `response_format` (and the OpenAI JSON chains lose their server-side guarantee) or accepts a provider-specific options bag (in which case the interface is leaky — callers still know which provider they're talking to).

The deeper cost is that the abstraction lies. Readers see `model.chat(...)` and think "one call, one shape." They forget that Anthropic charges per-token differently, has different rate limits, supports prompt caching with a 90% discount on cached input tokens (5min TTL), and returns content shaped as `{ content: [{ text }] }` while OpenAI returns `{ choices: [{ message: { content } }] }`. An honest abstraction surfaces these; a tidy one buries them.

Cross-cutting features would have been cheaper under the abstraction — but we have zero cross-cutting features today. Paying the abstraction cost up-front for features that don't exist is the YAGNI antipattern.

### The breakpoint

The pattern flips at three providers. With 2, the 10 branch arms have a uniform shape and `grep "provider === 'claude'"` finds every callsite in seconds. At 3, you have 15 arms and 5 pairs of near-identical code — the duplication starts to hurt, and the next cross-cutting feature lands in 15 places instead of one abstraction. The day we add Gemini, Mistral, or a local model, we extract a real `BaseChatModel` with a tagged-union return type (so OpenAI's `response_format` doesn't have to be papered over — it becomes a provider-specific option that the interface acknowledges).

A secondary trigger is cross-cutting feature volume. If we ship streaming + retries + token counting + rate-limit handling all in one sprint, the abstraction starts to pay back even at 2 providers — because 4 features × 10 arms = 40 places to update, vs 4 features × 1 abstraction = 4 places. Today: zero such features in the backlog.

### What wasn't actually a tradeoff

Reading provider per call vs caching it at app start was never a real performance tradeoff. SecureStore reads are sub-5ms and every AI call has a 800ms+ network round-trip behind it. The "cache it" path would have bought ~0% speedup at the cost of a stale-config bug the day a user re-keys. We picked the obvious option.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk

- **Codebase uses:** `@anthropic-ai/sdk` — `client.messages.create` with `claude-sonnet-4-6` / `claude-haiku-4-5`; the canonical provider branch.
- **Why it's here:** the Claude branch of every provider switch; the SDK the codebase defaults to.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling that wrappers sometimes flatten or delay.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures and `useChat` hook.

### Raw fetch to OpenAI `/v1/chat/completions`

- **Codebase uses:** native `fetch` to `https://api.openai.com/v1/chat/completions` with `response_format: json_object` and model `gpt-4o` / `gpt-4o-mini`.
- **Why it's here:** the OpenAI branch of the provider switch; used because `response_format: json_object` doesn't exist on the Anthropic side.
- **Leading today:** OpenAI Node SDK — `adoption-leading`, 2026.
- **Why it leads:** typed request/response shapes, built-in retries, and full coverage of all OpenAI API features including streaming and batch.
- **Runner-up:** Vercel AI SDK — `innovation-leading` wrapper unifying OpenAI + Anthropic + others behind one streaming interface.

### LangChain BaseChatModel

- **Codebase uses:** not used — named as the tidy-but-dishonest alternative to explicit per-provider branches.
- **Why it's here:** the file explicitly frames explicit branches as the deliberate rejection of `BaseChatModel`; understanding why it was skipped is the point.
- **Leading today:** Vercel AI SDK — `innovation-leading` for JS/TS multi-provider abstraction, 2026.
- **Why it leads:** typed message structures, streaming-first, framework-aware (Next.js / Remix / Nuxt); LangChain.js has adoption but Vercel AI SDK is the faster-moving JS/TS choice.
- **Runner-up:** LangChain.js — broad adoption and ecosystem; Python side is even broader; `BaseChatModel` pattern originates here.

---

## Project exercises

### [B1.6] Provider-swap eval across all five chains

- **Exercise ID:** `[B1.6]`
- **What to build:** A fixture set of 10 representative inputs per chain (50 total). Run each fixture through Claude (Sonnet 4.6 / Haiku 4.5 for classify) and through OpenAI (GPT-4o / GPT-4o-mini for classify) using the same prompt. Diff outputs side-by-side; document where the providers diverge meaningfully (JSON-format quirks, system-prompt handling, refusal patterns).
- **Why it earns its place:** "provider-agnostic at the service layer" is a claim until you've shown the swap works on real inputs. This is the receipt and surfaces the one or two places where the chains aren't actually provider-agnostic.
- **Files to touch:** new `scripts/provider-swap-eval.mjs`; fixtures under `scripts/fixtures/provider-swap/{summarize,caption,classify,expand,interpret}/`; reads existing chains from `src/services/ai/*.ts`.
- **Done when:** a `scripts/provider-divergences.md` exists listing every meaningful divergence (rubric or LLM-judge'd pairwise); at least one divergence is root-caused to a specific provider quirk or chain assumption.
- **Estimated effort:** `1–2 days`.

### [B1.9] user_overridden_* lock pattern audit (cross-link)

- **Exercise ID:** `[B1.9]` — primary exercise lives in [10-user-overridden-type-lock.md](./10-user-overridden-type-lock.md). Included here because provider swap is the most likely moment the lock could regress.
- **What to build:** A test fixture that runs `classify` on a todo with `user_overridden_type=1` and verifies the override survives a re-classification — on BOTH Claude and OpenAI classify outputs.
- **Why it earns its place:** the lock is the one place where provider behavior must NOT leak into user-visible state. Verifying both providers honor it closes the only real risk of provider abstraction breaking a user-facing invariant.
- **Files to touch:** `src/services/todos/classify.ts`, `src/services/todos/reconcileMeta.ts`; new test fixture.
- **Done when:** the fixture runs cleanly on both providers and asserts `user_overridden_type=1` is preserved end-to-end.
- **Estimated effort:** `<1hr` after `[B1.6]` plumbing.

---

## Summary

Provider abstraction is the layer that lets a caller use one of several interchangeable implementations behind a single interface, and the call-site-branch shape is the deliberately-honest variant of it. In this codebase every AI service reads `getProvider()` from `src/services/ai/config.ts` at call time and branches into either the Anthropic SDK (`client.messages.create`) or a raw fetch to OpenAI's `/v1/chat/completions` — 5 chains × 2 providers = 10 explicit branch arms across `summarize`, `caption`, `classify`, `expand`, and `interpret`. The constraint that drove it is honesty about real differences between the two SDKs — OpenAI's `response_format: json_object` exists, Claude's doesn't, and a unified `BaseChatModel` would either lie about that or force the lowest common denominator. The cost is duplicated code per caller and cross-cutting features (token counting, streaming, retries) landing in every branch arm. With a third provider added the unified-interface alternative starts winning.

Key points to remember:
- 5 chains × 2 providers = 10 explicit branch arms, each with a uniform call shape: get provider, get key, branch, parse, validate.
- Provider is read per call from SecureStore — live switching works mid-session without restart.
- OpenAI uses `response_format: json_object`; Claude uses prompt instructions plus defensive ``` ```json ``` fence stripping.
- Three providers is the threshold to extract a real `BaseChatModel` interface — at two, it's a switch with a uniform contract, not an abstraction.
- The cost is honest duplication: cross-cutting features land in 10 places instead of one.

---

## Interview defense

### What an interviewer is really asking
"Why didn't you build a `BaseChatModel` interface?" — they want to see whether I know what an abstraction *costs* and what it *pays back*. The interviewer is hunting for the candidate who reaches for LangChain's unified interface as a reflex. I want to land on: I have 2 providers × 5 chains = 10 explicit branch arms with a uniform call shape — that's a pattern, not an abstraction. A real abstraction needs three implementations to be worth writing.

### Likely questions

[mid] Q: Walk me through what happens in `summarize.ts` when the user has set provider=openai. Where does the branch live?
      A: `summarize.ts` calls `getProvider()` from `ai/config.ts` which reads SecureStore — synchronous-ish. It then calls `getOpenAIKey()`. If the key is missing it returns `{ error: 'no API key' }`. Otherwise it hits the OpenAI branch: a raw `fetch` to `/v1/chat/completions` with `response_format: { type: 'json_object' }`, `model: 'gpt-4o'`, system + user messages. The response comes back as `r.choices[0].message.content`, gets passed to `parseJson`, then to `validateSummary`. If provider had been `claude` the same function would have used `client.messages.create` from `@anthropic-ai/sdk` and read `r.content[0].text`. Same prompts, same validators, different SDK call.

```
[summarize provider branch — provider=openai path]

  summarize(date)
        │
        ▼  config.ts:getProvider() — SecureStore read
  provider === 'openai'
        │
        ├─ getOpenAIKey() missing → { error: 'no API key' }
        │
        ▼  callOpenAI(...)
  fetch /v1/chat/completions
    model: gpt-4o, response_format: json_object
        │
        ▼  r.choices[0].message.content
  parseJson() → validateSummary() → SQLite ai_summaries
```

[senior] Q: Why read provider on every call instead of once at app start?
         A: Two reasons. One: it lets the user switch providers in `app/settings/ai.tsx` without restarting the app — the next call picks up the new provider mid-session. Two: SecureStore reads are cheap, and there's no hot path where the cost matters (every call is followed by a network round-trip orders of magnitude slower). The cost of reading per-call is roughly zero; the cost of caching it would be a stale-config bug the day a user re-keys.

```
                  Path taken (read per call)          Alternative (cache at app start)
                  ─────────────────────────           ───────────────────────────────
SecureStore read  ~1-5ms per AI call                  one read at boot
network behind it 800ms-5s (dwarfs the read)          same — network unchanged
live switching    works mid-session                   user must restart app
stale-config bug  impossible                          re-key in settings → next call uses
                                                      stale key → 401 → loud failure
hot-path cost     0 (read << network)                 0 (read is one-time)
cognitive load    every call self-contained           must remember the cache exists
when this flips   reads cost more than network        never on this stack
```

[arch] Q: At what point does the `BaseChatModel`-style abstraction start winning? What's your threshold?
       A: Around three providers. With two, the 10 branch arms (5 chains × 2 providers) duplicate ~20 lines per pair and stay readable. At three, you'd have 15 arms and the duplication starts to hurt. At five, every cross-cutting concern (token counting, streaming, retry-with-backoff) lands in five places and the abstraction pays back. I'd extract a real interface the day I add the third provider. Today the call shape is uniform enough that "branch on provider" reads cleanly, and `response_format: json_object` only exists on OpenAI — a unified interface would either lie about that or force Claude to pretend it has the knob.

```
At 3+ providers OR 4+ cross-cutting features:

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — chains call the same function   │
  └─────────────────────────────────────────────┘
              │
  ┌─ Chains (5) ────────────────────────────────┐
  │ branch arms grow N=2→3 → 10→15 arms         │  ◀── duplication painful at N=3
  │ 5 pairs of near-identical pairs duplicated  │
  └─────────────────────────────────────────────┘
              │
  ┌─ Cross-cutting features ────────────────────┐
  │ streaming / retries / token counting        │  ◀── 4 features × 15 arms = 60 edits
  │ each lands in N×M places without abstraction│
  │ extract BaseChatModel with tagged-union out │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You have 10 `if (provider === 'claude')` branches across five files. You call this an "abstraction". How is it an abstraction?

A: Correct — it's a switch, not an abstraction. I called it abstraction in the docs because the call sites have a uniform shape and converge on the same parser/validator, but the implementations are duplicated. If I added Gemini tomorrow I'd have 15 branch arms, five pairs of near-identical code, and five places to update for every cross-cutting feature. The honest framing is: this is "duplicated implementation, uniform contract", and it's a deliberate stop short of a `BaseChatModel`. The day I add a third provider I'll extract a real interface — probably with a tagged-union return type so the OpenAI-only `response_format: json_object` doesn't have to be papered over. With two providers, an abstraction layer would have one consumer and five call sites and not pay back. I'd rather grep for `'claude'` than read three layers of indirection.

```
                  Path taken (uniform switch)         Suggested (BaseChatModel today)
                  ──────────────────────────          ───────────────────────────────
honesty           "switch on provider"; quirks visible "one interface"; quirks hidden
provider features OpenAI json_object usable           interface ignores it OR leaky opts
adding provider   write 5 new branch arms             write 1 new implementor
adding feature    edit 10 places                      edit 1 interface
quirks readers    visible at call site                must know per-provider gotchas
                                                      anyway
N where pays back N >= 3 providers                    paid up-front at N=2 for no return
solo-dev fit      grep and read; ~20 LOC per pair     ~3 layers of indirection to trace
honesty score     high — the differences are real     low — interface flattens what's not
```

### One-line anchors
- "It's a switch, not an abstraction. Honest duplication beats dishonest abstraction."
- "Read provider per call. SecureStore is cheap; restart-required is not."
- "Three providers is the day I extract `BaseChatModel`."
- "OpenAI's `response_format: json_object` is exactly the kind of detail a unified interface lies about."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain LLM provider switching to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/ai/config.ts:getProvider` + a representative branch site
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

The user is mid-day, has been using Claude. They open Settings → AI and switch the provider to OpenAI. They go back to the journal and edit an entry. Walk what happens on the next caption call: does anything refresh? Does the open caption screen rebind? What if they had pressed "expand" on a todo at the moment of the switch — which provider answers?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/caption.ts` L201–L223 and `src/services/ai/config.ts` L9–L12 to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/summarize.ts:callClaude` and `:callOpenAI` (the explicit two-function shape) to support what exists
→ Point to where a `BaseChatModel` interface would land (a new `src/services/ai/provider.ts` + 5 refactored callsites) if you chose the alternative

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
Updated: 2026-05-10 — branch-site count grew from 4 to 5 (interpret added with its own callClaude/callOpenAI pair).
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block; corrected "four providers × four callsites = eight functions" to "5 chains × 2 providers = 10 explicit branch arms" throughout (diagram, pseudocode header, mid/senior/arch/dodge interview answers, Level 4).
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram. Added architectural-layer labels (Service → Config → Provider/network → Service) since the flow crosses callsite, config-store, SDK/network, and parse/validate boundaries.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk, raw fetch to OpenAI /v1/chat/completions, LangChain BaseChatModel.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (two-faucets-one-drain metaphor opening / 4 layered sub-sections — config from SecureStore, Claude SDK vs OpenAI raw fetch branch, shared parse-validate-persist tail, what stays vs what changes — each with frontend bridges and concrete consequences / principle paragraph on thin abstractions over thick differences).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (two-espresso-machines-on-the-counter scenario → "thin choice at each call site, everything else shared" pattern naming → bolded stakes pivot to `getProvider()` + per-chain `switch` keeping JSON-mode and tool-calling per-vendor-native → before/after bullets on unified-wrapper vs per-call-site → one-line "thin abstractions over thick differences" metaphor).

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care + How it works to anchor on real software (replaced two-espresso-machines + two-faucets analogies with Stripe's `PaymentIntent` `payment_method_types` + React Native's `.ios.ts` / `.android.ts` platform-specific module pattern + Vercel adapter pattern). How it works HIW1 was missed by the original triage; included in this pass.

---
Updated: 2026-05-14 — v1.32.0 pass: dropped Stripe `PaymentIntent` + Vercel adapter (level-5 whole-products) from both Why care + How it works Move 1; led with the level-1 primitive (`switch (provider)` block at each call site) plus React Native `.ios.ts`/`.android.ts` (level-1). Added Move 1 mnemonic diagram (switch + shared-tail flow) + 3 Move 2 sub-section diagrams: config module signature + key-cache, two-branch side-by-side, shared-tail pipeline. Existing sub-section 4 markdown table left in place (acceptable outside Tech reference). Total: 4 new diagrams.
