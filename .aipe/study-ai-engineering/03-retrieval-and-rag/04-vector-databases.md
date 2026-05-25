# Vector databases

**Industry name(s):** Vector database, vector store, ANN index
**Type:** Industry standard

> Where the embeddings live. Options range from in-memory + JSON (prototype) to pgvector (existing Postgres) to dedicated Pinecone/Weaviate (large scale). For local-first apps, sqlite-vec is the sweet spot.

**See also:** → [01-embeddings-geometrically](./01-embeddings-geometrically.md) · → [02-embedding-model-choice](./02-embedding-model-choice.md) · → [10-incremental-indexing](./10-incremental-indexing.md)

---

## Why care

### Move 1 — The grounded scenario

You've built buffr's embedding pipeline. 10k entries × 1536 floats × 4 bytes = 60MB of vectors. Where do they go? On-disk in SQLite as a serialized blob — but then how do you do cosine similarity in SQL? Pull all rows into JS and score in memory? Works at 10k; doesn't at 100k. Run cosine in SQLite via the `sqlite-vec` extension? Native, fast, but adds a runtime dep. Bigger picture: the storage choice determines query latency and scale ceiling.

### Move 2 — Name the question the pattern answers

That where-do-vectors-live question is what vector databases answer. Not "what's the best vector DB" (workload-specific); just *what storage shape matches my corpus size, my runtime, and my latency budget*.

### Move 3 — Why answering that question matters

**What breaks without thoughtful storage choice:** prototype works (in-memory + JSON); production with 100k vectors crawls (full-table scan in JS); switch is a substantial refactor. Buffr's `B2A.1` curriculum item is the deliberate choice up front so the migration is one-time.

### Move 4 — Concrete before/after

Without deliberate choice:
- Start with in-memory scoring
- Corpus grows; query latency degrades
- Refactor to sqlite-vec mid-production

With deliberate choice:
- Pick sqlite-vec from day 1 (local-first matches buffr's architecture)
- Migrate Postgres mirror to pgvector at the same time (so cloud-side reads work too)
- One-time setup

### Move 5 — The one-line summary

For local-first apps under ~1M vectors: sqlite-vec on device + pgvector mirror in cloud. For larger scale or hosted-only: pgvector or a dedicated vector DB.

---

## How it works

### Move 1 — The mental model

```
   Storage options
   ───────────────

   ┌─ In-memory + JSON ──────────────────────────────┐
   │  <1000 vectors. Prototype only.                  │
   └──────────────────────────────────────────────────┘

   ┌─ sqlite-vec (SQLite extension) ─────────────────┐
   │  Local-first apps. No server. Buffr's likely     │
   │  choice. ~1M vectors comfortable.                │
   └──────────────────────────────────────────────────┘

   ┌─ pgvector (Postgres extension) ─────────────────┐
   │  Already on Postgres. Unifies relational +       │
   │  vector queries. Buffr cloud-side mirror.        │
   └──────────────────────────────────────────────────┘

   ┌─ Dedicated (Pinecone, Weaviate, Qdrant, Chroma)─┐
   │  Massive scale. Dedicated infra. Adds latency    │
   │  + network dep. Skip until needed.               │
   └──────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — sqlite-vec mechanics.** Adds a virtual table type that holds vectors with cosine/L2/dot indexes. Query: `SELECT entry_id, distance FROM entry_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 10`. Index type: brute-force scan up to ~100k vectors; HNSW for larger. For buffr at 10k entries, brute-force is fast enough (~5ms).

**Layer 2 — pgvector on the cloud side.** When buffr syncs `entry_embeddings` to Supabase, the cloud side uses pgvector for queries that originate cloud-side (e.g., admin tools, future server-side ML features). Same vector data; different index backend.

```
   Buffr's planned storage shape (B2A.1)
   ─────────────────────────────────────
   Local (canonical):    sqlite-vec on entry_embeddings.embedding
   Cloud (mirror):       pgvector on entry_embeddings.embedding
   Migration:            embedding stored as base64-encoded blob via sync
                          → pgvector parses at landing time
```

**Layer 3 — when to leave SQLite.** When vector count exceeds ~1M, or when query latency exceeds the budget. For buffr's projected corpus (10k entries even after years of journaling), SQLite is comfortable. The migration point is hypothetical — likely never reached.

### Move 3 — The principle

Match storage to scale and runtime. Local-first apps stay local; cloud-only apps use Postgres or dedicated; rare cases need dedicated vector DBs.

---

## Vector storage — diagram

```
┌─ Buffr's two-side storage (planned) ───────────────────────────────────┐
│                                                                        │
│   Device (SQLite, canonical)         Cloud (Postgres, mirror)          │
│   ─────────────────────────         ──────────────────────             │
│   entry_embeddings (sqlite-vec)     entry_embeddings (pgvector)        │
│         │                                       │                      │
│         ▼ query                                 ▼ query                │
│   sqlite-vec cosine MATCH           pgvector <=> operator              │
│   ~5ms for 10k vectors              ~10ms for 10k vectors              │
│                                                                        │
│   Sync: embeddings written locally, then debounced-pushed to cloud     │
│         (same pattern as every synced table — `schedulePush()`)         │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr has not chosen storage yet.**

`B2A.1` build: evaluate `sqlite-vec` vs in-app cosine; pick sqlite-vec if a binary build is available for Android Hermes runtime, else fall back to in-app cosine until scale demands the switch. The cloud-side pgvector is straightforward (Postgres extension already supported by Supabase).

---

## Elaborate

### Where this pattern comes from

`pgvector` (2021) brought vector search into existing Postgres deployments; `sqlite-vec` (2024) did the same for SQLite. Dedicated vector DBs (Pinecone 2019) predate both and remain dominant for very large scale.

### Where this breaks down

For React Native + Expo specifically, `sqlite-vec` binary availability for Hermes Android needs verifying. If unavailable, in-app cosine on a TEXT column works until ~50k vectors.

### What to explore next

- [10-incremental-indexing](./10-incremental-indexing.md) — once stored, when to update
- [11-rag](./11-rag.md) — what queries the storage

---

## Tradeoffs

```
┌──────────────────┬─────────────────────┬───────────────────────┬──────────────┐
│ Storage          │ Setup               │ Query latency (10k)   │ Scale ceiling│
├──────────────────┼─────────────────────┼───────────────────────┼──────────────┤
│ In-memory + JSON │ trivial             │ ~50ms                 │ ~10k         │
│ sqlite-vec       │ binary dep          │ ~5ms                  │ ~1M          │
│ pgvector         │ already-on-Postgres │ ~10ms                 │ ~10M         │
│ Pinecone et al.  │ separate infra      │ ~30ms (network)       │ ~1B          │
└──────────────────┴─────────────────────┴───────────────────────┴──────────────┘
```

### The breakpoint

Below 10k vectors and prototype phase: in-memory. Local-first production: sqlite-vec. Cloud-only production: pgvector. Above 1M vectors: dedicated.

---

## Tech reference

- **sqlite-vec:** SQLite extension by Alex Garcia. Brute-force and HNSW indexes.
- **pgvector:** Postgres extension. IVFFlat and HNSW indexes.
- **Cosine vs L2 vs dot:** cosine is default for embeddings (normalized vectors).

---

## Project exercises

### B2A.1 — Storage decision

- **What to build:** spike `sqlite-vec` on the Android Hermes runtime; if available, adopt; else fall back to in-app cosine on a TEXT column. Document at `docs/embedding-storage.md`.
- **Done when:** spike committed; decision documented.
- **Estimated effort:** 4 hours.

---

## Summary

- Match storage to scale + runtime.
- Buffr likely: sqlite-vec local + pgvector cloud mirror.
- Migration up the scale (Postgres → dedicated) is unlikely for buffr.

---

## Interview defense

**Q [mid]:** When do you reach for a dedicated vector DB?

**A:** When (a) corpus exceeds ~1M vectors, (b) you need sub-10ms p50 at higher QPS than Postgres handles, or (c) you need features the extensions don't (filtered ANN at scale, multi-tenant isolation, multi-modal). For buffr's local-first journaling corpus, none of those apply — sqlite-vec on device + pgvector mirror covers it.

### One-line anchors

- Storage choice maps to scale and runtime.
- sqlite-vec + pgvector is the local-first sweet spot.
- Dedicated DBs add latency; reach for them only at scale.

---

## Validate

### Quick check
- What's buffr's likely device-side storage?
- What's the migration trigger to leave Postgres?
- What's the latency penalty of going to Pinecone?
