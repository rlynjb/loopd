# Context window

**Industry name(s):** Context window, context length, prompt window
**Type:** Industry standard

> A fixed token budget that the model "sees" per call. Input + output share it. Everything competes for space: system prompt, history, retrieval, response. Over-budget = truncation or rejected request.

**See also:** → [`01-llm-foundations/02-tokenization`](../01-llm-foundations/02-tokenization.md) · → [02-lost-in-the-middle](./02-lost-in-the-middle.md) · → [`03-retrieval-and-rag/11-rag`](../03-retrieval-and-rag/11-rag.md)

---

## Why care

### Move 1 — The grounded scenario

You're building the `expand` chain in buffr. Input: a todo (~50 tokens) + 4 sibling todos (~200 tokens) + last 3 days of journal entries (capped at ~1000 chars each, ~250 tokens each = ~750 total). Total prompt around 1000 tokens. Sonnet 4.6's context window is 200k. Plenty of room. Then someone writes a long-form journal day — 5000 tokens of prose. The principle-#11 cap was supposed to be in characters; nobody bounded it in tokens. The prompt now runs 5500 tokens; still fits, but the model attends to the long entry's first and last sections and ignores the middle (where the relevant sibling-context lived). The output gets worse without erroring.

### Move 2 — Name the question the pattern answers

That what-fits-and-what-doesn't question is what the context window answers. Not "what's the largest model I can pick" (orthogonal); just *what's the budget for one call, who's spending it, and what happens at the edges*. The answer: a hard cap per model (Sonnet 4.6 = 200k, GPT-4o = 128k), shared between input and output, and you don't want to be anywhere close to the cap because behaviour degrades before it errors.

### Move 3 — Why answering that question matters

**What breaks without context-window discipline:** at 80% of the cap, lost-in-the-middle kicks in (concept 02). At 100%, the request errors (or some providers silently truncate). In buffr, the chains all sit comfortably under 5% of the Sonnet window — context is not the constraint today. The discipline matters as features grow (a future "interpret week" chain with all 7 days of entries plus retrieval would push toward 20% of the window; if poorly bounded it could approach the limit).

### Move 4 — Concrete before/after

Without context-window awareness:
- Build `interpret-week` with no token-budgeting
- Works for 7 short days (~3k tokens total)
- A user with verbose entries hits 50k tokens; quality degrades silently
- Debug: weeks (the model isn't erroring, it's just outputting worse)

With context-window awareness:
- Document each chain's expected budget in code
- Add `countTokens` assertion in dev/staging
- Long-input case triggers truncation or chunking
- Quality stays stable

### Move 5 — The one-line summary

The context window is a fixed budget shared by input + output; everything competes for space; behaviour degrades long before the hard cap; bound your input or the cap binds your output.

---

## How it works

### Move 1 — The mental model

```
   ┌────────────────────────────────────────────────┐
   │              Context window (finite)           │
   │                                                │
   │  System prompt    [██████░░░░░░░░░░░░░░░░░░]  │
   │  Conversation     [████████████░░░░░░░░░░░░]  │
   │  Retrieved docs   [████░░░░░░░░░░░░░░░░░░░░]  │
   │  Response space   [░░░░░░░░░░░░░░░░████████]  │
   │                                                │
   │  Total: fixed. Everything competes for space.  │
   └────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — model-specific limits.** Each model has a documented window. Pick a model that fits your needs with buffer; don't pick one that "just barely fits" because behaviour at 80%+ is unreliable.

```
   Model context windows (May 2026)
   ────────────────────────────────
   Claude Sonnet 4.6     200k tokens
   Claude Haiku 4.5      200k tokens
   GPT-4o                128k tokens
   GPT-4o-mini           128k tokens
   Gemini 2.x            1M tokens   (with lost-in-the-middle caveat)
```

**Layer 2 — input + output share the budget.** A 200k window means input tokens + reserved output tokens together stay under 200k. If you set `max_tokens = 4096`, only 195,904 are available for input. Most chains: input is the constraint; reserved output is small (a few hundred tokens for JSON; a few thousand for markdown).

```
   Buffr's per-chain budget (input / reserved output)
   ──────────────────────────────────────────────────
   summarize    ~1500 in  /  500 out      → 1% of 200k window
   caption      ~800 in   /  300 out      → 0.5%
   expand       ~4000 in  /  800 out      → 2.5%
   classify     ~150 in   /  50 out       → 0.1%
   interpret    ~3000 in  /  2000 out     → 2.5%
```

All well under the cap. Context is not a constraint for buffr today.

**Layer 3 — the 80% rule.** Lost-in-the-middle (concept 02) kicks in well before the hard cap. Modern frontier models attend strongly to the start and end of context, weakly to the middle. At 80% of the window, the middle is large enough that important content there gets ignored. Treat 80% as a soft cap.

```
   Practical thresholds
   ────────────────────
   <20% of window    →  prompt is "small"; lost-in-the-middle not a factor
   20-80% of window  →  budget matters; place key content at start or end
   >80% of window    →  lost-in-the-middle is real; chunk or summarise first
   100% of window    →  truncation or error from the provider
```

### Move 3 — The principle

Budget every chain's input. Pick a model with comfortable headroom (target 5-30% utilisation). When a chain grows close to 80%, reach for retrieval + reranking or chunking — not for "a bigger model." Bigger models with poor budget discipline still suffer lost-in-the-middle.

The full picture is below.

---

## Context window — diagram

```
┌─ Chain budget allocation ──────────────────────────────────────────────┐
│                                                                        │
│   ┌──────────────────────────────────────────────────────────┐         │
│   │ system prompt (~200-500 tokens)                          │         │
│   ├──────────────────────────────────────────────────────────┤         │
│   │ user message + context (~500-4000 tokens)                │         │
│   ├──────────────────────────────────────────────────────────┤         │
│   │ retrieved docs (variable — 0 to ~5000 tokens)            │         │
│   ├──────────────────────────────────────────────────────────┤         │
│   │ ░░░░░░░░░░░░░░░░░░ free space ░░░░░░░░░░░░░░░░░░          │         │
│   │  available for output                                    │         │
│   └──────────────────────────────────────────────────────────┘         │
│                                                                        │
│   Cap: 200k tokens (Sonnet 4.6). Buffr's chains: ~150 to ~5000 input.  │
│   Headroom: comfortable. No chain approaches 80% threshold today.       │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A (passive) — buffr's chains all sit comfortably under 5% of the Sonnet 4.6 window.**

**Files:** `src/services/ai/{summarize,caption,expand,classify,interpret}.ts` — each chain's input is bounded by the principle-#11 cap (~1000 chars per source) plus a small system prompt. The largest chain (`expand`) tops out around 4000 input tokens.

No chain currently counts tokens or asserts an input budget at runtime. The current shape works because the principle-#11 cap is conservative; a future chain that retrieves vector-search results could blow past 80% if poorly bounded. The buildable next step is the `B1.2` token logging (concept 01-llm-foundations/06) plus a per-chain assertion that input tokens stay under a documented budget.

---

## Elaborate

### Where this pattern comes from

Context windows have grown ~30× since GPT-3 (4k → 200k+). The growth pattern: each generation makes more headroom available, but lost-in-the-middle effects mean usable utilisation has only grown ~5×. Engineering practice: budget within the usable range, not the cap.

### The deeper principle

Any system with a finite shared resource needs explicit budgeting. The LLM context window is a particularly silent resource — over-budget chains degrade output instead of erroring.

### Where this breaks down

For very small inputs (under 2000 tokens), context-window budgeting is not load-bearing — you're at <2% utilisation. For RAG systems with variable retrieval set sizes, budgeting is the load-bearing discipline.

### What to explore next

- [02-lost-in-the-middle](./02-lost-in-the-middle.md) — why 80% utilisation degrades quality
- [`01-llm-foundations/06-token-economics`](../01-llm-foundations/06-token-economics.md) — once you count tokens, you can budget
- [`03-retrieval-and-rag/11-rag`](../03-retrieval-and-rag/11-rag.md) — RAG is where context windows get tight

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Explicit budgeting        │ "It'll fit"                  │
├──────────────────┼───────────────────────────┼──────────────────────────────┤
│ Quality at scale │ Stable                    │ Degrades on long inputs       │
│ Catches over-    │ Yes, at build time        │ Only via user complaints      │
│ budget           │                           │                              │
│ Cost overhead    │ One countTokens call/chain│ Zero                         │
│ Code complexity  │ ~5 lines per chain        │ Zero                         │
└──────────────────┴───────────────────────────┴──────────────────────────────┘
```

### The breakpoint

Add budgeting whenever a chain's input is user-controlled and not strictly bounded. For chains with fixed-shape input (classifier, fixed-schema extraction), the budget is implicit in the schema.

---

## Tech reference

### Anthropic Sonnet 4.6 / Haiku 4.5

- **Codebase uses:** both, 200k context window each.
- **Why it's here:** comfortable headroom for buffr's chain sizes.

### `countTokens` helper

- **Codebase uses:** **Case B** — not currently used. Would gate input budget assertions.

---

## Project exercises

### B-context-budget — Document per-chain context budgets

- **What to build:** add a header comment in each chain file naming its expected input budget (in tokens) and the assumption that gates it (e.g., "principle #11 cap holds inputs to ~4000 tokens; assert via `countTokens` if this assumption is changed").
- **Why it earns its place:** budgeting is documented assumption; without the doc, the next engineer working on the chain may grow the input without realising they crossed a threshold.
- **Files to touch:** all 5 chain files in `src/services/ai/`.
- **Done when:** each chain has a documented budget; `B1.2` is implemented to enforce assertions.
- **Estimated effort:** 1 hour.

---

## Summary

### Part 1 — concept recap

The context window is a fixed token budget per call, shared between input and output. Quality degrades around 80% utilisation (lost-in-the-middle), not at the hard cap. Buffr's chains sit at <5% of the Sonnet 4.6 window — context isn't a constraint today. The discipline matters as chains grow (future week-scope interpret + retrieval could approach 20%).

### Part 2 — key points to remember

- Window is shared by input + output.
- Hard caps: Sonnet 200k, GPT-4o 128k, Gemini 1M.
- Soft cap: 80% of the window (lost-in-the-middle).
- Bigger models don't fix poor budgeting.
- Buffr's chains are far under the cap today; build the budget discipline for the future.

---

## Interview defense

### Likely questions

**Q [mid]:** What's the 80% rule?

**A:** Lost-in-the-middle kicks in well before the hard context cap. At ~80% utilisation, the middle of the context is large enough that important content there gets ignored by the model's attention pattern. Treat 80% as a soft cap; reach for retrieval or chunking before crossing it. Bigger models (Gemini 1M) don't fix this — the attention bias scales with context size.

**Q [senior]:** How do you decide when to chunk vs use a bigger window?

**A:** If the relevant content can be ranked by relevance, chunk + retrieve (top-k chunks, much smaller window). If the content needs to be processed end-to-end (a long document summary), use a bigger window AND structure the prompt to put key content at start and end. Avoid the middle ground where you stuff a long context and hope.

### One-line anchors

- Context window is a shared budget for input + output.
- Quality degrades at 80%, not 100%.
- Buffr is at <5% today; future chains may push higher.
- Bigger models don't fix poor budgeting.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the context window with system prompt + user message + retrieved docs + free space competing for one budget.

### Level 2 — Explain it out loud

Explain in under 60 seconds why 80% utilisation is the soft cap.

### Level 3 — Apply it to a new scenario

A new requirement: buffr's `interpret` chain extends to week-scope (7 days of entries). Estimate budget. Where do you put the most important content?

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should switch to Gemini 2.x for the 1M context window; principle #11 stops being load-bearing."

### Quick check — code reference test

- What's buffr's current chain at highest token utilisation?
- Where does the principle-#11 cap live?
- What's the 80% rule?
