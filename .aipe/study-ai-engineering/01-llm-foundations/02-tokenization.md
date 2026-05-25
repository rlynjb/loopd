# Tokenization

**Industry name(s):** Tokenization, BPE, byte-pair encoding, sentencepiece, WordPiece
**Type:** Industry standard

> Text becomes tokens before the model sees it. Context windows are sized in tokens, not characters; pricing is per token. Misunderstanding tokens means under-budgeting context and over-paying for chains.

**See also:** → [01-what-is-an-llm](./01-what-is-an-llm.md) · → [06-token-economics](./06-token-economics.md) · → [`02-context-and-prompts/01-context-window`](../02-context-and-prompts/01-context-window.md)

---

## Why care

### Move 1 — The grounded scenario

You're building the `expand` chain in `src/services/todos/expand.ts`. The prompt is the todo text + 4 sibling todos + last 3 days of journal entries. You eyeball the input — "looks like maybe 800 characters, plenty of room in a 200k context window." Ship it. Three weeks later, the chain starts truncating sibling todos mid-sentence because someone wrote a long-form journal day. The chain doesn't error; it silently produces a worse expansion. Context window was sized in tokens, not characters; your eyeball was off by a factor of ~4 in English and worse in code blocks or non-Latin scripts.

### Move 2 — Name the question the pattern answers

That how-do-I-budget-for-this question is what tokenization answers. Not "how does BPE work internally" (academic — interesting, not load-bearing); just *what unit does the model see, how do I count it, and what does it cost*. The answer: a token is roughly ~4 characters in English, ~1 character in Chinese or Japanese, variable in code (whitespace and brackets become their own tokens), and the model never sees characters — only tokens.

### Move 3 — Why answering that question matters

**What breaks without the discipline:** budgeting prompts by character count instead of token count means your "fits in context" assumption fails the moment input shape changes. A 100-line prose entry might be 800 tokens; a 100-line code block in the same prose might be 1600. In buffr, the `expand` chain caps each input source at ~1000 chars as the principle-#11 retrieval limit — that's a token-equivalent of roughly 250 tokens per source, total prompt budget around 4000 tokens, well under the 200k context window. The cap is in characters because it's user-readable; the token math is what makes it safe.

### Move 4 — Concrete before/after

Without token-aware budgeting:
- Build `expand` with a "looks fine" character limit
- Ship it; works on typical inputs (~600-char journal entries)
- User writes a 3000-char journal day with embedded code snippets
- Prompt fits in context window but `expand` quality degrades (lost-in-the-middle kicks in)
- Debug: weeks

With token-aware budgeting:
- Count tokens before sending; if over budget, truncate or chunk
- `expand` chain has explicit `maxTokensPerSource = 1000 chars ~ 250 tokens` documented in code
- Long journal day triggers truncation logic, surfaces a warning
- Quality stays consistent

### Move 5 — The one-line summary

A token is the unit the model sees, prices, and budgets against; estimate ~4 chars per token in English, count exactly when it matters (cost, context limits, retrieval truncation), and never trust your eyeball on prompts over ~1000 chars.

---

## How it works

### Move 1 — The mental model

```
   Input string:  "Today I built the auth flow."
                              │
                              ▼  BPE tokenizer
                              │
   Tokens:        [15496, 314, 3170, 262, 6580, 5202, 13]
                  "Today" " I" " built" " the" " auth" " flow" "."
                  (7 tokens for 29 chars)
```

Token boundaries don't match word boundaries. Common words are one token; uncommon words split. Punctuation is its own token. Leading spaces are often part of the next token.

### Move 2 — The layered walkthrough

**Layer 1 — what tokenization does.** A tokenizer is a learned mapping from substrings to integer IDs. BPE (byte-pair encoding) starts with characters and greedily merges the most-common adjacent pairs into single tokens during training. The result: common substrings ("the", "ing", "tion") get one ID each; rare substrings split into multi-token sequences.

```
   "untokenizable"   →  ["un", "token", "izable"]      (3 tokens)
   "tokenization"    →  ["token", "ization"]            (2 tokens)
   "antidisestablishmentarianism"  →  ["ant", "id", "ises", "tab", "lish", "ment", "arian", "ism"]
                                       (8 tokens)
```

If you're coming from frontend, this is the same shape as a hash function: an opaque, learned mapping from string to integer that you should never write by hand and should always verify with a counter.

**Layer 2 — why token counts matter at three boundaries.** First, *context window* — each model has a fixed total token budget (Sonnet 4.6 = 200k, GPT-4o = 128k); input + output must fit. Second, *pricing* — providers charge per token, input vs output (output usually 3-5× more expensive). Third, *latency* — both input processing and output generation scale with token count.

```
   Three places token count matters
   ────────────────────────────────
   context window:    "does it fit"            → hard cap
   pricing:           "how much per call"      → cost
   latency:           "how fast per call"      → user-perceived speed
```

In buffr, all three apply: the `expand` chain has input around 4000 tokens which fits in 200k (context not the constraint); pricing per call is ~$0.005 against Sonnet which adds up at scale; latency is ~1-2 seconds per call, dominated by output generation.

**Layer 3 — how to count without guessing.** Use the provider's tokenizer or a compatible library. Anthropic's SDK exposes `client.messages.countTokens()`; OpenAI's `tiktoken` library counts for GPT models. Both return exact counts; never estimate from characters when it matters. For rough budgeting in prose: 1 token ≈ 4 chars in English. For code, structured data, or non-Latin scripts: count exactly.

```
   ┌─ Quick estimate (English prose, ±25%) ────────────────────┐
   │   ~4 chars per token                                       │
   │   ~0.75 words per token                                    │
   │   1 page (single-spaced) ~ 500 tokens                      │
   └────────────────────────────────────────────────────────────┘

   ┌─ Always count exactly when... ────────────────────────────┐
   │   building close to a context limit                        │
   │   pricing matters                                          │
   │   input is code, JSON, or non-Latin                        │
   │   building retrieval logic that truncates                  │
   └────────────────────────────────────────────────────────────┘
```

### Move 3 — The principle

Tokens are the model's atomic unit. Budget in tokens, count exactly when it matters, never trust character estimates past the rough-cut stage. The bug class is silent: budget overruns produce worse output, not errors.

The full picture is below.

---

## Tokenization — diagram

```
┌─ Your code ────────────────────────────────────────────────────────────┐
│                                                                        │
│   build prompt (string)                                                │
│         │                                                              │
│         ▼                                                              │
│   countTokens(prompt) ──→ assert(count < context_limit - response_budget)│
│         │                                                              │
│         ▼                                                              │
│   send to provider                                                     │
│         │                                                              │
└─────────│──────────────────────────────────────────────────────────────┘
          │
          ▼
┌─ Provider ─────────────────────────────────────────────────────────────┐
│                                                                        │
│   tokenize string  →  [int IDs]                                        │
│         │                                                              │
│         ▼                                                              │
│   embed tokens → run model → produce output tokens                     │
│         │                                                              │
│         ▼                                                              │
│   detokenize → string output                                           │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

   Tokens you pay for:                   Tokens that surprise you:
   ─────────────────────                 ──────────────────────────
   every input token (cached or not)     code blocks: brackets, indents
   every output token (typically 3-5×)   non-Latin scripts: ~1 char/token
                                         emoji: often 2-4 tokens each
                                         JSON: key + colon + value
```

---

## In this codebase

**Case B — buffr does not currently count tokens before any chain call.**

**Files:** `src/services/ai/summarize.ts`, `caption.ts`, `expand.ts`, `classify.ts`, `interpret.ts` — none of these count tokens; they assume the cap-by-characters approach in `expand.ts` (~1000 chars per source) is conservative enough that the 200k Sonnet context window is never approached. That assumption holds for current inputs but is undocumented and unverified at runtime.

The buildable next step (curriculum item `B1.2` and `B1.8`) is to add a `tokenCount` field to a new `ai_call_log` table (one row per chain call), compute via `@anthropic-ai/sdk`'s `countTokens` helper on the input message array, and surface in the `app/settings/ai.tsx` cost & latency panel. Once that's in place, the implicit "looks fine" budgeting can be replaced with explicit budget assertions per chain.

---

## Elaborate

### Where this pattern comes from

BPE was introduced by Sennrich, Haddow & Birch in 2016 for neural machine translation; GPT-2 popularized it for general-purpose LLMs in 2019. SentencePiece (Google) is a variant used by some non-English models. The exact tokenizer is provider- and model-specific.

### The deeper principle

Whenever a system has a finite resource (context window, pricing budget, latency budget), the unit of accounting must match the unit the system uses. Counting in your unit (characters, lines) instead of the system's unit (tokens) creates silent drift between what you think is happening and what's actually happening.

### Where this breaks down

For very small inputs (under 200 chars), the character-to-token ratio is stable enough that counting characters is fine. For very large inputs (over ~10k chars) or budget-critical paths, always count tokens. The middle ground (200-10k chars) is where most production bugs hide — the inputs are "probably fine" by character count but occasionally aren't.

### What to explore next

- [06-token-economics](./06-token-economics.md) — once you count tokens, you can compute cost
- [`02-context-and-prompts/01-context-window`](../02-context-and-prompts/01-context-window.md) — the context window is what the token budget protects you against overflowing
- [`02-context-and-prompts/02-lost-in-the-middle`](../02-context-and-prompts/02-lost-in-the-middle.md) — even within budget, where tokens sit in the prompt matters

---

## Tradeoffs

```
┌──────────────────┬────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Count tokens exactly       │ Estimate from chars          │
├──────────────────┼────────────────────────────┼──────────────────────────────┤
│ Code complexity  │ Extra dep + per-call count │ Zero (just .length)          │
│ Accuracy         │ Exact                      │ ±25% in English, worse in    │
│                  │                            │ code or non-Latin            │
│ Catches overruns │ Yes, at build time         │ Only after they happen       │
│ Latency overhead │ Tiny (local tokenizer)     │ None                         │
└──────────────────┴────────────────────────────┴──────────────────────────────┘
```

### What we gave up

Counting tokens adds a small amount of code per chain (one extra call before the LLM call) and a dependency on the provider's tokenizer. For chains that are clearly far under the budget, the overhead is wasted work.

### What the alternative would have cost

Character estimates work until the moment they don't. The failure mode is silent — chains produce worse output without erroring — which is the most expensive bug class to debug.

### The breakpoint

Count tokens when (a) prompt is over ~2000 chars, (b) input includes code or non-Latin scripts, (c) pricing is being optimized, or (d) you're building retrieval logic that truncates. Below those triggers, character-based estimates are fine for development; replace before shipping.

---

## Tech reference (industry pairing)

### Anthropic `countTokens` helper

- **Codebase uses:** **Case B** — not currently called. Available via `@anthropic-ai/sdk` v0.90+.
- **Why it's here:** the only way to know exact token count for Claude models is to use Anthropic's tokenizer; their BPE is not identical to OpenAI's.
- **Leading today:** `client.messages.countTokens({ model, messages })` — accepts the same message array shape as the actual call.
- **Why this leads:** provider-native; no drift between count and actual billing.
- **Runner-up:** `tiktoken` library — OpenAI's tokenizer for GPT models. Used when buffr's provider is `openai`.

---

## Project exercises

### B1.2 — Add token usage logging per chain

- **Exercise ID:** `B1.2`
- **What to build:** create `ai_call_log` SQLite table (`{id, chain, provider, model, input_tokens, output_tokens, ms, created_at}`), wrap each chain call to log on success, surface in `app/settings/ai.tsx` as a per-chain cost-and-latency panel.
- **Why it earns its place:** turns the "looks fine" budgeting into observable budgeting; necessary for `B1.8` cost dashboard.
- **Files to touch:** new migration for `ai_call_log`; `src/services/ai/{summarize,caption,expand,classify,interpret}.ts` wrap-and-log; `app/settings/ai.tsx` new panel.
- **Done when:** every chain call writes one row; the settings panel shows last-24h call count + total tokens + estimated cost per chain.
- **Estimated effort:** 4 hours.

---

## Summary

### Part 1 — concept recap

Tokens are the model's atomic unit — context windows are sized in them, pricing is per them, latency scales with them. Estimating from characters is fine for rough cuts (~4 chars per token in English) but unsafe near context limits, for cost optimization, or for inputs with code or non-Latin content. Buffr currently estimates via the principle-#11 character cap; the buildable next step is the `ai_call_log` table for exact per-call token tracking.

### Part 2 — key points to remember

- 1 token ≈ 4 chars in English; less for code, JSON, non-Latin; emoji often 2-4 tokens.
- Token count matters at three boundaries: context window, pricing, latency.
- Use provider tokenizer for exact counts; never trust character estimates past development.
- Bug class is silent: budget overruns degrade output quality, don't error.
- Buffr currently caps by chars (principle #11); explicit token logging is `B1.2`.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you handle context limits," they're checking whether you count or guess. Engineers who count tokens build systems that survive input growth; engineers who guess from characters ship "works until it doesn't" code.

### Likely questions

**Q [mid]:** How do you know if a prompt fits in the context window?

**A:** Count tokens with the provider's tokenizer before sending. For Anthropic, `client.messages.countTokens()`; for OpenAI, `tiktoken`. Don't estimate from `.length` — character ratios vary by content type. In buffr today the assumption is "way under the limit" because the principle-#11 cap holds inputs to ~4000 tokens against a 200k window; if any chain grew to RAG-shape with retrieved chunks, I'd add explicit `countTokens` assertions before the call.

**Q [senior]:** What's the difference between tokenizers across providers?

**A:** Different BPE training data and merge rules produce different token IDs and counts for the same string. A prompt that's 1200 tokens against Sonnet might be 1350 against GPT-4o. For exact accounting, you have to use the provider's tokenizer. For budgeting, the differences are small enough (~10%) that one tokenizer's count is a fine sanity check for the other; for billing or hard limits, use the matching one.

```
   Same string, different counts
   ─────────────────────────────
   "today I built the auth flow."
     Claude tokenizer    →  ~8 tokens
     GPT-4o tokenizer    →  ~8 tokens   (small string, both agree)

   1000-line code file
     Claude tokenizer    →  ~3500 tokens
     GPT-4o tokenizer    →  ~4100 tokens   (15% drift)
```

**Q [arch]:** When would you NOT count tokens?

**A:** When (a) the prompt is small enough that the worst-case character-to-token ratio still fits comfortably (under ~500 chars in English), or (b) the chain is in development and you're iterating on the prompt itself (count once at the end). Premature token-counting adds code noise without payoff. The trigger to add counting: any prompt that takes user-controlled input whose size you don't bound, OR any chain whose cost or latency you're tracking.

### The question candidates always dodge

**Q:** What's a tokenization failure mode that surprised you?

**A:** Emoji. A "🚀 today I shipped" prompt is much longer than its character count suggests — the rocket emoji alone is often 3 tokens. For buffr's `interpret` chain that consumes user prose, an entry full of emoji can be 30-50% more tokens than its character count predicts. Same applies to non-Latin scripts: Japanese text averages roughly 1 token per character, not 4. The general rule: count exactly any time the input source is user-controlled and the content is heterogeneous.

### One-line anchors

- Token = model's atomic unit. Budget in tokens, not chars.
- ~4 chars per token in English; worse for code, JSON, emoji, non-Latin.
- Three boundaries that matter: context window, pricing, latency.
- Silent failure mode — budget overrun degrades output, doesn't error.
- Buffr's current cap is character-based (principle #11); token logging is `B1.2`.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the token flow: input string → tokenize → integer IDs → model → output IDs → detokenize → output string, with "tokens you pay for" labels on both directions.

### Level 2 — Explain it out loud

Explain in under 60 seconds why character count is unsafe past a certain prompt size.

### Level 3 — Apply it to a new scenario

A new requirement: buffr should support attaching a file to a journal entry (e.g., a code snippet). Estimate the token-count change between a 1000-char prose entry and a 1000-char code snippet. Where does the difference come from?

Reference: try both inputs through `tiktoken` or Anthropic's `countTokens` to verify.

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should pre-tokenize every prose input on save so the token count is always available without a runtime call." Why or why not?

### Quick check — code reference test

Without opening files:
- What does buffr currently use as a proxy for token count?
- Which chain is closest to exhausting its budget if input shape changes?
- What table would `B1.2` add?
