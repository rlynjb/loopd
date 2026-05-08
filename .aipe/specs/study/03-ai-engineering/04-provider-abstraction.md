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

---

## Interview defense

### What an interviewer is really asking
"Why didn't you build a `BaseChatModel` interface?" — they want to see whether I know what an abstraction *costs* and what it *pays back*. The interviewer is hunting for the candidate who reaches for LangChain's unified interface as a reflex. I want to land on: I have two providers, eight call sites, and a uniform call shape — that's a pattern, not an abstraction. A real abstraction needs three implementations to be worth writing.

### Likely questions

[mid] Q: Walk me through what happens in `summarize.ts` when the user has set provider=openai. Where does the branch live?
      A: `summarize.ts` calls `getProvider()` from `ai/config.ts` which reads SecureStore — synchronous-ish. It then calls `getOpenAIKey()`. If the key is missing it returns `{ error: 'no API key' }`. Otherwise it hits the OpenAI branch: a raw `fetch` to `/v1/chat/completions` with `response_format: { type: 'json_object' }`, `model: 'gpt-4o'`, system + user messages. The response comes back as `r.choices[0].message.content`, gets passed to `parseJson`, then to `validateSummary`. If provider had been `claude` the same function would have used `client.messages.create` from `@anthropic-ai/sdk` and read `r.content[0].text`. Same prompts, same validators, different SDK call.

[senior] Q: Why read provider on every call instead of once at app start?
         A: Two reasons. One: it lets the user switch providers in `app/settings/ai.tsx` without restarting the app — the next call picks up the new provider mid-session. Two: SecureStore reads are cheap, and there's no hot path where the cost matters (every call is followed by a network round-trip orders of magnitude slower). The cost of reading per-call is roughly zero; the cost of caching it would be a stale-config bug the day a user re-keys.

[arch] Q: At what point does the `BaseChatModel`-style abstraction start winning? What's your threshold?
       A: Around three providers. With two, the eight call sites duplicate ~20 lines per pair and stay readable. At three, you'd have twelve call sites and the duplication starts to hurt. At five, every cross-cutting concern (token counting, streaming, retry-with-backoff) lands in five places and the abstraction pays back. I'd extract a real interface the day I add the third provider. Today the call shape is uniform enough that "branch on provider" reads cleanly, and `response_format: json_object` only exists on OpenAI — a unified interface would either lie about that or force Claude to pretend it has the knob.

### The question candidates always dodge
Q: You have eight `if (provider === 'claude')` branches across four files. You call this an "abstraction". How is it an abstraction?

A: Correct — it's a switch, not an abstraction. I called it abstraction in the docs because the call sites have a uniform shape and converge on the same parser/validator, but the implementations are duplicated. If I added Gemini tomorrow I'd have twelve branches, three pairs of near-identical code, and three places to update for every cross-cutting feature. The honest framing is: this is "duplicated implementation, uniform contract", and it's a deliberate stop short of a `BaseChatModel`. The day I add a third provider I'll extract a real interface — probably with a tagged-union return type so the OpenAI-only `response_format: json_object` doesn't have to be papered over. With two providers, an abstraction layer would have one consumer and three call sites and not pay back. I'd rather grep for `'claude'` than read three layers of indirection.

### One-line anchors
- "It's a switch, not an abstraction. Honest duplication beats dishonest abstraction."
- "Read provider per call. SecureStore is cheap; restart-required is not."
- "Three providers is the day I extract `BaseChatModel`."
- "OpenAI's `response_format: json_object` is exactly the kind of detail a unified interface lies about."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
