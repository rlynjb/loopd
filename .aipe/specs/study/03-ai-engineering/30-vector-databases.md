# Vector databases

**Industry name(s):** Vector database, vector store, ANN index, similarity search engine
**Type:** Industry standard

> Where the vectors live, how the index works, and why the right answer for loopd is "SQLite, not a new service."

**See also:** → [24-embeddings-geometric](./24-embeddings-geometric.md) · → [33-incremental-indexing](./33-incremental-indexing.md) · → [32-stale-embeddings](./32-stale-embeddings.md)

---

## Why care

Open Pinecone's console on any indexed namespace. Paste a query text into the sample-query form, hit search, and get the top-10 nearest vectors back in under 100ms — regardless of whether the index holds a thousand vectors or a million. The speed comes from the HNSW (Hierarchical Navigable Small World) index Pinecone runs underneath. SQLite's `sqlite-vec` extension exposes the same shape via `CREATE VIRTUAL TABLE entry_vec USING vec0(...)`; Postgres's `pgvector` exposes it via `CREATE INDEX ON entries USING hnsw (embedding vector_cosine_ops)`. Same query shape, three storage engines, one underlying algorithm.

The implicit question is "given a query point, what are the nearest neighbours in this space, and how fast can we find them?" A vector database is the name for the storage layer that holds those points plus the index that answers the question without scanning every row. Two real decisions live underneath: which storage engine holds the vectors, and which algorithm (exhaustive vs ANN) the index uses.

**What depends on getting this right:** which databases the codebase has to operate, how retrieval latency scales, and whether vectors stay co-located with the rows they describe. For loopd the planned `entry_embeddings` table lives in `loopd.db` next to `entries`, synced to Supabase via the existing `schedulePush` machinery — picking `sqlite-vec` keeps one canonical store and makes "filter `deleted_at IS NULL` then ORDER BY cosine" a single SQL statement. Pick Pinecone instead and every retrieval becomes a cross-service round-trip, plus a third operational surface, plus a sync mapper between two incompatible vector formats — for 365 entries per user, the new service earns nothing.

Without the right call:
- Pick Pinecone at 365 vectors → third service to operate, no SQL joins, ~50–200ms network round-trip per query, local-first stance broken
- Pick JSON TEXT + JS cosine at 1M vectors → linear scan in JS takes ~5000ms per query, app freezes during retrieval
- Pick `sqlite-vec` at 100× scale with multi-tenant pressure → SQLite's concurrent-read limits start mattering before the algorithm does

With the right call:
- `entry_embeddings` lives in `loopd.db` alongside `entries`; one PK convention, one sync path, one canonical store
- HNSW index inside SQLite answers nearest-neighbour in sub-10ms even at 100k vectors
- Migration to `pgvector`-primary becomes a layer swap, not a re-architecture, the day multi-tenant scale arrives

The vector is data; the index is infrastructure — use the database you already have until it can't.

---

## How it works

A vector DB does two things: store vectors with metadata, and answer "k nearest neighbours" queries fast. The first is trivial; the second is everything.

### Exhaustive search vs ANN — the algorithmic split

For N vectors of dimension D, exhaustive nearest-neighbour search is O(N × D). At loopd's solo scale (~365 entries, 1536 dim), that's 561k operations per query — about 5ms in JavaScript on a modern phone. Fine.

At 100k vectors of the same dim it's 153M operations — about 1500ms. Not fine.

Approximate Nearest Neighbour (ANN) algorithms trade exact correctness for speed. HNSW (Hierarchical Navigable Small World, the dominant algorithm) builds a graph where each vector has a few connections, and queries walk the graph greedily. Query time scales roughly with log(N) instead of N — sub-10ms even at millions of vectors.

If you're coming from frontend, the analogue is `Array.prototype.find()` vs a Map lookup. Linear search is fine at small sizes; you switch to indexed lookup when it isn't.

### Where the vectors physically live

Three options, ordered by infra burden:

1. **In your existing database** — `pgvector` for Postgres, `sqlite-vec` for SQLite. Zero new services. Joins with non-vector data are SQL.
2. **In a dedicated vector service** — Pinecone, Weaviate, Qdrant. Managed or self-hosted. Optimised for scale; adds a service to operate.
3. **In memory** — FAISS, hnswlib, in-process. Fastest. Resets on restart. Right for ephemeral or read-only indexes.

For loopd specifically: the SQLite layer is the canonical store; the cloud mirror is Supabase Postgres. Both have first-class vector support (`sqlite-vec` ships as an extension; pgvector is a Postgres extension). Adding a separate Pinecone service would be a new operational surface for marginal benefit.

### Sync mirror for vectors — same shape as everything else

loopd's sync pattern is local SQLite is canonical, Supabase Postgres is mirror. Vectors fit the pattern: store in SQLite locally with the rest of the entry data, push to Supabase via the existing `schedulePush` machinery. The only twist is that vectors are large compared to other columns (1536 floats × 4 bytes = 6 KB per row) — but still small in absolute terms at solo scale.

### Where vector DBs go wrong

The most common production failure: choosing Pinecone (or any dedicated service) at low scale and then having two databases — your "main" database with users, entries, sync metadata, AND the vector DB with vectors. Every query that needs both joins becomes a cross-service round-trip. The fix is "keep everything in one place until you can't" — usually until you have 1M+ vectors or genuine performance pressure.

### This is what people mean by "vectors are just another column"

The vector is data; the index is infrastructure. If your existing database can index vectors, use it. If it can't, you have two databases to operate. For loopd the answer is SQLite + the `sqlite-vec` extension. For multi-tenant production at scale the answer might be different. Here's the picture.

---

## Vector databases — diagram

```
The storage decision tree for loopd

  ┌─ How many vectors? ────────────────────────────────┐
  │                                                    │
  │  < 100k        100k–10M           > 10M            │
  │     │              │                  │            │
  │     ▼              ▼                  ▼            │
  │  sqlite-vec     pgvector +      Dedicated vec DB   │
  │  (in SQLite)    HNSW index      (Pinecone, etc.)   │
  │                                                    │
  │  loopd today ←  loopd at 10×  ←  loopd at 100×     │
  └────────────────────────────────────────────────────┘

  Storage layout (loopd's plan, [B2A.2])

  ┌─ Storage layer (SQLite + sqlite-vec) ──────────────┐
  │  entry_embeddings                                  │
  │  ────────────────                                  │
  │  source_id    INTEGER  → entries.id                │
  │  chunk_index  INTEGER  → 0 for whole-entry         │
  │  content      TEXT     → for stale-check           │
  │  embedding    BLOB     → 1536 floats × 4 bytes     │
  │  model        TEXT     → "text-embedding-3-small"  │
  │  embedding_stale_at TEXT → re-embed marker         │
  │  + sync columns (synced_at, deleted_at)            │
  └────────────────────────────────────────────────────┘
                  │
                  ▼  query path
  ┌─ Service layer ────────────────────────────────────┐
  │  SELECT source_id                                  │
  │  FROM entry_embeddings                             │
  │  WHERE deleted_at IS NULL                          │
  │  ORDER BY vec_distance_cosine(embedding, :query)   │
  │  LIMIT 10                                          │
  └────────────────────────────────────────────────────┘
```

---

## In this codebase

**Status:** Case B — no vector storage today.

`[B2A.1]` picks the storage approach (`sqlite-vec` extension vs JSON TEXT + JS cosine); `[B2A.2]` defines the schema. The plan is to keep everything in SQLite — same canonical store as every other loopd table, same sync mirror pattern, same soft-delete contract.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, table lives via `src/services/database.ts` schema; sync mapper in `src/services/sync/tables/entryEmbeddings.ts`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Vector databases as a category emerged around 2019-2021 as embedding-based retrieval became practical. Before that, the storage problem was solved with custom in-memory indexes (FAISS from Meta, ScaNN from Google) used as libraries. The "vector DB as a service" market is largely a 2021+ phenomenon driven by RAG.

### The deeper principle
The right data store for a new data type is "the one you already have" — until you have specific pressure (scale, latency, query patterns) that forces a switch. The principle generalises: adopt new infrastructure when current infrastructure breaks, not when marketing tells you to.

### Where this breaks down
Storing vectors in your transactional database breaks down when the index size, query rate, or join complexity exceeds what your DB can handle. Postgres + pgvector at >10M vectors with HNSW index tuning starts looking like dedicated-vector-DB-shaped work; SQLite + sqlite-vec breaks earlier (around 1-10M vectors and high concurrent query rates).

### What to explore next
- [32-stale-embeddings](./32-stale-embeddings.md) → how the storage handles edits to embedded text
- [33-incremental-indexing](./33-incremental-indexing.md) → re-embed on idle pass
- [27-dense-vs-sparse](./27-dense-vs-sparse.md) → BM25 lives in a different storage shape (inverted index)

---

## Tradeoffs

### Comparison table — storage options for loopd

```
┌────────────────────────┬──────────────────┬──────────────────┬───────────────────┐
│ Cost dimension         │ sqlite-vec       │ JSON TEXT + JS   │ Pinecone (service)│
├────────────────────────┼──────────────────┼──────────────────┼───────────────────┤
│ New service            │ No               │ No               │ Yes               │
│ Storage location       │ loopd.db         │ loopd.db         │ Pinecone cloud    │
│ Local-first stance     │ Native           │ Native           │ Broken            │
│ Sync to Supabase       │ Existing pattern │ Existing pattern │ Separate sync     │
│ Query latency (365)    │ ~2–5ms           │ ~5–10ms          │ ~50–200ms (net)   │
│ Query latency (1M)     │ ~10ms (ANN)      │ ~5000ms (linear) │ ~10–50ms          │
│ Setup cost             │ Add extension    │ 0                │ Account + SDK     │
│ Cross-table joins      │ SQL              │ SQL              │ Round-trip        │
│ Vendor lock-in         │ None             │ None             │ Significant       │
└────────────────────────┴──────────────────┴──────────────────┴───────────────────┘
```

### Sub-block 1 — what `sqlite-vec` gives up

Cross-platform polish — `sqlite-vec` is newer than `pgvector` and the Expo SDK's bundling story for SQLite extensions on Android isn't fully smooth as of 2025. The exercise (`[B2A.1]`) is partly to verify the extension actually works in Expo SDK 55. The fallback is JSON TEXT + JS cosine, which is slower per query but ships without extension drama.

### Sub-block 2 — what JSON TEXT + JS cosine would have cost

Linear-time queries — fine at 365 entries, breaks first at ~100k. No ANN index. The cost is invisible at solo scale and immediately fatal at 10× scale. The shape is the right *interface* (SQL `SELECT ... ORDER BY cosine_in_js`) but the wrong implementation.

### Sub-block 3 — the breakpoint
`sqlite-vec` stops being the right call at (a) corpus size where mobile SQLite query times exceed ~100ms, roughly 100k-1M vectors depending on device, OR (b) multi-tenant scale where loopd's local-first stance softens. The transition would be to `pgvector` in Supabase as the primary store with SQLite as a cache.

### What wasn't actually a tradeoff
A dedicated vector service (Pinecone, Qdrant) was never a realistic option for solo loopd. The operational complexity and the violation of the "local SQLite is canonical" principle are both severe; neither earns its place at this scale.

---

## Tech reference (industry pairing)

### sqlite-vec

- **Codebase uses:** target plan for `[B2A.1]`.
- **Why it's here:** SQLite extension that adds vector columns, `vec_distance_cosine()`, and an HNSW-like index. Designed to fit into existing SQLite-based apps with minimal disruption.
- **Leading today:** `sqlite-vec` — `innovation-leading` for embedded vector search, 2026.
- **Why it leads:** fits loopd's local-first architecture; no new service; written by the SQLite team's adjacent community.
- **Runner-up:** JSON TEXT + JavaScript cosine — `adoption-leading` fallback for codebases that can't bundle extensions; loses ANN but ships without extension drama.

### pgvector

- **Codebase uses:** target choice for the Supabase mirror.
- **Why it's here:** Postgres extension; vector column type; HNSW and IVFFlat indexes. Standard in 2026 for Postgres-based vector search.
- **Leading today:** `pgvector` — `adoption-leading` for Postgres vector search, 2026.
- **Why it leads:** ships in managed Postgres providers (Supabase, Neon, RDS); native SQL integration; HNSW added in v0.5 closes the perf gap with dedicated vector services.
- **Runner-up:** Pinecone — `innovation-leading` for managed vector search at scale; fastest ANN; costs more than `pgvector` and adds vendor lock-in.

---

## Project exercises

### [B2A.1] Pick storage: sqlite-vec vs JSON TEXT + JS cosine

- **Exercise ID:** `[B2A.1]`
- **What to build:** A decision spec in `loopd/.aipe/specs/features/rag-personal-corpus.md` comparing (a) the `sqlite-vec` extension in Expo SDK 55 + Supabase Postgres with `pgvector`, vs (b) JSON TEXT column with JS-side cosine. Includes a proof-of-concept: install `sqlite-vec` in dev, insert one vector, read it back, run a cosine query. If `sqlite-vec` works in Expo, pick it; else fall back to JSON TEXT.
- **Why it earns its place:** the storage choice is irreversible without migrating every vector. Getting it right at the start saves a future migration.
- **Files to touch:** new `loopd/.aipe/specs/features/rag-personal-corpus.md`; eventually new migrations in `src/services/database.ts` and `supabase/migrations/`.
- **Done when:** the decision is documented, the proof-of-concept ships, and the schema migration adding `entry_embeddings` is written.
- **Estimated effort:** `1–4hr` (PoC), `1–2 days` if `sqlite-vec` doesn't work in Expo and the fallback needs work.

### [B2A.2] Schema: entry_embeddings, todo_embeddings

- **Exercise ID:** `[B2A.2]`
- **What to build:** Add two tables: `entry_embeddings` and `todo_embeddings`. Columns: `{source_id, chunk_index, content, embedding, model, embedding_stale_at}` plus sync columns (`user_id`, `synced_at`, `deleted_at`, `created_at`, `updated_at`). Sync mappers in `src/services/sync/tables/`.
- **Why it earns its place:** the schema is what every other Phase 2A build item depends on.
- **Files to touch:** new SQLite migration; new `supabase/migrations/0006_embeddings.sql`; new sync mappers.
- **Done when:** `npx tsc --noEmit` passes; a vector can be inserted, synced to Supabase, pulled back, and queried for nearest-neighbours.
- **Estimated effort:** `1–2 days`.

---

## Summary

A vector database is the storage + index layer for embeddings. In loopd this is not yet implemented; the plan keeps everything in the existing SQLite + Supabase stack (`sqlite-vec` local, `pgvector` cloud) rather than introducing a dedicated vector service. The constraint that makes this the right call is loopd's local-first stance plus its scale: at 365 entries per user, neither cross-table joins nor query latency demand a new service, and adding one would violate the "SQLite is canonical" principle. The cost being paid is dependence on the `sqlite-vec` extension being usable in Expo SDK 55 — the fallback is JSON TEXT + JS cosine, which is slower but works.

Key points to remember:
- Vector DBs differ in storage and query algorithm (ANN vs exhaustive).
- For loopd's scale, the answer is "your existing database, with vector support."
- HNSW is the dominant ANN algorithm; both `sqlite-vec` and `pgvector` ship it.
- Dedicated vector services pay off at >1M vectors or multi-tenant scale.
- Storage choice cascades into every Phase 2A build item.

---

## Interview defense

### What an interviewer is really asking
"Where do your vectors live?" tests whether the candidate over-engineered the storage decision. Picking Pinecone for 1k vectors is a tell; picking SQLite + sqlite-vec is the senior-flavoured answer.

### Likely questions

  [mid] Q: Why didn't you use Pinecone?
  A: Three reasons. First, scale — loopd has ~365 vectors per user, well below the ~1M threshold where dedicated vector services start being necessary. Second, the local-first architectural principle — loopd's canonical store is SQLite on device with Supabase Postgres as a sync mirror; introducing a third service for vectors would break that pattern. Third, cross-table joins — every retrieval needs to filter `deleted_at IS NULL` and often join with the entry text; SQL is cheaper than two-service round-trips.
  Diagram:
  ```
  Picked: sqlite-vec + pgvector       Suggested: Pinecone
  ─────────────────────────           ─────────────────────
  Same DB as everything else          Third service
  SQL joins                           Round-trip joins
  ~365 vectors per user               Right at 1M+ vectors
  Local-first preserved               Breaks local-first
  ```

  [senior] Q: What changes at 10× corpus?
  A: The architectural lever is moving from "JS-side cosine on JSON" (if that's the fallback) to "sqlite-vec HNSW index" — query time goes from linear-in-N to log-in-N. If `sqlite-vec` was already shipped, nothing changes at the storage layer; only the index parameters might be tuned. At 100× scale (multi-tenant production), the question becomes whether SQLite's concurrent-read limits start mattering — at which point Supabase pgvector becomes the primary store with SQLite as a per-device cache.
  Diagram:
  ```
  Today (365 vectors)           →  sqlite-vec or JSON+JS cosine
  10× scale (~3650)             →  sqlite-vec with HNSW (sub-10ms)
  100× scale (multi-tenant)     →  pgvector primary, SQLite cache
  1000× scale                   →  dedicated vector DB worth considering
  ```

  [arch] Q: What if sqlite-vec doesn't work in Expo SDK 55?
  A: The `[B2A.1]` decision spec explicitly considers this; the fallback is JSON TEXT + JS cosine. The interface stays the same (SQL `SELECT ... ORDER BY cosine LIMIT k`), just slower per query and without an ANN index. The cost is invisible at 365 vectors and would force a re-evaluation at ~50k vectors. The proof-of-concept in `[B2A.1]` is precisely to find out which side of this we're on before committing.
  Diagram:
  ```
  ┌─ Service layer ──────────────────┐
  │ retrieveByVector()               │
  │  ├─ if sqlite-vec works:         │
  │  │    indexed cosine + HNSW      │  ← target
  │  └─ else:                        │
  │       JSON read + JS cosine      │  ← fallback
  └──────────────────────────────────┘
  ```

### The question candidates always dodge
"Why two storage backends — SQLite locally and Supabase remotely?" The honest answer: it's not "two backends," it's "one canonical store with a sync mirror." Vectors fit the same pattern as every other table in loopd — local-first reads, cloud as durable backup. The complication is keeping vector schemas in sync across the two: `sqlite-vec`'s BLOB-encoded vectors and pgvector's `vector(1536)` column type are not byte-compatible, so the sync mappers need explicit serialisation logic.

```
Picked: SQLite + Supabase mirror       Suggested: one store only
─────────────────────────────          ─────────────────────────
Local-first reads                       Cloud-only reads (online req.)
Cloud as backup                         Cloud as primary (latency)
Sync mappers handle format diff         No format dif (one store)
Right at local-first stance             Right at always-online apps
```

### One-line anchors
- The vector is data; the index is infrastructure.
- Use your existing DB until it can't.
- HNSW is the dominant ANN algorithm.
- Dedicated vector services pay off at >1M vectors or multi-tenant scale.
- The storage choice cascades into every other Phase 2A build.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the decision tree: corpus size → storage choice. Annotate the loopd today / 10× / 100× points.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) what a vector DB does, (b) the ANN vs exhaustive split, (c) why loopd uses SQLite + sqlite-vec, (d) when a dedicated service starts winning.

### Level 3 — Apply it to a new scenario
loopd grows to 1000 users averaging 1000 entries each — 1M vectors total. The Supabase pgvector instance is the primary read path. Without looking, predict what changes architecturally and where the bottleneck lands first.

Open the comparison table and check against the "Query latency (1M)" row.

### Level 4 — Defend the decision you'd change
Today the plan is SQLite + sqlite-vec for the local store. If you were starting today, would you skip sqlite-vec and store vectors only in Supabase pgvector (always-online reads)? Defend your answer naming one specific failure mode.

### Quick check — code reference test
- What table will hold entry vectors?
- What's the fallback if sqlite-vec doesn't work in Expo?

Answer: `entry_embeddings` (target — `[B2A.2]`). Fallback: JSON TEXT column + JavaScript cosine in retrieval function.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (librarian-with-2D-map scenario → nearest-neighbours-without-scanning pattern naming → bolded "what depends on getting this right" with `entry_embeddings`/`schedulePush` stakes → with/without bullets walking storage choices at 365 / 1M / 100× scale → one-line "vector is data; index is infrastructure" metaphor).

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care to anchor on real software (replaced librarian-2D-book-map analogy with the Pinecone console UI, sqlite-vec CREATE VIRTUAL TABLE, pgvector HNSW index).
