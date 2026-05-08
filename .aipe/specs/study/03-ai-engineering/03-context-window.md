# Context window — how loopd packs it

> The model only sees what's in the window for *this call*. Loopd hand-picks small, capped slices per feature.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [07-rag](./07-rag.md)

---

## Quick summary
- **What:** every AI feature builds a small context — today's text, last 3 days, sibling todos (capped at 5), recent captions (capped at 5). No cross-day "memory" beyond what's explicitly added.
- **Why here:** keep the window small enough that small fast models can do the job. Predictable cost, predictable shape.
- **Tradeoff:** the model never sees anything you didn't explicitly hand it. No surprises, no autonomy.

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

## How it works

Per feature, loopd picks a fixed shape:

- **classify** — text-only, ~50 tokens out. Context-free for cost: the surrounding entry isn't sent. Spec §5.3 calls this out as deliberate.
- **summarize** — full day (all entries for one date) + clip metadata + habits list. ~1024 tokens out.
- **caption** — `rawLog[]` (sentence-split entry text + done todo bullets) + last 5 captions for anti-repetition + mood. The 5 recent captions are the *only* multi-day context.
- **expand** — entry text + ≤5 sibling todos + last 3 days of entries with their cached AI summaries. The biggest context window of the four; even so, each part is capped.

The cap on each section (in `expand.ts:147` `buildContext`) is what keeps the window predictable: `siblingTodos.slice(0, 5)`, `recentDates.slice(0, 3)`. Without those caps, a heavy journaling day could blow past the model's budget.

---

## In this codebase

- `src/services/todos/expand.ts` → `buildContext()` with the explicit `.slice(0, N)` caps.
- `src/services/ai/caption.ts` → `getRecentAISummaries(date, 5)` for anti-repetition.
- `src/services/ai/summarize.ts` → packs the whole day; bounded by per-day text.
- `src/services/todos/classify.ts` → no surrounding context at all.

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

- **Hand-picked, capped context** — gives: predictable cost, no surprises. Costs: must remember to update caps when adding new features.
- **No cross-day memory by default** — gives: easy to reason about. Costs: features that need history must explicitly fetch and add it.
- **Per-feature context shape** — gives: each prompt is just-right. Costs: 4 different `buildContext`-ish helpers; no shared one-size-fits-all.

---

## Interview defense

### What an interviewer is really asking
"How do you decide what goes in the context?" probes whether I have a cost model and whether I understand that cost is a function of *every* prompt section, not just the model choice. The interviewer wants to see explicit caps and a reason for each one. Generic "we pass relevant info" answers fail this question.

### Likely questions

[mid] Q: Why does `classify.ts` send no surrounding context at all? Wouldn't more context help disambiguate?
      A: Yes, more context would help, and yes I deliberately don't send it. Classify runs on every new ambiguous todo line — a heavy journaling day produces 30+ todos, and at $0.0001 per call on Haiku/4o-mini the cost is already trivial only because the prompt is ~50 tokens in, ~50 out. Adding the surrounding entry text would multiply input tokens by 10× for marginal accuracy gain on a 7-class problem where the heuristic already caught the obvious ones. I traded accuracy for cost predictability and it's the right trade for this app.

[senior] Q: Why per-feature `buildContext` instead of one shared context-builder?
         A: Because the four chains need different shapes. `expand.ts:147 buildContext()` pulls last 3 days of entries plus their cached summaries plus ≤5 sibling todos. `caption.ts` pulls 5 recent captions for anti-repetition plus mood. `summarize.ts` packs the whole day. `classify.ts` pulls nothing. A unified builder would either send too much (every chain pays for context it doesn't need) or expose so many flags that the call site looks like a config object. Each chain owns its context shape, with explicit `.slice(0, N)` caps that you can grep for and reason about.

[arch] Q: At a million-token context window, do these caps still matter?
       A: They matter less for *fitting* and more for *cost and quality*. A 1M-token prompt costs roughly 1M-tokens-worth, and the model's recall in the middle of a giant context is documented to dip. The caps in `expand.ts` aren't there because I'm scared of the context limit; they're there because last-3-days is the right amount for the task and the rest is noise. If I moved to a 1M-token model I'd keep the caps.

### The question candidates always dodge
Q: You hand-pick "last 3 days, 5 siblings, 5 captions" — those are magic numbers. How do you know they're right?

A: I don't, exactly. I picked them by feel — last 3 days is enough to see continuity in a journaling app where days connect; 5 siblings is enough to give the model nearby todos without dominating the prompt; 5 captions is enough to detect repetition without anchoring the model to old voice. There's no A/B test behind any of these numbers. The defence isn't that they're optimal — it's that they're capped. A bad cap is still bounded; an uncapped prompt grows with the user's data and one heavy journaling day blows past budget. If I started seeing quality regressions I'd treat the cap as a tuning knob, not a constant. Today the user-facing quality is fine, so the numbers stay.

### One-line anchors
- "Caps decouple cost from data size."
- "The model only sees what's in the window for *this* call."
- "Each chain owns its context shape — there is no shared `buildContext`."
- "A bad cap is still bounded; no cap grows with the user."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
