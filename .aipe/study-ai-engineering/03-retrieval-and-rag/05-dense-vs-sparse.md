# Dense vs sparse retrieval

**Industry name(s):** Dense retrieval, sparse retrieval, BM25, embedding retrieval, keyword retrieval
**Type:** Industry standard

> Dense (embeddings) wins on paraphrase; sparse (BM25) wins on exact-term match. Neither beats both for every query — production usually combines both (hybrid retrieval, concept 06).

**See also:** → [01-embeddings-geometrically](./01-embeddings-geometrically.md) · → [06-hybrid-retrieval-rrf](./06-hybrid-retrieval-rrf.md) · → [11-rag](./11-rag.md)

---

## Why care

### Move 1 — The grounded scenario

User searches buffr for "auth bug." Two relevant entries exist: one literally says "auth bug" (sparse retrieval finds it instantly); another says "login is broken when token expires" (dense retrieval finds it via semantic similarity). Dense-only misses the first match's exactness; sparse-only misses the second's paraphrase. Picking one means missing half the relevant content.

### Move 2 — Name the question the pattern answers

That which-retrieval-shape question is what dense-vs-sparse answers. Not "which is better in general" (depends on query); just *what kinds of queries does each shape favour, and when do I want both*.

### Move 3 — Why answering that question matters

**What breaks if you pick wrong:** retrieval misses entire query classes. Code lookups that need exact identifier matches fail with dense-only. Conceptual queries fail with sparse-only. For buffr's planned retrieval (Phase 2A), the journal corpus contains both shapes — exact `#tags` (sparse wins) and reflective prose (dense wins).

### Move 4 — Concrete before/after

Dense-only:
- "auth bug" → finds "login broken" (good)
- "#auth" tag query → misses entries without literal `#auth` in prose (bad)

Sparse-only:
- "#auth" → finds exact tag matches (good)
- "auth bug" → misses "login broken" (bad)

Hybrid (concept 06):
- Both query shapes work

### Move 5 — The one-line summary

Dense for paraphrase, sparse for exact term; combine in production unless the query shape is uniformly one or the other.

---

## How it works

### Move 1 — The mental model

```
   Dense (embeddings):                  Sparse (BM25):
   ──────────────────                   ──────────────
   query: "fix auth bug"                query: "fix auth bug"
        │                                    │
        ▼ embed                              ▼ tokenize
        │                                    │
   [vector]                              ["fix", "auth", "bug"]
        │                                    │
        ▼ cosine vs all                      ▼ term-frequency × IDF
        │                                    │
   top-k by similarity                  top-k by score
```

### Move 2 — The layered walkthrough

**Layer 1 — what BM25 does.** Best Matching 25 (Robertson 1994). Scores documents by how often each query term appears (term frequency) × how rare the term is across the corpus (inverse document frequency). Long-standing baseline; available in every search engine (Lucene, Elasticsearch, Postgres FTS).

**Layer 2 — when dense outperforms sparse.** Paraphrases ("buy milk" → "purchase dairy"). Cross-lingual ("error" → "fehler"). Conceptual queries that don't repeat the document's vocabulary.

**Layer 3 — when sparse outperforms dense.** Exact identifiers (function names, error codes, hashtags like `#auth`). Rare technical terms the embedding model wasn't trained on. Very short queries (under 3 words) where embeddings are unstable.

```
   Query types and winning retrieval
   ─────────────────────────────────
   "auth bug"               →  both work
   "#auth"                  →  sparse (exact)
   "login broken"           →  dense (semantic)
   "CVE-2024-1234"          →  sparse
   "general feelings about  →  dense
    the project"
```

### Move 3 — The principle

Pick by query shape. When queries are uniformly one shape (code search → sparse; conceptual search → dense), pick one. When queries span both, use hybrid (concept 06).

---

## Dense vs sparse — diagram

```
┌─ Two retrieval shapes ─────────────────────────────────────────────────┐
│                                                                        │
│   Dense (embedding cosine)            Sparse (BM25 keyword)             │
│   ─────────────────────────           ────────────────────────         │
│   index: entry_embeddings             index: inverted (term → docs)    │
│   query: embed + cosine MATCH         query: tokenize + score           │
│   strong: paraphrase                  strong: exact term                │
│   weak:   exact term                  weak:   paraphrase                │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does neither dense nor sparse retrieval today.**

Phase 2A's `B2A.6` defines the dense path; `B2A.10` adds BM25 alongside cosine and combines via RRF (concept 06). For buffr's `#tag` thread feature, sparse is the dominant query shape (exact tag matches); for "find related entries" the dominant shape is dense. The hybrid path is the production target.

---

## Elaborate

### The deeper principle

Different retrieval methods favour different query shapes. The shape of your queries determines the shape of your retrieval.

### Where this breaks down

When query distribution is uniform (always paraphrases or always exact), one shape suffices and the dispatch logic isn't needed. For buffr's planned mixed queries (`#tag` lookups + reflective queries), the hybrid path earns its keep.

### What to explore next

- [06-hybrid-retrieval-rrf](./06-hybrid-retrieval-rrf.md) — how to combine
- [11-rag](./11-rag.md) — what retrieval feeds

---

## Tradeoffs

The breakpoint: dense if queries paraphrase; sparse if queries match terms exactly; hybrid if you have both.

---

## Tech reference

- **BM25:** classical IR. Postgres has `ts_rank_cd`; SQLite has FTS5 with BM25 ranking.
- **Cosine:** see vector-databases (concept 04).

---

## Project exercises

### B2A.10 — Add BM25 alongside cosine

- **Exercise ID:** `B2A.10`
- **What to build:** add a FTS5-shaped sparse index over `entries.text`; run query through both; combine via RRF (concept 06); measure hit@k.
- **Done when:** hybrid eval shows improvement over dense-alone.
- **Estimated effort:** 4 hours.

---

## Summary

- Dense for paraphrase; sparse for exact term.
- Buffr's planned hybrid: dense for prose queries, sparse for `#tag` queries.
- Combine via RRF (concept 06).

---

## Interview defense

**Q [mid]:** When does each retrieval shape win?

**A:** Dense wins on paraphrase — "auth bug" finds "login broken." Sparse wins on exact terms — `#auth`, `CVE-2024-1234`, function names. In production, you usually need both; RRF is the simple combination.

### One-line anchors

- Dense: paraphrase. Sparse: exact term.
- Buffr's mixed query shape requires hybrid.
- RRF is the simple combination.

---

## Validate

### Quick check
- Which retrieval wins on `#auth`?
- Which wins on "the project felt heavy today"?
- What's the combination strategy?
