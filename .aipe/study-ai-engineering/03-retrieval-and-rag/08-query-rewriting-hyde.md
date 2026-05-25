# Query rewriting and HyDE

**Industry name(s):** Query rewriting, HyDE (Hypothetical Document Embeddings), query expansion
**Type:** Industry standard

> User queries are short and ambiguous; documents are long and specific. The embedding spaces don't always align. Rewriting bridges the gap by expanding the query (synonym + intent) or generating a hypothetical answer and embedding that instead.

**See also:** → [01-embeddings-geometrically](./01-embeddings-geometrically.md) · → [11-rag](./11-rag.md) · → [`02-context-and-prompts/03-prompt-chaining`](../02-context-and-prompts/03-prompt-chaining.md)

---

## Why care

### Move 1 — The grounded scenario

User searches buffr for "fix the auth thing." Short, vague. The relevant entry is "Today I debugged JWT signature mismatch and added secret rotation." Embeddings: the query vector sits in a different region than the doc vector — vocabulary doesn't overlap. Recall miss. Query rewriting expands "fix the auth thing" → "how to debug authentication token signature verification errors" → embedding closer to the doc → retrieval finds it.

### Move 2 — Name the question the pattern answers

That short-query-long-doc question is what rewriting and HyDE answer. Not "should I always rewrite" (latency cost matters); just *when does the embedding mismatch between query and doc justify an extra LLM call to bridge it*.

### Move 3 — Why answering that question matters

**What breaks without rewriting:** queries with vocabulary mismatch to docs miss the relevant content. For buffr's planned retrieval (Phase 2A), user queries on the dashboard are likely short ("auth", "the project"); the docs are full journal entries with specific wording. Rewriting closes the gap.

### Move 4 — Concrete before/after

Without rewriting:
- "fix auth" → embedding mismatched to "JWT signature" — retrieval miss

With rewriting:
- LLM expands "fix auth" → "authentication debugging including JWT and tokens"
- Expanded query embedding closer to the doc
- Retrieval hits

### Move 5 — The one-line summary

Short queries embed poorly compared to long docs; an extra LLM call to expand or generate-then-embed (HyDE) closes the gap when measured recall is poor.

---

## How it works

### Move 1 — The mental model

```
   Two approaches

   Query rewriting:
   ───────────────
   original:  "fix the auth thing"
        │
        ▼ LLM rewrites
        │
   expanded: "how to debug authentication token verification errors"
        │
        ▼ embed → retrieve

   HyDE (Hypothetical Document Embeddings):
   ────────────────────────────────────────
   original:  "fix the auth thing"
        │
        ▼ LLM generates a hypothetical answer
        │
   hypothetical: "To debug auth, check the token signature against
                  the JWT secret in the env file..."
        │
        ▼ embed the hypothetical → retrieve docs similar to it
```

### Move 2 — The layered walkthrough

**Layer 1 — query rewriting mechanics.** A small LLM call (Haiku, gpt-4o-mini) prompted: "Rewrite this user query into a more retrievable form, expanding synonyms and intent." Output is a longer query. Embed and retrieve as normal. Cost: one extra LLM call per query (~$0.0001 + ~200ms latency).

**Layer 2 — HyDE mechanics.** LLM call prompted: "Write a short hypothetical answer to this question." The answer is fictitious but plausible. Embed the answer (NOT the original question); retrieve docs similar to the hypothetical. Often outperforms rewriting because the hypothetical sits in the same embedding region as real answers.

**Layer 3 — when each earns its place.** Rewriting: when user queries are short or use different vocabulary than docs. HyDE: same; usually a step better, slightly more expensive. Both: skip when measured recall@k on bare queries is already high.

```
   Decision flow
   ─────────────
   measure recall@k on bare queries
         │
    ┌────┴─────┐
    │  high?   │
    └────┬─────┘
         │
    ┌────┴─────┐
    │          │
    ▼ yes      ▼ no
   skip        add rewriting or HyDE
   rewriting   measure improvement
              ship if improvement justifies cost
```

### Move 3 — The principle

Bridge the query-doc embedding gap when measured recall is poor; pick the cheaper bridge (rewriting) unless HyDE shows clear wins.

---

## Query rewriting / HyDE — diagram

```
┌─ Retrieval flow with optional rewriting ───────────────────────────────┐
│                                                                        │
│   user query                                                           │
│        │                                                               │
│        ├── if rewriting enabled ──→  LLM rewrite (~200ms, $0.0001)     │
│        │                                  │                            │
│        ▼                                  ▼                            │
│   embed (~10ms)                      embed expanded                    │
│        │                                  │                            │
│        ▼                                  ▼                            │
│   cosine retrieval (~5ms)                                              │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

   HyDE variant:
   ─────────────
   query → LLM generates hypothetical answer → embed the answer → retrieve
```

---

## In this codebase

**Case B — buffr does not rewrite queries.**

Phase 2B's `B2B.5` defines aipe's query-rewriting build (expanding `/aipe:feature <intent>` into a richer retrieval query). For buffr specifically, query rewriting would apply to user-facing search-style features (search across journal entries) — not currently implemented; Case B for the future.

---

## Elaborate

### Where this pattern comes from

HyDE: Gao et al. 2022 "Precise Zero-Shot Dense Retrieval without Relevance Labels." Query rewriting predates HyDE by decades in classical IR.

### The deeper principle

When query and doc come from different "languages" (short user query vs long technical doc), embedding alone may miss. An LLM as a translator between the two languages is a load-bearing bridge.

### Where this breaks down

For corpora where queries and docs share vocabulary (e.g., users search for words that appear in docs), rewriting adds latency for no gain. For latency-critical paths (search-as-you-type), the extra LLM call breaks the UX.

### What to explore next

- [01-embeddings-geometrically](./01-embeddings-geometrically.md) — what gets rewritten and embedded
- [11-rag](./11-rag.md) — rewriting is part of the retrieval step

---

## Tradeoffs

The breakpoint: add rewriting when bare-query recall@k is measurably poor (<60% for an eval set). Skip when recall is already high.

---

## Tech reference

- **Rewriter model:** Haiku 4.5 or gpt-4o-mini — cheap and fast.
- **HyDE prompt template:** "Write a 2-3 sentence hypothetical answer to: {query}."

---

## Project exercises

### B2B.5 — Query rewriting on aipe slash commands

- **Exercise ID:** `B2B.5`
- **What to build:** for the aipe Phase 2B work, expand `/aipe:feature <intent>` into a richer retrieval query via Haiku rewrite. Buffr Case B for future buffr search features.
- **Done when:** rewriting measurably improves precision@k.
- **Estimated effort:** 3 hours.

---

## Summary

- Rewriting and HyDE bridge the query-doc embedding gap.
- Rewriting: cheaper; HyDE: typically more accurate.
- Add only when bare-query recall is measurably poor.

---

## Interview defense

**Q [mid]:** Why does HyDE work?

**A:** Short queries embed in a different region than long, specific docs. A hypothetical answer is closer in shape to a real doc, so its embedding sits closer to where the real doc lives in vector space. You retrieve docs similar to the hypothetical, not to the bare query.

### One-line anchors

- Rewriting: LLM expands the query before embedding.
- HyDE: LLM generates a hypothetical answer and embeds that.
- Both: skip if bare-query recall is high.

---

## Validate

### Quick check
- What's the difference between rewriting and HyDE?
- When do you add either?
- What's the latency cost?
