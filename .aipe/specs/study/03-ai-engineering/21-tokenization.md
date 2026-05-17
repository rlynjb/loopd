# Tokenization

**Industry name(s):** Tokenization, BPE (byte-pair encoding), SentencePiece, tiktoken, sub-word tokenization
**Type:** Industry standard · Language-agnostic

> The reason an LLM's "context window" is measured in tokens — not words, not characters — and why one byte of unusual text costs more than one byte of common text.

**See also:** → [01-what-an-llm-is](./01-what-an-llm-is.md) · → [03-context-window](./03-context-window.md) · → [23-token-economics](./23-token-economics.md)

---

You write `text.split(' ')` to break a string into words for processing — the resulting array's length is a clean number you could use to bill or budget. Now imagine the same call with a different splitting function: not whitespace, not characters, but a *learned vocabulary* of ~50,000 strings, where the function chops the input into the *fewest* matching entries. Common English fragments collapse to one entry (`"the"` → one integer); rare strings shatter into many (`"a8f3b2c1"` → eight integers, one per char). A 1k-character paragraph of English might map to 250 entries; the same byte count of UUIDs maps to 600+ entries. Same input length, very different costs. That's exactly what the model's tokenizer does — a learned `split()` whose output-array length is what the API bills.

The implicit question is what unit the bill is denominated in. Not characters, not words — the vocabulary entries chosen by the tokenizer's cutting algorithm, where common English maps cheaply and rare strings shatter.

**What depends on getting this right:** every cost estimate, every context-window budget, every "why did that prompt suddenly get expensive" mystery in this codebase. `interpret.ts` already caps input at `MAX_INPUT_CHARS = 2000` (L17), which is a character cap standing in for a token cap. The summary prompt at `prompt.ts` L4–L27, the four-voice caption prompt at `caption.ts` L24–L100, and the rotation block at `caption.ts` L102–L121 all get billed in tokens — when the day's `rawLog` is long, or when the prior captions feed has rare technical phrasing, the token count balloons in ways the character count doesn't predict. Lose this mental model and you misjudge which prompt edits cost real money — a 50-line addition of plain prose is cheaper than a 5-line addition of base64 tokens, and the cost-per-call diff hides until the bill arrives.

Without the tokenization mental model:
- Add a 200-char block of UUIDs to a prompt; expect ~50 tokens
- Actual cost: ~200 tokens (one per char on rare strings)
- Multiply by 4 caption variants × 30 days = 24,000 tokens nobody budgeted

With the tokenization mental model:
- Add a 200-char block of UUIDs to a prompt; expect 1 char ≈ 1 token on rare strings
- 1k chars of English ≈ 250 tokens; 1k chars of UUID/code ≈ 600+ tokens
- The cost-per-character is not constant; rare-string cost is the surprise budget

Tokens are the integers your input maps to via a learned `split()` — that integer count is what the API bills.

---

## How it works

A function that maps `string` to `number[]` via a learned vocabulary of ~50,000 entries. Each entry could be a whole word (`"the"` → one integer), a fragment (`"ization"` → one integer), a single character (`"ø"` → one integer), or punctuation (`'",\n'` → one integer). The tokenizer's job is to chop the input into the *fewest* vocabulary entries possible, then output the integer IDs as a `number[]`.

The function signature in one picture:

```
   function tokenize(text: string): number[] {
     /* greedy BPE merge against ~50,000-entry vocabulary */
   }

   input:                          output:
   "buffr uses Sonnet"             [14334, 67, 5829, 328, 86471]
        │                                ↑
        │  greedy BPE merge              │
        │  against vocabulary             │
        ▼                                │
   "loop"  ──▶  14334  ─────────────────┤
   "d"     ──▶     67  ─────────────────┤
   " uses" ──▶   5829  ─────────────────┤  one integer per
   " S"    ──▶    328  ─────────────────┤  vocabulary entry
   "onnet" ──▶  86471  ─────────────────┘

   array length = 5 tokens
   API bills you for 5 input tokens (plus the system prompt's tokens)
```

The three sub-sections below trace the BPE training, the attention cost (tokens are also the unit of compute), and how the boundary cuts shape model behavior.

### BPE — the dictionary is learned, not designed

Byte-pair encoding builds the dictionary by greedy merging. Start with one entry per byte (256 entries). Walk a giant text corpus, count which byte pairs co-occur most often, merge the top pair into a new entry (`t` + `h` → `th`), repeat ~50,000 times. If you're coming from frontend, you're used to thinking of strings as sequences of UTF-16 code units. Here it's different: the model sees integers drawn from a vocabulary that's *shaped by the training data*. Common English fragments are one token each; rare strings (a Python AST node name, a UUID, a Korean honorific) get shattered into many tokens.

The practical consequence: the string `"ization"` is one token (~one integer), while `"a8f3b2c1"` is eight tokens (one per character). A 1k-character paragraph of English prose is ~250 tokens; a 1k-character JSON payload with UUIDs is ~600+ tokens. **This is why your cost-per-character is not constant.**

Same 1k chars, very different token counts:

```
   input (1k characters)                       token count       chars-per-token
   ───────────────────────────────────         ───────────       ───────────────
   English prose ("The quick brown fox...      ~250 tokens       ~4
   thought about going to the store...")
                                                                   ◄── common
                                                                       fragments
                                                                       are single
                                                                       tokens

   markdown                                     ~280 tokens       ~3.5
   ("## Header\n\n- bullet 1\n- bullet 2")

   JSON with UUIDs                              ~600 tokens       ~1.6
   ([{ id: "a8f3b2c1-...", ... }])                                ◄── UUIDs
                                                                       shatter
                                                                       to 1 char
                                                                       per token

   minified JS                                  ~500 tokens       ~2
   (function(a,b){return a+b})
```

The takeaway: when planning prompt edits, English ≈ 4 chars/token; rare strings approach 1 char/token. The bill follows the harder-to-compress shape.

### The token is also the unit of attention

The model's transformer architecture computes attention between *every pair of tokens*. Attention cost scales quadratically with sequence length. So tokens aren't just a billing unit — they're the unit of computation the model actually performs. A 2× longer prompt costs ~4× more compute even before output generation.

The quadratic-attention curve at a glance:

```
   prompt tokens         attention pairs computed       relative cost
   ─────────────         ──────────────────────────     ─────────────
        500              500 × 500   = 250,000          1×
      1,000              1,000 × 1,000 = 1,000,000      4×
      2,000              2,000 × 2,000 = 4,000,000      16×
      8,000              8,000 × 8,000 = 64,000,000     256×
     32,000              32,000 × 32,000 = 1,024,000,000  4096×
    128,000              128,000² = 1.6 × 10¹⁰          16,384×

   doubling prompt length quadruples the attention compute.
   modern models use sparse attention and other tricks to keep
   the constant low, but the asymptotic shape is O(n²) — that's
   why "stuff the whole corpus" stops being viable past a certain
   corpus size.
```

Tokens aren't just a billing unit; they're the unit the model's actual computation scales against.

### Where the boundary cuts shape the model's behavior

Tokenizers are case-sensitive: `"buffr"` and `"Buffr"` are usually different tokens. Whitespace is part of the token: `" the"` (with leading space) and `"the"` (without) are different tokens. This means *small textual edits can change tokenization significantly* — and the model's prior over what comes next is conditioned on the exact tokens, not the exact characters.

How small textual edits change the tokenization:

```
   string                          tokens (approx)             notes
   ─────────────────────────       ──────────────────────      ─────────────
   "the"                           [1820]                      common; one token
   " the"                          [262]                       different — leading
                                                                space matters
   "The"                           [1858]                      different — case
                                                                matters
   "the!"                          [1820, 0]                   2 tokens
   "the !"                         [1820, 837]                 3 tokens (space-bang
                                                                is its own entry)

   "buffr"                         [9437, 67]                  rare brand → 2 tokens
   "Buffr"                          [43, 9437, 67]              cap'd version → 3
                                                                 (one extra capital
                                                                  prefix)
```

The model's next-token prior is conditioned on the exact integer sequence, not the visible string — formatting consistency in prompts matters for both cost and behavior.

### This is what people mean by "tokens, not words"

Every model spec sheet lists context window in tokens. Every API bills in tokens. Every prompt-engineering best practice ("be concise") is a token-budgeting practice. The reason the abstraction took over is that it's the only unit where the model's behavior, its cost, and its computational footprint are all the same thing. Here's the diagram of how a string moves through it.

---

## Tokenization — diagram

```
Tokenization pipeline

┌─ Input ──────────────────────────────────────────────────┐
│  "buffr uses Sonnet"                                     │
└──────────────────────────────────────────────────────────┘
            │
            ▼  byte-pair encoder (BPE / tiktoken)
┌─ Vocabulary lookup ──────────────────────────────────────┐
│   "loop"  → 14334                                        │
│   "d"     →    67                                        │
│   " uses" →  5829                                        │
│   " S"    →    328                                       │
│   "onnet" →  86471                                       │
└──────────────────────────────────────────────────────────┘
            │
            ▼
┌─ Token ID sequence (what the model sees) ────────────────┐
│  [14334, 67, 5829, 328, 86471]                           │
│   ↑                                                      │
│   5 tokens — billed as 5, computed as 5×5 attention      │
└──────────────────────────────────────────────────────────┘
```

The model never sees `"buffr uses Sonnet"`. It sees five integers. Every cost, every limit, every attention computation is denominated in those five integers.

---

## In this codebase

**Status:** `learn-only` — no token-level instrumentation is built today.

buffr makes ~30+ LLM calls on an active journaling day across five chains, but does not currently measure or log per-call token counts. The curriculum gates this concept as `learn-only` for two reasons:

1. The dedicated build for tokenization visualisation lives in *reincodes* (the portfolio repo), not buffr.
2. Token-economic instrumentation in buffr is `[B1.2]` (the `ai_call_log` table) and `[B1.8]` (the AI ops panel) — see [23-token-economics](./23-token-economics.md). Those exercises use the *output* of tokenization (the count) without requiring buffr to ship its own tokenizer.

**File:** *(no implementation in buffr today)*
**Function / class:** *(deferred — see reincodes tokenization viz for the concept-builder)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
BPE was invented in 1994 for data compression and adapted to NLP by Sennrich et al. (2016) for neural machine translation. The win was statistical: an unbounded vocabulary is brittle, a character-level vocabulary is slow, and BPE finds a sweet spot at ~30k–50k learned sub-word units that handle both common words and arbitrary rare strings without explosion.

### The deeper principle
The model's vocabulary is part of its training. You can't change it after the fact without retraining. This means every API quirk (Claude tokenizes differently from GPT-4o, which tokenizes differently from Llama) is a *property of the model*, not a configurable knob.

### Where this breaks down
BPE struggles with non-Latin scripts that weren't well-represented in training data — Korean, Chinese, and code-heavy strings can shatter into many more tokens than their English-prose-equivalent. For users in those languages, "1k characters of context" is a much smaller window than for English speakers.

### What to explore next
- [03-context-window](./03-context-window.md) → how buffr budgets the token window per chain
- [23-token-economics](./23-token-economics.md) → why per-call token count is the unit of billing in buffr
- The reincodes tokenization visualiser → for interactive intuition on where the cuts fall

---

## Tradeoffs

### Comparison table — BPE vs character-level vs word-level vocabularies

```
┌────────────────────────┬──────────────────────┬─────────────────────────┬──────────────────────┐
│ Cost dimension         │ BPE (current)        │ Character-level         │ Word-level           │
├────────────────────────┼──────────────────────┼─────────────────────────┼──────────────────────┤
│ Vocabulary size        │ ~50k                 │ ~256 (bytes)            │ ~1M+ (unbounded)     │
│ Sequence length        │ Moderate             │ Long (5–10×)            │ Short                │
│ Rare-word handling     │ Graceful shatter     │ Native                  │ <UNK> token          │
│ Compute per token      │ Constant             │ Constant                │ Constant             │
│ Total compute per call │ Moderate             │ High (long seqs)        │ Low                  │
│ Multilingual coverage  │ Good (with caveats)  │ Excellent               │ Bad without retrain  │
└────────────────────────┴──────────────────────┴─────────────────────────┴──────────────────────┘
```

### Sub-block 1 — what BPE gives up

BPE accepts that some inputs cost more than others. A 100-character UUID may cost 90 tokens; the same 100 characters of English prose costs ~25. This non-uniformity is invisible in the source string and only becomes visible at billing time.

### Sub-block 2 — what character-level would have cost

Character-level tokenization makes cost perfectly uniform (1 token per byte) but multiplies sequence length by 5–10×. Because attention is O(n²), a character-level GPT-4 would be ~25–100× slower per call. The cost trade is hidden complexity (in BPE) vs hidden compute (in character-level).

### Sub-block 3 — the breakpoint
BPE stops being the right choice when (a) your domain is non-Latin-script and existing tokenizers shatter your inputs catastrophically (Korean text in a model trained mostly on English), or (b) you need exact-character-level outputs (e.g., a programming-language code generator where token boundaries straddle syntactically-meaningful boundaries). Most production codebases — including buffr — never hit either.

### What wasn't actually a tradeoff
Custom-trained tokenizers are not a real option for an application developer. Tokenizers ship with the model; choosing a tokenizer means choosing a model.

---

## Tech reference (industry pairing)

### tiktoken (OpenAI)

- **Codebase uses:** not used in buffr today; buffr talks to Claude (which uses Anthropic's own tokenizer) and OpenAI (which uses tiktoken).
- **Why it's here:** the de facto standard library for measuring token counts before sending a request; mirrors the BPE used by GPT-3.5 / GPT-4 / GPT-4o.
- **Leading today:** tiktoken — `adoption-leading` for OpenAI token counting, 2026.
- **Why it leads:** maintained by OpenAI; matches the production tokenizer byte-for-byte; widely available in Python, JS, Go.
- **Runner-up:** `gpt-tokenizer` (npm) — `innovation-leading` for browser-runnable token counting; pure-JS port of tiktoken.

### Anthropic tokenizer

- **Codebase uses:** not used in buffr today; Claude calls don't ship a public tokenizer the way OpenAI does — the `usage` field on the response is the post-hoc count.
- **Why it's here:** Claude's own BPE; not exposed as a standalone library but observable via the API response's `usage.input_tokens` / `usage.output_tokens`.
- **Leading today:** Anthropic API `usage` field — `adoption-leading` for Claude cost measurement, 2026.
- **Why it leads:** authoritative count from the model itself; no pre-flight tokenization needed.
- **Runner-up:** `@anthropic-ai/tokenizer` — emerged in 2024 but trails OpenAI's tooling in maturity.

---

## Project exercises

**Status:** `learn-only` (Phase 1 — `[C1.1]` is tagged `learn-only — built in reincodes viz`). The build target lives in the reincodes portfolio repo; buffr consumes the *output* of tokenization (counts) without owning a tokenizer.

The exercises that build tokenization intuition are:

### (reincodes) Tokenization visualizer

- **Exercise ID:** `Interview prep — reincodes` (curriculum's "Interview prep surface" section)
- **What to build:** An interactive visualizer at `concepts/ai-engineering/tokenization/` in reincodes that takes a user-typed string, runs it through tiktoken (JS port), and highlights each token with a colour. Two views: BPE merge sequence, and final token IDs.
- **Why it earns its place:** tokenization is the most-misunderstood concept candidates trip on. An interactive tool that lets the reader paste a code snippet and *see* the shatter pattern is the strongest possible study aid.
- **Files to touch:** new component in reincodes; depends on the `gpt-tokenizer` npm package.
- **Done when:** the visualizer is published to the reincodes portfolio; ASCII art of the merge sequence is reproducible from the interactive view.
- **Estimated effort:** `1–2 days`.

### (buffr) Consume the count, not the tokenizer

- **Exercise ID:** `[B1.2]` (token usage logging) — primary target is [23-token-economics](./23-token-economics.md).
- **What to build:** buffr's `ai_call_log` table records `prompt_tokens` and `completion_tokens` from the Anthropic/OpenAI response. No client-side tokenizer needed.
- **Why it earns its place:** the count is what matters in production; the tokenizer is what matters in pedagogy. buffr doesn't need both.
- **Files to touch:** see [23-token-economics](./23-token-economics.md).
- **Done when:** see [23-token-economics](./23-token-economics.md).
- **Estimated effort:** `1–4hr`.

---

## Summary

Tokenization is the deterministic process that maps a byte string into a sequence of integer IDs from a fixed ~50k-entry vocabulary. In buffr it is not directly implemented — the model providers tokenize internally and report `input_tokens` / `output_tokens` in their responses, which `[B1.2]` logs into `ai_call_log`. The constraint that makes this the right call here is that buffr doesn't need to pre-flight tokenize for budgeting; the post-hoc count is sufficient for cost panels and rate limiting. The cost is that we can't enforce a hard token cap *before* the call — we discover oversized prompts when the API rejects them rather than when we build them.

Key points to remember:
- BPE = ~50k learned sub-word units; common English fragments are 1 token, rare strings shatter.
- Token count is the unit of billing, the unit of attention compute, and the unit of context-window measurement — all three at once.
- 1k chars of English prose ≈ 250 tokens; 1k chars of UUIDs ≈ 800+ tokens. Non-uniform by design.
- Tokenizers are per-model; choosing a model chooses a tokenizer.
- buffr consumes counts from the API response; it does not run a client-side tokenizer.

---

## Interview defense

### What an interviewer is really asking
"Explain tokenization" tests whether the candidate has internalised that the model doesn't see text — it sees a sequence of integers from a fixed vocabulary. The follow-up tests are about cost prediction and edge cases (Korean text, code, JSON). Candidates who answer in terms of "words" or "characters" reveal they've never had to debug a token budget.

### Likely questions

  [mid] Q: What's the difference between a token and a character?
  A: A token is an integer ID drawn from a fixed vocabulary the model was trained with — usually ~50k entries for modern LLMs. Common English sub-word fragments are one token each (`ization`, `the`, `loop`); rare strings get shattered into many tokens (a UUID is ~one token per character). The model never sees characters; it sees the integer sequence. That's why you can't equate "1k characters" with "1k tokens" in any reliable way.
  Diagram:
  ```
  "buffr uses Sonnet"  →  [14334, 67, 5829, 328, 86471]  →  model
  17 characters                  5 tokens
  ```

  [senior] Q: Why does pasting a code block cost more tokens than the equivalent prose?
  A: BPE was trained on a corpus dominated by natural-language text, so its learned merges optimise for English (and similar) prose. Code contains many strings that aren't in the merge table — variable names, hex strings, indentation patterns — and these get cut into smaller, sometimes character-level tokens. A function signature like `getUserByIdSafe(uuid: string)` is ~10–14 tokens; the same character count of prose is ~6–8. In buffr specifically, this matters most for the `expand` chain when the user's todos include code-like content.
  Diagram:
  ```
  Prose:  "the user logged in"      ≈ 5 tokens
  Code:   "getUserById(uuid)"       ≈ 8 tokens (same chars)
                                     ↑
                                     no learned merge for "Uuid" or "(uuid"
  ```

  [arch] Q: What changes at 10× scale — say, 100k users on buffr?
  A: Two things. First, the cost per chain becomes the dominant operational cost, and the non-uniformity of token cost across users (Korean-speaking users pay 2–3× per character) becomes a fairness issue worth surfacing. Second, the lack of a pre-flight tokenizer becomes a real problem — at 100k users you can't afford the API rejecting oversized prompts as a budgeting signal; you need to refuse on the client. The fix is adding tiktoken (or Claude's equivalent) at the chain layer for input estimation.
  Diagram:
  ```
  Today (solo)        →  send → API rejects oversize  → degrade gracefully
  At 100k users       →  estimate client-side → refuse early → no wasted call
                            ↑ this layer doesn't exist in buffr today
  ```

### The question candidates always dodge
"How does Claude's tokenizer differ from OpenAI's, and why does that matter for your code?" Most candidates say "they're both BPE" and stop. The real answer is that *the vocabularies are different and not portable*. A prompt that's 1k tokens on Sonnet might be 1.2k on GPT-4o because their merges learned different fragments. In a provider-abstracted codebase like buffr's, this means budget calculations done against one tokenizer are wrong for the other. Today buffr dodges the problem by using post-hoc counts from each provider's `usage` response — but a pre-flight client-side estimator would need to maintain *two* tokenizers.

```
Claude tokenizer       OpenAI tokenizer (tiktoken)
─────────────────       ─────────────────
"interpretation"        "interpretation"
→ 2 tokens?             → 2 tokens
"interpretability"      "interpretability"
→ 3 tokens?             → 4 tokens

Same string, different counts.
Pre-flight estimation needs both libraries.
```

### One-line anchors
- The model sees integers, not letters.
- One token of English prose ≠ one token of code ≠ one token of Korean.
- Cost-per-character is non-uniform by construction.
- Choosing a model chooses a tokenizer.
- Post-hoc counts from `usage` are authoritative; pre-flight estimates are approximate.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file and draw the tokenization pipeline diagram from memory: input string → BPE → vocabulary lookup → integer ID sequence → model. Label the 5-token example for `"buffr uses Sonnet"`.

✓ Pass: your diagram shows the byte-pair encoder, the vocabulary lookup, and the integer output.
✗ Fail: re-read "How it works" and try again.

### Level 2 — Explain it out loud
Explain tokenization in under 90 seconds. Did you say: (a) BPE makes a ~50k vocabulary by greedy merging, (b) common fragments are one token and rare strings shatter, (c) the model sees integers not text, (d) cost-per-character is non-uniform?

### Level 3 — Apply it to a new scenario
A buffr user starts journaling in Korean. They notice their per-day token spend is 3× higher than an English-only user with the same character count. Without looking at the file, explain why — and propose one mitigation.

Open this file and check your answer against the "Where this breaks down" section.

### Level 4 — Defend the decision you'd change
Today buffr has no client-side tokenizer. If you were starting today, would you ship one from day 1, or stay with post-hoc counts? Answer in 3–5 sentences, referencing the cost dimension you'd prioritise.

### Quick check — code reference test
- What buffr file does this concept live in?
- What function logs the token count today?

Answer: tokenization itself is not implemented in buffr; the `usage` count is consumed by `[B1.2]`'s planned `ai_call_log` table — no implementation yet.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (clerk-with-phrasebook scenario, name the what-is-the-bill-unit question, MAX_INPUT_CHARS/prompt-cost stakes, before/after, single-line metaphor).

---
Updated: 2026-05-14 — v1.32.0 pass: swapped Why care + How it works Move 1 from the clerk-with-phrasebook / 50,000-line-dictionary physical-world analogy (banned per v1.31.0/v1.32.0) to level-1 primitives (`text.split(' ')` returning a `number[]` via a learned vocabulary). Swapped Why care Move 5 from "tokens are the line-numbers in the phrasebook" to "tokens are the integers your input maps to via a learned `split()`." Added Move 1 mnemonic diagram (tokenize() function signature with input/output trace) + 3 Move 2 sub-section diagrams: chars-per-token table across input types, quadratic-attention compute table from 500 to 128K tokens, small-edits change tokenization examples. Total: 4 new diagrams.
