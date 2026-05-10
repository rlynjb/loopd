# Provider abstraction (LLM)

**Industry name(s):** Strategy pattern, Adapter pattern, Provider pattern
**Type:** Industry standard · Language-agnostic

> Every AI service file imports `getProvider`, branches twice (once on the request, once on the model id), then converges on the same downstream parse step.

**See also:** → [03-ai-engineering/04-provider-abstraction](../03-ai-engineering/04-provider-abstraction.md) · → [03-ai-engineering/02-single-purpose-chains](../03-ai-engineering/02-single-purpose-chains.md)

---

## Why care

You've shipped an integration with a third-party service and then watched the vendor change their pricing, deprecate an endpoint, or just go down for a day. If the call to that vendor was sprinkled across thirty files, you got to spend a week chasing it down. If it was behind one well-defined seam, you swapped vendors in an afternoon. The difference is not how good either vendor was — it's how prepared the codebase was for the day one of them stopped being the right answer.

The strategy pattern is a way to keep the call site stable while letting the implementation behind it change at runtime, chosen by configuration or user preference. It belongs to the family of "decouple consumer from producer" patterns alongside dependency injection and the adapter pattern. You've seen this in payment processing libraries that route to Stripe or Adyen behind one charge() call, in object-storage SDKs that target S3, GCS, or R2 with the same upload, and in logging frameworks where the same log() call ends up in stdout, a file, or a hosted aggregator. Here's how the shape lands in this codebase.

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

- **Explicit branches** — gives: each provider can use its optimal API. Costs: every caller has to know about both.
- **Read provider per call** — gives: live switching works without restart. Costs: every call hits SecureStore (fast but not free).
- **Default Claude, OpenAI optional** — gives: Anthropic SDK gets the canonical path; OpenAI is a maintained alternate. Costs: when the SDKs diverge, Claude features land first.

---

## Quick summary

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
