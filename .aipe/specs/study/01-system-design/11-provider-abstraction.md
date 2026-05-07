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
