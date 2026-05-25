# Lost in the middle

**Industry name(s):** Lost-in-the-middle, attention bias, position bias
**Type:** Industry standard

> Models attend strongly to the start and end of the context, weakly to the middle. A relevant doc at position 5 of 10 gets attended less than the same doc at position 1 or position 10. Mitigation: rerank to put the most relevant content at the edges, not the middle.

**See also:** → [01-context-window](./01-context-window.md) · → [03-prompt-chaining](./03-prompt-chaining.md) · → [`03-retrieval-and-rag/07-reranking-with-cross-encoder`](../03-retrieval-and-rag/07-reranking-with-cross-encoder.md)

---

## Why care

### Move 1 — The grounded scenario

You're building an `expand` chain for buffr. You retrieve 8 sibling todos and 4 days of journal entries. You stuff them all into the prompt: system instructions first, then todos 1-8 in order, then journal entries 1-4 in order, then the user's actual request at the bottom. The model produces an expansion. Quality is mediocre. You debug; turns out the most-relevant sibling (todo #4) was at position 4 of 8 — middle of the retrieved set. The model effectively ignored it.

### Move 2 — Name the question the pattern answers

That where-in-the-prompt question is what lost-in-the-middle answers. Not "how does attention work" (mechanistic); just *where should I put the content I most want the model to use*. The answer: at the start or at the end. Never in the middle.

### Move 3 — Why answering that question matters

**What breaks without position discipline:** prompts that retrieved the right docs still produce wrong answers because the docs are in the wrong places. Buffr's `expand` chain currently orders inputs by the (heuristic) most relevant last — sibling todos by recency descending, journal entries by date descending. The most relevant sits closest to the user request at the end. The fix is implicit in how `prompt.ts` constructs the message.

### Move 4 — Concrete before/after

Without position discipline:
- Retrieve top-8 docs, stuff in retrieval order
- Most-relevant doc (rank 1) is at position 1 — good
- Second-most-relevant (rank 2) is at position 2 — middle — partially ignored
- Quality: inconsistent

With position discipline:
- Retrieve top-8 docs
- Place rank-1 at the start, rank-2 at the end (the two attention-strong positions)
- Lesser-ranked in the middle (they're less important; loss tolerated)
- Quality: more consistent

### Move 5 — The one-line summary

Start and end of context get attention; middle gets less; put your most important content at the edges.

---

## How it works

### Move 1 — The mental model

```
   Attention strength across position
   ──────────────────────────────────

        strong  ←─ system prompt
        strong  ←─ first 1-2 retrieved docs
       weaker
       weakest  ←─ middle docs
       weaker
        strong  ←─ last 1-2 retrieved docs
        strong  ←─ user's question
```

A doc at position 5 of 10 retrieved docs gets less attention than the same doc at position 1 or 10. The effect is empirical (Liu et al. 2023) and present in every frontier model to varying degrees.

### Move 2 — The layered walkthrough

**Layer 1 — empirical pattern.** Liu et al. (2023) "Lost in the Middle" showed that models retrieve information from the middle of long contexts with measurably lower accuracy than from the start or end. The effect is U-shaped: high accuracy on start tokens, dipping in the middle, recovering at the end.

**Layer 2 — practical position rules.** Three positions matter: (1) system prompt — strong; (2) first 1-2 docs in the retrieval set — strong; (3) the user's actual question at the very end — strongest. Place the most important content at these positions. Lesser content goes in the middle where it's "available but less weighted."

```
   buffr's expand prompt structure
   ───────────────────────────────
   1. system prompt          (attention-strong)
   2. user's todo + question (attention-strong; final)
   3. sibling todos (4)      (in retrieved order; middle gets weakest attention)
   4. journal entries (3)    (in date-desc order; most recent at the bottom)
```

The implicit ordering puts the user's question at the strongest position; the most-recent journal entry is near the end (also attention-strong); the sibling todos are in the middle of the context where they're available but de-prioritised.

**Layer 3 — when the pattern is load-bearing.** With under ~10 retrieved items, lost-in-the-middle is mild. With 20+ items, it's severe. With 100+ items (which Gemini's 1M-token window enables), most middle items are effectively invisible. The mitigation strategy depends on count: small retrieval sets → just put rank-1 at start; large retrieval sets → use a reranker and only feed top-3 to the prompt.

### Move 3 — The principle

Position is part of prompt design. Where content sits determines how much attention it gets. Combine with retrieval + reranking for the strongest version of the pattern.

---

## Lost in the middle — diagram

```
┌─ Long prompt with middle-buried relevant doc ──────────────────────────┐
│                                                                        │
│   ┌─────────────────────────────────────────────────────────┐         │
│   │ [system prompt]               ← strong attention         │         │
│   ├─────────────────────────────────────────────────────────┤         │
│   │ [doc 1 — irrelevant]          ← strong attention         │         │
│   │ [doc 2 — irrelevant]          ← decaying                 │         │
│   │ [doc 3 — RELEVANT!]           ← weak (lost in middle)    │         │
│   │ [doc 4 — irrelevant]          ← weakest                  │         │
│   │ [doc 5 — irrelevant]          ← weak                     │         │
│   │ [doc 6 — irrelevant]          ← decaying back up         │         │
│   │ [doc 7 — irrelevant]          ← strong attention         │         │
│   ├─────────────────────────────────────────────────────────┤         │
│   │ [user question]               ← strongest                │         │
│   └─────────────────────────────────────────────────────────┘         │
│                                                                        │
│   The relevant doc at position 3 of 7 gets less attention than docs    │
│   at positions 1 or 7. Model effectively misses it.                    │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A (passive) — buffr's `expand` chain orders inputs to favour attention-strong positions.**

**Files:**
- `src/services/ai/expand.ts` and `src/services/ai/prompt.ts` — the prompt constructor places the user's todo + question at the very end (strongest position), then sibling todos in retrieval order, then journal entries date-descending so the most recent entry sits near the end.
- `docs/spec.md` principle #11 notes the cap (≤1000 chars per source) but doesn't currently document the position rule. The buildable next step is to add a comment in `prompt.ts` naming the position-as-design-decision.

For chains with smaller retrieval sets (`summarize`, `caption`, `interpret`), lost-in-the-middle is not a factor at current sizes.

---

## Elaborate

### Where this pattern comes from

Liu, Lin, Hewitt, Paranjape, Bevilacqua, Petroni, Liang (2023) "Lost in the Middle: How Language Models Use Long Contexts." Has been replicated across model families.

### The deeper principle

Position in any structured input encodes priority. Treating position as design rather than incidental is the discipline.

### Where this breaks down

For very short prompts (under 1000 tokens), attention is roughly uniform — position barely matters. For RAG with reranking that consistently surfaces the top result, position discipline matters less because the top result is what's used.

### What to explore next

- [`03-retrieval-and-rag/07-reranking-with-cross-encoder`](../03-retrieval-and-rag/07-reranking-with-cross-encoder.md) — reranking lets you place the strongest result at the strongest position
- [01-context-window](./01-context-window.md) — bigger windows amplify the lost-in-the-middle effect

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Position discipline       │ Stuff-and-pray               │
├──────────────────┼───────────────────────────┼──────────────────────────────┤
│ Quality          │ More consistent           │ Variable with input size      │
│ Implementation   │ ~5 lines per chain        │ Zero                         │
│ Works at scale   │ Yes                       │ Degrades                     │
└──────────────────┴───────────────────────────┴──────────────────────────────┘
```

---

## Tech reference

- **Empirical paper:** Liu et al. (2023) "Lost in the Middle"
- **Mitigation in buffr today:** implicit ordering in `prompt.ts` (recency-desc puts recent at the end)
- **Mitigation at higher retrieval count:** cross-encoder reranking before placing in prompt

---

## Project exercises

### B-document-position-rule — Document the position-as-design rule in `prompt.ts`

- **What to build:** add a header comment in `src/services/ai/prompt.ts` naming the position rule: user question at end, recent content near end, less-relevant in middle, irrelevant content excluded.
- **Why it earns its place:** the rule is currently implicit; a refactor could accidentally re-order and lose the attention-strong placement.
- **Files to touch:** `src/services/ai/prompt.ts`.
- **Done when:** the rule is documented; future contributors see it.
- **Estimated effort:** 30 minutes.

---

## Summary

### Part 1 — concept recap

Lost-in-the-middle is the empirical pattern that models attend strongly to context start and end, weakly to the middle. Place important content at the edges (system prompt + first retrieved doc + last retrieved doc + user question). Buffr's `expand` chain orders inputs to favour attention-strong positions implicitly; the rule isn't documented in code today.

### Part 2 — key points to remember

- Models attend U-shaped across position: strong start, weak middle, strong end.
- Strongest positions: system prompt, first retrieved doc, last retrieved doc, user question.
- Effect amplifies with context size; 100k+ tokens makes middle effectively invisible.
- Mitigation: rerank + place top result at start; place user question at end.

---

## Interview defense

**Q [mid]:** Why does position matter?

**A:** Empirically, transformer attention is U-shaped across context position — strong at start and end, weak in the middle. Liu et al. 2023 documented this; it replicates across model families. So when you stuff retrieved docs into a prompt, the rank-3 doc at position 3 of 10 gets less attention than the same doc would at position 1 or 10. Solution: place the most relevant content at the start or end, not the middle.

**Q [senior]:** When does this become load-bearing in production?

**A:** As soon as retrieval count exceeds ~10 docs or context exceeds ~50% of the window. Below those thresholds, attention is roughly uniform and position is incidental. Above them, position is the difference between "we retrieved the right doc" and "the model used the right doc."

---

## Validate

### Level 1
Draw the U-shaped attention curve across context position.

### Level 2
Explain in under 60 seconds why a relevant doc at position 5 of 10 may be effectively ignored.

### Level 3
Buffr's `expand` chain currently orders inputs to favour attention-strong positions implicitly. If you added a vector-retrieval step that returned 20 candidate docs, how would you place them?

### Level 4
Defend or oppose: "Use the entire 200k context window every time — model can sort relevance itself."

### Quick check
- Where in the prompt does buffr put the user's question?
- What's the attention shape across position?
- When does the effect become load-bearing?
