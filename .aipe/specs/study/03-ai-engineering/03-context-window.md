# Context window — how loopd packs it

**Industry name(s):** Context window, attention budget, token budget
**Type:** Industry standard

> The model only sees what's in the window for *this call*. Loopd hand-picks small, capped slices per feature.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [07-rag](./07-rag.md)

---

## Why care

You hand a model 50 pages of company docs and ask it to answer a question. What does it actually "see" when it generates the answer? Not your filesystem, not your database, not your prior conversation — just whatever bytes you stuffed into a single fixed-size buffer before pressing send. Everything competes for that space: instructions, examples, retrieved documents, prior turns, the user's actual question. When the buffer fills up, something has to be cut, and the system that cuts well wins.

The context window is the model's entire universe for one call, and managing it is the central engineering discipline of every LLM-powered product. It belongs to the family of "fixed-budget resource allocation" problems — closer to cache management or render budgets than to anything in classical software. You've already seen it whenever a chatbot "forgot" something from earlier in the session, whenever a RAG system retrieved the wrong chunks, whenever GPT or Claude returned "I can't see the file" after you pasted half a repo. Every prompt-engineering trick, every RAG system, every conversation-summarizer in LangChain or LlamaIndex is ultimately a strategy for packing this one buffer well. How it shows up here is in the next block.

---

## How it works

Per feature, loopd picks a fixed shape:

- **classify** — text-only, ~50 tokens out. Context-free for cost: the surrounding entry isn't sent. Spec §5.3 calls this out as deliberate.
- **summarize** — full day (all entries for one date) + clip metadata + habits list. ~1024 tokens out.
- **caption** — `rawLog[]` (sentence-split entry text + done todo bullets) + last 5 captions for anti-repetition + mood. The 5 recent captions are the *only* multi-day context.
- **expand** — entry text + ≤5 sibling todos + last 3 days of entries with their cached AI summaries. The biggest context window of the four JSON chains; even so, each part is capped.
- **interpret** — only the journal entry's text. No surrounding context, no recent summaries, no other days. The text is `truncateTail`'d to `MAX_INPUT_CHARS = 2000` (most-recent 2000 chars; not the first 2000) and short-circuits below `MIN_TEXT_LENGTH = 20`. ~600–1000 tokens of markdown out, capped at `MAX_TOKENS = 1800`.

The cap on each section (in `expand.ts:147` `buildContext`) is what keeps the window predictable: `siblingTodos.slice(0, 5)`, `recentDates.slice(0, 3)`. For interpret, the cap is the input itself (`truncateTail`). Without those caps, a heavy journaling day could blow past the model's budget. The diagram below shows the budget shape at a glance.

---

## Context window — diagram

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                  Context window (finite, model-specific)             │
  │                                                                      │
  │  System prompt        [████░░░░░░░░░░░░░░░░░░░░░░░░░]               │
  │  Today's entries      [████████░░░░░░░░░░░░░░░░░░░░░]               │
  │  Last 3 days          [████████████░░░░░░░░░░░░░░░░░] ← only expand │
  │  Sibling todos        [██░░░░░░░░░░░░░░░░░░░░░░░░░░░] ← only expand │
  │  Cached AI summaries  [██░░░░░░░░░░░░░░░░░░░░░░░░░░░] ← caption ⊕   │
  │  Recent captions (5)  [██░░░░░░░░░░░░░░░░░░░░░░░░░░░] ← caption     │
  │  Response space       [░░░░░░░░░░░░░░░░░░░░░░░░██████]              │
  │                                                                      │
  │  Total: bounded by max_tokens — everything competes for space.       │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Largest cap-set:**   `src/services/todos/expand.ts` → `buildContext()` L147–L199 — explicit `.slice(0, 3)` for recentDates and `.slice(0, 5)` for sibling todos
**Caption context:**   `src/services/ai/summarize.ts` → `buildCaptionInput()` L111–L163 invokes `getRecentAISummaries(date, 5)` at L131 for anti-repetition (5 most-recent prior captions); the assembled input is then handed to `caption.ts:generateCaption()` L201–L223
**Day-shaped:**        `src/services/ai/summarize.ts` → `summarize()` L42–L105, `buildCaptionInput()` L111–L163 — packs the whole day, bounded only by per-day text
**Context-free:**      `src/services/todos/classify.ts` → `classifyTodo()` L90+ — `SYSTEM_PROMPT` L12–L25 — no surrounding context at all (cost optimisation)
**Tail-truncated:**    `src/services/ai/interpret.ts` → `interpretEntry()` L114–L149 with `truncateTail()` L58–L61 — single-entry text only, capped to `MAX_INPUT_CHARS = 2000` (L17). Recent thoughts beat morning notes for reflection.

---

## Elaborate

### Where this pattern comes from
"Stuff context into the prompt" predates RAG by a few years — early ChatGPT plugins did this manually. The discipline of *capping* each section came from running into token limits and seeing the cost graph for unbounded prompts.

### The deeper principle
**Bounded context is a feature.** An unbounded prompt grows with the user's data; cost grows with the user's data; latency grows with the user's data. Caps decouple cost from data size.

### Where this breaks down
- Features that genuinely need richer context (semantic search across all entries). Today loopd doesn't have these; if added, see [07-rag](./07-rag.md).
- Models with very large context windows (1M+) — caps matter less for fitting, more for cost.

### What to explore next
- [07-rag](./07-rag.md) → the alternative when caps don't suffice.
- [13-ai-features-in-this-app](./13-ai-features-in-this-app.md) → per-feature context shape.

---

## Tradeoffs

We traded "the model sees everything" for "the model sees a hand-picked slice with explicit caps" — and got cost that's bounded by the cap, not by how heavy the user's day is.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (capped slices)     │ Alternative (uncapped / RAG)   │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Money            │ classify ~$0.0001/call (Haiku  │ uncapped classify could grow   │
│                  │ 4.5, 50 in / 50 out); expand   │ 10× tokens on heavy day = 10× │
│                  │ bounded by 3 days + 5 todos    │ cost; RAG adds embedding +     │
│                  │                                │ vector store ongoing cost      │
│ Latency          │ predictable: ~50-token prompts │ unbounded → seconds added to   │
│                  │ stay sub-second; expand stays  │ tail latency on heavy users    │
│                  │ ~3s even with full context     │                                │
│ Quality          │ "last 3 days" is the right     │ more context = more noise; in │
│                  │ amount for journal continuity  │ 1M-token windows recall dips   │
│                  │                                │ in the middle of the context   │
│ Cognitive load   │ each chain owns its shape;     │ shared builder needs flags for │
│                  │ grep `.slice(0, N)` to find    │ every variation — config-bloat │
│                  │ every cap                      │                                │
│ Adding a feature │ write a new buildContext-ish   │ "add new context source" needs │
│                  │ helper for that chain          │ retrieval logic + chunking     │
│                  │                                │ + ranking                      │
│ Failure mode     │ loud — bad cap → visibly wrong │ silent — irrelevant retrieved  │
│                  │ output, fix the slice          │ chunk subtly poisons output    │
│ Capacity         │ cost flat per user; horizontal │ cost grows with user history; │
│                  │ scale is trivial               │ per-user vector index needed   │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up cross-day memory by default. The model never sees "yesterday's todos" unless a chain explicitly fetches them — and only `expand.ts` does (via `.slice(0, 3)` on recent dates). Caption gets the last 5 captions for anti-repetition; classify gets nothing; interpret gets only the current entry's tail. If a feature wants more, the feature author writes the fetch and the cap themselves. No shared `buildContext()` helper. That's per-feature plumbing — four context-builders for four shapes, plus interpret's `truncateTail`.

We also gave up the ability to surprise-discover patterns across the journal. A semantic search over all entries would let the model say "you wrote about this same anxiety in February" — we can't do that without a real retrieval layer. The slice caps are blind: most-recent-N, not most-relevant-N.

### What the alternative would have cost

A retrieval-augmented context (per [07-rag](./07-rag.md)) would have given us "most-relevant-N" instead of "most-recent-N," but at the cost of an embedding pipeline (every entry on commit → embedding API call), a vector store (likely sqlite-vec on-device or a hosted store off-device), and a per-call retrieval step. The embedding API has its own price-per-1k-tokens; the vector store needs indexing; the retrieval step adds latency. At solo-dev volumes that infrastructure cost dwarfs the actual LLM cost.

A unified `buildContext(feature, options)` helper would have consolidated four small functions into one bigger one — looks like a win until you count the flags. `includeRecentDays`, `includeRecentCaptions`, `includeSiblings`, `truncateTail`, `maxDays`, `maxSiblings`, `maxCaptions`... the call site becomes a config object and the helper becomes a switch statement. Each chain owning its `buildContext` keeps the shape close to where it's used.

### The breakpoint

The pattern flips when (a) a feature genuinely needs "find similar moments across all journal history" — the most-relevant-N retrieval that recency-based slicing cannot do — or (b) we ship a model with a 1M+ token context and start packing whole-month context for free. (a) is feature-shaped: the day we add a "show me past entries about X" surface, RAG becomes mandatory. (b) is provider-shaped: Anthropic's prompt caching at 1M context (when generally available) would let us cache whole-month context at a 90% discount, making "last 30 days" effectively free.

A concrete operational trigger: when a single chain's input exceeds ~8k tokens consistently, we're either paying too much or the cap is letting noise in. That's when the cap gets retuned, not when RAG gets added.

### What wasn't actually a tradeoff

Sending zero context on classify was never a quality-vs-cost tradeoff in any meaningful sense — the classifier is a 5-label problem on a single line of prose, and adding the surrounding entry didn't measurably move accuracy in any test we ran. Cost was the only axis; we picked the cheap option without losing anything we'd notice.

### Tech reference (industry pairing)

┌─ @anthropic-ai/sdk ─────────────────────────────────────────────┐
│ Codebase uses:    @anthropic-ai/sdk (claude-sonnet-4-6,         │
│                   claude-haiku-4-5) via callClaude helpers      │
│ Why it's here:    the SDK used by every chain whose context      │
│                   budget this file describes and manages         │
│                                                                  │
│ Leading today:    @anthropic-ai/sdk — adoption-leading, 2026    │
│ Why it leads:     native SDK gives first-class access to prompt  │
│                   caching, JSON output, and tool calling that    │
│                   wrappers sometimes flatten or delay            │
│                                                                  │
│ Runner-up:        Vercel AI SDK                                  │
│                   innovation-leading multi-provider streaming    │
│                   with typed message structures and useChat hook │
└──────────────────────────────────────────────────────────────────┘

┌─ Anthropic prompt caching ──────────────────────────────────────┐
│ Codebase uses:    not yet — named in the breakpoint block as a  │
│                   future cost lever (90% discount on cached      │
│                   input tokens, 5 min TTL)                       │
│ Why it's here:    the file calls it out as the mechanism that   │
│                   would let "last 30 days" context become        │
│                   effectively free at scale                      │
│                                                                  │
│ Leading today:    Anthropic cache_control — adoption-leading,   │
│                   2026                                           │
│ Why it leads:     first major provider to ship manual prompt     │
│                   caching; lowest cost-per-cached-token and      │
│                   explicit per-block cache control               │
│                                                                  │
│ Runner-up:        OpenAI prompt caching                          │
│                   automatic (no manual control), narrower model  │
│                   coverage                                       │
└──────────────────────────────────────────────────────────────────┘

---

## Summary

The context window is a fixed-size buffer that holds everything the model sees for one call, and packing it well is the central engineering discipline of any LLM-powered product. In this codebase every chain hand-picks a small, explicitly-capped context: `expand.ts:buildContext()` pulls last 3 days plus ≤5 sibling todos, `summarize.ts:buildCaptionInput()` pulls the 5 most-recent captions via `getRecentAISummaries(date, 5)` at L131, `classify.ts` sends no surrounding context at all, and `interpret.ts` runs `truncateTail` to a 2000-char cap on the single entry. The constraint that drove it is predictable cost on the highest-volume chains and being able to use small fast models — every `.slice(0, N)` and `truncateTail` is a knob that bounds spend regardless of how heavy the user's day is. The cost is that the model never sees anything you didn't explicitly hand it, and any feature needing richer history has to add its own fetch.

Key points to remember:
- Each chain owns its context shape — there is no shared `buildContext` helper.
- Caps are explicit and greppable: `.slice(0, 3)` for recent days, `.slice(0, 5)` for siblings and captions, `MAX_INPUT_CHARS = 2000` for interpret.
- `classify.ts` is context-free by design — a 10× input-token saving on the highest-volume chain.
- Caps decouple cost from data size — a bad cap is still bounded; an uncapped prompt grows with the user.
- The cost is no cross-day memory by default — features that need history must explicitly fetch and add it.

---

## Interview defense

### What an interviewer is really asking
"How do you decide what goes in the context?" probes whether I have a cost model and whether I understand that cost is a function of *every* prompt section, not just the model choice. The interviewer wants to see explicit caps and a reason for each one. Generic "we pass relevant info" answers fail this question.

### Likely questions

[mid] Q: Why does `classify.ts` send no surrounding context at all? Wouldn't more context help disambiguate?
      A: Yes, more context would help, and yes I deliberately don't send it. Classify runs on every new ambiguous todo line — a heavy journaling day produces 30+ todos, and at $0.0001 per call on Haiku/4o-mini the cost is already trivial only because the prompt is ~50 tokens in, ~50 out. Adding the surrounding entry text would multiply input tokens by 10× for marginal accuracy gain on a 7-class problem where the heuristic already caught the obvious ones. I traded accuracy for cost predictability and it's the right trade for this app.

```
[classify input shape — context-free by design]

  one todo line ("[] book flight to Tokyo")
        │
        ▼  ~50 tokens in
  classify SYSTEM_PROMPT + user line
        │
        ▼  Haiku 4.5 / gpt-4o-mini
  ~50 tokens out: { type: 'todo', confidence }
        │
        ▼  cost ≈ $0.0001/call
  30 calls on heavy day ≈ $0.003
```

[senior] Q: Why per-feature `buildContext` instead of one shared context-builder?
         A: Because the five chains need different shapes. `expand.ts:147 buildContext()` pulls last 3 days of entries plus their cached summaries plus ≤5 sibling todos. `summarize.ts:buildCaptionInput()` L111 pulls 5 recent captions via `getRecentAISummaries(date, 5)` at L131 for anti-repetition plus mood — and hands the result to `caption.ts:generateCaption()`. `summarize.ts:summarize()` itself packs the whole day. `classify.ts` pulls nothing. `interpret.ts` pulls one entry's text and `truncateTail`s it to 2000 chars — no recent-summary dependency, no sibling context, just the entry's most-recent words. A unified builder would either send too much (every chain pays for context it doesn't need) or expose so many flags that the call site looks like a config object. Each chain owns its context shape, with explicit `.slice(0, N)` or `truncateTail` caps that you can grep for and reason about.

```
                  Path taken (per-chain builders)     Alternative (unified buildContext)
                  ──────────────────────────────      ──────────────────────────────────
shape per chain   purpose-built; what it needs        config object: includeRecentDays,
                                                      includeSiblings, includeCaptions, ...
finding the cap   grep .slice(0,N) — 4 hits           one file with 7 flags + a switch
adding a feature  write the helper next to the chain  add another flag, another branch
cost per chain    pays for exactly what it sends      risk of sending unused fields
testability       stub the 1 fetch the chain needs    stub the unified builder + mock 5 ins
when this flips   ≥3 chains share identical shape     today: zero overlap; flag would lie
```

[arch] Q: At a million-token context window, do these caps still matter?
       A: They matter less for *fitting* and more for *cost and quality*. A 1M-token prompt costs roughly 1M-tokens-worth, and the model's recall in the middle of a giant context is documented to dip. The caps in `expand.ts` aren't there because I'm scared of the context limit; they're there because last-3-days is the right amount for the task and the rest is noise. If I moved to a 1M-token model I'd keep the caps.

```
At 10× users + 1M-token model + provider prompt caching:

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — chains call the same way        │
  └─────────────────────────────────────────────┘
              │
  ┌─ Cost layer ────────────────────────────────┐
  │ caching: 90% off cached input tokens        │
  │ → static SYSTEM_PROMPT cached cheaply       │
  │ → per-call dynamic context still pays full  │
  └─────────────────────────────────────────────┘
              │
  ┌─ Caps layer (slice / truncateTail) ─────────┐
  │ STILL THE BOTTLENECK — cap defines what's   │  ◀── caps still load-bearing
  │ "right context for the task," not what fits │     even at 1M-token window
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You hand-pick "last 3 days, 5 siblings, 5 captions" — those are magic numbers. How do you know they're right?

A: I don't, exactly. I picked them by feel — last 3 days is enough to see continuity in a journaling app where days connect; 5 siblings is enough to give the model nearby todos without dominating the prompt; 5 captions is enough to detect repetition without anchoring the model to old voice. There's no A/B test behind any of these numbers. The defence isn't that they're optimal — it's that they're capped. A bad cap is still bounded; an uncapped prompt grows with the user's data and one heavy journaling day blows past budget. If I started seeing quality regressions I'd treat the cap as a tuning knob, not a constant. Today the user-facing quality is fine, so the numbers stay.

```
                  Path taken (capped, by-feel)        Suggested (A/B tuned per cap)
                  ────────────────────────────        ─────────────────────────────
cap discovery     by-feel; "last 3 days = continuity" controlled experiments per knob
cost ceiling      known; bounded by cap × users       known after experiment runs
infrastructure    zero — slice in code                test harness, fixture data, metrics
quality signal    user-facing — drop a star, retune   per-experiment offline metric
when this flips   user complaints + quality dip       team large enough to staff tuning
worst-case cap    bounded — still cheap and visible   unbounded during experiment phase
solo-dev fit      ship-it, watch the output           wrong shape for a 1-person team
```

### One-line anchors
- "Caps decouple cost from data size."
- "The model only sees what's in the window for *this* call."
- "Each chain owns its context shape — there is no shared `buildContext`."
- "A bad cap is still bounded; no cap grows with the user."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain how loopd packs the context window to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/expand.ts:buildContext` is the canonical example
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user has a heavy day: 3 entries totaling 6500 tokens of prose, plus 12 sibling todos, plus the system prompt is ~800 tokens. The expand chain fires for one of those todos. Walk what `buildContext()` actually packs given the explicit caps. Total token count? Which "soft" limits could you bump and which would actually require a different prompt strategy?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/expand.ts` L147–L199 to verify the slice caps.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/expand.ts:buildContext` (the per-feature, explicit-caps shape) to support what exists
→ Point to where a unified `buildContext` helper would live (likely a new `src/services/ai/context.ts` plus rewrites in 4 callers) if you chose the alternative

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
Updated: 2026-05-10 — added interpret context shape (`truncateTail` to MAX_INPUT_CHARS = 2000, MIN_TEXT_LENGTH = 20). See `14-interpret.md`.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block; re-attributed `getRecentAISummaries(date, 5)` to `summarize.ts:buildCaptionInput()` L131 (was wrongly placed in `caption.ts:generateCaption()`).
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram. Diagram layer-labels skipped (token-budget bar visualization, conceptual — no architectural boundaries crossed).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk, Anthropic prompt caching.
