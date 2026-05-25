# Token economics

**Industry name(s):** Token economics, LLM cost accounting, per-call cost
**Type:** Industry standard

> Output tokens cost 3–5× more than input tokens. A chain that runs 10k times/day at $0.01/call is $3000/month — worth measuring before optimising. Cost discipline starts with counting; the chain you're not measuring is the one bleeding money.

**See also:** → [02-tokenization](./02-tokenization.md) · → [07-heuristic-before-llm](./07-heuristic-before-llm.md) · → [`06-production-serving/02-llm-cost-optimization`](../06-production-serving/02-llm-cost-optimization.md)

---

## Why care

### Move 1 — The grounded scenario

You shipped buffr's 5 chains. They work. A month in, you check the Anthropic dashboard: $87 for the month. Most of it from the `interpret` chain (markdown output, ~800 output tokens per call). The classifier (Haiku, ~50 tokens out) is rounding error; the caption chain (4 variants × ~80 tokens each = ~320 tokens out) is moderate; `interpret` dominates. You had no way of knowing which chain was the cost driver until you opened the dashboard, because buffr logs no token data locally.

### Move 2 — Name the question the pattern answers

That where-is-the-money-going question is what token economics answer. Not "what does inference cost" (Anthropic's pricing page); just *which chains in MY system drive cost and how do I measure them without leaving the codebase*. The answer: a per-call log of input tokens + output tokens + model + chain name, queryable per chain per day.

### Move 3 — Why answering that question matters

**What breaks without per-chain cost tracking:** you can't optimise what you don't measure. The default optimisation move ("switch the whole codebase to a cheaper model") often makes a chain that was fine worse without touching the one that was the actual cost driver. In buffr today, no chain logs token usage; the provider dashboard is the only signal, and it aggregates across chains. The `B1.2` build is the `ai_call_log` SQLite table that fixes this.

### Move 4 — Concrete before/after

Without per-chain cost data:
- Bill is $87/month; "feels high"
- Engineer optimises the wrong chain (the one they happen to be working on)
- Bill stays $80/month; "barely moved"

With per-chain cost data:
- Bill is $87/month; query `ai_call_log` shows `interpret` at $72, others at $5 each
- Optimisation focuses on `interpret`: switch to Haiku for first draft, prompt cache the system message
- Bill drops to $25/month next cycle

### Move 5 — The one-line summary

Output tokens cost 3–5× input; output is where the money goes; measure per-chain to know which one to optimise. The chain you're not logging is the one quietly bleeding money.

---

## How it works

### Move 1 — The mental model

```
   Per-call cost ledger (one row per chain invocation)
   ───────────────────────────────────────────────────

   ┌────────────────────────────────────────────────────────┐
   │ Input tokens (you pay 1× per token)                    │
   │   system prompt:        200 tokens                     │
   │   user message:         150 tokens                     │
   │   conversation history: 800 tokens                     │
   │   retrieved docs:       400 tokens                     │
   │   Total input:         1550 tokens                     │
   ├────────────────────────────────────────────────────────┤
   │ Output tokens (you pay 3–5× per token)                  │
   │   response:             300 tokens                     │
   │   Total output:         300 tokens                     │
   ├────────────────────────────────────────────────────────┤
   │ Cost (Sonnet 4 pricing):                                │
   │   input:  1550 × $3/1M   = $0.00465                    │
   │   output:  300 × $15/1M  = $0.00450                    │
   │   Total per call:        $0.00915                      │
   └────────────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — three line items per chain.** Input tokens (system prompt + user message + history + retrieval), output tokens (the response), and any cached prefix (provider-side prompt caching — typically 10% of input cost on hits). Track all three. Most chains: input dominates volume, output dominates cost.

```
   ┌─ Three things to log per call ──────────────────┐
   │   input_tokens     →  what you sent              │
   │   output_tokens    →  what you got back          │
   │   cache_read_tokens→  if prompt caching enabled  │
   │   model            →  what got billed            │
   │   chain            →  for grouping               │
   └──────────────────────────────────────────────────┘
```

**Layer 2 — output is where the money goes.** Sonnet 4: $3 input / $15 output per million tokens. Haiku 4.5: $1 input / $5 output per million. A 200-token-in / 200-token-out call against Sonnet costs $0.0036 ($0.0006 input + $0.003 output). Output is 5× the cost. Compress output before input: shorter responses, structured outputs with concise schemas, no chain-of-thought when not needed.

```
   Cost-per-call drivers ranked
   ────────────────────────────
   1. output token count           (5× per token vs input)
   2. model tier                   (Sonnet/Opus 5× vs Haiku)
   3. input token count            (dominates volume, not cost)
   4. cache miss rate              (10% saving on cache hits)
```

**Layer 3 — per-chain attribution beats aggregate dashboards.** The provider dashboard shows total spend; that doesn't tell you which chain. A local log table keyed by `(chain_name, date)` answers "what does each chain cost per day" — the question that drives optimisation. In buffr, the `B1.2` design is a simple `ai_call_log` SQLite table that every chain writes to in a finally-block after the call.

```
   buffr's planned ai_call_log table
   ──────────────────────────────────
   id              integer  primary key
   chain           text     ('summarize' | 'caption' | ...)
   provider        text     ('anthropic' | 'openai')
   model           text     ('claude-sonnet-4-6' | ...)
   input_tokens    integer
   output_tokens   integer
   cache_read      integer
   ms              integer  (latency)
   error           text     nullable
   created_at      text
```

### Move 3 — The principle

Measure per-chain, not in aggregate. Optimise the chain that's actually expensive, not the one you happen to be working on. Output tokens are the cost driver; compress output, route cheaper, cache the system prefix.

The full picture is below.

---

## Token economics — diagram

```
┌─ Per-call accounting ─────────────────────────────────────────────────┐
│                                                                       │
│   chain.ts call                                                       │
│         │                                                             │
│         ▼                                                             │
│   provider.messages.create({...})                                     │
│         │                                                             │
│         ▼                                                             │
│   response.usage.input_tokens   = 1550                                │
│   response.usage.output_tokens  = 300                                 │
│   response.usage.cache_read     = 0                                   │
│         │                                                             │
│         ▼                                                             │
│   INSERT INTO ai_call_log (chain, model, input_tokens, ...)           │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘

┌─ Cost dashboard query (B1.8 build) ───────────────────────────────────┐
│                                                                       │
│   SELECT chain,                                                       │
│          SUM(input_tokens * input_rate(model)                         │
│              + output_tokens * output_rate(model)) AS daily_cost      │
│   FROM ai_call_log                                                    │
│   WHERE date >= ?                                                     │
│   GROUP BY chain                                                      │
│   ORDER BY daily_cost DESC                                            │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not log token usage today.**

**Files:** every chain in `src/services/ai/` calls the provider, gets the response, returns the parsed output — the `usage` field is discarded.

The buildable next step is the `B1.2` build (the `ai_call_log` table), followed by `B1.8` (the `app/settings/ai.tsx` cost-and-latency panel). Estimated effort: 4 hours for `B1.2`, 4 more for `B1.8`. Until then, the Anthropic dashboard is the only signal — and it doesn't break down by chain.

---

## Elaborate

### Where this pattern comes from

Per-call cost logging became canonical in production LLM systems by mid-2023 when bills started running into thousands. The closest cross-domain analog is Google Analytics' per-event cost attribution — same shape, different domain.

### The deeper principle

You can't optimise what you don't measure. Aggregate metrics tell you something is wrong; per-source metrics tell you what.

### Where this breaks down

For very small applications (under ~$10/month in LLM spend), the engineering effort to build per-chain logging exceeds the savings it enables. Skip until the bill is high enough to justify a half-day of work — for buffr, around $50/month would be the threshold.

### What to explore next

- [02-tokenization](./02-tokenization.md) — token counting is the input to cost accounting
- [07-heuristic-before-llm](./07-heuristic-before-llm.md) — the biggest cost lever in buffr today
- [`06-production-serving/02-llm-cost-optimization`](../06-production-serving/02-llm-cost-optimization.md) — the optimisations once measurement is in place

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Per-chain logging         │ Aggregate provider dashboard  │
├──────────────────┼───────────────────────────┼──────────────────────────────┤
│ Optimisation     │ Targeted; data-driven     │ Guesswork; "feels expensive" │
│ targeting        │                           │                              │
│ Implementation   │ 4 hours; SQLite table +   │ Zero                         │
│                  │ wrap-and-log              │                              │
│ Per-call latency │ Tiny (sync INSERT)        │ Zero                         │
│ Storage          │ ~1 KB per 100 calls       │ N/A                          │
└──────────────────┴───────────────────────────┴──────────────────────────────┘
```

### The breakpoint

Build per-chain logging the moment monthly LLM spend exceeds ~$50, or any time you're considering optimising chain cost without knowing which chain to target.

---

## Tech reference (industry pairing)

### Anthropic `usage` field

- **Codebase uses:** **Case B** — `response.usage.input_tokens` / `output_tokens` / `cache_read_input_tokens` exposed on every `messages.create()` response. Not currently logged.
- **Why it's here:** the source of truth for billing-tracked counts.
- **Leading today:** every major provider returns usage in the response.

### Pricing snapshots (May 2026)

- Sonnet 4.6: $3 / $15 per million (input / output)
- Haiku 4.5: $1 / $5 per million
- GPT-4o: $2.5 / $10 per million
- GPT-4o-mini: $0.15 / $0.60 per million

Prices change; the relative ratios (output 3–5× input, Sonnet 3–5× Haiku) are stable.

---

## Project exercises

### B1.2 — Token usage logging per chain (`ai_call_log` table)

- **Exercise ID:** `B1.2`
- **What to build:** new SQLite migration adding `ai_call_log` table; wrap every `messages.create()` call to write a row with chain, model, input/output tokens, latency, error.
- **Why it earns its place:** prerequisite for cost optimisation and B1.8 dashboard.
- **Files to touch:** new migration, every `src/services/ai/*.ts` chain, possibly a small helper in `src/services/ai/_log.ts`.
- **Done when:** every call writes a row; rows survive app restart; `SELECT * FROM ai_call_log` shows usage by chain.
- **Estimated effort:** 4 hours.

### B1.8 — Cost & latency panel in `app/settings/ai.tsx`

- **Exercise ID:** `B1.8`
- **What to build:** new section in the AI settings screen showing last-7-day cost per chain, latency p50/p95, and call count.
- **Why it earns its place:** turns the `ai_call_log` data into actionable observability.
- **Files to touch:** `app/settings/ai.tsx`, possibly a new query helper.
- **Done when:** panel renders without errors; sort by cost shows the most expensive chain at the top.
- **Estimated effort:** 4 hours.

---

## Summary

### Part 1 — concept recap

Token economics is per-chain cost accounting: input tokens, output tokens, model, chain name, latency, all logged per call. Output tokens cost 3–5× input; output is where the money goes. Buffr does not currently log token usage; the provider dashboard is the only signal and it's aggregated. The `B1.2` build (`ai_call_log` table) plus `B1.8` (settings panel) is the buildable next step.

### Part 2 — key points to remember

- Output tokens cost 3–5× input tokens.
- Per-chain logging is what enables targeted optimisation.
- The Anthropic dashboard doesn't break down by chain; you have to log locally.
- The first optimisation is usually "stop running this chain" (heuristic-before-llm).
- The second is "run a cheaper model for this chain."

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you control LLM cost," they're checking whether you measure per-chain. Engineers who say "we use the cheapest model" haven't measured; engineers who say "we log per-chain and route accordingly" have.

### Likely questions

**Q [mid]:** What's the biggest cost lever in an LLM application?

**A:** Output tokens — they cost 3–5× input. Cut output length (concise schemas, no chain-of-thought when not needed, shorter response budgets) and you cut cost proportionally. Second lever: heuristic-before-llm short-circuit — if you can answer 70% of inputs without calling the model, you cut cost 70% on that chain. Third: cheaper model per chain (Haiku for classifier; Sonnet only when capability matters).

**Q [senior]:** How would you decide which chain to optimise first?

**A:** Per-chain cost data. Without it, you optimise by guess and usually pick the wrong chain. With it, sort by daily cost descending — the top chain is where time pays back. For buffr, my prediction (untested until `B1.2` ships) is `interpret` dominates because the output is markdown reflection averaging ~800 tokens; the classifier is rounding error because Haiku and tiny output.

### One-line anchors

- Output tokens cost 3–5× input.
- Output length is the biggest cost lever.
- Per-chain logging is non-negotiable past ~$50/month.
- Heuristic-before-llm is the second-biggest lever.
- Aggregate dashboards tell you something's expensive; per-chain logs tell you what.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the per-call cost ledger: input tokens + output tokens + cache read → cost, with per-token rates.

### Level 2 — Explain it out loud

Explain in under 60 seconds why output token count matters more than input token count.

### Level 3 — Apply it to a new scenario

Estimate buffr's monthly cost if every daily-active user triggers all 5 chains once per day, you have 100 DAU, and average output is 200 tokens per chain.

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should switch all chains to Haiku to cut cost in half." Why or why not?

### Quick check — code reference test

Without opening files:
- What table does `B1.2` add?
- Which buffr chain do you expect to dominate cost?
- What's the output-to-input cost ratio for Sonnet 4.6?
