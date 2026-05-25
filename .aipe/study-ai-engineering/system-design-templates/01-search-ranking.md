# Search ranking system design

**Industry name(s):** Information retrieval system, learned ranking, search-ranking system design (IK Module 1)
**Type:** Industry standard

> Design a search ranking system that takes a user query and returns the top-k most relevant items from a corpus.

**See also:** → [07-rag](../07-rag.md) · → [24-embeddings-geometric](../24-embeddings-geometric.md) · → [27-dense-vs-sparse](../27-dense-vs-sparse.md) · → [28-hybrid-retrieval-rrf](../28-hybrid-retrieval-rrf.md) · → [29-reranking-cross-encoder](../29-reranking-cross-encoder.md)

---

- **The prompt:** Design a search ranking system that takes a user query and returns the top-k most relevant items from a corpus.

- **Standard architecture:**

  ```
  Search ranking — three-stage architecture

  ┌─ Query ingest ─────────────────────────────────────────┐
  │  user_query → tokenize → expand → embed                 │
  │                              └─ optional HyDE rewrite   │
  └────────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ Stage 1: candidate retrieval (recall) ───────────────┐
  │                                                        │
  │  Dense path:    embed(query) → vector store → top-100  │
  │  Sparse path:   tokens → BM25 index → top-100          │
  │                       │                                │
  │                       ▼                                │
  │           Reciprocal Rank Fusion → top-50              │
  └────────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ Stage 2: rerank (precision) ─────────────────────────┐
  │  cross-encoder(query, doc) per (query, candidate)      │
  │  → top-K (typically K=5 or 10)                         │
  └────────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ Stage 3: serve ──────────────────────────────────────┐
  │  Apply business rules (freshness, diversity, fairness) │
  │  Log impression for online metrics                     │
  │  Return ranked list                                    │
  └────────────────────────────────────────────────────────┘
  ```

- **Data model:**
  - `documents` — `{doc_id, content, metadata, created_at, updated_at, deleted_at}`. The corpus itself.
  - `embeddings` — `{doc_id, chunk_index, vector, model, embedding_stale_at}`. Dense representation.
  - `inverted_index` — BM25 sparse representation (managed by the storage layer's FTS extension).
  - `query_log` — `{query, results_shown, clicked, dwelled_ms, user_id, ts}`. For online eval and learning to rank.
  - `eval_set` — `{query, expected_doc_ids, label_source}`. Hand-curated relevance judgments.

- **Key components:**
  - *Embedding pipeline*: incremental indexing (see [33-incremental-indexing](../33-incremental-indexing.md)) keeps vectors current on document changes. Choice: `text-embedding-3-small` 1536-dim for general English; pick smaller dim only after eval.
  - *Hybrid retrieval*: combines dense (cosine over embeddings) with sparse (BM25). Combined via RRF (k=60). Handles both paraphrase (dense) and proper-noun queries (sparse).
  - *Reranker*: cross-encoder (Cohere Rerank or self-hosted ms-marco-MiniLM) on the top-50 candidates. Trade-off: +500-2000ms latency for +5-20% precision; ship only if eval supports.
  - *Query rewriter*: HyDE for short queries on long-form corpora. Optional; eval-driven.
  - *Eval harness*: golden + adversarial + regression sets; metrics hit@k, MRR, NDCG.

- **Scale concerns:**
  - At ~10M docs: linear-scan dense cosine fails (~5000ms). Solution: HNSW ANN index (`sqlite-vec`, `pgvector`, or dedicated vector DB).
  - At ~1k QPS: synchronous reranker latency makes p95 unacceptable. Solution: rerank only on the top-K candidates (already this shape); consider rerank-bypass for confident cases.
  - At ~10k QPS sustained: embedding-model API rate limits become the bottleneck. Solution: cache query embeddings (semantic cache keyed by query string + model version).

- **Eval framing:**
  - Offline: hit@1, hit@5, MRR on hand-curated relevance judgments.
  - Online: CTR, dwell time, session-success rate, query-reformulation rate. Note: "no-click is not a negative label" — see [39-no-click-not-negative](../39-no-click-not-negative.md).
  - Per-deployment: A/B test new rankers; statistical significance over 1-2 weeks.
  - Adversarial set: position-bias-resistant evaluation; explicit edge cases (proper nouns, paraphrases, negation, multi-language).

- **Common failure modes:**
  - *Stale embeddings*: document edited but vector still represents old content. Mitigation: mark-stale-on-write + idle re-embed pass (see [32-stale-embeddings](../32-stale-embeddings.md)).
  - *Cold-start docs*: new documents not yet indexed; queries miss them. Mitigation: incremental indexing on commit, not nightly.
  - *Long-tail queries*: rare query patterns score badly on aggregate metrics. Mitigation: tail-aware eval slicing; surface low-confidence results with a "we're not sure" indicator.
  - *Ranking bias*: position bias inflates click rates on top results regardless of true relevance. Mitigation: counterfactual eval; explicit relevance labels.

- **Applies to this codebase:** `partially`. buffr will be a partial search ranking system once Phase 2A ships. The corpus (`entries`) is small (~365 per user), so most "scale concerns" don't apply yet, but the architectural shape matches: incremental indexing, hybrid retrieval (`[B2A.10]`), optional rerank (`[B2A.11]`), conditional HyDE (deferred). The `[B2A.7]` interpret-this-week and `[B2A.8]` related-entries features will both be search-ranking-flavoured at small scale.

- **How to make it apply:** Ship Phase 2A in full — `[B2A.1]` storage, `[B2A.2]` schema, `[B2A.3]` embedding model, `[B2A.4]` stale tracking, `[B2A.7]` interpret-week, `[B2A.8]` related-entries, `[B2A.10]` hybrid + RRF, `[B2A.11]` conditional rerank. Then `[B3.5]` builds the eval suite (hit@k, MRR). After all that, buffr is defensible as "I built a search ranking system" — small scale, full shape.
