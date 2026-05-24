# Token budgeting and context window management

**Industry name(s):** Token budgeting, context window management, prompt compression, prefix caching, lost-in-the-middle
**Type:** Industry standard · Language-agnostic

> Count tokens. Allocate budget per section. Stay under 80% of the context window. Know about lost-in-the-middle and prefix caching. This is basic hygiene that distinguishes amateur from professional prompt work.

**See also:** → [01-anatomy](./01-anatomy.md) · → [03-prompts-as-code](./03-prompts-as-code.md) · → [06-single-purpose-chains](./06-single-purpose-chains.md)

---

## Why care

### Move 1 — The grounded scenario

Your chain has been running fine for three months. Today it starts timing out on roughly 20% of calls. You check the model version: unchanged. You check the prompt: unchanged. You check the input: ah — the user's journal entries have grown. The chain interpolates "the last 30 days of entries" as context, and at some point in the last week the typical 30-day window crossed the 100,000-token mark. The model is taking 90 seconds to respond instead of 8. Some calls hit the API's hard timeout. Nobody was counting tokens.

### Move 2 — Name the question the pattern answers

That what-fits-and-what-doesn't question is what token budgeting answers. Not "how do I write a concise prompt" (style), not "how do I shrink my data" (engineering) — just *what's the per-section token allocation, what's the total budget, and what happens when the inputs grow.* Most chains are designed against the typical input size and ignore the worst-case size. The chain works in demos, ships to production, and starts timing out the day a power user's data crosses the budget nobody set.

### Move 3 — Why answering that question matters

**What breaks without it:** the chain crosses a context-window threshold silently and fails noisily. In buffr today, the `summarize` chain interpolates the entries of a single date into its prompt — a single day's text is unlikely to ever cross any reasonable budget, so this chain is fine. The `interpret` chain is different — it interpolates the entire journal entry plus a "what to interpret" framing; long entries (some users write 3,000+ words per day) plus a long system prompt plus the response budget can push past 8K tokens on input alone. The day someone exports their journal and runs interpret across a year of entries (which is a future feature, not today), the chain truncates the prompt at the SDK boundary, the model's response degrades quality without erroring, and nobody sees the degradation until a user reports it.

### Move 4 — Concrete before/after

Without token budgeting (no measurement, no allocation):
- `interpret` chain works fine for the first 6 months — typical entries are 200–800 words
- A power user starts writing 3,000-word entries
- One day's interpret call totals ~6K tokens in; system prompt + response budget pushes to ~9K
- Within the context window of Sonnet 4.6 (200K), no error — but lost-in-the-middle starts kicking in
- The "interpret" output starts referencing the wrong parts of the entry; user reports "the reflection feels off"
- Nobody knows why because nobody is logging token counts

With token budgeting (count + allocate + alert):
- Chain has a defined budget: system 800 tokens, context 4K, examples 500, user request 200, response budget 2K → 7.5K total target
- Per-call logging emits `inputTokens` and `outputTokens` (see [03-prompts-as-code](./03-prompts-as-code.md))
- When input exceeds 80% of the budget (6K), alert + auto-summarize the journal entry before passing to interpret
- Power-user case detected at the metric layer; mitigation lands before the quality regression hits users

### Move 5 — The one-line summary

Token budgeting is the same discipline as response-size budgeting in REST APIs — count the bytes, allocate per field, alert at 80% of the limit, and don't let one growing field push the whole payload past the threshold.

---

## How it works

### Move 1 — The mental model

The context window is a fixed-size buffer that holds your entire prompt plus the model's response. Every section of the prompt — system, context, examples, user message — competes for that buffer. The response also competes, because providers reserve part of the window for the output. If your input crosses the input-budget threshold, the model either truncates silently (older providers), returns an error (most modern providers), or degrades response quality through lost-in-the-middle attention (all providers).

```
   context window (e.g., 200K tokens on Sonnet 4.6)
   ┌───────────────────────────────────────────────────────────────┐
   │ [SYSTEM] [CONTEXT] [EXAMPLES] [USER]                          │
   │   ~800      ~4K       ~500     ~200      input  = ~5.5K       │
   │                                          response = up to ~4K │
   │                                                               │
   │                                                               │
   │                                                               │
   │                                                               │
   │                                                ~190K headroom │
   └───────────────────────────────────────────────────────────────┘
                  ▲                                       ▲
                  │                                       │
                  │  budget set at design time            │  the 80% rule:
                  │                                       │  cross this and
                                                          │  you're one
                                                          │  model bump from
                                                          │  truncation
```

The 80% rule: if any single call routinely uses more than 80% of the model's context window, you're one model change (a smaller-context successor, a price change that pushes you to a cheaper-but-smaller model) away from breaking. Stay under the threshold or build in compression.

### Move 2 — The layered walkthrough

**Layer 1 — count tokens, don't estimate.** Use the provider's tokenizer (Anthropic's `@anthropic-ai/tokenizer`, OpenAI's `tiktoken`) or a SDK function that returns the count. English averages ~4 characters per token but the ratio differs for code (~3 chars/token), Japanese/Chinese (~1 char/token), and emojis (1 token each). Don't `Math.ceil(text.length / 4)` in production — too inaccurate, especially on the tail where it matters most.

```
   input string         tokenizer output
   ───────────────────  ────────────────
   "Hello, world"       3 tokens
   "ありがとう"          4 tokens (Japanese, near 1 char/token)
   "🎉🎉🎉"             3 tokens (emojis are 1 each)
   "function foo(x) {   24 tokens (code dense in tokens)
    return x + 1;
   }"
```

If you're coming from frontend, this is the same shape as measuring image bandwidth — don't estimate by file extension, measure the actual bytes. Concrete consequence: a 300-word English entry is ~400 tokens; a 300-character Japanese entry is also ~400 tokens. Mixing the two without measuring leads to budget surprises.

**Layer 2 — allocate budget per section.** Before writing the chain, write down: how many tokens for system prompt, how many for context (typical and max), how many for examples, how many reserved for the response. The total should be under 80% of the context window. If the math doesn't fit, the chain needs compression, not a bigger model.

```
   chain budget allocation (worked example: buffr interpret)
   section          target   max     compression strategy
   ─────────────    ──────   ───     ─────────────────────
   system           ~600     ~600    fixed, no compression
   context          ~3000    ~6000   summarise entry if > max
   examples         ~400     ~400    fixed, no compression
   user request     ~100     ~100    fixed
   ─────────────    ──────   ───
   input total      ~4100    ~7100
   response budget  ~2000    ~2000
   ─────────────    ──────   ───
   call total       ~6100    ~9100
   under 80% of context window (200K Sonnet 4.6 = 160K floor)
   safe even at ~10× max
```

If you're coming from frontend, this is the same discipline as setting `max-width` on every layout container — without explicit allocation, one growing field pushes everything else off-screen.

**Layer 3 — lost-in-the-middle is real.** Even when your input fits the window, the model's attention is not uniform across the input. Content placed in the middle of a long prompt is attended-to less than content at the start or the end. This is empirically documented (Liu et al, "Lost in the Middle" 2023, replicated across every provider). Practical consequence: when you interpolate retrieved context into a prompt, put the most relevant context at the start or the end, not the middle. When you have few-shot examples plus context plus a user request, the request goes at the very end so the model attends to it strongly.

```
   typical prompt structure (worst to best for important content)
   ┌─────────────────────────────────────────────────┐
   │ [system rules]              ← strong attention  │
   │ [long retrieved context]    ← middle: weaker    │
   │ [examples]                  ← middle: weaker    │
   │ [user request]              ← end: strong       │
   └─────────────────────────────────────────────────┘
   
   the rebalance: put what matters most at start or end,
   accept that middle content gets attended-to less
```

**Layer 4 — prefix caching is the cheap win.** Providers cache the prefix of a prompt across calls if the prefix is identical (Anthropic's prompt caching, OpenAI's prefix caching, both production-stable in 2026). The system prompt + examples — the parts that don't change call to call — sit at the front. The provider returns a cache-hit token count, and you pay 10–20% of the normal rate for those cached tokens. This is the structural argument for putting variable content (the per-call user message) at the END of the prompt, not the beginning: a one-character change to a prefix invalidates the cache.

```
   non-cached call                  cached call (Anthropic)
   ────────────────                 ───────────────────────
   system: 800 tokens × full price  system: 800 tokens × 0.1 price
   context: 4K × full price         context: 4K × full price (changes)
   examples: 500 × full             examples: 500 × 0.1 (cached)
   user: 200 × full                 user: 200 × full (changes)
   ─────                            ─────
   input cost: ~5500 full tokens    input cost: ~4200 full + 1300 cached
                                    effective: ~4330 token equivalent
                                    (~21% savings)
```

If you're coming from frontend, this is the same shape as HTTP cache headers on static assets — the static prefix is the "vendor.js" file you cache forever; the variable suffix is the per-request data. Concrete consequence: in buffr's chain files, the order of prompt sections matters for cache hits. System and examples should come BEFORE the per-call context, not after.

### Move 2.5 — Current state vs future state

Buffr today doesn't count tokens anywhere. Each chain passes its prompt string to the SDK and receives the response; the SDK reports `usage.input_tokens` and `usage.output_tokens` in the response object, but the chain code doesn't read or log these. There's no budget allocation per chain, no compression strategy on the long-input chains, no prefix-caching ordering convention.

```
          Now (buffr)                         Later (instrumented)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ call provider                │  │ pre-call: estimate input tokens   │
│ wait for response            │  │   compare against per-chain budget│
│ discard usage stats          │  │   if > 80% of max: compress       │
│                              │  │     (auto-summarize long context) │
│                              │  │ call provider with prefix-cache   │
│                              │  │   friendly ordering               │
│                              │  │ log usage.input/output to metrics │
└──────────────────────────────┘  └──────────────────────────────────┘
   no measurement, no defense        measurement + defense + caching
```

What doesn't have to change between phases: the chain's logic, the prompts, the SDK calls. What changes is *measurement and reaction* — the same observability layer from [03-prompts-as-code](./03-prompts-as-code.md) plus a token-count check before each call.

### Move 3 — The principle

Anything you don't measure regresses silently. Token counts are the bytes-on-the-wire of LLM calls — without them, your chain works fine until a data growth crosses a threshold nobody set, and then it fails in a way no error message names clearly. The discipline is: measure, allocate, alert at 80%, compress at 100%. Skipping the discipline means waiting for the failure to surface as a user complaint.

The full picture is below.

---

## Token budgeting — diagram

```
┌─ Authoring layer ───────────────────────────────────────────────────────┐
│  per-chain budget allocation:                                            │
│    SYSTEM   = X tokens (fixed)                                           │
│    CONTEXT  = Y tokens (typical) … Y' (max, with compression)            │
│    EXAMPLES = Z tokens (fixed)                                           │
│    USER     = W tokens (variable)                                        │
│    RESPONSE = R tokens (reserved)                                        │
│    TOTAL    = X+Y+Z+W+R < 80% of model's context window                  │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Pre-call layer ────────────────────────────────────────────────────────┐
│  count input tokens via tokenizer                                        │
│    if > 80%: compress context (summarise older turns, retrieval filter)  │
│    if > 100%: refuse + log + fallback                                    │
│  arrange prompt for prefix-caching:                                      │
│    [system] [examples] FIRST (cacheable, stable)                         │
│    [context] [user] LAST (changes per call)                              │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Provider call ─────────────────────────────────────────────────────────┐
│  provider returns: result + usage.input_tokens + usage.output_tokens     │
│    +  usage.cache_read_tokens (if Anthropic cached prefix hit)           │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Post-call layer (observability) ───────────────────────────────────────┐
│  log: { chain, prompt_hash, model, input_tokens, output_tokens,          │
│         cache_read_tokens, latency_ms }                                  │
│  alert: when chain's p99 input_tokens crosses 80% of budget              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Buffr's longest-input chain:**

**File:** `src/services/ai/interpret.ts`
**Function / class:** `interpret(entryText, framing)`
**Line range:** L1–L149 — interpolates the full entry text plus a system prompt of ~600 tokens

**File:** `src/services/ai/summarize.ts`
**Function / class:** `summarize(date)`
**Line range:** L43–L188 — interpolates a single day's entries; bounded input

**File:** `src/services/ai/caption.ts`
**Function / class:** `caption(entryText, date, yesterdaySummary)`
**Line range:** L1–L223 — interpolates one entry + one summary; bounded input

None of these chains measure tokens. None of them carry a documented budget. None of them use prefix caching (the order of system + examples + context within the prompt is convention-driven, not cache-optimized).

**Tokenizer dependency available but not used:** the `@anthropic-ai/sdk` SDK includes `Anthropic.tokens.count()` (added 2024). Buffr does not import it.

---

## Elaborate

### Where this pattern comes from

The 80% rule and the per-section budget allocation came out of the early-2024 production-LLM-engineering scene — Hamel Husain, Eugene Yan, Simon Willison all touched it in different writings. The lost-in-the-middle finding is from the Liu et al. 2023 paper (replicated and now baked into provider documentation). Prefix caching shipped from Anthropic in mid-2024 and from OpenAI shortly after; the cache-friendly ordering convention is an industry-converged response to the pricing structure.

### The deeper principle

Anything you don't measure regresses silently. Budget allocation at design time forces the design decisions early ("if context grows past Y, I need a compression strategy") instead of forcing them under incident pressure later.

### Where this breaks down

Chains where the input is bounded and small (`classify` on a single todo line — at most ~50 tokens of input, totally fine in any window) don't earn the discipline overhead. The 80% rule applies to chains where the input scales with user data, not to chains with intrinsically small inputs.

### What to explore next

- [03-prompts-as-code](./03-prompts-as-code.md) — per-call observability is the foundation that makes token-budget alerting possible.
- [06-single-purpose-chains](./06-single-purpose-chains.md) — splitting a chain into two smaller chains is one of the compression strategies (the second chain can run on the first's summary).
- [11-meta-prompting](./11-meta-prompting.md) — auto-summarising old context is itself an LLM call (a small one) that needs its own budget.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Budget + measure          │ Don't measure (buffr now) │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Setup            │ One budget table + per-   │ Zero                      │
│                  │ call counter (~50 lines)  │                           │
│ Failure mode     │ Loud + early              │ Silent (degraded quality  │
│                  │ (alert at 80%)            │ → user complaints)        │
│ Cost overruns    │ Capped by refusal at 100% │ Unbounded                 │
│ Cache savings    │ ~10–20% with ordering     │ Zero                      │
│ Compression cost │ One extra LLM call when   │ Zero (until you hit limit │
│                  │ context exceeds budget    │ and have to compress      │
│                  │                           │ reactively)               │
│ Cognitive load   │ One budget per chain      │ "Hope inputs stay small"  │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Setting up token measurement costs you one new dependency (the tokenizer), one budget table (5 rows for buffr's 5 chains), one per-call counter call (`logChainCall({ inputTokens, outputTokens })` — pairs naturally with the per-call logging from [03-prompts-as-code](./03-prompts-as-code.md)), and one "what do I do when budget is exceeded" decision per chain. For buffr that's roughly a half-day to set up the foundation and another half-day per long-input chain to design the compression strategy.

### What the alternative would have cost

Not measuring costs you every silent regression. The `interpret` chain's quality is the most exposed today — a power user with a long entry gets degraded output without anyone seeing the cause. The cost of NOT having budgeting shows up as user-reported "the AI feature feels worse for me," which is diagnostically the worst class of complaint because it's untraceable without measurement.

### The breakpoint

Token budgeting is overhead until any chain's typical input crosses ~20% of the context window — at that point the worst case starts approaching the 80% line and budget breaches become realistic. Buffr's chains are nowhere near this today (typical inputs are well under 5% of Sonnet's 200K window). The discipline becomes load-bearing the first time a feature lands that interpolates multi-day or multi-entry context.

### What wasn't actually a tradeoff

"Just use a bigger model." Sonnet 4.6's 200K window is huge, and the temptation is to just say "we won't hit the limit." This skips the lost-in-the-middle problem (which kicks in well below the limit) AND the cost-per-call problem (longer prompts cost more per call, multiplicatively in production volume) AND the latency problem (longer prompts take longer to process). The bigger model defers the failure mode, not removes it.

---

## Tech reference (industry pairing)

### Anthropic tokenizer

- **Codebase uses:** Not imported in buffr today. Would come from `@anthropic-ai/sdk`'s tokenizer utility.
- **Why it's here:** the only accurate way to count tokens before sending. Estimation via character count is wrong on the tail.
- **Leading today:** Anthropic SDK tokenizer — `adoption-leading` for Claude models, 2026.
- **Why it leads:** matches the actual tokenizer used by the model; no estimation drift between count and reality.
- **Runner-up:** `tiktoken` for OpenAI models (`adoption-leading` for GPT models); `js-tiktoken` for browser-compatible counting; rough estimation via `text.length / 4` for English-only fallback (acceptable only in non-production code paths).

### Anthropic prompt caching

- **Codebase uses:** Not used in buffr today. Would be `cache_control: { type: 'ephemeral' }` in the SDK call's system or message blocks.
- **Why it's here:** the cheap structural win — ~10–20% input cost reduction for chains where the prefix is stable across calls.
- **Leading today:** Anthropic prompt caching — `adoption-leading` for Claude, 2026.
- **Why it leads:** 90% discount on cached tokens; 5-minute TTL by default; no cache-key management needed (provider hashes the prefix).
- **Runner-up:** OpenAI prefix caching — `adoption-leading`, automatic without explicit `cache_control` (less control, easier setup).

---

## Project exercises

### B3.7 — Add per-chain budget allocation + measurement

- **Exercise ID:** `[B3.7]`
- **What to build:** define a per-chain budget table at `src/services/ai/budgets.ts` — one row per chain naming target and max for system / context / examples / user / response. Add a `countTokens(text)` helper using the Anthropic tokenizer. In each chain, before the SDK call, compute the input token count and log it via `logChainCall()` from [03-prompts-as-code](./03-prompts-as-code.md). Alert (console.warn) if any call's input exceeds 80% of that chain's budget.
- **Why it earns its place:** turns token measurement from "nobody is doing it" to "every call is measured." First time a chain crosses 80%, you'll know before users do.
- **Files to touch:** new `src/services/ai/budgets.ts`, new `src/services/ai/tokens.ts` (the count helper), modifications to each chain file under `src/services/ai/`.
- **Done when:** dashboard surface in `app/settings/cloud-sync.tsx` shows per-chain p50 and p99 input token counts over the last 7 days, with a warning indicator for any chain whose p99 exceeds 80% of its budget.
- **Estimated effort:** 1–2 days.

### B3.8 — Enable Anthropic prompt caching on long-prefix chains

- **Exercise ID:** `[B3.8]`
- **What to build:** in chains where the system prompt + few-shot examples are stable across calls (any of `summarize`, `caption`, `expand`, `classify`), add `cache_control: { type: 'ephemeral' }` to the system block in the Anthropic `messages.create()` call. Confirm cache hits via the response's `usage.cache_read_input_tokens`. Track cache-hit rate in the per-call log.
- **Why it earns its place:** 10–20% input cost reduction with one SDK parameter change. Low effort, immediate measurable benefit.
- **Files to touch:** each of the 5 chain files (Anthropic branch only).
- **Done when:** dashboard shows cache hit rate per chain; cost reduction visible in the AI provider's billing report.
- **Estimated effort:** <1hr.

---

## Summary

### Part 1 — concept recap

Token budgeting is per-section allocation of the context window — system, context, examples, user request, response budget — with the total staying under 80% of the model's context window, plus per-call measurement so you know when inputs grow past your design assumptions. Buffr's 5 chains do none of this today; the SDK returns `usage.input_tokens` but nobody reads it, no chain has a documented budget, and the longest-input chain (`interpret`) is the most exposed to silent quality regression as user data grows. The constraint forcing this concept is that LLM failures from context-window pressure are mostly invisible — truncation is silent on older providers, lost-in-the-middle degrades quality without erroring, cost overruns appear on the billing dashboard a month late. The cost being paid for the current shape is that the first time a power user's data crosses the threshold, the only signal is "the AI feature feels off."

### Part 2 — key points to remember

- Count tokens, don't estimate. Character-count heuristics are wrong on the tail.
- The 80% rule: if any call routinely uses more than 80% of the context window, you're one model change from breaking.
- Lost-in-the-middle is real and affects you below the window limit. Put what matters at the start or end.
- Prefix caching is the cheap win — order prompts so stable prefixes (system + examples) come first, variable suffixes (user message + context) come last.
- Measurement is the foundation. Without per-call token logging, every other budgeting effort is theatre.

---

## Interview defense

### What an interviewer is really asking

"How do you handle long context?" is the question; underneath is "have you ever had a chain regress because nobody was counting tokens?" The answer that names the 80% rule, lost-in-the-middle, and prefix caching is the answer of someone who has been on call for an AI-feature incident.

### Likely questions

**Q [mid]:** How do you decide whether a chain needs a token budget?

**A:** Two tests. First, does the input scale with user data? A classifier on a single todo line (~50 tokens) doesn't need a budget — the input is intrinsically bounded. The summarize chain interpolating a day's entries (~hundreds of tokens) doesn't need one either; bounded by daily writing limits. The interpret chain interpolating "this entry plus context from the last 30 days" needs one because the input grows with the user. Second, does the chain run at production volume? A debug-only chain doesn't need a budget; a per-foreground-app-open chain absolutely does. Pass both tests → budget. Fail either → skip.

```
   input bounded?              production volume?      → budget needed?
   ─────────────────────       ───────────────────     ─────────────────
   ✓ (single todo line)        ─                       no
   ─                           ✗ (debug-only)          no
   ✗ (multi-entry context)     ✓ (per-foreground)      yes
```

**Q [senior]:** Buffr's chains don't count tokens today. Why hasn't this bit you yet?

**A:** Because buffr is single-user and the user is the developer. The user writes a couple hundred words a day; the `interpret` chain caps at ~1500 tokens of input on a long day; the Sonnet 4.6 context window is 200K. There's ~130× headroom on every call. The day the product opens to other users (Phase B), the headroom shrinks per-call (some users write 5,000-word entries; the average shifts; the worst case multiplies by user count). At 1,000 users with one power user writing 10K-word entries daily, the interpret chain's worst case is suddenly real, and there's no token measurement to catch it before users notice. The discipline is overhead until it isn't; Phase B is when it becomes mandatory, and the cost of retrofitting is the same as the cost of building it now — except retrofitting happens under incident pressure.

```
   today (single user)             Phase B (1k users)
   ─────────────────              ────────────────────
   interpret max ~1500 tokens     interpret max ~10000+ tokens
   200K window: 130× headroom     200K window: 20× headroom (power users)
   cache: 0%                      cache: 15–20% savings × volume = real money
   ─────                          ─────
   measurement: optional          measurement: required
   compression: not needed yet    compression: load-bearing
```

**Q [arch]:** At 100× the call volume, what breaks in your token-budgeting story?

**A:** Three things. (1) The per-call tokenizer call adds latency — if you're counting tokens before every SDK call, that's ~10–50ms per call from local tokenization; at 100× volume that aggregates to user-visible latency. The fix is sampling: tokenize 1% of calls, alert if p99 of the sample crosses the threshold, accept that 1% sampling means you catch threshold violations within minutes instead of seconds. (2) The metrics storage starts costing — one log row per call × 100× volume is millions of rows per day. Move to aggregated metrics (p50, p99, count, alert-fires per chain per hour) and discard raw rows after a 7-day window. (3) The compression strategy starts firing more often — if 5% of calls trigger auto-summarisation, the summarisation chain becomes a load-bearing sub-system with its own budget. The architecture breaks first at metrics storage; the budgeting itself scales fine.

```
   today                          100× scale
   ─────                          ──────────
   tokenize every call            sample 1%, alert on p99
   log every call                 aggregate, discard after 7 days
   compress rarely                compression is hot path; needs budget too
   ─────                          ─────
   breaks first: nothing yet      breaks first: metrics storage
                                  fix: aggregation + retention policy
```

### The question candidates always dodge

**Q:** Lost-in-the-middle is documented and provider-acknowledged. Why isn't this a solved problem — why do prompts still need to be structured to put important content at start or end?

**A:** Because the attention mechanism that causes it is structural to how transformers process long contexts; the only "solutions" are (1) provider-side mitigations (retrieval-augmented inference, prompt compression at the provider) which require integration buy-in, (2) longer-context models with more uniform attention (which exist but cost more per token AND don't fully eliminate the effect), or (3) prompt-author-side discipline (put important content at start/end, retrieve only what's relevant instead of stuffing everything). The discipline is the cheapest of the three and applies regardless of provider. The candidates who dodge this question want the provider to solve it; the production engineers structure their prompts as if the provider never will.

```
   what's been picked          what alternatives cost
   ─────────────────────       ────────────────────────
   structure prompts so        wait for providers to fix:
   important content sits      no timeline, no clarity
   at start or end             ─
   ─                           use longer-context models:
   cost: a convention          higher cost per call,
   benefit: works on every     attention still uneven,
   provider, every model       still need start/end discipline
                               (no escape from the discipline)
```

### One-line anchors

- Count tokens. Don't estimate. Tokenizer or it didn't happen.
- The 80% rule is the line between "fine today" and "one model change from broken."
- Lost-in-the-middle is real below the window limit. Put what matters first or last.
- Prefix caching is the cheap win. Order prompts cache-friendly: stable prefix first, variable suffix last.
- Measurement is the foundation. Budgets without per-call logging are theatre.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the four-layer flow: authoring (budget allocation), pre-call (count + compress + reorder for caching), provider call (with usage stats returned), post-call (log + alert).

### Level 2 — Explain it out loud

Explain token budgeting to a colleague who asked "we're using Sonnet, the context window is huge, do we really need to count?" Under 90 seconds.

Checkpoints — did you:
- Name lost-in-the-middle as a sub-limit effect?
- Name the 80% rule and why it matters even below the absolute limit?
- Name prefix caching as the cheap win that depends on prompt ordering?

### Level 3 — Apply it to a new scenario

A new feature lands: buffr's `interpret` chain should support "interpret across the last 30 days of entries" (currently it operates on a single entry).

Without looking at the code: design the budget allocation for the new feature. What's the typical input size? What's the worst case? What compression strategy fires at the worst case? Where does the lost-in-the-middle problem land?

Write your answer in 3–5 sentences. Then open `src/services/ai/interpret.ts` to compare your design against the current chain's structure.

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr doesn't need token budgeting today; the chains are nowhere near the window limit and the discipline is premature overhead."

### Quick check — code reference test

Without opening files:
- Which buffr chain has the largest typical input?
- Does any chain in buffr use prefix caching today?
- What's the SDK's reported field for input token count after a call?
