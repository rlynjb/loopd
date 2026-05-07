# Provider abstraction — read on every call, no shared interface

> Each callsite branches on `'claude' | 'openai'`. Same prompts, same JSON contract, different SDK calls.

**See also:** → [01-system-design/11-provider-abstraction](../01-system-design/11-provider-abstraction.md) · → [02-single-purpose-chains](./02-single-purpose-chains.md)

---

## Quick summary
- **What:** every AI service reads `getProvider()` at call time, branches into either Anthropic SDK or raw fetch to OpenAI, then converges on the same parser.
- **Why here:** the app sells AI features but doesn't lock the user into one provider. SecureStore keys can be either; the user picks. Default is Claude.
- **Tradeoff:** every caller carries the branch — there is no single `BaseModel.invoke` interface. Each path can use the provider's optimal API.

---

## Provider abstraction — diagram

```
  Each callsite (summarize / caption / classify / expand)
                        │
                        ▼
                 ┌──────────────────┐
                 │  ai/config.ts    │
                 │  getProvider()   │  ← reads SecureStore: 'claude' | 'openai'
                 │  getXxxKey()     │
                 └──────────┬───────┘
                            │
                  ┌─────────┴─────────┐
                  ▼                   ▼
         provider == 'claude'   provider == 'openai'
                  │                   │
                  ▼                   ▼
         Anthropic SDK          raw fetch /v1/chat/completions
         models.create({...})   response_format: json_object
                  │                   │
                  └─────────┬─────────┘
                            ▼
                 string of model output
                            │
                            ▼
                 caller-specific parser + validator
```

---

## How it works

`ai/config.ts` exposes `getProvider()` and key getters. Both reads hit SecureStore — fast and synchronous-ish. Every AI service starts with: get provider, get key, branch.

The branches are intentionally explicit. The Claude branch uses `@anthropic-ai/sdk` directly; the OpenAI branch uses raw `fetch` to `/v1/chat/completions` so the codebase can pass `response_format: json_object` (Claude doesn't have that knob).

After both branches return, the rest of the function is shared: extract JSON, validate against schema, persist to SQLite, return.

**What changes when you swap providers:** the model identifier and the API client. That's it.
**What doesn't change:** the prompts, the JSON shape the model is asked to produce, the validators, the persist layer.

---

## Why no `BaseChatModel` interface

The two providers' APIs are different enough that a unified interface either lies (gluing OpenAI's `response_format: json_object` over Claude's looser shape) or constrains both to the lowest common denominator. The codebase chose explicit branches per callsite — four providers × four callsites = eight functions, but each one can use the optimal API for that provider.

```
Per-call branches (all 4 callsites follow this exact shape):

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

- `src/services/ai/config.ts` → `getProvider()`, `getAnthropicKey()`, `getOpenAIKey()`.
- `src/services/ai/summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts` — each implements the branch.
- The default provider is `claude`; the user can switch in `app/settings/ai.tsx`.

---

## Elaborate

### Where this pattern comes from
LangChain's `BaseChatModel` is the unified-interface alternative. It works for the lowest common denominator. Loopd chose the opposite — explicit branches that stay honest about what each SDK can do.

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

- **Explicit branches** — gives: each provider can use its optimal API. Costs: every caller has to know about both.
- **Read provider per call** — gives: live switching works without restart. Costs: every call hits SecureStore (fast but not free).
- **No shared interface** — gives: honest about differences. Costs: cross-cutting features harder to add.
