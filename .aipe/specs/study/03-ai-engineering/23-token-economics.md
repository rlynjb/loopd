# Token economics

**Industry name(s):** Token economics, LLM cost accounting, per-call token usage, input/output token billing
**Type:** Industry standard

> Why a chain that "feels free" can quietly cost more than the rest of the app combined — and how to measure it before it does.

**See also:** → [21-tokenization](./21-tokenization.md) · → [05-heuristic-before-llm](./05-heuristic-before-llm.md) · → [41-llm-cost-optimization](./41-llm-cost-optimization.md)

---

## Why care

A small café gets a single utility bill at the end of the month: $312. The owner pays it and shrugs. The next month it's $487 and the owner still doesn't know why — the bill aggregates the espresso machine, the lights, the walk-in freezer, the music speakers, into one number. To find out the freezer's seal failed and is running 24/7, the owner has to walk around with a clamp meter, room by room, and measure. Until those per-circuit numbers exist, every "make the bill smaller" plan is a guess.

The implicit question is where the spend is going, not how much it is. Not a single monthly total, not "feels cheap" intuition — per-chain, per-call, per-user numbers that let you point at the freezer.

**What depends on getting this right:** answering "which of the five chains in `src/services/ai/` accounts for most of the spend, and is the heuristic gate on `classify` actually saving money?" In this codebase nothing currently logs token usage — the planned `ai_call_log` table (referenced by exercise `[B1.2]` in this file and `21-tokenization.md`) would write one row per call with `chain_name`, `input_tokens`, `output_tokens`, `model`, `timestamp`. The Anthropic response's `usage.input_tokens` / `usage.output_tokens` and OpenAI's `prompt_tokens` / `completion_tokens` are already in every response — they just aren't read. Without that table, three cost surprises stay hidden: the cheap-but-frequent chain (classify firing on every new todo when the heuristic skip-rate drops), the chain whose context quietly grew (`expand.ts` shipping ~3 days of entry context), and the chain whose output doubled (output is 5× input per token on Sonnet, so verbose output is the early-warning signal).

Without per-chain token logging:
- Monthly Anthropic console total: $42
- "Is summarize or interpret the expensive one?" — you don't know
- A user-volume 10× would cost $420, but you can't tell which chain scales which way

With per-chain token logging (planned `ai_call_log`):
- Row per call: `summarize | 1234 in / 567 out | sonnet-4.6 | 2026-05-13T10:14`
- Aggregate by `chain_name` → "interpret is 60% of spend, summarize is 25%, classify is 5%"
- Heuristic skip-rate visible; output-token p95 visible; optimisation targets visible

A clamp meter on every circuit, not one monthly bill.

---

## How it works

LLM billing has two prices per model: input tokens (what you send) and output tokens (what comes back). On Claude Sonnet 4.6 the prices are ~$3 per million input tokens and ~$15 per million output tokens — a 5× ratio. On Haiku 4.5 they're ~$0.80 and ~$4 — same ratio, smaller absolute number. The ratio is roughly stable across providers because output is more expensive to generate than input is to process.

### The unit of cost is the call, not the day

Provider dashboards aggregate at the API-key level by day. That's useful for noticing a regression ("yesterday cost 2× normal") but useless for diagnosing *which feature* caused the regression. If you're coming from frontend, this is the same problem as having one big "JS bundle size" number without per-route attribution: you know the answer at the wrong granularity.

The practical consequence: to attribute spend, you log every call with `chain_name`, `input_tokens`, `output_tokens`, `model`, `timestamp`, `user_id` (always 1 today; matters when loopd grows to multi-tenant). The provider responses ship the token counts for free in their `usage` field — you just have to read them and write them to a local table.

### The provider gives you the counts; you build the table

```
Anthropic response shape (relevant fields)
  {
    "content": [{ "type": "text", "text": "..." }],
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0
    }
  }
```

OpenAI's response shape is similar but renames fields (`prompt_tokens`, `completion_tokens`). In a provider-abstracted codebase like loopd, normalising these into one `ai_call_log` row per call is two lines per provider arm.

### Where the cost surprises hide

Three patterns recur in real codebases:

1. **The cheap chain that ran 100×.** A heuristic-gated chain (classify in loopd) is cheap per-call but fires on every new todo. If the heuristic skip-rate drops from 70% to 40% after a content shift, classify spend triples silently. The fix isn't "make the chain cheaper" — it's *re-tuning the heuristic*, which you can only do if you can see the per-chain skip rate.

2. **The expensive chain that ran on context you didn't notice.** `expand.ts` ships ~3 days of entry context plus 5 sibling todos. If a user writes long entries, the expand prompt grows. You'd never notice the per-call cost creep without per-chain p50/p95 input-token logging.

3. **The output that was 10× longer than expected.** Models sometimes go verbose. The 5× input/output ratio means a chain whose output doubled has effectively doubled its cost. Output-token p95 is the early-warning signal.

### This is what people mean by "observability before optimisation"

You can't optimise what you can't measure. The first build item in this discipline is *not* "make it cheaper" — it's "make it visible." Once the per-chain spend is a number on a screen, the optimisation decisions become obvious (the heuristic-first pattern in `[05-heuristic-before-llm.md](./05-heuristic-before-llm.md)` is a direct response to "classify dominates spend"). Until then they're guesses. Here's the picture of how the data flows.

---

## Token economics — diagram

```
Per-call token logging pipeline

┌─ Chain call site (5 chains) ────────────────────────────┐
│  await client.messages.create({...})                    │
└─────────────────────────────────────────────────────────┘
            │
            ▼  response.usage = {input_tokens, output_tokens}
┌─ Logger (new) ──────────────────────────────────────────┐
│  logAiCall({                                            │
│    chain: 'caption',                                    │
│    provider: 'anthropic',                               │
│    model: 'claude-sonnet-4-6',                          │
│    input_tokens: 1234,                                  │
│    output_tokens: 567,                                  │
│    latency_ms: 2840,                                    │
│    timestamp: NOW(),                                    │
│  })                                                     │
└─────────────────────────────────────────────────────────┘
            │
            ▼
┌─ Storage layer ─────────────────────────────────────────┐
│  ai_call_log  (local-only SQLite table)                 │
│  ────────────────────────────────────                   │
│  id, chain, provider, model,                            │
│  input_tokens, output_tokens,                           │
│  latency_ms, timestamp                                  │
└─────────────────────────────────────────────────────────┘
            │
            ▼  read on demand
┌─ UI layer ──────────────────────────────────────────────┐
│  app/settings/ai.tsx — "AI cost & latency"              │
│   Per-chain: count, p50/p95 latency, $/30d              │
│   Classify: heuristic skip-rate                         │
└─────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Status:** Case B — concept not yet implemented.

loopd makes 30+ LLM calls on an active journaling day across five chains, but the only place spend is visible today is the provider's own console (aggregated, not per-chain). The curriculum's `[B1.2]` adds the `ai_call_log` table and the wrapper; `[B1.8]` adds the surface that reads from it.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, would land as `src/services/ai/aiCallLog.ts` consumed by every chain's call site)*
**Line range:** *(n/a)*

The closest existing pattern is `src/services/sync/syncMeta.ts` — a per-table local-only ledger that records sync timestamps. The `ai_call_log` table follows the same shape (local-only, append-only, read for UI panels).

---

## Elaborate

### Where this pattern comes from
Token-economics observability is inherited directly from API-cost observability (Stripe, Twilio, SendGrid) — the same "log every call, attribute it" pattern, retrofitted for LLMs once spend became real. The discipline became important around 2023 when production LLM costs started rivalling or exceeding hosting costs for some apps.

### The deeper principle
You optimise what you measure. Without per-chain attribution, every cost decision is a guess. The principle generalises beyond LLMs: it's the same reason you instrument route-level latency in a web framework, query-level cost in a database, and bundle-route attribution in a frontend.

### Where this breaks down
Per-call logging adds a few ms of overhead per chain — acceptable for ~30 calls/day, possibly not for a high-volume API where calls happen in tight loops. At loopd's solo scale this is invisible; at 100k QPS it would need batching or sampling.

### What to explore next
- [05-heuristic-before-llm](./05-heuristic-before-llm.md) → the cost-saving pattern that this instrumentation makes visible
- [41-llm-cost-optimization](./41-llm-cost-optimization.md) → what you do with the data once you have it
- [40-llm-caching](./40-llm-caching.md) → prompt caching, the other big lever

---

## Tradeoffs

### Comparison table — per-call log vs provider-dashboard only

```
┌──────────────────────┬────────────────────────┬────────────────────────┐
│ Cost dimension       │ Per-call log (target)  │ Provider dashboard only│
├──────────────────────┼────────────────────────┼────────────────────────┤
│ Per-chain attribution│ Yes                    │ No                     │
│ Per-call latency     │ Yes                    │ No                     │
│ Heuristic skip rate  │ Computable             │ Invisible              │
│ Storage (90 days)    │ ~5 MB                  │ 0                      │
│ Code complexity      │ 1 wrapper + 1 table    │ 0                      │
│ Per-call overhead    │ ~1–5ms                 │ 0                      │
│ Cost-regression alert│ Local (custom)         │ Provider email only    │
│ Debugging surface    │ SQL query              │ Vendor UI              │
└──────────────────────┴────────────────────────┴────────────────────────┘
```

### Sub-block 1 — what per-call logging gives up

A new local-only table (`ai_call_log`) with five-ish columns and a no-op wrapper at every chain call site. Roughly 50 lines of code and ~5 MB of storage over 90 days at solo usage. Plus ~1–5ms of overhead per call (negligible — the network call is 2000–5000ms).

### Sub-block 2 — what dashboard-only would have cost

Continued blindness on the question "which chain costs the most?" Today loopd has a justified-but-untested belief that classify is cheap (heuristic gates 60–70%) and `interpret` is expensive (Sonnet, 2k input tokens). Without per-chain logging, that belief is unfalsifiable — and the moment a chain regresses (model drift, prompt change, longer entries), the regression is invisible until the monthly bill arrives.

### Sub-block 3 — the breakpoint
The provider-dashboard-only choice stops being acceptable the moment loopd's monthly LLM spend exceeds a meaningful number — anywhere from $20/mo (solo dev hobby threshold) to $5k/mo (small-team production threshold). For loopd today the spend is small; the discipline isn't being built for cost-control but for *practice* — to learn the observability pattern on a system where the cost of getting it wrong is small.

### What wasn't actually a tradeoff
Real-time alerting (Slack pings when a chain spikes) was never considered for loopd's scale. It belongs in Phase 5 once there are users beyond solo.

---

## Tech reference (industry pairing)

### Anthropic `usage` field

- **Codebase uses:** target consumer for `[B1.2]`; today the field is received but discarded.
- **Why it's here:** authoritative token count returned on every Claude API response; the source of truth for billing-grade input/output token numbers.
- **Leading today:** Anthropic `usage` — `adoption-leading`, 2026.
- **Why it leads:** ships on every response; includes cache-aware fields (`cache_read_input_tokens`); no separate API call needed.
- **Runner-up:** client-side estimation via `@anthropic-ai/tokenizer` — `innovation-leading` for pre-flight estimation; useful when you need to refuse oversized prompts before the call, but trails the in-response count for accuracy.

### Langfuse

- **Codebase uses:** not used.
- **Why it's here:** managed LLM observability — traces, spans, cost attribution. The Datadog of LLM calls.
- **Leading today:** Langfuse — `innovation-leading` for self-hosted LLM observability, 2026.
- **Why it leads:** open source, self-hostable, OpenTelemetry-compatible. Fits loopd's local-first stance better than SaaS alternatives.
- **Runner-up:** LangSmith — `adoption-leading` for managed observability if you're already in the LangChain ecosystem; bigger feature surface but vendor lock-in.

---

## Project exercises

### [B1.2] Add token usage logging per chain

- **Exercise ID:** `[B1.2]`
- **What to build:** A new local-only SQLite table `ai_call_log` (id, chain, provider, model, input_tokens, output_tokens, latency_ms, timestamp). A small wrapper `logAiCall()` in `src/services/ai/aiCallLog.ts` that every chain call site invokes after the model response returns. The wrapper reads `response.usage` (Anthropic) or `response.usage.prompt_tokens` / `completion_tokens` (OpenAI) and inserts a row.
- **Why it earns its place:** the foundation for `[B1.8]`, `[B5.3]` (cost optimisation), and the interview answer "how do you know what your app costs?". Without it, every other cost-related decision is a guess.
- **Files to touch:** new migration in `src/services/database.ts` schema bootstrap; new `src/services/ai/aiCallLog.ts`; edit `summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts`, `interpret.ts` to call `logAiCall()` after every response.
- **Done when:** every chain call adds a row to `ai_call_log`; a SQLite query confirms per-chain row counts; `npx tsc --noEmit` passes; the wrapper handles the OpenAI-vs-Anthropic field rename cleanly.
- **Estimated effort:** `1–4hr`.

### [B1.8] AI cost & latency panel in app/settings/ai.tsx

- **Exercise ID:** `[B1.8]`
- **What to build:** A read-only panel in `app/settings/ai.tsx` showing per-chain count, p50/p95 latency, and 30-day token spend in dollars (using a small `MODEL_PRICING` constant table for input/output rates per model). Classify gets an additional "heuristic skip-rate" row: of the last N todos, what fraction never hit the network.
- **Why it earns its place:** the receipt for `[05-heuristic-before-llm](./05-heuristic-before-llm.md)`'s named win — the skip-rate is the senior-interview answer to "how do you know the heuristic is worth keeping?". Also closes the loop on `[B1.2]`: logged data is only useful when surfaced.
- **Files to touch:** `app/settings/ai.tsx`, new `src/services/ai/queries.ts` (p50/p95 + skip-rate SQL helpers), depends on `[B1.2]` for the `ai_call_log` table.
- **Done when:** the panel renders on device; numbers match a hand-computed SQL spot-check; tapping a chain row drills into its last-24h call history.
- **Estimated effort:** `1–2 days`.

---

## Summary

Token economics is the discipline of measuring LLM cost at call-site granularity so you can attribute spend to specific chains, features, or users. In loopd this is not yet implemented — the only spend visibility today is the provider's aggregate dashboard, which can't answer "which chain spent that?". The constraint that makes per-call logging the right call is that loopd's heuristic-first cost pattern is unfalsifiable without measurement: every cost claim in this codebase is currently a belief, not a number. The cost to pay is one new local-only table, a wrapper at every chain call site, and ~1–5ms of overhead per call — invisible against the 2–5s network round-trip.

Key points to remember:
- Input and output are billed separately; output is ~5× the input rate on every modern model.
- The provider dashboard tells you "today cost X"; per-call logging tells you "chain Y caused X."
- The `usage` field on every response gives you the count for free — log it.
- Without per-chain attribution, every cost optimisation decision is a guess.
- `[B1.2]` (the table) and `[B1.8]` (the panel) are the smallest possible end-to-end build for this discipline.

---

## Interview defense

### What an interviewer is really asking
"How do you know what your LLM app costs?" probes whether the candidate has actual numbers or just vibes. The follow-up — "which chain costs the most?" — separates candidates who instrumented from candidates who only read the monthly bill.

### Likely questions

  [mid] Q: How do you measure LLM cost in your app?
  A: I log every call into a local `ai_call_log` table — chain, provider, model, input tokens, output tokens, latency, timestamp. The token counts come for free from the API response's `usage` field; I just read them and write a row. From there, a SQL query against the table gives me per-chain spend, p50/p95 latency, and (for the classify chain specifically) the heuristic skip-rate. That's the foundation for the AI cost & latency panel in settings.
  Diagram:
  ```
  chain.call() ──► API response.usage ──► logAiCall() ──► ai_call_log
                                                              │
                                                              ▼
                                                       SQL → settings/ai.tsx
  ```

  [senior] Q: Which chain in loopd costs the most? How would you optimise it?
  A: Without `[B1.2]` shipped, I'm guessing — but the educated guess is `interpret` (Sonnet 4.6, ~2k input tokens, ~1k output tokens) because it runs at the high price per token and skips no calls. `caption` is second because of the rotation block adding ~500 tokens per call. Classify is the cheapest by absolute spend even though it has the highest call rate, because Haiku 4.5 is cheap and the heuristic skip-rate gates 60–70% of calls. The optimisation order would be: ship `[B1.2]` to verify the ranking; then ship `[B5.2]` prompt caching for the system-prompt portion of interpret and caption; then ship `[B5.8]` semantic cache for interpret specifically.
  Diagram:
  ```
  Picked: Sonnet + no cache       Suggested: cache + cheaper
  ───────────────────────────     ──────────────────────────
  ~$0.012 per interpret           ~$0.003 per cached hit
  Hard to know without log        After [B1.2]: visible
                                    After [B5.2]: cheaper
  ```

  [arch] Q: What changes at 10× scale — 100k journaling users?
  A: Two architectural shifts. First, the local-only `ai_call_log` table becomes a multi-tenant cloud-mirrored table with per-user attribution and indexing for query performance. Second, the cost-optimisation lever shifts from per-call optimisation to *budget enforcement* — you need pre-flight token estimation (client-side tokenizer) and a refusal path for users who exceed a budget, because at 100k users a single regression in `expand` would burn the cost budget in hours.
  Diagram:
  ```
  ┌─ UI layer ──────────────────────┐
  │ AI ops panel                    │
  └─────────────────────────────────┘
              │
  ┌─ Service layer ─────────────────┐
  │ Pre-flight tokenizer ◄ NEW      │ ← breaks first at 10×
  │ Per-user budget enforcement     │
  └─────────────────────────────────┘
              │
  ┌─ Storage layer ─────────────────┐
  │ Cloud-mirrored ai_call_log      │
  │ + budget rules table            │
  └─────────────────────────────────┘
  ```

### The question candidates always dodge
"Why didn't you just use Langfuse or LangSmith from day one?" The honest answer: at solo scale, the value of a managed observability tool is less than the cost of integrating one. A local SQLite table that ships in your existing app is ~50 lines and 0 new dependencies. Langfuse is 0 lines of integration if you're already running it, but it's a service to operate. The decision flips when (a) you have multiple users and per-user attribution matters, or (b) you have multiple developers and shared observability beats individual queries.

```
Picked: local ai_call_log         Suggested: Langfuse
─────────────────────────         ─────────────────────
~50 LOC                            ~5 LOC integration + service to operate
0 deps                             1 dep + 1 service
Solo SQL queries                   Shared dashboards
Free                               Self-host or pay
Right at solo scale                Right at team scale
```

### One-line anchors
- Output is ~5× input price. Per token, output dominates spend.
- "Cheap per call" × "called a lot" = often the most expensive thing.
- The `usage` field is free; not logging it is the only mistake here.
- Heuristic skip-rate is the receipt for the heuristic-first pattern's claim.
- Local table now; managed observability when there are users to attribute to.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the per-call token logging pipeline. Label the four boxes: chain call site, logger, storage layer, UI layer. Include the table schema.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) what `usage` returns, (b) why per-call logging beats provider dashboard, (c) the two build items (`[B1.2]` and `[B1.8]`) and what each delivers, (d) the heuristic-skip-rate number and why it matters.

### Level 3 — Apply it to a new scenario
You ship `[B1.2]` and discover that `expand` accounts for 60% of monthly spend — much higher than expected. Without changing the chain, name two interventions you could try and what each would cost.

Open `[B2A.7]` and `[05-heuristic-before-llm](./05-heuristic-before-llm.md)` to check your answers against the patterns already in the codebase.

### Level 4 — Defend the decision you'd change
Today `ai_call_log` is local-only. If you were starting today with multi-user from day one, would you make it cloud-mirrored from the start? Defend your answer in 3–5 sentences, naming the specific cost dimension you'd accept.

### Quick check — code reference test
- What table would `[B1.2]` create?
- Where is the `usage` field consumed today?

Answer: `ai_call_log` (target, not yet created). `usage` is *received* on every API response but currently *discarded* — no code consumes it.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (café-with-one-utility-bill scenario, name the per-circuit-attribution question, planned ai_call_log stakes for the five chains, before/after, single-line metaphor).
