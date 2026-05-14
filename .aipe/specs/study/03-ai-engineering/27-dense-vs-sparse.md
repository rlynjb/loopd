# Dense vs sparse retrieval

**Industry name(s):** Dense retrieval, sparse retrieval, BM25, lexical search, TF-IDF
**Type:** Industry standard

> Why "search by keyword" and "search by meaning" each handle cases the other gets badly wrong — and why production systems often run both.

**See also:** → [24-embeddings-geometric](./24-embeddings-geometric.md) · → [28-hybrid-retrieval-rrf](./28-hybrid-retrieval-rrf.md) · → [29-reranking-cross-encoder](./29-reranking-cross-encoder.md)

---

## Why care

Two librarians work the reference desk. One was hired for her photographic memory of every book's exact title and author — ask for *The Old Man and the Sea* and she walks straight to it; ask for "a book about a fisherman struggling" and she stares at you blankly. The other was hired for her knack with themes — ask for "a book about a fisherman struggling" and she pulls Hemingway, Melville, and a Steinbeck novella; ask for *The Old Man and the Sea* by exact title and she might bring you something close but not the one you wanted. Each librarian fails on the other's strength.

The implicit question is which librarian you put on the desk. Not one or the other — both, with a system to reconcile their picks. Sparse retrieval (BM25, exact-token matching) is the photographic-memory librarian; dense retrieval (embeddings, cosine similarity) is the theme librarian.

**What depends on getting this right:** every retrieval feature that has to handle both proper-noun lookups and meaning-based queries. Loopd doesn't index either way today — there's no `embed.ts`, no FTS5 index on `entries.text`, no `entry_embeddings`. The day a "find my entries about Spice House" feature lands, dense-only retrieval will return entries about "Indian restaurant" and miss the literal-string matches; sparse-only will miss entries that say "that new place we ate at" without naming it. The planned shape is hybrid: an FTS5 virtual table over `entries.text` for sparse, an `entry_embeddings` table for dense, and a fusion step (see `28-hybrid-retrieval-rrf.md`) to merge ranked lists. Lose either half and a whole class of queries silently fails — proper nouns and rare technical terms (sparse's strength) or paraphrase and synonymy (dense's strength).

Without both layers (dense-only future):
- Query "Spice House" → ranked entries about generic Indian food
- Two entries with the literal string buried at rank 17
- User concludes "search doesn't work" and stops using it

With both layers (planned hybrid):
- Dense lane: `cosine(queryVec, entry_embeddings.vec)` → top-k by meaning
- Sparse lane: FTS5 on `entries.text` → top-k by exact-token match weighted by BM25
- Fusion (RRF) merges the two rankings; Spice House entries top the list AND paraphrased meal entries appear

One librarian for exact titles, one for themes, both on the desk.

---

## How it works

Both approaches map queries and documents into a representation that's comparable. The representations are radically different.

### Dense — every document is one fat vector

Embedding-based retrieval (see [24-embeddings-geometric](./24-embeddings-geometric.md)) produces a 1536-float vector per document. Similarity is cosine. The vector encodes "what this text means" in a learned compressed form. If you're coming from frontend, the analogue is HSL colour distance — two colours that look similar are close in HSL space; two phrases that *mean* similar things are close in embedding space.

### Sparse — every document is a long thin vector of word counts

BM25 (Best Matching 25, refined from TF-IDF) produces a vector with one dimension per *word in the vocabulary* — but almost every dimension is zero. A 1500-word entry has maybe 200 unique words; its sparse vector has 200 non-zero positions out of (potentially) hundreds of thousands. Similarity is computed only on the non-zero positions: how many query words appear in this doc, weighted by how rare those words are globally and how long the doc is.

If you're coming from frontend, sparse retrieval is the same shape as `Array.prototype.filter()` combined with relevance ranking — you're literally counting word overlap, just smartly weighted.

### What they each handle well

```
Query: "What did I write about Spice House?"
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
  Dense (embed cosine)     Sparse (BM25)
  - "Spice House" maps     - "Spice" and "House" both
    near "Indian          rare in corpus → high weight
    restaurant"           - Direct hit on entries
  - Returns entries         containing the literal phrase
    about generic Indian   - Returns the two entries
    food first              with exact mentions
```

The dense vector lost the specificity ("Spice House" → "Indian restaurant" cluster). The sparse vector kept it.

### What they each fail at

```
Query: "How was the meal at that new place?"
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
  Dense (embed cosine)     Sparse (BM25)
  - "meal" close to        - "meal," "new," "place"
    "dinner," "lunch,"       all common words →
    "food"                   low weight
  - Returns relevant       - Returns very few entries
    food entries even        because no rare word
    without word overlap     to anchor on
```

Now dense wins. The user's query shares no rare words with the relevant entries, but their meaning is the same.

### Where the difference comes from architecturally

The practical consequence: dense retrieval is great at *paraphrase* and bad at *out-of-vocabulary identifiers* (proper nouns, product names, code identifiers, error codes). Sparse retrieval is the opposite. Most real corpora have both kinds of queries.

For loopd specifically: a daily-journal corpus has lots of proper nouns (place names, people, project names, `#tags`) that sparse handles well, and lots of natural-language description (mood, feelings, themes) that dense handles well.

### This is what people mean by "no free lunch in retrieval"

You don't get to skip either. The strongest production systems run both and merge the results — that's hybrid retrieval, covered in [28-hybrid-retrieval-rrf](./28-hybrid-retrieval-rrf.md). Here's the picture of the two approaches side-by-side.

---

## Dense vs sparse — diagram

```
Two representations of the same entry

Entry: "Had dinner at Spice House. The vindaloo was excellent."

DENSE (embedding)
  ┌─────────────────────────────────────────────────────┐
  │ [0.013, -0.42, 0.18, 0.81, ..., 0.07]               │
  │   ← 1536 floats, all non-zero ─────────────────►    │
  │   Encodes: meaning compressed into geometry         │
  └─────────────────────────────────────────────────────┘

SPARSE (BM25)
  ┌─────────────────────────────────────────────────────┐
  │ {                                                   │
  │   "dinner":     0.34,                               │
  │   "spice":      1.82,    ← rare word, high weight   │
  │   "house":      0.51,                               │
  │   "vindaloo":   2.41,    ← rare word, high weight   │
  │   "excellent":  0.27,                               │
  │   (every other word in the vocabulary: 0)           │
  │ }                                                   │
  │ ← long thin vector, mostly zeros ───────────────►   │
  │   Encodes: which rare words appear here             │
  └─────────────────────────────────────────────────────┘

Query handling

  Query: "Spice House review"   ┐
                                ├──► Dense: rank by cosine
  Query embedding: [0.04, ...]  ┘    (semantic match)

  Query: "Spice House review"   ┐
                                ├──► Sparse: rank by sum of
  Query terms: {spice, house,   ┘    weighted term overlap
              review}                (literal match)
```

---

## In this codebase

**Status:** Case B — neither dense nor sparse retrieval is implemented today.

The closest existing pattern is SQL `LIKE '%substring%'` filtering, which is the most degenerate form of sparse search (no weighting, no ranking, just match/no-match). loopd doesn't currently use it for full-text search either; retrieval is hand-picked by date or `#tag`. Phase 2A's `[B2A.10]` adds BM25 alongside cosine and measures whether the combination outperforms either alone.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, sparse logic lives in `src/services/ai/bm25.ts` or via `sqlite-fts5`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
TF-IDF dates to the 1970s; BM25 (Robertson et al., 1995) refined it with document-length normalisation and term-frequency saturation. Dense retrieval became practical in 2019-2020 with sentence-transformers. The "hybrid is better than either" finding is established empirically across many benchmarks and is the basis of every modern enterprise search system.

### The deeper principle
The two approaches compress different aspects of text — dense compresses meaning, sparse compresses surface tokens. Different query types stress different aspects. Production retrieval is plural: don't pick one when you can use both.

### Where this breaks down
For very small corpora (< 100 docs), the distinction matters less because exhaustive matching is fast and most queries return useful results from any reasonable scoring. For multilingual corpora, sparse breaks first (BM25 doesn't translate; "Spice House" is unrecognised in Korean text); dense holds up better with multilingual embedding models.

### What to explore next
- [28-hybrid-retrieval-rrf](./28-hybrid-retrieval-rrf.md) → how to combine dense and sparse scores
- [29-reranking-cross-encoder](./29-reranking-cross-encoder.md) → the final-rerank step that often makes hybrid unnecessary
- [30-vector-databases](./30-vector-databases.md) → many vector DBs ship hybrid built in (Vespa, pgvector + pg_trgm, Pinecone hybrid)

---

## Tradeoffs

### Comparison table — dense vs sparse vs hybrid for loopd

```
┌─────────────────────────┬─────────────────┬─────────────────┬───────────────────┐
│ Cost dimension          │ Dense only      │ Sparse only     │ Hybrid (target)   │
├─────────────────────────┼─────────────────┼─────────────────┼───────────────────┤
│ Proper-noun precision   │ Low             │ High            │ High              │
│ Paraphrase recall       │ High            │ Low             │ High              │
│ Setup complexity        │ Embedding model │ Inverted index  │ Both + RRF        │
│ Per-query latency       │ ~50–200ms       │ ~10–30ms        │ ~80–250ms         │
│ Per-query cost          │ ~$0.000002      │ $0              │ ~$0.000002        │
│ Storage / 365 entries   │ ~2 MB           │ ~500 KB         │ ~2.5 MB           │
│ Implementation effort   │ ~200–400 LOC    │ ~50 LOC + fts5  │ ~300–500 LOC      │
│ Cross-language          │ Partial         │ Zero            │ Limited by sparse │
└─────────────────────────┴─────────────────┴─────────────────┴───────────────────┘
```

### Sub-block 1 — what dense-only gives up

Out-of-vocabulary identifier precision. Every proper noun in a loopd entry — restaurant names, friend names, project names, place names — is a query the user might issue verbatim, and dense ranks paraphrases higher than literal matches. For a personal journal with lots of named entities, this is a real precision loss.

### Sub-block 2 — what sparse-only would have cost

Paraphrase recall. A user who searches "felt overwhelmed today" can't surface entries that wrote "couldn't keep up" or "drowning in stuff" because the query and the entries share no rare words. The user expects a journaling app to handle that. Sparse alone makes it impossible.

### Sub-block 3 — the breakpoint
Dense-only is the right call if (a) the corpus has few proper nouns or (b) users rarely search by them. Sparse-only is the right call for small corpora where keyword matching is sufficient and engineering cost matters. Hybrid is the right call when the corpus has both kinds of content and the cost of running two indexes is acceptable (typically yes at any scale past trivial).

### What wasn't actually a tradeoff
Skipping retrieval entirely was never an option for Phase 2A. The corpus is too big to scan exhaustively and the queries are too unbounded to hand-pick.

---

## Tech reference (industry pairing)

### BM25 (via `sqlite-fts5`)

- **Codebase uses:** target plan for `[B2A.10]`.
- **Why it's here:** the standard sparse retrieval algorithm; `sqlite-fts5` ships in `expo-sqlite` and provides BM25 ranking out of the box via virtual tables.
- **Leading today:** BM25 — `adoption-leading` for sparse retrieval, 2026 (well past 2026 in fact — it's been the standard since the early 2000s).
- **Why it leads:** robust to document length variance, well-tuned defaults, drop-in via fts5 with no extra dependencies.
- **Runner-up:** SPLADE — `innovation-leading` learned sparse retrieval (a neural model that produces sparse weights). Better quality, but requires hosting an inference model — more infra than loopd's local-first stance accommodates.

### Cosine similarity (vector dot product on normalised vectors)

- **Codebase uses:** target plan as the dense scorer.
- **Why it's here:** the dense counterpart, already covered in [24-embeddings-geometric](./24-embeddings-geometric.md).
- **Leading today:** cosine — `adoption-leading` for dense retrieval, 2026.
- **Why it leads:** magnitude-invariant; the de facto distance function for normalised embedding vectors.
- **Runner-up:** dot product directly — `innovation-leading` for performance (skip the normalisation step) if your embeddings are already normalised at storage time.

---

## Project exercises

### [B2A.10] Add BM25 alongside cosine; combine with RRF; measure hit@k

- **Exercise ID:** `[B2A.10]`
- **What to build:** A BM25 sparse index built via `sqlite-fts5` virtual table over `entries.text`. A retrieval function that runs both BM25 and cosine, merges the rankings via Reciprocal Rank Fusion (see [28-hybrid-retrieval-rrf](./28-hybrid-retrieval-rrf.md)), and returns top-k. Eval the hybrid against cosine-only on `[B2A.9]`'s eval set. Document the lift (or lack thereof) in `loopd/.aipe/specs/features/rag-personal-corpus.md`.
- **Why it earns its place:** Phase 2A's biggest single retrieval-quality lever is hybrid retrieval. If the hybrid lift on real data is meaningful (~5%+ hit@5 over dense-only), it's worth the storage cost. If it isn't, dense-only ships and BM25 stays a learn-only concept.
- **Files to touch:** new fts5 virtual table migration in `src/services/database.ts`; new `src/services/ai/bm25.ts` + `hybridRetrieve.ts`; eval results in `scripts/eval-results/hybrid-vs-dense-<date>.md`.
- **Done when:** the fts5 table is populated; the hybrid retrieval function returns top-k; eval results compare hybrid vs dense-only on the 20-30 query/expected pairs with measured numbers.
- **Estimated effort:** `1–2 days`.

---

## Summary

Dense (embedding-based) and sparse (BM25-based) retrieval are two different compressions of text that handle different query types — dense wins on paraphrase, sparse wins on proper nouns and rare identifiers. In loopd neither is implemented today; `[B2A.10]` plans hybrid retrieval (both, combined via RRF) for Phase 2A. The constraint that makes hybrid the right target is loopd's corpus mix: a personal journal contains both lots of named entities (restaurant names, project names, `#tag` slugs) that sparse handles well AND lots of mood/theme prose that dense handles well. The cost being paid is running two indexes instead of one — ~500 KB of additional storage for the BM25 inverted index and ~50 LOC of orchestration.

Key points to remember:
- Dense = vector cosine = meaning. Good at paraphrase, bad at exact identifiers.
- Sparse = BM25 = weighted word overlap. Good at proper nouns and rare terms, bad at synonyms.
- Production retrieval is hybrid: run both, combine.
- For loopd, the corpus mix justifies hybrid — both surface types matter.
- Eval-driven: ship hybrid only if `[B2A.9]` shows meaningful lift over dense-only.

---

## Interview defense

### What an interviewer is really asking
"Do you do hybrid retrieval?" tests whether the candidate has internalised that dense alone is incomplete. The follow-up — "how do you combine the scores?" — tests whether they know about RRF or are reinventing weight-tuning.

### Likely questions

  [mid] Q: What's the difference between dense and sparse retrieval?
  A: Dense retrieval embeds documents and queries as fixed-dimensional vectors (typically 1536 floats) and ranks by cosine similarity — it captures meaning, so "felt stuck" can retrieve an entry that wrote "hit a wall." Sparse retrieval (BM25) represents each document as a sparse vector with one dimension per word, weighted by rarity and document length — it captures exact word overlap, so a query containing a rare proper noun like "Spice House" can pull entries that contain that literal phrase. They fail on each other's strengths; production systems usually run both.
  Diagram:
  ```
  Query: "Spice House review"
            │
       ┌────┴─────┐
       ▼          ▼
    Dense       Sparse
    (cosine)    (BM25)
    "Indian     "Spice House"
    food        literal
    cluster"    matches
  ```

  [senior] Q: Why not just use dense retrieval everywhere?
  A: Two reasons. First, embeddings map proper nouns into their semantic cluster, which loses identifier precision — "Spice House" gets ranked near "Indian restaurant," so a user who knows the exact name they want will see synonyms first. Second, embeddings are biased by training data: rare-in-training identifiers get poorly-localised vectors (Korean place names, internal project codenames). BM25 has the opposite biases — it ignores meaning but nails identifiers. For a journaling corpus with lots of proper nouns (restaurants, friends, projects, `#tags`), dense-only sacrifices the use case that matters most.
  Diagram:
  ```
  Picked: hybrid (dense + sparse)        Suggested: dense only
  ──────────────────────────────        ───────────────────────
  Both indexes, ~2.5 MB                  One index, ~2 MB
  Handles "Spice House" exactly          Returns "Indian food" cluster
  Handles "felt stuck" semantically      Handles "felt stuck" semantically
  ~300 LOC + RRF                         ~200 LOC
  ```

  [arch] Q: How would you scale hybrid retrieval to 10× the corpus?
  A: Two architectural shifts. First, BM25 via `sqlite-fts5` stays fine at 10× — fts5 is built for much larger corpora. Second, dense cosine in JavaScript starts being user-visible (~50-100ms on 3650 vectors) and needs to move to an ANN index (`sqlite-vec` HNSW or pgvector with HNSW). The RRF combination layer is unchanged regardless — it operates on small top-k result lists, not the full index. So the architectural change is in the dense side, not in the hybrid orchestration.
  Diagram:
  ```
  ┌─ Service layer ──────────────────────┐
  │ hybridRetrieve()                     │  ← unchanged at 10×
  │   ├─ bm25_search() (fts5)            │  ← unchanged
  │   └─ cosine_search()                 │  ← breaks first at 10×
  │       JS → sqlite-vec HNSW           │
  │   └─ rrf_merge(top_k_dense, top_k)   │  ← unchanged
  └──────────────────────────────────────┘
  ```

### The question candidates always dodge
"What if hybrid doesn't help on your data?" Most candidates assume it does. The honest answer: on small homogeneous corpora (all the same shape, like a single user's journal), the lift may be small or zero. The discipline is to evaluate, not assume. Phase 2A's plan is explicitly to ship hybrid *only if* `[B2A.9]`'s eval shows meaningful lift over dense-only. If not, BM25 stays a learn-only concept and dense-only ships.

```
Picked: eval-driven decision        Suggested: hybrid by default
──────────────────────────────       ──────────────────────────────
Ship hybrid IF eval shows lift       Ship hybrid because "industry does"
~300 LOC if needed                   ~300 LOC always
Right at "we have eval signal"       Right at "we don't have eval signal"
```

### One-line anchors
- Two compressions of text; two failure modes; usually run both.
- Dense ≈ meaning. Sparse ≈ identifiers.
- BM25 is older, simpler, still load-bearing.
- Hybrid is "run both, combine ranks via RRF."
- Eval before assuming hybrid helps on your data.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and draw the dense-vs-sparse vector representation side-by-side for a single entry. Show what's in each: dense is fat-and-fully-populated, sparse is long-and-mostly-zero.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) when dense wins (paraphrase), (b) when sparse wins (proper nouns), (c) why production systems run both, (d) the deciding eval for loopd.

### Level 3 — Apply it to a new scenario
A loopd user searches for "the meeting where Sarah pushed back on the architecture decision." Without looking, predict whether dense, sparse, or hybrid handles this best and why. Where does each one's weakness show up?

Open the comparison table and check your answer against the proper-noun precision row.

### Level 4 — Defend the decision you'd change
Today the plan is hybrid via RRF. If you were starting today, would you skip BM25 and go straight to dense + a reranker (`[B2A.11]`)? Defend your answer naming one specific failure mode each choice creates.

### Quick check — code reference test
- What table/index would hold the sparse representation?
- What function would do hybrid combination?

Answer: `sqlite-fts5` virtual table over `entries.text` (target — `[B2A.10]`). `hybridRetrieve()` in `src/services/ai/` (target, not yet created).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (two-librarians-at-reference-desk scenario, name the which-librarian-on-the-desk question, planned FTS5 + entry_embeddings + hybridRetrieve stakes, before/after, single-line metaphor).
