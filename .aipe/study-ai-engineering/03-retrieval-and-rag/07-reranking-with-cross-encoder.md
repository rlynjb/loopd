# Reranking with a cross-encoder

**Industry name(s):** Reranking, cross-encoder rerank, two-stage retrieval
**Type:** Industry standard

> Two-stage pattern: bi-encoder retrieves top-N fast (cosine, ~100 candidates); cross-encoder reranks them slowly but accurately into top-k (~5). Earns its place only when retrieval recall is measurably bad; add it after measuring, not before.

**See also:** → [06-hybrid-retrieval-rrf](./06-hybrid-retrieval-rrf.md) · → [11-rag](./11-rag.md) · → [`05-evals-and-observability/02-eval-methods`](../05-evals-and-observability/02-eval-methods.md)

---

## Why care

### Move 1 — The grounded scenario

Buffr's hybrid retrieval (dense + sparse via RRF) returns 50 candidate entries for a query. The top 5 are "good but not great" — they contain the answer, but the most relevant one is buried at rank 3 of the top 5. A cross-encoder reranker scores each (query, doc) pair with full attention; reorders by relevance. Now rank 1 is actually the most relevant. Cost: an extra LLM-style call per candidate.

### Move 2 — Name the question the pattern answers

That can-I-rerank question is what cross-encoder rerank answers. Not "is reranking always good" (no — adds latency); just *when does the precision gain justify the latency cost*. Answer: when eval shows your top-1 isn't actually the most relevant.

### Move 3 — Why answering that question matters

**What breaks without measuring first:** add reranking preemptively → pay latency cost for no gain. Skip reranking when it would help → quality stays mediocre. Buffr's `B2A.11` curriculum item makes the measurement-first approach explicit: rerank on the "related entries" feature; if hit@5 doesn't improve, skip rerank in the aipe Phase 2B.

### Move 4 — Concrete before/after

Without rerank:
- Retrieval returns 5 docs; top-1 is "near-best" but not "best"
- User-perceived quality: medium

With rerank (when justified by eval):
- Retrieval returns 50; rerank to top-5
- Top-1 is actual best
- Latency cost: ~200ms additional

Without rerank (when not justified):
- Retrieval returns 5; top-1 is best
- Rerank would just shuffle order at the margins
- Latency added with no quality gain

### Move 5 — The one-line summary

Bi-encoder retrieves fast and coarse; cross-encoder reranks slow and accurate; use the cross-encoder only when measured hit@k improves with it.

---

## How it works

### Move 1 — The mental model

```
   Query
     │
     ▼
   ┌──────────────────────────────┐
   │ Stage 1: Bi-encoder retrieve │  fast, top-N (N=50)
   │ (cosine similarity)          │  parallel for all docs
   └──────────────┬───────────────┘
                  │
                  ▼  50 candidates
   ┌──────────────────────────────┐
   │ Stage 2: Cross-encoder rerank│  slow, top-k (k=5)
   │ (full attention on pair)     │  sequential per (query, doc)
   └──────────────┬───────────────┘
                  │
                  ▼
              Top 5 ranked
```

### Move 2 — The layered walkthrough

**Layer 1 — bi-encoder vs cross-encoder.** Bi-encoder embeds query and document independently; cosine similarity between the vectors. Fast because doc embeddings are pre-computed. Cross-encoder takes (query, document) as a pair and scores their joint representation with full attention. Accurate but slow because it can't pre-compute (each query-doc pair is unique).

**Layer 2 — when rerank earns its place.** Eval hit@k on bi-encoder-only vs bi-encoder-then-rerank. If rerank improves hit@5 by >5%, justify the latency cost. If improvement is <2%, skip — the gain doesn't justify the engineering cost.

```
   Measurement before commitment
   ─────────────────────────────
   eval set: 30 (query, expected_doc) pairs
   measure:
     bi-encoder hit@5:       baseline
     hybrid (RRF) hit@5:     +X% over baseline
     hybrid + rerank hit@5:  +Y% over hybrid
   ──
   if Y > 5%: ship rerank
   if Y < 2%: skip rerank
```

**Layer 3 — model choice for reranking.** Open-source cross-encoders (bge-reranker, cohere rerank) run locally or via API. Latency: ~50ms per pair. For 50 candidates → 2.5 seconds added. Reduce by batching or by running rerank only when retrieval confidence is low (gating by bi-encoder margin).

### Move 3 — The principle

Two-stage retrieval — fast pre-filter, slow precision step. The pre-filter is mandatory; the precision step is optional and gated by eval.

---

## Cross-encoder rerank — diagram

```
┌─ Two-stage retrieval ──────────────────────────────────────────────────┐
│                                                                        │
│   query                                                                │
│     │                                                                  │
│     ▼                                                                  │
│   bi-encoder retrieve (cosine) ──→ top-50 candidates                   │
│     │                                                                  │
│     ▼                                                                  │
│   cross-encoder rerank ──→ score each (query, doc) pair                │
│     │                                                                  │
│     ▼                                                                  │
│   sort by rerank score → top-5                                         │
│                                                                        │
│   Gate (optional):                                                     │
│     if top-1 bi-encoder cosine > 0.9: skip rerank (high confidence)    │
│     else: rerank                                                       │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not rerank.**

`B2A.11` curriculum item gates the choice on eval: add cross-encoder rerank to the "related entries" feature; if hit@5 improvement is meaningful, ship it; if not, skip in the aipe Phase 2B.

---

## Elaborate

### Where this pattern comes from

Two-stage retrieval is decades old in information retrieval (Lucene's rescoring); cross-encoder reranking specifically became canonical post-2020 with Sentence-BERT and cross-encoder models trained on MS MARCO.

### The deeper principle

Precision and speed trade off; two stages let each have its budget — fast on the long list, slow on the short list.

### Where this breaks down

For small corpora (<1000 docs), bi-encoder alone is precise enough that rerank adds noise. For latency-critical paths (search-as-you-type), rerank's added 200ms breaks the UX.

### What to explore next

- [06-hybrid-retrieval-rrf](./06-hybrid-retrieval-rrf.md) — the typical input to rerank
- [`05-evals-and-observability/02-eval-methods`](../05-evals-and-observability/02-eval-methods.md) — the measurement gate

---

## Tradeoffs

The breakpoint: rerank when eval-measured hit@k improvement exceeds ~5%. Skip otherwise.

---

## Tech reference

- **bge-reranker:** open-source, local-runnable. ~100MB model.
- **Cohere Rerank:** API-based, $1/M tokens. Fast.
- **Cross-encoder models in general:** trained on (query, doc, relevance) triples.

---

## Project exercises

### B2A.11 — Cross-encoder rerank on "related entries"

- **Exercise ID:** `B2A.11`
- **What to build:** add rerank step after RRF on the "related entries" feature; measure hit@5 before and after; commit if improvement justifies; skip in `aipe` Phase 2B if no improvement.
- **Done when:** decision documented based on eval data.
- **Estimated effort:** 4 hours.

---

## Summary

- Two-stage: bi-encoder fast pre-filter; cross-encoder slow precision.
- Eval first; commit only if hit@k improves >5%.
- Cost: ~200ms latency per call.

---

## Interview defense

**Q [mid]:** Why two stages instead of one?

**A:** Cross-encoders are accurate but slow — you can't run them against every doc in the corpus. Bi-encoders are fast (pre-computed embeddings) but coarse. Two stages give the cross-encoder a manageable top-N to consider while keeping retrieval scale-friendly. Only add the cross-encoder when eval-measured recall justifies the latency.

### One-line anchors

- Bi-encoder retrieve; cross-encoder rerank.
- Measure before committing; eval-gated.
- ~200ms latency cost.

---

## Validate

### Quick check
- What's the bi-encoder's strength vs cross-encoder?
- What's the eval gate to ship rerank?
- What's the typical latency cost?
