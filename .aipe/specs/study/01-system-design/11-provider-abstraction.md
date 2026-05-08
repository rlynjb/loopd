# Provider abstraction (LLM)

> Every AI service file imports `getProvider`, branches twice (once on the request, once on the model id), then converges on the same downstream parse step.

**See also:** → [03-ai-engineering/04-provider-abstraction](../03-ai-engineering/04-provider-abstraction.md) · → [03-ai-engineering/02-single-purpose-chains](../03-ai-engineering/02-single-purpose-chains.md)

---

## Quick summary
- **What:** four AI services (summarize, caption, classify, expand). Each branches on `'claude' | 'openai'`. Same prompts, same JSON contract, different SDK calls.
- **Why here:** the app sells AI features but doesn't lock the user into one provider. SecureStore keys can be either; the user picks. Default is Claude.
- **Tradeoff:** every caller carries the branch — there is no single `BaseModel.invoke` interface. Two providers, four callsites, eight code paths. Worth it because each path can use the provider's optimal API.

---

## Provider abstraction — diagram

```
  callsite: summarize(date) / classifyTodo(text) / expandTodo(...)  / generateCaption(...)
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │  ai/config.ts        │
                            │  getProvider() → 'claude' | 'openai'
                            └─────────┬────────────┘
                                      │
                ┌─────────────────────┼─────────────────────┐
                ▼                                           ▼
        provider == 'claude'                        provider == 'openai'
                │                                           │
                ▼                                           ▼
        @anthropic-ai/sdk                            raw fetch + JSON
        models.create({ ... })                       /v1/chat/completions
                │                                           │
                └─────────────────────┬─────────────────────┘
                                      ▼
                       same shape: string of model output
                                      │
                                      ▼
                      callsite parses + validates + persists
```

---

## How it works

`ai/config.ts` exposes `getProvider()` and key getters. Both reads hit SecureStore — fast and synchronous (well, async-promise but cached). Every AI service starts with: get provider, get key, branch.

The branches are intentionally explicit. The Claude branch uses `@anthropic-ai/sdk` directly; the OpenAI branch uses raw `fetch` to `/v1/chat/completions` so the codebase can pass `response_format: json_object` (Claude doesn't have that knob).

After both branches return, the rest of the function is shared: extract JSON, validate against schema, persist to SQLite, return.

---

## In this codebase

- `src/services/ai/config.ts` → `getProvider()`, `getAnthropicKey()`, `getOpenAIKey()`.
- `src/services/ai/summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts` — each implements the same branch pattern.
- The default provider is `claude`; the user can switch in `app/settings/ai.tsx`.

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

- **Explicit branches** — gives: each provider can use its optimal API. Costs: every caller has to know about both.
- **Read provider per call** — gives: live switching works without restart. Costs: every call hits SecureStore (fast but not free).
- **Default Claude, OpenAI optional** — gives: Anthropic SDK gets the canonical path; OpenAI is a maintained alternate. Costs: when the SDKs diverge, Claude features land first.

---

## Interview defense

### What an interviewer is really asking
"Provider abstraction" is a phrase that triggers strong opinions. The interviewer wants to know whether you understand that LangChain-style unified interfaces lie about provider-specific features — and whether your decision to *not* unify was deliberate or accidental. The dodge they're testing for: did you ship duplicated code and call it abstraction?

### Likely questions

[mid] Q: A user switches from Claude to OpenAI mid-session. What actually happens?

A: They tap the provider toggle in `app/settings/ai.tsx`, which writes the new provider name to SecureStore. The next AI call (e.g. typing a new entry that triggers `summarize`) reads `getProvider()` from `ai/config.ts` — which hits SecureStore live, not a cached value. The branch then takes the OpenAI path: raw `fetch` to `/v1/chat/completions` with the OpenAI key. No restart, no cache invalidation, no warm-up. The cost is one SecureStore read per AI call, but SecureStore is fast on Android (a few ms) and the LLM call itself is the dominant latency.

[senior] Q: Why didn't you build a `BaseChatModel`-style interface like LangChain does? You'd cut the duplicated code in half.

A: I'd also lose the OpenAI `response_format: json_object` parameter — Claude doesn't have that knob, and a unified interface would have to either skip it (lower JSON compliance from OpenAI) or pretend to support it on Claude (and fail silently when the model returns prose). Same problem with system-prompt placement, with caching, with streaming. The unified interface either lies about provider differences or constrains to the lowest common denominator. With two providers, the duplication cost is one branch per call site — four branches total. With five providers I'd reconsider; the abstraction starts paying back when the duplicated code outweighs the cost of leaky abstraction.

[arch] Q: What changes if you wanted to add a third provider — Gemini, say?

A: Three things break. First, `getProvider()` returns a string union of two values; that becomes three. Second, every AI service file (summarize, caption, classify, expand) has a two-way branch; each becomes three-way. Third, the `ai/config.ts` key getter needs a `getGoogleKey()`. The code stays parallel — same shape four times — but at three providers the duplicated branch starts feeling redundant. That's where I'd extract a small interface: `interface AIProvider { complete(system, user): Promise<string> }` with three implementations. The branch becomes a factory call. I haven't done it yet because two providers don't need it.

### The question candidates always dodge
Q: You have eight code paths (four call sites × two providers). You call this an abstraction in your docs, but it's clearly just a switch. Defend the naming.

A: It's a fair callout — "abstraction" is the wrong word in the strict sense. What I have is a switch with parallel implementations. The reason I called it an abstraction in the docs is that the *call sites* have a uniform shape: get provider, get key, branch, parse, validate, persist. From the perspective of `app/` code calling into `services/ai/`, the provider is hidden — `summarize(date)` returns the same shape regardless of who answered. From the perspective of `services/ai/summarize.ts` itself, the duplication is real and visible. If I were renaming the docs today, I'd call it "provider switching" with a note that the abstraction line is at the call site, not the implementation. The honest version of the doc is "I made a deliberate choice to not extract a provider interface; here's why." When I add a third provider, the renaming becomes "provider interface" because the extraction will have happened.

### One-line anchors
- "I have provider switching, not provider abstraction — the call sites are uniform, the implementations are not."
- "Two cleanly-different code paths beat one half-true unified interface; LangChain's `BaseChatModel` is the cautionary case."
- "Live switching works because `getProvider()` reads SecureStore on every call — the cost is a few ms; the win is no restart."
- "At three providers I'd extract; at two, the duplication is the cheaper option."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
