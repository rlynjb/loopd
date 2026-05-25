# Hybrid retrieval with RRF

**Industry name(s):** Hybrid retrieval, Reciprocal Rank Fusion, RRF
**Type:** Industry standard

> Run dense and sparse retrieval separately, then combine the rankings via Reciprocal Rank Fusion: each retriever "votes" by rank. Better recall than either alone; no need to normalize scores between methods.

**See also:** → [05-dense-vs-sparse](./05-dense-vs-sparse.md) · → [07-reranking-with-cross-encoder](./07-reranking-with-cross-encoder.md) · → [11-rag](./11-rag.md)

---

## Why care

### Move 1 — The grounded scenario

You've built buffr's dense retrieval (cosine over `entry_embeddings`) and sparse retrieval (FTS5 BM25 over `entries.text`). Query: "auth bug." Dense returns: [entry42, entry17, entry5]. Sparse returns: [entry17, entry8, entry3]. entry17 appears in both — clearly the strongest. The other matches differ. Need a way to combine into a single ranked list.

### Move 2 — Name the question the pattern answers

That how-do-I-combine question is what RRF answers. Not "which weighted average" (RRF beats weighted averages because scores aren't comparable across methods); just *how do I fuse two ranked lists into one, valuing items that appear in both*.

### Move 3 — Why answering that question matters

**What breaks without fusion:** you either pick one retriever and miss what the other catches, or you try to normalize scores between methods and the score scales drift unpredictably. RRF sidesteps the normalisation problem by ignoring scores and only using ranks.

### Move 4 — Concrete before/after

Without RRF:
- Try to normalize cosine (0-1) and BM25 (0-∞) into one scale
- Drift; scale tweaks per corpus
- Quality unstable

With RRF:
- Each method ranks its top-k
- Score = sum over methods of `1 / (k + rank)`
- Items appearing in both rank high; items in one rank lower but still surface
- No normalisation needed

### Move 5 — The one-line summary

RRF combines ranked lists by 1/(k+rank) per method; items appearing in multiple lists rank highest; no score normalisation needed.

---

## How it works

### Move 1 — The mental model

```
   Query → ┌─ Dense (cosine) ──→ [doc3, doc7, doc1]    (rank 1, 2, 3)
           └─ Sparse (BM25) ──→ [doc7, doc2, doc5]    (rank 1, 2, 3)

   Reciprocal Rank Fusion (k=60 typical):
     score(doc) = sum over methods of 1 / (k + rank)

   doc7:  1/(60+2) + 1/(60+1)  =  0.0164  ← highest (appears in both)
   doc3:  1/(60+1)             =  0.0164
   doc2:  1/(60+2)             =  0.0161
   ...
```

### Move 2 — The layered walkthrough

**Layer 1 — why reciprocal rank.** The reciprocal function diminishes returns for lower ranks (rank 1 contributes 1/61 ≈ 0.0164; rank 100 contributes 1/160 ≈ 0.0063). Items in top positions dominate; items deep in lists contribute marginally. The `k=60` constant is the standard (Cormack et al. 2009 paper; empirical default).

**Layer 2 — why scores don't get normalised.** Cosine scores range 0-1; BM25 ranges 0-∞ and varies wildly by query. Any weighted combination (`0.7 × cosine + 0.3 × BM25`) requires re-tuning weights every time corpus or query distribution shifts. Rank-based fusion is invariant to score scale — the rank is what matters.

```
   Why ranks beat scores
   ─────────────────────
   weighted combination:    "is 0.85 cosine equivalent to 50 BM25?"
                            answer depends on corpus
   RRF:                     "is rank-1 in dense the same as rank-1 in sparse?"
                            answer: yes, by definition
```

**Layer 3 — when RRF underperforms.** When one retriever is dramatically better than the other on every query, fusion adds noise. Measure: eval dense-alone vs sparse-alone vs hybrid on the same query/expected-doc set; pick what wins.

### Move 3 — The principle

Fuse by rank, not by score. Items appearing in multiple lists earn the votes. No tuning required.

---

## RRF — diagram

```
┌─ Hybrid retrieval pipeline ────────────────────────────────────────────┐
│                                                                        │
│   query                                                                │
│      │                                                                 │
│      ├──→ dense retrieval ────→ [d1, d2, d3, ...]   (top-k by cosine)  │
│      │                                                                 │
│      └──→ sparse retrieval ───→ [s1, s2, s3, ...]   (top-k by BM25)    │
│                │                                                       │
│                ▼                                                       │
│   ┌────────────────────────────────────────────────┐                  │
│   │ for each doc id in union of both lists:        │                  │
│   │   score = 1/(60 + dense_rank) +                │                  │
│   │            1/(60 + sparse_rank)                │                  │
│   │ (use 1/(60 + ∞) ≈ 0 for missing)               │                  │
│   └────────────────────────────────────────────────┘                  │
│                │                                                       │
│                ▼                                                       │
│         sort by score desc; take top-k                                 │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not implement hybrid retrieval today.**

Phase 2A's `B2A.10` defines the build: dense via `entry_embeddings` + sparse via FTS5, combined via RRF. The combination is a ~20-line function: take both ranked lists, compute reciprocal-rank scores, sort by sum. No external library needed.

---

## Elaborate

### Where this pattern comes from

Cormack, Clarke, Buettcher 2009 — "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods." Has been the default fusion method ever since for its simplicity and effectiveness.

### The deeper principle

When two methods produce ranked lists, the union-of-top-ranks is usually better than either alone. The fusion method matters less than having one; RRF wins on simplicity.

### Where this breaks down

When the two methods rank the same way most of the time (high overlap, low complementarity), RRF adds little. When they rank very differently, fusion may surface bad results that one method ranked high. Eval on a held-out set decides.

### What to explore next

- [07-reranking-with-cross-encoder](./07-reranking-with-cross-encoder.md) — applied AFTER RRF when accuracy beats latency
- [05-dense-vs-sparse](./05-dense-vs-sparse.md) — the two inputs to RRF

---

## Tradeoffs

The breakpoint: use RRF whenever you have two retrievers running in parallel. There's no downside at small scale; the combination function is trivial.

---

## Tech reference

- **k constant:** typically 60; rarely tuned.
- **Implementation:** in-app function; no library needed.

---

## Project exercises

### B2A.10 — RRF combination

- **Exercise ID:** `B2A.10`
- **What to build:** ~20-line function that takes two ranked lists + k=60 and returns fused ranking. Wire dense + sparse → RRF as the production retrieval path.
- **Done when:** hybrid hit@k beats dense-alone and sparse-alone.
- **Estimated effort:** 1 hour (the function), 2 hours (eval).

---

## Summary

- RRF combines ranked lists by `1/(k+rank)` per method.
- No score normalisation; rank is what matters.
- Items in multiple lists rank high.
- `k=60` is the standard.

---

## Interview defense

**Q [mid]:** Why RRF over a weighted average of scores?

**A:** Scores aren't comparable across methods — cosine is 0-1, BM25 is 0-∞ and varies by query. Any weighted average requires per-corpus tuning. RRF uses only ranks, which are scale-invariant. The math is simpler and the result is more stable.

### One-line anchors

- Fuse by rank, not score.
- 1/(k+rank); k=60 standard.
- Items in multiple lists rank highest.

---

## Validate

### Quick check
- What's the standard value of k?
- What's the formula for an item's RRF score?
- Why don't you normalize scores first?
