# Embeddings (geometrically)

**Industry name(s):** Embeddings, vector representations, semantic vectors
**Type:** Industry standard

> Text → vector in N-dimensional space. Similar meanings cluster geometrically. Distance between vectors approximates semantic distance — the unit retrieval is built on.

**See also:** → [02-embedding-model-choice](./02-embedding-model-choice.md) · → [05-dense-vs-sparse](./05-dense-vs-sparse.md) · → [11-rag](./11-rag.md)

---

## Why care

### Move 1 — The grounded scenario

You're imagining buffr's future "find related entries" feature for threads. A user types `#auth` and wants entries mentioning auth-adjacent things — "login flow", "session management", "JWT", "OAuth" — even when the exact `#auth` tag wasn't typed. Keyword search misses these. Embedding search doesn't: each entry is a vector; the query is a vector; cosine similarity surfaces semantically-close entries regardless of vocabulary overlap.

### Move 2 — Name the question the pattern answers

That find-similar-without-keyword-match question is what embeddings answer. Not "how do transformers produce embeddings" (academic); just *what's the data shape that lets two texts be "close" without sharing words*. The answer: a fixed-dimensional vector per text, where distance correlates with semantic similarity.

### Move 3 — Why answering that question matters

**What breaks without embedding-shaped retrieval:** "find related" features fail when vocabulary differs (synonyms, paraphrases, related concepts). Buffr today does no semantic search — the `expand` chain uses hand-picked recency-based retrieval (principle #11) and `interpret` uses the full day's prose. The future "interpret week" and thread "related entries" features are both Case B build targets that need embedding-shaped retrieval to work well at the user's natural query phrasing.

### Move 4 — Concrete before/after

Without embeddings:
- Thread `#auth` "related entries" → only entries with literal `#auth` tag or word "auth"
- Misses entries about "login flow", "session"
- User experiences feature as incomplete

With embeddings:
- Each entry has an embedding stored in `entry_embeddings` (Case B build B2A.2)
- Query "auth" embeds to a vector; cosine search returns top-k semantically close
- Surfaces "login flow" and "session" entries

### Move 5 — The one-line summary

An embedding is a fixed-dimensional vector per text where geometric distance approximates semantic distance; the unit retrieval is built on.

---

## How it works

### Move 1 — The mental model

```
   Text → vector in N-dimensional space

   "buy milk"        → [0.12, -0.84, 0.33, ..., 0.07]    (1536 dims for text-embedding-3-small)
   "purchase dairy"  → [0.15, -0.79, 0.31, ..., 0.09]    ← close to "buy milk"
   "stock market"    → [-0.42, 0.61, 0.18, ..., -0.23]   ← far from both

   2D projection:

            ↑
            │  • "stock market"
            │
            │
            │           • "buy milk"
            │              • "purchase dairy"
            └─────────────────────────────────→
```

### Move 2 — The layered walkthrough

**Layer 1 — what an embedding is.** A vector of floats (typically 384, 768, 1024, or 1536 dimensions). Produced by an embedding model (separate from generation models — e.g., `text-embedding-3-small` for OpenAI, `embed-multilingual-v3.0` for Cohere). Same text → same embedding (deterministic). Same model required for both indexing and querying (different models produce non-comparable vectors).

**Layer 2 — distance metrics.** Cosine similarity (1 = identical, -1 = opposite) is the dominant choice. Sometimes Euclidean. Dot product when vectors are normalized. For buffr's planned use: cosine on top-k retrieval over `entry_embeddings`.

```
   ┌─ Cosine similarity ────────────────────────────────────────┐
   │   cos(A, B) = (A · B) / (|A| · |B|)                        │
   │   range: -1 (opposite) to 1 (identical)                    │
   │   intuition: how aligned are the two vectors               │
   └────────────────────────────────────────────────────────────┘
```

**Layer 3 — what embeddings don't do.** They don't understand meaning. They've learned that similar-meaning texts cluster together based on the model's training data. They have no real concept of "auth" as a thing — they've just learned that texts about auth cluster with each other. This matters: niche domains where the embedding model wasn't trained on relevant data produce weak clustering.

```
   What embeddings do well                  What embeddings struggle with
   ───────────────────────                  ───────────────────────────
   English paraphrase clustering            very rare technical terms
   common-domain synonyms                   project-specific vocabulary
   semantic-near matches                    short queries (under 3 words)
   cross-script normalization               exact-string requirements
```

### Move 3 — The principle

Embeddings turn text into a unit (vector) that geometric operations can apply to. The unit lets you do "find similar" cheaply across millions of items. Cost: an embedding model call per item indexed, plus the vector storage. Benefit: a quantitative similarity score between any two texts.

---

## Embeddings — diagram

```
┌─ Indexing path (one-time per entry, or on edit) ───────────────────────┐
│                                                                        │
│   entry.text                                                           │
│         │                                                              │
│         ▼ embedding model (text-embedding-3-small or similar)         │
│         │                                                              │
│   [1536 floats]                                                        │
│         │                                                              │
│         ▼                                                              │
│   INSERT INTO entry_embeddings (entry_id, embedding, model, stale_at)  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─ Query path (every retrieval) ─────────────────────────────────────────┐
│                                                                        │
│   query string (e.g. "auth")                                           │
│         │                                                              │
│         ▼ same embedding model                                         │
│         │                                                              │
│   [1536 floats]                                                        │
│         │                                                              │
│         ▼ cosine similarity vs every entry embedding                   │
│         │                                                              │
│   ORDER BY cosine DESC LIMIT 10                                        │
│         │                                                              │
│         ▼                                                              │
│   top-10 entry IDs to feed the next step (display or another chain)    │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not currently produce or query embeddings.**

The Phase 2A curriculum spec defines the build:
- `B2A.1` — pick storage: `sqlite-vec` extension (preferred) or text+JS cosine for prototyping
- `B2A.2` — schema: `entry_embeddings`, `todo_embeddings` with `{source_id, chunk_index, content, embedding, model, embedding_stale_at}` plus sync columns
- `B2A.3` — pick embedding model (likely `text-embedding-3-small`)
- `B2A.4` — embed on commit; mark stale on text change; re-embed in idle pass
- `B2A.6` — query path: embed query → top-k cosine → filter `deleted_at IS NULL`

No files in `src/services/` touch embeddings today.

---

## Elaborate

### Where this pattern comes from

word2vec (2013) made embedding-shaped representations canonical; modern sentence/document embeddings (Sentence-BERT 2019, OpenAI's ada/3-small 2022+) extended the pattern from words to full passages.

### The deeper principle

Anything you want to do "fuzzy lookup" on benefits from a vector representation. The cost is the embedding model call; the benefit is geometric operations (similarity, clustering, nearest neighbor).

### Where this breaks down

For project-specific vocabulary the embedding model never saw, similarity scores are noisy. For very short queries (under 3 words), the embedding is unstable. For exact-match needs, sparse retrieval (BM25) wins.

### What to explore next

- [02-embedding-model-choice](./02-embedding-model-choice.md) — picking the model is the one-way decision
- [04-vector-databases](./04-vector-databases.md) — where to store the vectors
- [05-dense-vs-sparse](./05-dense-vs-sparse.md) — when embeddings help vs hurt

---

## Tradeoffs

```
┌──────────────────┬────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Embedding-shaped retrieval │ Keyword retrieval (BM25)    │
├──────────────────┼────────────────────────────┼─────────────────────────────┤
│ Paraphrase recall│ Strong                     │ Weak                        │
│ Exact-term       │ Weak                       │ Strong                      │
│ Indexing cost    │ Embedding model call/item  │ Tokenize only               │
│ Query cost       │ One embedding + cosine     │ One BM25 score              │
│ Storage          │ ~6KB per item (1536 floats)│ Inverted index (varies)     │
└──────────────────┴────────────────────────────┴─────────────────────────────┘
```

### The breakpoint

Use embeddings when the user's queries paraphrase the corpus (synonyms, semantic neighbors). Use sparse when exact-term match matters (code identifiers, error codes, IDs). Use hybrid (concept 06) when both matter.

---

## Tech reference

- **OpenAI:** `text-embedding-3-small` (1536 dim, $0.02/M tokens) — strong English baseline.
- **Cohere:** `embed-multilingual-v3.0` — when non-English matters.
- **sentence-transformers:** local, on-device — when privacy or latency matters.

---

## Project exercises

### B2A.1 — Pick storage and document the choice

- **Exercise ID:** `B2A.1`
- **What to build:** evaluate `sqlite-vec` (SQLite extension) vs in-app cosine (TEXT column + JS scoring); pick one; document trade-offs in `docs/spec.md`.
- **Why it earns its place:** the storage choice is one-way and gates every later RAG build item.
- **Files to touch:** `docs/spec.md`, possibly proof-of-concept code in `scripts/`.
- **Done when:** decision documented with thresholds for when to revisit.
- **Estimated effort:** 4 hours including spike.

### B2A.2 — Embeddings schema

- **Exercise ID:** `B2A.2`
- **What to build:** new tables `entry_embeddings` and `todo_embeddings` with the columns specified above.
- **Done when:** migration committed; sync layer aware of the new tables.
- **Estimated effort:** 2 hours.

---

## Summary

### Part 1 — concept recap

An embedding is a fixed-dimensional vector per text where geometric distance approximates semantic distance. Cosine similarity is the standard distance metric. Same model must index and query (vectors aren't comparable across models). Buffr does not currently produce or query embeddings; Phase 2A's `B2A.1`–`B2A.6` are the build path.

### Part 2 — key points to remember

- Embedding = vector of floats; same text → same vector; same model required both sides.
- Cosine similarity: 1 identical, -1 opposite, 0 unrelated.
- Strong on paraphrase recall; weak on exact-term match.
- Indexing cost: embedding model call per item.
- Storage: ~6KB per item at 1536 dimensions.

---

## Interview defense

**Q [mid]:** What does an embedding give you that keyword search doesn't?

**A:** Paraphrase recall. "Auth bug" and "login broken" don't share words but should both match a query about authentication. Embeddings put them at nearby points in vector space, so cosine similarity finds the connection. Keyword search misses entirely unless you maintain a synonym list. For buffr's planned thread "related entries" feature, embeddings are the only way the feature works at all.

**Q [senior]:** What can go wrong with embeddings?

**A:** Three things: (1) wrong model — if you change embedding models, your index is unusable until re-embedded, this is a one-way decision; (2) stale embeddings — if the underlying text changes and you don't re-embed, the vector still maps to the old meaning; (3) niche-domain weakness — if the embedding model wasn't trained on your domain, similarity scores are noisy. All three are designed-around in the Phase 2A spec.

### One-line anchors

- Embedding = vector; cosine = similarity.
- Same model both sides.
- Strong on paraphrase; weak on exact match.
- Indexing cost is the embedding call.
- Buffr is Case B; Phase 2A build target.

---

## Validate

### Level 1
Draw the indexing and query paths side by side.

### Level 2
Explain in under 60 seconds why same model must be used for indexing and querying.

### Level 3
A new requirement: "find related todos." Sketch the embedding schema for `todo_embeddings`.

### Level 4
Defend or oppose: "Buffr should use the same embedding model for `text-embedding-3-large` even though it's 4x more expensive — better recall."

### Quick check
- What's the dimension of `text-embedding-3-small`?
- What metric does buffr's planned retrieval use?
- What's stored in `entry_embeddings.embedding_stale_at`?
