# RAG (Retrieval-Augmented Generation)

**Industry name(s):** RAG, retrieval-augmented generation
**Type:** Industry standard

> Retrieve relevant chunks; stuff into the prompt; LLM generates an answer grounded in retrieved content. The standard answer to "the model doesn't know my data" and "the data changes after training cutoff." Quality is bounded by retrieval quality.

**See also:** → [01-embeddings-geometrically](./01-embeddings-geometrically.md) · → [06-hybrid-retrieval-rrf](./06-hybrid-retrieval-rrf.md) · → [07-reranking-with-cross-encoder](./07-reranking-with-cross-encoder.md)

---

## Why care

### Move 1 — The grounded scenario

User opens buffr's "interpret this week" feature. The LLM needs the user's last 7 days of entries. Stuffing all 7 days verbatim → maybe 10k tokens — within budget but stuffs unrelated content. A RAG path: retrieve the 5 most relevant entries to the user's query/intent → stuff those → LLM generates the interpret with grounded references. Better quality at smaller prompt size.

### Move 2 — Name the question the pattern answers

That how-do-I-get-my-data-into-the-LLM question is what RAG answers. Not "what model should I use" (orthogonal); just *what pipeline brings relevant content into the prompt context for grounded generation*.

### Move 3 — Why answering that question matters

**What breaks without RAG (when warranted):** the LLM either fakes the answer (hallucination) or has to read everything (cost, context window, lost-in-the-middle). For buffr's planned "interpret week" and thread "related entries" features, RAG is the difference between grounded answers and either hallucination or bloated prompts.

### Move 4 — Concrete before/after

Without RAG (stuff everything):
- "interpret this week" with all 7 days = ~10k tokens
- Lost-in-the-middle hits; the mid-week entries get less attention
- Quality: degrades on heterogeneous weeks

With RAG (retrieve relevant):
- Top-5 entries by relevance to user's query/intent
- Prompt ~3k tokens; all relevant; positioned at attention-strong slots
- Quality: better grounding, less hallucination

### Move 5 — The one-line summary

RAG = retrieve relevant chunks + stuff into prompt + generate. Quality bounded by retrieval; principle-#11 says don't add it until measurement shows you need it.

---

## How it works

### Move 1 — The mental model

```
   User question
     │
     ▼
   ┌──────────────────────────────────┐
   │  Retrieve relevant chunks         │ ← embed query, cosine search,
   │  (top-k)                          │   optionally hybrid + rerank
   └──────────────┬───────────────────┘
                  │
                  │  [chunk 1] [chunk 2] [chunk 3]
                  ▼
   ┌──────────────────────────────────┐
   │  Stuff into prompt context        │ ← place at attention-strong
   │                                   │   positions (start / end)
   └──────────────┬───────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────┐
   │  LLM generates answer             │ ← grounded in retrieved content,
   └──────────────┬───────────────────┘   not training data
                  │
                  ▼
   Answer (optionally with citations to chunk IDs)
```

### Move 2 — The layered walkthrough

**Layer 1 — three steps.** (1) Retrieve: embed query, cosine top-k (or hybrid via RRF, optionally reranked). (2) Stuff: add the chunks to the prompt context. (3) Generate: LLM produces the answer.

**Layer 2 — buffr's planned RAG (Phase 2A).** Two features: "interpret this week" — retrieve top-5 entries across the past 7 days; pass to the interpret chain with summary context. "Related entries" on threads — retrieve top-10 entries semantically related to the thread's slug or recent prose; display in the thread detail screen.

```
   Buffr's planned RAG features
   ────────────────────────────
   interpret-week:    7-day query → top-5 entries → interpret chain
   thread-related:    thread slug → top-10 entries → display
```

**Layer 3 — principle #11.** Buffr's existing principle #11 says: "no RAG until provably needed." The threshold is documented per feature. For the `expand` chain (today's chains), hand-picked retrieval (sibling todos + last 3 days) is sufficient — RAG would be overkill at sub-corpus scale. Above threshold (week-scope, thread-scope), RAG earns its keep.

### Move 3 — The principle

RAG turns "LLM doesn't know my data" into "LLM has the right slices." Quality is bounded by retrieval; bad retrieval produces confidently-wrong answers. Measure retrieval (hit@k, MRR) before measuring generation quality.

---

## RAG — diagram

```
┌─ Buffr's planned interpret-week pipeline ──────────────────────────────┐
│                                                                        │
│   user opens "interpret this week"                                     │
│         │                                                              │
│         ▼                                                              │
│   build retrieval query: "interpret this user's week of entries"       │
│         │                                                              │
│         ▼                                                              │
│   embed query → cosine search over entry_embeddings (last 7 days)      │
│         │                                                              │
│         ▼                                                              │
│   top-5 entries by relevance                                           │
│         │                                                              │
│         ▼                                                              │
│   stuff into interpret chain prompt + full-week summary                │
│         │                                                              │
│         ▼                                                              │
│   interpret chain (Sonnet 4.6, t=0.7) → markdown reflection           │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not implement RAG today.**

Principle #11 documents the "above-threshold" exception. Phase 2A `B2A.7` and `B2A.8` are the build targets:
- `B2A.7`: interpret-week — interpret chain at 7-day scope; retrieval supplements full-week text
- `B2A.8`: related-entries on thread detail — semantic, complements prose mentions

Both depend on the embedding infrastructure (B2A.1–B2A.6).

---

## Elaborate

### Where this pattern comes from

Lewis et al. 2020 "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks." Adopted broadly by 2022 with the ChatGPT-era hosted LLM stack.

### The deeper principle

Models don't know your data; retrieve before generate; generation quality is bounded by retrieval quality.

### Where this breaks down

For corpora that fit in the context window (buffr's typical use today), retrieval is overhead — just stuff. For freshness-critical data (live news, prices), basic RAG is fine but staleness mitigations (concept 09) become load-bearing.

### What to explore next

- [01-embeddings-geometrically](./01-embeddings-geometrically.md), [06-hybrid-retrieval-rrf](./06-hybrid-retrieval-rrf.md), [07-reranking-with-cross-encoder](./07-reranking-with-cross-encoder.md) — the retrieval stack
- [`05-evals-and-observability/01-eval-set-types`](../05-evals-and-observability/01-eval-set-types.md) — how to measure RAG quality

---

## Tradeoffs

The breakpoint: add RAG when (a) the relevant content exceeds the comfortable prompt size, (b) the content changes after training cutoff, or (c) you can't predict in advance which slices are relevant.

---

## Tech reference

- **Retrieval:** dense + sparse + RRF + optional rerank (concepts 05-07).
- **Stuff:** placement at attention-strong positions (`02-context-and-prompts/02-lost-in-the-middle`).
- **Generate:** any chain that consumes the retrieved chunks.

---

## Project exercises

### B2A.7 — Interpret week

- **Exercise ID:** `B2A.7`
- **What to build:** interpret chain at week-scope; retrieval over `entry_embeddings` (last 7 days).
- **Done when:** the feature ships; hit@5 measured against the curated eval set.
- **Estimated effort:** included in Phase 2A work.

### B2A.8 — Thread related entries

- **Exercise ID:** `B2A.8`
- **What to build:** "related entries" section on thread detail; retrieval over `entry_embeddings` complementing prose-derived `thread_mentions`.
- **Done when:** thread page shows semantically-related entries.
- **Estimated effort:** included in Phase 2A work.

---

## Summary

- RAG = retrieve relevant + stuff + generate.
- Quality bounded by retrieval; measure retrieval before generation.
- Buffr's principle #11: no RAG until provably needed.
- Phase 2A build targets: interpret-week, thread-related-entries.

---

## Interview defense

**Q [mid]:** When does RAG help vs hurt?

**A:** Helps when the relevant content is too large to stuff in the prompt OR you can't predict in advance which slices are relevant. Hurts when the corpus fits in the prompt and you're guessing wrong on which slices to retrieve — at that point retrieval is just truncation and you'd be better off stuffing everything.

**Q [senior]:** What's the failure mode of RAG?

**A:** Bad retrieval. The model generates confident-looking answers grounded in the wrong content. Symptom: the answer is well-written but factually wrong. Mitigation: measure retrieval quality (hit@k, MRR) independently of generation quality; if retrieval is bad, the generation can't be good no matter how good the model is.

### One-line anchors

- Retrieve → stuff → generate.
- Quality bounded by retrieval.
- Principle #11: no RAG until provably needed.
- Measure retrieval before measuring generation.

---

## Validate

### Quick check
- What's the three-step shape of RAG?
- What bounds RAG quality?
- What are buffr's two planned RAG features?
