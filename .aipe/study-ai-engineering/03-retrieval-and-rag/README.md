# 03 — Retrieval and RAG

Twelve patterns covering retrieval mechanics, from vector representations through to GraphRAG. Mostly Case B for buffr — principle #11 says "no RAG until provably needed"; the Phase 2A build path is the buildable next step for week-scope interpret and thread related-entries.

## Concepts

1. **[Embeddings (geometrically)](./01-embeddings-geometrically.md)** — text → vector; cosine distance approximates semantic distance.
2. **[Embedding model choice](./02-embedding-model-choice.md)** — one-way decision; store `model` per row to hedge.
3. **[Chunking strategies](./03-chunking-strategies.md)** — fixed, sentence-window, structural; match to query granularity.
4. **[Vector databases](./04-vector-databases.md)** — sqlite-vec + pgvector is the local-first sweet spot.
5. **[Dense vs sparse](./05-dense-vs-sparse.md)** — dense for paraphrase; sparse for exact term.
6. **[Hybrid retrieval with RRF](./06-hybrid-retrieval-rrf.md)** — fuse ranked lists by `1/(k+rank)`.
7. **[Reranking with cross-encoder](./07-reranking-with-cross-encoder.md)** — two-stage; eval-gated.
8. **[Query rewriting and HyDE](./08-query-rewriting-hyde.md)** — bridge query-doc embedding gap.
9. **[Stale embeddings](./09-stale-embeddings.md)** — track `embedding_stale_at`; re-embed in idle pass.
10. **[Incremental indexing](./10-incremental-indexing.md)** — events: created / updated / deleted.
11. **[RAG](./11-rag.md)** — retrieve + stuff + generate; quality bounded by retrieval.
12. **[GraphRAG](./12-graphrag.md)** — traverse explicit structure; buffr's threads are a graph already.

## What buffr exercises today

- **Case A (passive):** buffr's `threads` + `thread_mentions` form an explicit graph (concept 12); not yet used for retrieval.
- **Case B (build path):** everything else. Phase 2A's B2A.1 through B2A.11 are the buildable sequence — pick storage, embed entries, query, hybrid, optional rerank.

## Reading order

Read 1–4 for the foundations (embeddings, model choice, chunking, storage). Read 5–7 for the retrieval shapes (sparse, hybrid, rerank). Read 8 if you have short queries / long docs. Read 9–10 for the indexing lifecycle. Read 11 for how it all assembles into RAG; 12 for the graph variant.
