# Provider abstraction — read on every call, no shared interface

**Industry name(s):** Strategy pattern, Adapter pattern, Provider pattern
**Type:** Industry standard · Language-agnostic

> Each callsite branches on `'claude' | 'openai'`. Same prompts, same JSON contract, different SDK calls.

**See also:** → [01-system-design/11-provider-abstraction](../01-system-design/11-provider-abstraction.md) · → [02-single-purpose-chains](./02-single-purpose-chains.md)

---

## Why care

You've installed a new database in a side project and realised the SDK is identical to the last one. Same `client.query()`, same `client.connect()` — the implementation behind it is completely different but the call sites don't know that. That's not an accident. It's a pattern with a name, and it's load-bearing in every system that needs to swap one piece for another without rewriting everything that talks to it.

Provider abstraction is the layer that lets a caller use one of several interchangeable implementations behind a single interface. It belongs to the family of "decouple the consumer from the producer" patterns, alongside dependency injection and the adapter pattern. You've already seen this in React's renderer abstraction (DOM, native, server — same component tree), in database drivers (Postgres, MySQL, SQLite behind the same query API), and in LLM client wrappers like LangChain or LiteLLM that put one `invoke()` over OpenAI, Anthropic, and a dozen others. Here's how that actually works in this codebase.

---

## How it works

`ai/config.ts` exposes `getProvider()` and key getters. Both reads hit SecureStore — fast and synchronous-ish. Every AI service starts with: get provider, get key, branch.

The branches are intentionally explicit. The Claude branch uses `@anthropic-ai/sdk` directly; the OpenAI branch uses raw `fetch` to `/v1/chat/completions` so the codebase can pass `response_format: json_object` (Claude doesn't have that knob).

After both branches return, the rest of the function is shared: extract JSON, validate against schema, persist to SQLite, return.

**What changes when you swap providers:** the model identifier and the API client. That's it.
**What doesn't change:** the prompts, the JSON shape the model is asked to produce, the validators, the persist layer. The diagram below shows the whole flow end-to-end, with the layers it crosses.

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

## Quick summary

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

[senior] Q: Why read provider on every call instead of once at app start?
         A: Two reasons. One: it lets the user switch providers in `app/settings/ai.tsx` without restarting the app — the next call picks up the new provider mid-session. Two: SecureStore reads are cheap, and there's no hot path where the cost matters (every call is followed by a network round-trip orders of magnitude slower). The cost of reading per-call is roughly zero; the cost of caching it would be a stale-config bug the day a user re-keys.

[arch] Q: At what point does the `BaseChatModel`-style abstraction start winning? What's your threshold?
       A: Around three providers. With two, the 10 branch arms (5 chains × 2 providers) duplicate ~20 lines per pair and stay readable. At three, you'd have 15 arms and the duplication starts to hurt. At five, every cross-cutting concern (token counting, streaming, retry-with-backoff) lands in five places and the abstraction pays back. I'd extract a real interface the day I add the third provider. Today the call shape is uniform enough that "branch on provider" reads cleanly, and `response_format: json_object` only exists on OpenAI — a unified interface would either lie about that or force Claude to pretend it has the knob.

### The question candidates always dodge
Q: You have 10 `if (provider === 'claude')` branches across five files. You call this an "abstraction". How is it an abstraction?

A: Correct — it's a switch, not an abstraction. I called it abstraction in the docs because the call sites have a uniform shape and converge on the same parser/validator, but the implementations are duplicated. If I added Gemini tomorrow I'd have 15 branch arms, five pairs of near-identical code, and five places to update for every cross-cutting feature. The honest framing is: this is "duplicated implementation, uniform contract", and it's a deliberate stop short of a `BaseChatModel`. The day I add a third provider I'll extract a real interface — probably with a tagged-union return type so the OpenAI-only `response_format: json_object` doesn't have to be papered over. With two providers, an abstraction layer would have one consumer and five call sites and not pay back. I'd rather grep for `'claude'` than read three layers of indirection.

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
