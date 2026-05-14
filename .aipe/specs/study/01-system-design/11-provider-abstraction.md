# Provider abstraction (LLM)

**Industry name(s):** Strategy pattern, Adapter pattern, Provider pattern
**Type:** Industry standard · Language-agnostic

> Every AI service file imports `getProvider`, branches twice (once on the request, once on the model id), then converges on the same downstream parse step.

**See also:** → [03-ai-engineering/04-provider-abstraction](../03-ai-engineering/04-provider-abstraction.md) · → [03-ai-engineering/02-single-purpose-chains](../03-ai-engineering/02-single-purpose-chains.md)

---

## Why care

React Native's platform-specific module pattern — `Foo.ios.ts` and `Foo.android.ts` resolved by the bundler based on the platform target — is exactly this shape. The component imports `from './Foo'`; the bundler picks the right file; the rest of the app is platform-agnostic. The day a platform changes, only the platform-specific file changes; everything that imports `./Foo` stays put. Stripe's `PaymentIntent` accepts `payment_method_types: ['card', 'apple_pay', 'us_bank_account']` for the same reason — same upstream call, same downstream parse, only the method picked at request time changes. Vercel's adapter pattern lets the same Next.js app target Edge or Node runtimes with one swap point.

The question those swap-point patterns answer is one any codebase with replaceable backends has to answer: when a vendor changes pricing, deprecates an endpoint, or goes down for a day, how prepared is the call site for a swap? Not "sprinkle the vendor's SDK across every file" — that's a week-long chase to swap providers. Not "wrap everything behind a single interface that both vendors satisfy" — that interface becomes the surface area that breaks when one vendor adds a feature the other doesn't have. The answer is a *thin strategy seam*: pick provider, then branch in each call site, then converge on a shared tail.

**What depends on getting this right:** whether adding or swapping a third-party LLM provider costs an afternoon or a week, and whether each provider's native features (Claude's prompt caching, OpenAI's `response_format: json_object`) can be used without an abstraction smearing them flat. In this codebase `src/services/ai/config.ts` exposes `getProvider()` (returns `'claude'` or `'openai'`) and `getApiKey(provider)`, both reading from `expo-secure-store`. Every AI service file (`summarize.ts`, `classifyTodo.ts`, `expandTodo.ts`, `generateCaption.ts`, `interpret.ts`) starts the same way: read the provider, then `switch (provider)` with two branches — Claude calls `@anthropic-ai/sdk`'s typed `client.messages.create({...})`; OpenAI builds a raw `fetch` to `https://api.openai.com/v1/chat/completions`. Both branches produce a string. The shared tail (parse JSON, validate against a Zod-like schema in `validate.ts`, persist via `database.ts`) runs identically regardless. There's no `AIProvider` interface — the abstraction is at the call-site, not in a shared contract.

Without the seam (Claude SDK called directly in every service file):
- Anthropic raises prices 3x; team decides to test OpenAI for one chain
- The `summarize.ts` Claude call is interwoven with prompt-building, retry logic, and response parsing
- Swapping requires rewriting 5 service files; each rewrite risks regressions in prompt logic
- The team gives up and eats the cost increase

With the thin seam (`getProvider()` + branch + shared tail):
- Same price hike; swap one line in `config.ts` to default to `'openai'`
- Every service file's branch picks up the new provider on the next call
- Each branch can still use that provider's native features (Claude's prompt caching survived because the abstraction never tried to express it)
- The swap is one config write plus a smoke test

The seam is `Foo.ios.ts` / `Foo.android.ts` — one import path, two implementations, picked at resolution time.

---

## How it works

React Native's `.ios.ts` / `.android.ts` resolution is the canonical pattern. Two implementations behind one import path; the bundler picks one based on the platform target; everything that imports the path is platform-agnostic. The codebase has two AI providers (Claude and OpenAI) wired to the same call shape — pick provider, get key, build prompt, call, parse JSON, persist. The two providers are the platforms; the import path is the chain function; the resolution lives in `getProvider()` reading from SecureStore at call time. Same shape as Stripe's `payment_method_types` parameter — one upstream call, one downstream parse, only the swap point changes.

### The config — `getProvider()` + key getters from SecureStore

`src/services/ai/config.ts` exposes `getProvider()` (returns `'claude'` or `'openai'`) and `getApiKey(provider)`. Both read from `expo-secure-store` (Android Keystore-backed), so the key never lives in JS bundle or plain disk. The reads are async but cached — first call hits the keystore, subsequent calls hit memory. If you're coming from frontend, this is the same shape as a React Context that holds the active feature-flag config — the consumer doesn't care where the config came from, only that it's typed and available synchronously after the first await. Concrete consequence: every AI service file starts with `const provider = await getProvider(); const apiKey = await getApiKey(provider);` — two await calls that are essentially free after the first one. The pattern keeps the keystore reads in one named place; if the storage backend changes (encrypted file, env var, server-side fetch), only `config.ts` needs editing. Boundary: this assumes the key was set during cloud-sync onboarding; if the user opens an AI feature without configuring keys, the call throws and the UI shows an "AI not configured" hint.

### The branch — Claude SDK vs raw fetch to OpenAI

Every AI service has the same structure: a `switch (provider)` (or `if/else`) with two branches. The Claude branch calls `@anthropic-ai/sdk`'s typed `client.messages.create({...})`. The OpenAI branch builds a `fetch` to `https://api.openai.com/v1/chat/completions` with hand-crafted JSON. If you're coming from frontend, this is the same pattern as two `useQuery` calls in the same hook, switched by a config boolean — same shape of output, different transports. Concrete consequence: in `src/services/ai/summarize.ts`, the Claude branch builds a `messages: [{role: 'user', content: prompt}]` and pulls the text out of `response.content[0].text`. The OpenAI branch builds the same prompt structure plus `response_format: {type: 'json_object'}` (Claude doesn't have that knob, so the Claude branch has to extract JSON from prose), POSTs, and reads `response.choices[0].message.content`. Both branches return a string; the caller doesn't know or care which provider produced it. Boundary: the abstraction is at the *call-site*, not in a shared interface — there's no `AIProvider` interface that both implementations satisfy. The branches diverge in body but converge on the contract (string in, string out). Adding a third provider means three branches in N service files, not one new class.

### The shared tail — parse, validate, persist

After both branches return their string, every AI service runs the same tail: extract JSON (regex or `JSON.parse`), validate against a Zod-like schema (custom validators in `src/services/ai/validate.ts`), persist to SQLite via the `database.ts` helpers ([01-local-first-request-flow](./01-local-first-request-flow.md)). Think of it like a React Query mutation's `onSuccess` — the transport produced the data, now the standard write-and-cache path takes over. Concrete consequence: `summarize.ts` calls the LLM, gets `'{"clipOrder":[...], "filter":"warm", ...}'`, runs `parseAISummary` to lift it into a typed object, calls `upsertAISummary(date, summary)` in `database.ts`. The cloud sync layer picks it up 5s later. Boundary: the validate step is where bad outputs get caught — if Claude returns a malformed JSON inside markdown fences, the validator throws, the UI surfaces an error toast, the user can retry. The persist step trusts the validated object.

### Why no shared interface — the leak that wasn't worth abstracting

The textbook move would be to define `interface AIProvider { call(prompt: string): Promise<string> }` and have both providers satisfy it. The codebase deliberately doesn't. The reason: the two providers diverge on more than just transport — Claude doesn't have `response_format: json_object`, OpenAI doesn't have Claude's prompt caching, error shapes differ, rate-limit headers differ. Any interface that abstracts both leaks at the edges; the abstraction either lowest-common-denominators (losing both providers' unique features) or grows knobs the leaf services have to thread through. If you're coming from frontend, this is the same situation as trying to wrap `fetch` and `axios` behind a common interface — possible, but the leaks (`onUploadProgress`, retry semantics, response.data shape) usually cost more than the indirection saves. Concrete consequence: a new provider requires touching every AI service file once (a `switch` arm in each). The cost is real (5 files × ~10 LOC each = 50 LOC per new provider). The benefit is that each branch can use the provider's unique features without an interface contract dragging it down. Boundary: at 4+ providers the boilerplate would justify an interface; at 2 it doesn't.

This is what people mean by "thin abstractions over thick differences." The temptation is always to wrap a divergent set of APIs behind a unified interface — but the interface itself becomes the surface area that breaks when one provider adds a new feature. The codebase trades a little duplication (`switch (provider)` in N files) for the ability to use each provider's native shape directly. Every codebase that ever survived a major version upgrade of a vendor library has some version of this discipline: keep the wrapper thin enough that you can rewrite it; keep the callers naive enough that they don't depend on the wrapper's quirks. The full picture is below.

---

## Provider abstraction — diagram

```
┌─ Service layer (AI callsites) ──────────────────────────────────────────┐
│  summarize(date) / classifyTodo(text) / expandTodo(...) / generateCaption(...)
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌─ Service layer (config) ────────────────────────────────────────────────┐
│                            ┌──────────────────────┐                     │
│                            │  ai/config.ts        │                     │
│                            │  getProvider() → 'claude' | 'openai'       │
│                            └─────────┬────────────┘                     │
└──────────────────────────────────────┼──────────────────────────────────┘
                                       │
                ┌──────────────────────┼──────────────────────┐
                ▼                                             ▼
┌─ Provider: Anthropic ──────────┐          ┌─ Provider: OpenAI ─────────┐
│  provider == 'claude'          │          │  provider == 'openai'      │
│  @anthropic-ai/sdk             │          │  raw fetch + JSON          │
│  models.create({ ... })        │          │  /v1/chat/completions      │
└──────────────┬─────────────────┘          └──────────────┬─────────────┘
               │                                           │
               └─────────────────────┬─────────────────────┘
                                     ▼
┌─ Service layer (post-call) ─────────────────────────────────────────────┐
│                  same shape: string of model output                     │
│                                  │                                      │
│                                  ▼                                      │
│                 callsite parses + validates + persists                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Provider read:**   `src/services/ai/config.ts` → `getProvider()` L9–L12, `getAnthropicKey()` + `getOpenAIKey()` L18–L40 (whole file is L1–L50)
**Branch sites (5):** `src/services/ai/summarize.ts` L42–L105, `caption.ts:generateCaption()` L201–L223, `src/services/todos/classify.ts:classifyTodo()` L90+, `src/services/todos/expand.ts:expandTodo()` L191+, `src/services/ai/interpret.ts:interpretEntry()` L114–L149 (helpers `callClaude` L63–L74, `callOpenAI` L76–L93) — each carries the `provider == 'openai' ? callOpenAI : callClaude` branch explicitly
**User toggle:**     `app/settings/ai.tsx` writes the new provider name to SecureStore — next AI call picks it up live (no restart, no cache invalidation)
**Default:**         `claude` (Anthropic SDK gets the canonical path; OpenAI is the maintained alternate via raw `fetch`)

```
Pseudocode (the shape every caller follows):
  provider = await getProvider()
  apiKey   = provider == 'openai' ? await getOpenAIKey() : await getAnthropicKey()
  if !apiKey: return { error: 'no API key' }

  raw = provider == 'openai'
        ? await callOpenAI(apiKey, system, user)
        : await callClaude(apiKey, system, user)

  parsed = extractJson(raw)
  validated = validateAgainstSchema(parsed)
  persist(validated)
```

---

## Elaborate

### Where this pattern comes from
Multi-provider AI abstraction was popularised by LangChain's `BaseChatModel` interface — one shape, many providers. The trade-off has been visible since 2023: unified interfaces either lie (papering over real differences like JSON mode, system prompts, tool calling) or constrain to the lowest common denominator (no caching, no streaming, no provider-native features).

### The deeper principle
**Two cleanly-different code paths beat one half-true unified interface.** When the abstraction is a lie, every reader has to remember what's actually different — the abstraction stops helping. Loopd writes the branch out.

### Where this breaks down
- Adding a third provider duplicates the branch shape three more times. At ~5 providers, the unified interface starts to win.
- New cross-cutting features (token counting, retries, streaming) have to land in both branches. There's no shared layer to hold them.

### What to explore next
- [03-ai-engineering/04-provider-abstraction](../03-ai-engineering/04-provider-abstraction.md) → the AI-engineering framing of the same pattern.
- LangChain `BaseChatModel` → for the unified-interface alternative.

---

## Tradeoffs

We traded one shared interface for ten honest branches: each provider gets its native API, and every caller pays a small duplication tax to keep provider quirks visible at the call site instead of hidden behind a lie.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (explicit branch) │ Alternative (BaseChatModel)  │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Code paths       │ 5 chains × 2 providers = 10  │ 5 chains × 1 interface = 5;  │
│                  │ branch arms                  │ +1 file per provider impl    │
│ Provider quirks  │ visible at branch — e.g.,    │ hidden; interface picks LCD  │
│                  │ response_format: json_object │ or papers over the gap       │
│                  │ on OpenAI only               │ (silent failure on Claude)   │
│ Cross-cutting    │ token counting / retry /     │ lands in one place           │
│ features         │ streaming lands in N×M places│                              │
│ Live switching   │ SecureStore read per call    │ same — interface picks impl  │
│                  │ (~ms) → next call switches   │ at call time                 │
│ Adding 3rd       │ +5 branch arms (15 total)    │ +1 implementor file          │
│ provider         │                              │                              │
│ Code surface     │ ~50 LOC duplicated per pair  │ +1 interface file + 1 impl   │
│                  │                              │ per provider                 │
│ Onboarding       │ "switch on provider" obvious │ "what does the interface     │
│                  │ in 5 seconds                 │ guarantee?" — needs reading  │
│ Honesty score    │ high — differences visible   │ low — interface flattens     │
│                  │                              │ what's not actually flat     │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

Every chain carries the `provider == 'openai' ? callOpenAI : callClaude` branch explicitly. With 5 chains (summarize, caption, classify, expand, interpret) and 2 providers that's 10 branch arms — ~50 LOC of near-identical code per pair. A new cross-cutting feature like token counting would land in 10 places; retry-with-backoff in 10 places. We've shipped neither because the cost is visible — and the moment we want one, the duplication tax becomes the work.

The default is Claude (Anthropic SDK), and OpenAI is the maintained alternate via raw `fetch`. When the SDKs diverge — Anthropic ships a new feature, OpenAI ships its own — Claude's lands first because that's the canonical path. The OpenAI branch tends to lag by a feature, which is fine when "OpenAI is the alternate" is honest but would be wrong if both branches were meant to be equally maintained.

Every AI call hits SecureStore for the provider read. SecureStore is fast (a few ms on Android Keystore-backed reads), but it's not free, and the cost is paid on every call. We've never observed this in profiling — the LLM call is 800ms+ — but at very high call rates it would show up.

### What the alternative would have cost

A `BaseChatModel`-style interface would mean one new file (`src/services/ai/provider.ts` with an `AIProvider` interface), one implementor per provider (today: Anthropic + OpenAI), and a factory call replacing each branch. Net code reduction: ~50 LOC × N pairs. At 2 providers and 5 chains that's a real saving once.

The hidden cost: every provider-specific feature has to either fit the interface or be lost. OpenAI's `response_format: json_object` (a parameter we depend on for JSON chains) has no Claude equivalent — the interface would either lie ("supports JSON mode" with silent failure on Claude) or constrain to the lowest common denominator (no JSON mode, weaker reliability everywhere). System-prompt placement, streaming, caching, tool-use shape — all of these diverge in shape and an interface either flattens them or leaks them through option bags that defeat the unification.

Onboarding cost rises. A new contributor reading the codebase sees a factory call and has to track down which implementor runs, then read that implementor to find the provider quirks. With the explicit branch they grep for `'claude'` and see exactly what runs.

### The breakpoint

Fine until the third provider lands. With 3 providers × 5 chains = 15 branch arms and three pairs of near-identical code, the duplication starts costing more than the leaky-abstraction tax. The day a third provider is real (Gemini becoming a top-tier option, or the user demanding a local Ollama path) is the day we extract a `BaseChatModel`-style interface with a tagged-union return type — the tagged union is what lets provider-specific features still surface without being papered over.

### What wasn't actually a tradeoff

A "switch on provider name globally and use shared SDK adapters" path wasn't on the table. The SDK shapes are too different — `@anthropic-ai/sdk`'s `messages.create` has a different request shape than OpenAI's `/v1/chat/completions` raw fetch (which we use because the OpenAI Node SDK adds dependency weight we don't want on a mobile build). Any shared layer above the SDKs would itself be the abstraction we're discussing.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk

- **Codebase uses:** `@anthropic-ai/sdk` (Claude Sonnet / Haiku).
- **Why it's here:** the canonical path for all Claude calls; the default branch in every AI service file.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling that wrappers sometimes flatten.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures and `useChat` hook.

### Raw fetch to OpenAI (`/v1/chat/completions`)

- **Codebase uses:** raw `fetch` — no OpenAI Node SDK.
- **Why it's here:** OpenAI is the maintained alternate; raw `fetch` avoids Node SDK dependency weight on mobile.
- **Leading today:** OpenAI Node SDK — `adoption-leading`, 2026.
- **Why it leads:** typed request/response shapes, built-in retries, and official first-party support.
- **Runner-up:** Vercel AI SDK — `innovation-leading` wrapper unifying OpenAI + Anthropic + others behind one streaming interface.

### LangChain BaseChatModel

- **Codebase uses:** not used — named as the rejected alternative.
- **Why it's here:** the file frames the explicit-branch decision against the LangChain unified-interface path.
- **Leading today:** Vercel AI SDK — `innovation-leading`, 2026.
- **Why it leads:** typed message structures, streaming-first, and framework-aware (Next.js / Remix / Nuxt); LangChain.js adoption lags its Python side.
- **Runner-up:** LangChain.js — still has adoption in JS/TS for agent orchestration and tool-use chains.

---

## Summary

The strategy pattern keeps the call site stable while letting the implementation behind it change at runtime, chosen by configuration or user preference. In this codebase `getProvider()` in `src/services/ai/config.ts` returns `'claude' | 'openai'` from SecureStore, and every AI service file (`summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts`, `interpret.ts`) carries an explicit two-arm branch — Claude via `@anthropic-ai/sdk`, OpenAI via raw `fetch` to `/v1/chat/completions` — before converging on a shared parse/validate/persist step. The constraint was that the app sells AI features without locking the user into one provider, and unified `BaseChatModel`-style interfaces either lie about provider-specific knobs (OpenAI's `response_format: json_object`) or constrain to a lowest common denominator. The cost is that every caller carries the branch: 5 chains × 2 providers = 10 explicit code paths, with no shared layer to hold cross-cutting features like token counting or retries. At three or more providers the duplication would start to feel redundant and a `BaseChatModel`-style interface would be the better call.

Key points to remember:
- The shape every caller follows is `getProvider()` → key getter → branch → parse → validate → persist; the branch is the only divergence.
- Live switching works because `getProvider()` reads SecureStore on every call, not from a cached union — toggling provider in `app/settings/ai.tsx` takes effect on the next AI call with no restart.
- Lives in step 2 (Request flow) of the system-design checklist.
- Each branch uses the provider's optimal API (e.g., `response_format: json_object` on OpenAI for the JSON chains; interpret omits it because it wants markdown out) — a unified interface would lose that.
- 5 chains × 2 providers = 10 code paths today; at 3+ providers the duplication starts costing more than the leaky-abstraction tax of a `BaseChatModel`-style interface.

---

## Interview defense

### What an interviewer is really asking
"Provider abstraction" is a phrase that triggers strong opinions. The interviewer wants to know whether you understand that LangChain-style unified interfaces lie about provider-specific features — and whether your decision to *not* unify was deliberate or accidental. The dodge they're testing for: did you ship duplicated code and call it abstraction?

### Likely questions

[mid] Q: A user switches from Claude to OpenAI mid-session. What actually happens?

A: They tap the provider toggle in `app/settings/ai.tsx`, which writes the new provider name to SecureStore. The next AI call (e.g. typing a new entry that triggers `summarize`) reads `getProvider()` from `ai/config.ts` — which hits SecureStore live, not a cached value. The branch then takes the OpenAI path: raw `fetch` to `/v1/chat/completions` with the OpenAI key. No restart, no cache invalidation, no warm-up. The cost is one SecureStore read per AI call, but SecureStore is fast on Android (a few ms) and the LLM call itself is the dominant latency.

```
[mid-session provider toggle]

  app/settings/ai.tsx → SecureStore.setItemAsync('ai_provider', 'openai')
        │
        ▼ next AI call fires (e.g. summarize)
  getProvider() reads SecureStore       ← fresh read, no cache
        │
        ▼ returns 'openai'
  branch: provider == 'openai' ? callOpenAI : callClaude
        │
        ▼ callOpenAI: raw fetch /v1/chat/completions
  parse + validate + persist (shared path)
```

[senior] Q: Why didn't you build a `BaseChatModel`-style interface like LangChain does? You'd cut the duplicated code in half.

A: I'd also lose the OpenAI `response_format: json_object` parameter — Claude doesn't have that knob, and a unified interface would have to either skip it (lower JSON compliance from OpenAI) or pretend to support it on Claude (and fail silently when the model returns prose). Same problem with system-prompt placement, with caching, with streaming. The unified interface either lies about provider differences or constrains to the lowest common denominator. With two providers, the duplication cost is one branch per call site — four branches total. With five providers I'd reconsider; the abstraction starts paying back when the duplicated code outweighs the cost of leaky abstraction.

```
                  Path taken (explicit branches)        Alternative (BaseChatModel interface)
                  ──────────────────────────────        ──────────────────────────────────
JSON mode (OpenAI) used directly at branch              interface ignores OR fakes — silent
                                                          failure on Claude
quirks visible    at every callsite                     hidden behind interface
duplication today 10 branch arms (~50 LOC × 5 pairs)    0 (one interface, two implementors)
adding feature    edit 10 places                        edit 1 interface
where it pays back 3+ providers                          2 providers — already there if
                                                          features were uniform (they're not)
honesty           differences are real, visible         flattens what isn't flat
debugging         grep for 'claude' — see exact path    follow factory → impl → quirks
ship correctness  high — quirks land at callsite        risk — interface drift over time
right call when   features diverge per-provider         features genuinely converge
```

[arch] Q: What changes if you wanted to add a third provider — Gemini, say?

A: Three things break. First, `getProvider()` returns a string union of two values; that becomes three. Second, every AI service file (summarize, caption, classify, expand) has a two-way branch; each becomes three-way. Third, the `ai/config.ts` key getter needs a `getGoogleKey()`. The code stays parallel — same shape four times — but at three providers the duplicated branch starts feeling redundant. That's where I'd extract a small interface: `interface AIProvider { complete(system, user): Promise<string> }` with three implementations. The branch becomes a factory call. I haven't done it yet because two providers don't need it.

```
At N=3 providers (e.g. + Gemini):

  ┌─ UI layer ──────────────────────────────────┐
  │ +1 toggle option in settings/ai.tsx          │
  └─────────────────────────────────────────────┘
              │
  ┌─ config layer ──────────────────────────────┐
  │ getProvider(): 'claude'|'openai'|'google'   │
  │ getGoogleKey() — new key getter              │
  └─────────────────────────────────────────────┘
              │
  ┌─ Chain layer (5 chains) ────────────────────┐
  │ branch arms 10 → 15                          │  ◀── BREAKS FIRST
  │ duplication starts costing more than         │     (extract AIProvider interface
  │ leaky-abstraction tax                        │      with tagged-union return, 3 impls)
  └─────────────────────────────────────────────┘
              │
  ┌─ Provider implementations ──────────────────┐
  │ +1 file: src/services/ai/providers/google.ts │
  │ existing 5 chains refactor to factory call   │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You have eight code paths (four call sites × two providers). You call this an abstraction in your docs, but it's clearly just a switch. Defend the naming.

A: It's a fair callout — "abstraction" is the wrong word in the strict sense. What I have is a switch with parallel implementations. The reason I called it an abstraction in the docs is that the *call sites* have a uniform shape: get provider, get key, branch, parse, validate, persist. From the perspective of `app/` code calling into `services/ai/`, the provider is hidden — `summarize(date)` returns the same shape regardless of who answered. From the perspective of `services/ai/summarize.ts` itself, the duplication is real and visible. If I were renaming the docs today, I'd call it "provider switching" with a note that the abstraction line is at the call site, not the implementation. The honest version of the doc is "I made a deliberate choice to not extract a provider interface; here's why." When I add a third provider, the renaming becomes "provider interface" because the extraction will have happened.

```
                  Path taken (named "abstraction")      Suggested (truly extract interface)
                  ──────────────────────────────        ──────────────────────────────────
abstraction line  at call site (app/ sees uniform)      at implementation (services/ai/ sees
                                                          uniform too)
naming honesty    misnamed — it's a switch              accurate — interface + implementors
implementation    duplicated per provider               unified per provider via interface
features kept     full provider features at branch      LCD or leaky options-bag
LOC impact        +0 (current state)                    -50 LOC duplication, +1 interface
                                                          file, +2 implementor files
right naming today "provider switching" + rationale     n/a — no abstraction extracted yet
right naming      "provider interface" — extraction      "provider interface" — extraction
post-3rd-provider has happened                          has happened
mitigation today  rewrite doc to honest framing         (deferred until 3rd provider)
```

### One-line anchors
- "I have provider switching, not provider abstraction — the call sites are uniform, the implementations are not."
- "Two cleanly-different code paths beat one half-true unified interface; LangChain's `BaseChatModel` is the cautionary case."
- "Live switching works because `getProvider()` reads SecureStore on every call — the cost is a few ms; the win is no restart."
- "At three providers I'd extract; at two, the duplication is the cheaper option."

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
- Name the specific file or function?  → `src/services/ai/config.ts:getProvider` + each branch site
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

You want to add Gemini as a third provider. Walk through what changes file-by-file: the type union in `getProvider`, the new key getter, and each branch site. Where does the duplication start to feel like the wrong shape, and at what number of providers would you actually extract a `BaseChatModel` interface?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/config.ts` and `src/services/ai/summarize.ts` L42–L105 to verify the current branch shape.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/summarize.ts` L42–L105 (the explicit two-branch shape) to support what exists
→ Point to where a `BaseChatModel` interface would land (a new `src/services/ai/provider.ts` module + four refactored callsites) if you chose the alternative

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
Updated: 2026-05-10 — branch-site count grew from 4 to 5 (interpret added). 4 callsites × 2 providers became 5 × 2 = 10 code paths.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet + restored missing `## Quick summary` heading + disambiguated `expand.ts` path to `src/services/todos/expand.ts`.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram; added architectural-layer labels to the primary diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk, Raw fetch to OpenAI, LangChain BaseChatModel.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (power-strip-two-outlets metaphor opening / 4 layered sub-sections — config from SecureStore, Claude SDK vs OpenAI raw fetch branch, shared parse-validate-persist tail, why no shared interface — each with frontend bridges and concrete consequences / principle paragraph on thin abstractions over thick differences).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (two-stoves-one-switch kitchen scenario → thin strategy seam named as the answer → bolded "what depends on getting this right" with getProvider/switch-branch/shared-tail stakes → before/after walking an Anthropic-to-OpenAI swap → one-line "the seam is a switch on the counter — same pan, different burner").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced kitchen-two-stoves + power-strip analogies with React Native platform-specific module pattern .ios.ts/.android.ts + Stripe PaymentIntent payment_method_types + Vercel adapter). Both Move 1s were missed by the original triage agent.
