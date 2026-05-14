# Hybrid retrieval with RRF

**Industry name(s):** Hybrid retrieval, Reciprocal Rank Fusion (RRF), rank fusion
**Type:** Industry standard

> How to combine two ranked lists into one — without picking arbitrary weights.

**See also:** → [27-dense-vs-sparse](./27-dense-vs-sparse.md) · → [29-reranking-cross-encoder](./29-reranking-cross-encoder.md) · → [24-embeddings-geometric](./24-embeddings-geometric.md)

---

## Why care

Two judges at a contestant show each write their own top-10 lineup. Judge A scores in points-out-of-ten; Judge B scores in some star system from -1.5 to +1.5. To make a single combined ranking you can't just sum the scores — they're on different scales — and you can't pick "weight A 60%, B 40%" without an argument over who decided that. The simple, defensible move is to throw the scores away and use only the rank positions: rank 1 from each judge counts the same; rank 5 from each counts the same; a contestant who lands top-3 on both lists rises above one who lands top-1 on only one list.

The implicit question is how to combine two lists when their scoring scales aren't comparable. Not normalisation, not learned weights — ranks-only fusion, where a constant smooths how aggressively rank-1 dominates.

**What depends on getting this right:** the fusion step between loopd's two planned retrieval lanes — `hybridRetrieve()` (target, not yet created) combining a dense lane (`cosine(queryVec, entry_embeddings.vec)`) and a sparse lane (FTS5/BM25 on `entries.text`). The day "find my entries about Spice House" ships, the dense lane will hand back one ranked list (entries that mean "Indian restaurant") and the sparse lane will hand back another (entries that contain the literal "Spice House"). Sum the scores and the BM25 magnitudes (0 to ∞) drown the cosine values (-1 to 1) every time; min-max normalise and the score distribution shape breaks the comparison. RRF — `Σ 1/(k+rank)` with k=60 — sidesteps both problems and lands a fused top-k that includes the literal matches and the paraphrase matches in proportion to their rank in each lane.

Without RRF (or any fusion):
- Pick one lane and discard the other — dense wins on synonyms, loses on proper nouns
- Or sum scores naively — BM25 magnitudes drown cosine values; sparse always wins
- Or hand-pick weights ("60% dense, 40% sparse") — works on the queries you tested, breaks on the others

With RRF:
- Ignore scores entirely; use only rank position
- `RRF_score(doc) = Σ 1/(60 + rank_in_lane)` across both lanes
- Doc at rank 1 in both lanes gets ~0.033; doc at rank 1 in one lane only gets ~0.016
- The fused list elevates docs that show up well in both lanes, not docs that score huge in one

Two judges, two scales, one merged ranking — by position, not by score.

---

## How it works

RRF treats both input rankings the same way: ignore the underlying scores; trust only the rank position.

### The formula

```
RRF_score(doc) = Σ over rankings R:  1 / (k + rank_R(doc))

  where k is a smoothing constant (typically 60)
  and rank_R(doc) is doc's position in ranking R (1 = best)
```

That's it. For each document, sum `1/(k+rank)` across every ranker that includes it. Sort by that sum.

If you're coming from frontend, the math is the same shape as React's `key` prop's role in reconciliation — you don't need to know the depth or contents of two trees, just the keys' positions. RRF doesn't need to know the dense scores or the BM25 scores, just where each ranker placed each doc.

### Why ignore the scores?

Dense cosine scores live on [-1, 1]. BM25 scores live on [0, ∞] with magnitudes depending on document length and corpus statistics. They're not comparable. Adding them is meaningless; even normalising them is fragile (which normalisation? min-max breaks if the score distribution is skewed; z-score breaks for small batches).

The practical consequence: throwing away the scores and keeping the ranks is the move that makes the combination *robust* — RRF works the same way regardless of which dense model or which sparse algorithm you use.

### Why k = 60?

The k constant smooths out the influence of high ranks. With k=60, rank 1 contributes 1/61 ≈ 0.0164, rank 10 contributes 1/70 ≈ 0.0143, rank 100 contributes 1/160 ≈ 0.0063. Without smoothing (k=0), rank 1 contributes 1.0 and rank 100 contributes 0.01 — a 100× ratio, where one strong ranker can dominate. With k=60, the ratio is ~2.6× — strong ranks help, but neither ranker can completely override the other.

The original paper picked k=60 empirically across many test collections. It rarely needs tuning.

### What RRF doesn't do

RRF doesn't know which ranker is better for which query. If sparse is better for proper-noun queries and dense is better for paraphrase, RRF gives them equal voice on every query. A more sophisticated system would learn to weight per query (learned-to-rank); RRF doesn't, and that's the trade for its simplicity.

### This is what people mean by "ensemble in retrieval"

The principle: many slightly-different rankings, combined by rank position, outperform any single ranker on average. Here's the diagram showing the merge.

---

## Hybrid retrieval with RRF — diagram

```
Two retrievers, one merged ranking

  Query: "Spice House review"
            │
   ┌────────┴───────────┐
   ▼                    ▼
 Dense                 Sparse
 (cosine top-10)       (BM25 top-10)
 ─────────             ─────────
 rank 1: #289          rank 1: #234   ← exact "Spice House" match
 rank 2: #401          rank 2: #289
 rank 3: #347          rank 3: #501
 rank 4: #156          rank 4: #401
 rank 5: #234          rank 5: #112
 ...                   ...

         │                    │
         └────────┬───────────┘
                  ▼
         RRF_score(doc) = Σ 1/(60 + rank)

         #234: 1/65 + 1/61 = 0.0317
         #289: 1/61 + 1/62 = 0.0327  ← top
         #401: 1/62 + 1/64 = 0.0317
         #347: 1/63 + ø    = 0.0159
         #156: 1/64 + ø    = 0.0156
         #501: ø    + 1/63 = 0.0159
         #112: ø    + 1/65 = 0.0154

                  ▼
         Final ranking: #289, #234, #401, #347, #501, ...
```

Note how #289 wins because it ranked well in *both* lists; #234 (only in sparse) ranks high but loses to #289 (in both); #347 (only in dense) ranks below #234. The fusion rewards consensus.

---

## In this codebase

**Status:** Case B — RRF not implemented; depends on dense + sparse both existing first.

The plan: once `[B2A.6]` (dense) and the BM25 half of `[B2A.10]` are in place, RRF is a ~20-line function that merges two top-k arrays into one ranked list.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, lives in `src/services/ai/hybridRetrieve.ts:rrfMerge()`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
RRF was introduced by Cormack, Clarke, and Büttcher in their 2009 paper "Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods." The finding has been re-confirmed across many benchmarks and retrieval contests; it's now a standard baseline that newer methods must beat.

### The deeper principle
When you have multiple imperfect rankers measuring different things, the cheapest way to combine them is rank-fusion. The principle generalises beyond retrieval: ensemble voting in classification, multi-judge rubric averaging in LLM evaluation, multi-metric scoring in product analytics. Trust the ordinals, not the cardinals.

### Where this breaks down
RRF assumes the rankers are *complementary*. If both rankers have the same blind spot (e.g., neither handles negation well), RRF can't fix it. The fix is adding a third ranker with a different bias — or using a reranker (see [29-reranking-cross-encoder](./29-reranking-cross-encoder.md)) on the merged list.

### What to explore next
- [29-reranking-cross-encoder](./29-reranking-cross-encoder.md) → the rerank layer that comes after RRF
- [36-eval-methods](./36-eval-methods.md) → how to measure whether RRF actually improved hit@k
- Learned-to-rank — the more sophisticated alternative; not in loopd's plan

---

## Tradeoffs

### Comparison table — RRF vs alternative fusion strategies

```
┌──────────────────────┬───────────────────┬─────────────────────┬─────────────────────┐
│ Cost dimension       │ RRF (target)      │ Weighted sum        │ Learned-to-rank     │
├──────────────────────┼───────────────────┼─────────────────────┼─────────────────────┤
│ Parameters to tune   │ k=60 (1, rare)    │ Weights per ranker  │ Full ML model       │
│ Score-scale-sensitive│ No                │ Yes (fragile)       │ Depends on features │
│ Implementation       │ ~20 LOC           │ ~30 LOC + tuning    │ ~500+ LOC + train   │
│ Sensitivity to ranker│ Treats equally    │ Weight reflects     │ Learns per-query    │
│   strength           │                   │ ranker quality      │ which to trust      │
│ Cold-start friendly  │ Yes               │ Needs eval to tune  │ Needs training data │
│ Hard to mis-tune     │ Yes               │ No                  │ No                  │
└──────────────────────┴───────────────────┴─────────────────────┴─────────────────────┘
```

### Sub-block 1 — what RRF gives up

Per-query adaptiveness. RRF treats both rankers equally on every query. If sparse is genuinely better than dense on proper-noun queries (it is), RRF still gives dense's ranking equal voice — slightly degrading proper-noun results. A learned-to-rank system would detect "this query has proper nouns" and weight sparse higher; RRF can't.

### Sub-block 2 — what weighted sum would have cost

Two parameters (one weight per ranker) that need eval-driven tuning, plus the fragility of mixing scores that live on different scales. Once you tune the weights for your current corpus, the moment your corpus or embedding model changes, the weights are stale. RRF's parameter-free nature is the feature.

### Sub-block 3 — the breakpoint
RRF stops being the right call when you have enough eval data to train a learned-to-rank model (10k+ labelled query-doc pairs) and a clear quality ceiling you're hitting. For loopd's eval-set size (20-30 pairs), learned-to-rank is wildly over-budget; RRF is the right call indefinitely.

### What wasn't actually a tradeoff
Weighted sum of *raw scores* (dense cosine + BM25 score) was never a real option because the scales are incomparable. Even minor calibration efforts (z-score normalisation) are fragile across query distributions.

---

## Tech reference (industry pairing)

### RRF (algorithm, no specific library)

- **Codebase uses:** target implementation in plain TypeScript.
- **Why it's here:** ~20 LOC algorithm; no dependency needed.
- **Leading today:** RRF — `adoption-leading` for rank fusion, 2026.
- **Why it leads:** parameter-free, score-scale-invariant, hard to mis-tune. Wins on most benchmarks unless you train something much more complex.
- **Runner-up:** Reciprocal Rank Fusion with weights — `innovation-leading` for codebases that have enough eval data to discriminate per-query ranker quality; pays off at scale.

### LangChain `EnsembleRetriever`

- **Codebase uses:** not used.
- **Why it's here:** the LangChain abstraction that ships RRF (and weighted alternatives) out of the box.
- **Leading today:** LangChain ensemble — `adoption-leading` for LangChain codebases, 2026.
- **Why it leads:** zero implementation cost if you're already in LangChain.
- **Runner-up:** custom implementation — `adoption-leading` for codebases that prefer no framework dependencies; loopd is in this camp.

---

## Project exercises

### [B2A.10] (partial) Implement RRF merge

- **Exercise ID:** `[B2A.10]` (the RRF half — sparse retrieval is the other half)
- **What to build:** A `rrfMerge(rankedListA, rankedListB, k=60)` function in `src/services/ai/hybridRetrieve.ts`. Takes two arrays of doc IDs (already top-k from each retriever), computes RRF scores, returns a merged ranking. Add to `[B2A.10]`'s eval to measure hybrid hit@k vs dense-only.
- **Why it earns its place:** ~20-line function that delivers the entire "hybrid retrieval" interview answer.
- **Files to touch:** `src/services/ai/hybridRetrieve.ts` (new).
- **Done when:** the function passes a unit test (small synthetic case) and is plugged into `[B2A.10]`'s eval pipeline.
- **Estimated effort:** `<1hr`.

---

## Summary

Reciprocal Rank Fusion is a near-parameter-free formula that merges multiple ranked lists into one by summing `1/(k+rank)` across rankers. In loopd this is the planned combination strategy for hybrid retrieval (`[B2A.10]`) — combining dense cosine and sparse BM25 into one ranking. The constraint that makes RRF the right call is that the two scoring scales are incomparable and any tuned weighted-sum would be fragile across query distributions. The cost being paid is per-query adaptiveness: RRF treats both rankers equally on every query, even when one is genuinely better for that query's shape.

Key points to remember:
- RRF ignores scores, uses ranks only.
- Formula: `Σ 1/(60 + rank)` per ranker; merge by sorting the sum.
- Robust to which dense or sparse algorithm you pick.
- Rewards consensus — docs in both lists outrank docs in only one.
- For loopd, ~20 LOC; the smallest "interview-defensible hybrid retrieval" build.

---

## Interview defense

### What an interviewer is really asking
"How do you combine retrieval scores?" tests whether the candidate knows RRF or is reinventing weighted-sum-with-tuning.

### Likely questions

  [mid] Q: How does RRF combine two ranked lists?
  A: For each document, sum `1/(60 + rank)` across every ranker that included it, then sort descending. Documents in both lists outrank documents in only one. The k=60 smoothing means no single ranker can completely dominate.
  Diagram:
  ```
  doc #289: 1/61 (dense) + 1/62 (sparse) = 0.0327
  doc #234:       —      + 1/61          = 0.0164
  
  Final rank: #289 (both lists), then #234.
  ```

  [senior] Q: Why not just normalise the scores and add them?
  A: Two reasons. First, the score scales are fundamentally incomparable — cosine is bounded [-1, 1] and BM25 is unbounded with magnitudes depending on doc length and corpus statistics. Even min-max normalisation breaks across query distributions. Second, RRF is parameter-free; weighted sum needs eval-driven tuning, and that tuning becomes stale every time the corpus or model changes. RRF's robustness comes from throwing away the scores and trusting only the ranks.
  Diagram:
  ```
  Picked: RRF (rank-based)              Suggested: weighted score sum
  ─────────────────────────             ─────────────────────────
  Parameter-free                          Per-ranker weights to tune
  Robust to score scale                   Fragile to score scale
  ~20 LOC                                 ~30 LOC + eval
  Right when you don't have               Right when you have lots of
  query-distribution training data        labelled per-query data
  ```

  [arch] Q: At scale, does RRF still win?
  A: Up until you have enough training data to learn per-query ranker preferences (10k+ labelled query-doc pairs), RRF is hard to beat. Beyond that, learned-to-rank models can outperform by adapting weights per query — knowing that proper-noun queries should weight sparse higher and paraphrase queries should weight dense higher. For loopd's eval set (20-30 pairs), learned-to-rank is wildly over-budget; RRF is right indefinitely.
  Diagram:
  ```
  Today (20-30 pairs)        →  RRF (parameter-free, robust)
  10k+ labelled pairs        →  RRF, but consider learned weights
  100k+ pairs                →  Learned-to-rank starts winning
  Production search at scale →  Learned-to-rank ships
  ```

### The question candidates always dodge
"Why is k=60 the right value?" Most candidates say "it's the default." The real answer: it was picked empirically by Cormack et al. across many test collections in 2009 and rarely needs tuning. The smoothing makes rank 1 contribute 1/61 vs rank 100 contributing 1/160 — a 2.6× ratio that lets strong ranks dominate without crushing weak ranks. Without smoothing (k=0), the rank-1 contribution is 1.0 vs 0.01 at rank 100 — a 100× ratio that lets one strong ranker completely override the other.

```
Picked: k=60 default               Suggested: k=0 (no smoothing)
─────────────────────              ─────────────────────────
Rank 1: 1/61 = 0.0164              Rank 1: 1.0
Rank 100: 1/160 = 0.0063           Rank 100: 0.01
2.6× ratio                         100× ratio
Strong wins but weak heard         Strong dominates absolutely
Balanced ensemble                  Effectively single-ranker
```

### One-line anchors
- Use ranks, not scores.
- `Σ 1/(60 + rank)`. That's it.
- Consensus across rankers wins.
- Parameter-free is the point.
- Beat it only when you have training data and a real ceiling.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and draw the merge: dense top-10 + sparse top-10 → RRF math → merged ranking. Use the #289 / #234 / #401 example.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the RRF formula, (b) why k=60, (c) why scores are thrown away, (d) when learned-to-rank starts beating RRF.

### Level 3 — Apply it to a new scenario
A user runs a query and the dense ranker returns 10 results; the sparse ranker returns only 3 (the query had only one rare word). Without looking, predict how RRF handles the asymmetry and whether it's a problem.

Open the diagram and check whether you handled the "only in dense" docs correctly (they still get RRF scores from the dense side only).

### Level 4 — Defend the decision you'd change
Today RRF treats both rankers equally. If you were starting today, would you weight sparse higher by default (since proper-noun precision is a real loopd weakness)? Defend your answer naming one specific failure mode.

### Quick check — code reference test
- What function would do the merge?
- What file would it live in?

Answer: `rrfMerge()` in `src/services/ai/hybridRetrieve.ts` (target, not yet created).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (two-judges-different-scales scenario, name the how-to-combine-incomparable-scores question, planned hybridRetrieve/rrfMerge stakes, before/after, single-line metaphor).
