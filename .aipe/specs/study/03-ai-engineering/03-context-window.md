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
