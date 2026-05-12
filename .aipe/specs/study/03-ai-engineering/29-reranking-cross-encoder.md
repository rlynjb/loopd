# Reranking with a cross-encoder

**Industry name(s):** Reranking, cross-encoder reranking, two-stage retrieval, retrieve-and-rerank
**Type:** Industry standard

> Why a fast-imprecise first stage + a slow-precise second stage beats either alone — the two-stage pattern that powers modern search.

**See also:** → [28-hybrid-retrieval-rrf](./28-hybrid-retrieval-rrf.md) · → [24-embeddings-geometric](./24-embeddings-geometric.md) · → [36-eval-methods](./36-eval-methods.md)

---

## Why care

You shipped hybrid retrieval. Top-5 hit@5 is 72%. The right answer is in top-20 about 90% of the time — it's just not at the top. Adding more vectors won't help; the model can rank well enough but not precisely. What you need is a smarter scorer for the top candidates, even if it's too slow to run on the whole corpus.

Reranking is the two-stage pattern that solves exactly this: a fast retriever pulls top-50 (or top-100) candidates; a slow but more accurate model re-scores just those candidates and picks the best top-K. The pattern is the same shape as a database query plan: a coarse index scan finds candidate rows, then an expensive filter narrows them. You get the speed of the cheap layer and the accuracy of the expensive one. Here's how the cross-encoder layer works and why it's such an underrated lever.

---

## How it works

Retrieval and reranking solve slightly different problems with slightly different shapes of model.

### Bi-encoder vs cross-encoder — the architectural split

A bi-encoder (what embeddings do) encodes the query and the document *separately*, then compares the two vectors. This is fast at retrieval time because all the documents can be pre-embedded once; queries just embed on demand and cosine against pre-computed vectors.

A cross-encoder takes the query AND the document *together* as input to a single transformer call, and outputs a single relevance score. This is much more accurate (the model gets to attend across query and doc together) but much slower (one model call per (query, doc) pair). You couldn't run a cross-encoder against an entire corpus.

If you're coming from frontend, the analogue is `Array.prototype.indexOf()` vs `Array.prototype.find(predicate)`. `indexOf` is fast (compare pre-computed hashes) but works only on equality. `find(predicate)` is slow (run a function per element) but expresses anything.

### Why you need both

```
Retrieval (bi-encoder, fast)          Rerank (cross-encoder, slow)
─────────────────────────────         ──────────────────────────────
Pre-compute every doc vector          Take query + 50 candidates
At query time: ~50ms cosine           At query time: ~50 × 200ms each
Returns top-50 candidates             Returns top-5 best-scored
Quality: good enough for recall       Quality: precise on top-k
```

The first stage casts a wide net; the second stage tightens it. Without the wide net, the rerank model can't see the right answer at all. Without the tight stage, you have lots of candidates and no way to pick.

### The practical cost

A cross-encoder call is 50–500ms depending on model and document length. Running it on 50 candidates means 2.5–25 seconds added to query time if done serially. Parallelisation helps somewhat, but cross-encoders are heavy enough that even parallel they add user-visible latency.

The practical consequence: rerank is a quality lever, not a latency-free lever. You use it when retrieval-only quality plateaus and you're willing to spend latency to get out of the plateau.

### Where the cross-encoder shines

Cross-encoders catch cases where the bi-encoder's separate-then-compare loses information:

- **Negation** — "I love coffee" vs "I don't love coffee" — bi-encoders often embed these close together; cross-encoders correctly mark them as opposite.
- **Specific numerical or factual claims** — "weighs 5kg" vs "weighs 50kg" — bi-encoders blur; cross-encoders attend to the difference.
- **Multi-sentence reasoning** — when relevance requires combining two sentences from the doc, the cross-encoder sees both simultaneously; the bi-encoder compressed them into one centroid.

### This is what people mean by "two-stage retrieval is the production pattern"

The two-stage pattern is in every mature search system: Google ranks coarsely then reranks with BERT-derived models; Bing does the same; every "AI search" startup ships this shape. The reason it's not the default first thing you build is that you have to *first* have a working first stage to rerank — and many small applications never plateau in the first stage. Here's the diagram of how it fits together.

---

## Reranking — diagram

```
Two-stage retrieval pipeline

  Query: "where did Sarah push back on the architecture?"
            │
            ▼  Stage 1: bi-encoder retrieval (fast)
  ┌──────────────────────────────────────────────────────┐
  │ embed(query) → cosine on entry_embeddings → top 50   │
  │ + BM25 → top 50 → RRF merge → 50 candidates          │
  │                                                      │
  │ ~50–200ms                                            │
  └──────────────────────────────────────────────────────┘
            │
            ▼  Stage 2: cross-encoder rerank (slow, precise)
  ┌──────────────────────────────────────────────────────┐
  │ For each of 50 candidates:                           │
  │   score = cross_encoder(query, doc)                  │
  │ Sort by score, take top 5                            │
  │                                                      │
  │ ~50 × 200ms (parallel) ≈ 500–2000ms                  │
  └──────────────────────────────────────────────────────┘
            │
            ▼
       Top 5 results
       (precision higher than Stage 1 top 5)
```

The rerank stage's input is small (50 candidates) but each scoring call is heavy. The output is small and precise.

---

## In this codebase

**Status:** Case B — no reranking today; depends on Phase 2A retrieval shipping first.

The curriculum's `[B2A.11]` is explicitly conditional: *"Cross-encoder rerank on 'related entries'; measure hit@5; if no improvement, skip in 2B."* The cost-benefit at loopd scale is unclear — for a single-user corpus where retrieval already returns 50 candidates and the right answer is in top-5 most of the time, rerank may not earn its place. The build is "ship it once, measure, decide."

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, lives in `src/services/ai/rerank.ts:rerankCandidates()`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
The retrieve-and-rerank pattern is older than transformers — classical IR systems used a fast lexical retrieval followed by a more sophisticated relevance model. The modern incarnation (Sentence-BERT bi-encoder + cross-encoder reranker) was crystallised by Reimers & Gurevych (2019) and is now the default architecture for production search.

### The deeper principle
Latency is a budget; spend it where it produces measurable quality lift. The two-stage pattern spends latency on the small number of candidates that actually need expensive scoring. The principle generalises: in any pipeline where most candidates can be filtered cheaply, the expensive layer should run only on the survivors.

### Where this breaks down
Reranking can't help if the right answer is *not in the retrieved top-K*. The rerank stage filters and reorders; it can't conjure missing docs. If your first-stage recall@50 is 60%, rerank's ceiling is 60% — you'd improve the first stage instead.

### What to explore next
- [36-eval-methods](./36-eval-methods.md) → measure first-stage recall@50 before deciding rerank is worth it
- [29-reranking — see also `[B2A.11]`'s conditional] — the eval-driven decision
- Listwise rerankers — newer approach where the model sees all candidates at once instead of one at a time

---

## Tradeoffs

### Comparison table — rerank vs no-rerank for loopd's likely scale

```
┌──────────────────────────┬──────────────────────┬──────────────────────────┐
│ Cost dimension           │ Rerank (target?)     │ No rerank (today)        │
├──────────────────────────┼──────────────────────┼──────────────────────────┤
│ Per-query latency        │ +500–2000ms          │ ~50–200ms total          │
│ Per-query cost           │ ~$0.0001–0.001       │ ~$0.000002 (embed only)  │
│ Quality lift (typical)   │ +5–20% hit@5         │ baseline                 │
│ Implementation effort    │ ~100 LOC + model     │ 0 (covered by hybrid)    │
│ New dependency           │ Cohere rerank API or │ none                     │
│                          │ self-hosted CE       │                          │
│ Mobile-feasible          │ API only (latency)   │ N/A                      │
│ Recall ceiling           │ first-stage recall@K │ first-stage recall@K     │
└──────────────────────────┴──────────────────────┴──────────────────────────┘
```

### Sub-block 1 — what rerank would give up

Per-query latency rising by ~500-2000ms on hybrid retrieval. For interactive search this can be the difference between "snappy" and "slow." A new API dependency (Cohere rerank) or a self-hosted cross-encoder model that adds operational complexity. A per-call cost that's small per query but adds up across daily usage.

### Sub-block 2 — what no-rerank would cost

The hit@5 plateau. If first-stage hybrid retrieval lands the right answer in top-50 90% of the time but in top-5 only 72% of the time, that ~18-point gap is invisible without rerank — and visible-to-users as "I searched, the right thing wasn't at the top, I scrolled and found it manually." For loopd at solo scale this may not matter; at multi-user scale every percentage point of hit@5 affects perceived quality.

### Sub-block 3 — the breakpoint
Rerank stops being a clear "skip" when (a) hybrid first-stage hit@5 on `[B2A.9]`'s eval plateaus below ~80%, AND (b) recall@50 is meaningfully higher than that (proving the right answer is in candidates), AND (c) interactive latency budget allows +500ms. Below those conditions, the simpler choice (skip rerank, invest the engineering elsewhere) wins.

### What wasn't actually a tradeoff
Running a cross-encoder on the entire corpus was never a real option. The latency math (365 entries × 200ms per scoring call) makes "rerank everything" infeasible at any meaningful scale.

---

## Tech reference (industry pairing)

### Cohere Rerank

- **Codebase uses:** target candidate for `[B2A.11]` (API-based; lowest implementation cost).
- **Why it's here:** managed reranker endpoint; one API call returns rescored top-K from a list of candidates.
- **Leading today:** Cohere Rerank — `adoption-leading` for managed reranking, 2026.
- **Why it leads:** purpose-built for retrieval reranking; well-documented; trained on diverse retrieval data; no infra to host.
- **Runner-up:** self-hosted `cross-encoder/ms-marco-MiniLM-L-6-v2` (sentence-transformers) — `adoption-leading` for self-hosted; runs on CPU at acceptable latency for solo loopd scale; trades infra for vendor independence.

### sentence-transformers cross-encoders

- **Codebase uses:** not used.
- **Why it's here:** the open-source family of cross-encoder reranking models; can self-host or run on CPU at small scale.
- **Leading today:** `cross-encoder/ms-marco-*` — `adoption-leading` for open-source rerankers, 2026.
- **Why it leads:** trained on MS-MARCO retrieval data; multiple size/quality variants; well-supported in the sentence-transformers library.
- **Runner-up:** BGE-reranker — `innovation-leading` for newer cross-encoders; comparable quality, sometimes slightly better.

---

## Project exercises

### [B2A.11] Cross-encoder rerank on "related entries"; measure hit@5; skip if no improvement

- **Exercise ID:** `[B2A.11]`
- **What to build:** Add a rerank step to the `[B2A.8]` related-entries pipeline only — take top-50 from hybrid retrieval, send to Cohere rerank API (or a self-hosted cross-encoder), keep top-5. Eval on `[B2A.9]`'s eval set; measure hit@5 lift. **If lift is < 5%, skip rerank in `[B2A.7]` interpret-this-week (don't ship rerank in 2B).** Document the decision.
- **Why it earns its place:** the eval-driven decision is the load-bearing part. Most candidates ship rerank by default because "everyone does it"; the rigorous answer is "we measured and decided."
- **Files to touch:** new `src/services/ai/rerank.ts`; modify `[B2A.8]` related-entries pipeline; eval results in `scripts/eval-results/rerank-vs-no-rerank-<date>.md`.
- **Done when:** the rerank pipeline runs; the eval comparing rerank vs no-rerank has measured numbers; the decision to ship-or-skip rerank in `[B2A.7]` is documented with the eval as evidence.
- **Estimated effort:** `1–2 days`.

---

## Summary

Reranking is the two-stage retrieval pattern that uses a fast bi-encoder for recall and a slow cross-encoder for precision on the top candidates. In loopd this is not yet implemented; `[B2A.11]` is an explicitly conditional build — ship it on the related-entries feature first, measure the lift, decide whether to extend to other features. The constraint that may make rerank the wrong call for loopd is solo-scale corpus size: with 365 entries, hybrid retrieval may already plateau at acceptable quality, leaving no headroom for rerank to recover. The cost being paid if we ship is +500–2000ms per query and a new API dependency.

Key points to remember:
- Two stages: bi-encoder (fast recall) → cross-encoder (slow precision).
- Cross-encoder sees query + doc together; bi-encoder sees them separately.
- Rerank's ceiling is the first-stage recall — it can't conjure missing docs.
- For loopd, the decision is eval-driven via `[B2A.11]`.
- "We tried it and it didn't help" is a defensible interview answer.

---

## Interview defense

### What an interviewer is really asking
"Do you rerank?" tests whether the candidate has the two-stage pattern in their mental model and whether they're willing to defend NOT shipping it when their eval doesn't support it.

### Likely questions

  [mid] Q: What's a reranker and where does it go in your pipeline?
  A: A reranker is a slower, more accurate model that re-scores the top candidates from your fast first-stage retriever. The first stage (bi-encoder or hybrid) pulls top-50 candidates; the reranker (cross-encoder) takes each (query, candidate) pair as joint input and outputs a relevance score. The slow stage can't run on the full corpus; the fast stage can't rank precisely. Combined, you get recall from one and precision from the other.
  Diagram:
  ```
  query → [hybrid retrieval] → 50 candidates → [cross-encoder] → top 5
          ~50–200ms              one call           per-pair scoring
                                                   ~500–2000ms total
  ```

  [senior] Q: Why might you decide NOT to rerank?
  A: Three reasons. First, latency budget — adding 500-2000ms to query time may not be acceptable for interactive search. Second, the lift may not justify the cost if first-stage hit@5 is already high; if hybrid retrieval lands the right answer in top-5 80% of the time, rerank might push to 85% — measurable but maybe not worth the infrastructure. Third, the recall ceiling — if your first-stage recall@50 is the bottleneck, rerank can't help; you'd improve the retriever instead. For loopd, `[B2A.11]` is explicitly eval-driven: ship rerank on one feature, measure, decide.
  Diagram:
  ```
  Picked: eval-driven decision         Suggested: rerank always
  ──────────────────────────           ──────────────────────────
  Ship on [B2A.8], measure              Ship everywhere
  Skip in [B2A.7] if no lift            +500-2000ms on every query
  ~100 LOC if it ships                  ~100 LOC + recurring cost
  Right when scale is uncertain         Right at production search scale
  ```

  [arch] Q: At 10× users, how would the rerank decision change?
  A: Two shifts. First, per-query latency budget is shared across more queries, so the +500-2000ms becomes operationally meaningful — you'd batch rerank calls or move to a dedicated rerank service. Second, the eval set grows past the noise threshold and small quality lifts become statistically real and product-impactful. The architectural change is moving rerank from "feature-specific opt-in" to "default with cache" — and caching the (query, doc-id) → rerank-score for repeated queries.
  Diagram:
  ```
  ┌─ Service layer ─────────────────┐
  │ rerank.ts (today: per-call)     │  ← needs batching at 10×
  │ → batched + cached rerank       │
  └─────────────────────────────────┘
            │
  ┌─ Storage layer ─────────────────┐
  │ rerank_cache (new at scale)     │
  └─────────────────────────────────┘
  ```

### The question candidates always dodge
"Why didn't you fine-tune your own reranker?" The honest answer: fine-tuning a cross-encoder needs a labelled dataset (10k+ (query, doc, relevance) tuples at minimum) and a training pipeline. Off-the-shelf cross-encoders (Cohere rerank, ms-marco-MiniLM) are trained on broad retrieval data and generalise well to most domains. For solo loopd this is decisively the wrong investment.

```
Picked: off-the-shelf rerank          Suggested: fine-tune our own
──────────────────────────             ──────────────────────────
0 training infra                       GPU + labelled dataset + eval
~100 LOC integration                   ~500+ LOC + train pipeline
Vendor API or HF model                 Hosted model
Right at solo scale                    Right at vertical-search startup scale
```

### One-line anchors
- Two stages: fast recall, slow precision.
- Cross-encoder beats bi-encoder on the same task because it sees both inputs together.
- Rerank's ceiling is the first stage's recall.
- Latency is the cost; quality lift is the win; eval is the judge.
- "We measured and it didn't help" is a defensible answer.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and draw the two-stage pipeline: query → bi-encoder retrieval (top-50) → cross-encoder rerank → top-5. Label latencies on each stage.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the bi-encoder vs cross-encoder split, (b) the latency cost of cross-encoder, (c) when rerank helps and when it doesn't, (d) loopd's eval-driven decision in `[B2A.11]`.

### Level 3 — Apply it to a new scenario
On the related-entries feature, hybrid retrieval has hit@5 of 76% and recall@50 of 92%. After adding rerank, hit@5 rises to 81%. Without looking, decide whether to ship rerank to the `[B2A.7]` interpret-this-week feature too, and defend your decision.

Open `[B2A.11]` in the curriculum and check whether your decision matches the conditional logic there.

### Level 4 — Defend the decision you'd change
Today rerank is eval-driven (ship on one feature first). If you were starting today, would you ship rerank to *all* retrieval surfaces by default? Defend your answer.

### Quick check — code reference test
- What file would the rerank logic live in?
- What's the typical first-stage candidate count fed to rerank?

Answer: `src/services/ai/rerank.ts` (target, not yet created). Typical: 50–100 candidates from first-stage retrieval.
