# Embeddings (geometric intuition)

**Industry name(s):** Embeddings, dense vector representations, latent representations, semantic vectors
**Type:** Industry standard · Language-agnostic

> Why "semantically similar" can be expressed as "geometrically close" — the abstraction that makes RAG, search, and recommendation possible.

**See also:** → [25-embedding-models](./25-embedding-models.md) · → [07-rag](./07-rag.md) · → [27-dense-vs-sparse](./27-dense-vs-sparse.md)

---

## Why care

A librarian is asked to arrange ten thousand index cards on a very large flat table so that cards about similar topics end up close to each other and cards about different topics end up far apart. There's no alphabetical scheme, no Dewey Decimal — the librarian just looks at each card's content and slides it to a spot. Cards about "morning runs" cluster in one corner; "cooking" cards in another; "cooking after a run" cards land on the line between them. Anyone walking up to the table with a question card can drop it down and the answer is whichever existing card is physically nearest.

The implicit question is how to make "similar in meaning" mean "near in space." Not a keyword index, not a thesaurus — coordinates assigned by a learned function, so distance becomes the similarity metric.

**What depends on getting this right:** every retrieval feature loopd hasn't built yet but the Phase 2A roadmap schedules. Today the codebase has no `embed.ts`, no `entry_embeddings` table, no vector store — interpret reads the day's entries by date, and expand reads ~3 days plus 5 sibling todos via hand-picked `buildContext` (in `expand.ts`). When the corpus grows past what fits in a single prompt — when interpret wants "all your prior reflect entries that touch this theme" rather than "today's entries" — those features need a coordinate per entry. The planned shape: an `embed(text) → number[1536]` call writing to `entry_embeddings(entry_id, vec)` rows, with `nearestNeighbours(queryVec, k=10)` replacing today's date-filter. Without the geometric intuition, the team picks a model on price alone and ships a system whose worldview doesn't match the user's prose ("running marathons" and "running my mouth" land in the same cluster).

Without geometric embeddings:
- Retrieval is keyword + date. "Reflect entries about money" misses entries that say "rent" but not "money."
- `expand.ts:buildContext` keeps growing the context window manually; runs out at the model's ceiling
- Cross-entry features (recall, theme detection) stay impossible

With geometric embeddings (planned):
- `embed(entry.text) → vec`; stored in `entry_embeddings` once at write time
- Retrieval is `cosine(queryVec, allVecs)` → top-k; surface-different prose with similar meaning matches
- Negation, magnitude, cross-language stay weak spots (the geometry has limits)

Meaning becomes coordinates, and similarity becomes distance.

---

## How it works

Picture a room. Every English sentence ever spoken gets a tiny dot somewhere in that room. Sentences about *running* cluster in one corner; sentences about *cooking* in another; sentences about *cooking while running* somewhere on the line between them. The room has 1536 dimensions instead of 3, but the intuition is the same — meaning becomes position.

### The vector is a learned compression of the input

If you're coming from frontend, you're used to thinking of a string as a sequence of UTF-16 code units. An embedding throws all of that away and replaces it with 1536 floats between roughly -1 and +1. The floats don't have names — there's no "dimension 47 = sportiness". The dimensions are *learned axes* that minimise reconstruction error during training; what each one represents is emergent and mostly uninterpretable.

The practical consequence: two strings that are surface-different but mean similar things (`"went for a jog"` and `"did a 5k run"`) get nearby vectors. Two strings that share words but mean different things (`"I love running my mouth"` vs `"I love running marathons"`) get distant vectors. The model learned that "running my mouth" is an idiom and "running marathons" is exercise — and that lives in the geometry.

### Distance is the meaning of "similarity"

Once everything is a vector, similarity becomes a math problem. Three common distance functions:

- **Cosine similarity** — angle between vectors, ignores magnitude. Most common for text. Range: -1 (opposite) to +1 (identical).
- **Euclidean distance** — straight-line distance. Sensitive to magnitude; usually normalised away.
- **Dot product** — sum of element-wise multiplications. Cheapest to compute; magnitude-sensitive.

In React you'd handle "find similar items" with `array.filter(item => keywordMatch(item, query))`. With embeddings, you handle it with `nearestNeighbours(queryVector, allVectors, k=10)` — and the result includes items that don't share a single word with the query.

### The vector has the same dimension every time, for every input

A 5-word query and a 5000-character document both produce a 1536-float vector. The model has learned a fixed-dimensional projection: whatever you give it, you get the same shape back. This is what makes batch operations possible — you can compare two vectors of any-original-length pair using one cosine-similarity call.

### Where the geometry breaks down

The geometry holds best for "topic similarity." It holds less well for:

- **Negation** — "I love coffee" and "I don't love coffee" can end up close because their topic vectors are similar.
- **Numerical reasoning** — "weighs 5kg" and "weighs 50kg" can embed near each other; embeddings don't reason about magnitude.
- **Cross-language** — different languages occupy different regions of space unless the model was specifically trained multilingually.

### This is what people mean by "vector space is the model's worldview"

The embedding model has learned a worldview through gradient descent on millions of text pairs. That worldview is fixed at training time and is what every downstream system inherits when it uses the embeddings. Choosing an embedding model means choosing whose worldview your similarity searches will reflect. Here's the picture.

---

## Embeddings — diagram

```
The vector space of meaning (compressed to 2D for visualisation)

   journaling axis →
   ▲
   │   "wrote in my diary"        "reflected on my day"
   │       •                              •
   │
   │             "ran 5k"
   │                •         "logged today's miles"
   │                              •
   │
   │   "made dinner"     "cooked pasta"
   │       •                  •
   │
   └─────────────────────────────────► fitness axis
   
                  Each • is a 1536-float vector.
                  Distance ≈ semantic dissimilarity.
                  Real space has 1536 dimensions; here it's flattened to 2.
```

```
The pipeline

  query: "what did I journal yesterday?"
       │
       ▼  embedding model (one network call)
  query_vector: [0.013, -0.42, 0.18, ..., 0.07]   ← 1536 floats
       │
       ▼  cosine similarity against every entry_embedding
  top-k similar entry IDs: [#347, #289, #401, ...]
       │
       ▼  fetch from SQLite
  rendered list of nearby entries
```

---

## In this codebase

**Status:** Case B — concept not yet implemented.

loopd does no embedding today. Every retrieval is hand-picked SQL: `getRecentAISummaries(date, 5)` for captions, `expand.ts:buildContext()` for sibling todos. The corpus is small (~365 entries/year for a daily journal) and bounded by recency, so hand-picked has been sufficient. Phase 2A's principle update (`[B1.4]`) reframes this as "RAG above threshold" — features at week/month scope will need embeddings; features at day scope will not.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, the embedder lives at `src/services/ai/embed.ts`; vector storage at `src/services/sync/tables/entryEmbeddings.ts`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Dense vector representations of words date to word2vec (Mikolov et al., 2013) and GloVe (2014). Sentence-level embeddings became practical with `sentence-transformers` (Reimers & Gurevych, 2019). The current production wave (text-embedding-3-small, Cohere embed, OpenAI ada → text-embedding-3) is dominated by transformer-based models trained on contrastive objectives.

### The deeper principle
Embeddings turn "search for meaning" into "search in geometry." Any task that can be framed as "find nearby points in a learned space" — recommendation, clustering, deduplication, RAG retrieval — becomes one library call once you have a good embedding model.

### Where this breaks down
Embeddings encode *what the model learned* — biases, training-data distribution, and missing concepts all live in the geometry. A model trained mostly on English will under-cluster Korean. A model trained pre-2023 won't represent COVID-era concepts well. The space isn't neutral; it's a snapshot of training data.

### What to explore next
- [25-embedding-models](./25-embedding-models.md) → which embedding model to pick for loopd
- [30-vector-databases](./30-vector-databases.md) → where to store these vectors at scale
- [27-dense-vs-sparse](./27-dense-vs-sparse.md) → the BM25 counterpart that handles keyword cases embeddings miss

---

## Tradeoffs

### Comparison table — embedding-based retrieval vs hand-picked SQL

```
┌───────────────────────┬──────────────────────────┬──────────────────────────┐
│ Cost dimension        │ Embeddings (Phase 2A)    │ Hand-picked SQL (now)    │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Recall (semantic)     │ High                     │ Low (keyword-only)       │
│ Setup complexity      │ ~200–400 LOC + new table │ 0 (already done)         │
│ Per-query latency     │ ~50–200ms (cosine search)│ ~5–10ms (indexed SQL)    │
│ Per-query cost        │ ~$0.00002 (embed query)  │ $0                       │
│ Storage (~365 entries)│ ~2 MB (1536 floats × 4B) │ 0                        │
│ Maintenance burden    │ Stale-embedding tracking │ None                     │
│ Debugability          │ Vector distances opaque  │ SQL `WHERE` is readable  │
│ Cross-language        │ Partial (model-dependent)│ Zero                     │
└───────────────────────┴──────────────────────────┴──────────────────────────┘
```

### Sub-block 1 — what embeddings would give up

A new pipeline: embedding call on every commit, a vector column or table, a similarity-search function, a stale-embedding tracker. ~200–400 LOC across `src/services/ai/embed.ts`, `entry_embeddings` schema, `src/services/sync/tables/entryEmbeddings.ts`, and the read paths in features that consume them. Storage is small at loopd's scale but non-zero: 1536 floats × 4 bytes × 365 entries ≈ 2 MB local + same cloud-side. Plus a recurring cost: every entry text edit means a re-embed.

### Sub-block 2 — what hand-picked-only would have cost

Continued blindness on any query that needs *semantic* recall instead of *recency* recall. Today the user can't ask "find anything I wrote about anxiety last quarter"; the only retrieval primitives are "today," "this date," and "this `#tag`." Adding semantic search via keyword grep would help marginally but fail on the exact case where embeddings shine — surfacing entries that don't share keywords but share *meaning*.

### Sub-block 3 — the breakpoint
Embeddings become non-optional when (a) a feature requires retrieval over an unbounded scope (week or month, as `[B2A.7]` demands), or (b) a feature requires semantic similarity rather than `#tag` co-occurrence (as `[B2A.8]` related-entries demands). Both are in the Phase 2A roadmap.

### What wasn't actually a tradeoff
Training a custom embedding model was never a real option for solo loopd. Off-the-shelf models (text-embedding-3, Cohere, BGE) are good enough and orders of magnitude cheaper.

---

## Tech reference (industry pairing)

### OpenAI text-embedding-3-small

- **Codebase uses:** target choice for `[B2A.3]` (pending the decision in that exercise).
- **Why it's here:** the cheapest credible general-purpose embedding model from a major provider; 1536 dimensions, ~$0.02 per million tokens.
- **Leading today:** `text-embedding-3-small` — `adoption-leading` for application-side embeddings, 2026.
- **Why it leads:** fast, cheap, well-documented, dimensions are configurable (you can request 256 or 1024 instead of 1536). The defacto first choice when you're not training your own.
- **Runner-up:** Cohere `embed-english-v3.0` — `innovation-leading` for retrieval quality; better hit@k on some benchmarks; costs more per query.

### Sentence-transformers (local)

- **Codebase uses:** not used; relevant if loopd needed offline embedding.
- **Why it's here:** the open-source family that runs locally (no API call); `all-MiniLM-L6-v2` is the canonical small choice.
- **Leading today:** `sentence-transformers` — `adoption-leading` for self-hosted embedding, 2026.
- **Why it leads:** runs on CPU at ~100 docs/sec for the small variants; no API key needed; works in air-gapped settings.
- **Runner-up:** BGE-small — `innovation-leading` for open-source quality; outperforms MiniLM on many benchmarks at similar size.

---

## Project exercises

### [B2A.1] Pick storage: sqlite-vec extension vs JSON TEXT + JS cosine

- **Exercise ID:** `[B2A.1]`
- **What to build:** A 1-page decision spec in `loopd/.aipe/specs/features/rag-personal-corpus.md` comparing two options for storing 1536-dim vectors in `loopd.db`: (a) the `sqlite-vec` extension (vector type, builtin distance ops, ANN index) vs (b) storing each vector as a JSON TEXT column and doing cosine search in JavaScript. Pick one. Document why.
- **Why it earns its place:** Phase 2A's storage choice cascades into every other build item. Picking this wrong means rebuilding the embedding pipeline later. Picking it well means everything downstream is straightforward.
- **Files to touch:** new `loopd/.aipe/specs/features/rag-personal-corpus.md` (decision section), eventually a new migration adding the `entry_embeddings` table.
- **Done when:** the decision spec exists, names the tradeoff, picks an option, and a tiny proof-of-concept inserts and reads back one vector successfully.
- **Estimated effort:** `1–4hr`.

### [B2A.3] Pick the embedding model

- **Exercise ID:** `[B2A.3]`
- **What to build:** A short eval comparing `text-embedding-3-small` (1536-dim and 512-dim variants) vs Cohere `embed-english-v3.0` on a small loopd-relevant test set: 10 queries × 30 entries each, scored on hit@5. Document the result, pick the winner, document why.
- **Why it earns its place:** the model choice locks in the geometry. Switching later is a full re-embed of every entry. Picking well now saves that pain.
- **Files to touch:** new `scripts/eval-embedding-models.mjs`; uses real `entries.text` from a dev DB.
- **Done when:** the eval script outputs hit@5 per model; the chosen model is named in `rag-personal-corpus.md` with a one-sentence rationale.
- **Estimated effort:** `1–4hr`.

---

## Summary

Embeddings are dense, fixed-dimensional vectors that encode the meaning of a piece of text as a point in a high-dimensional space — and turn "semantically similar" into the math problem "geometrically close." In loopd this is not yet implemented; every retrieval is hand-picked SQL because the bounded-scope chains (caption, expand) need only recency, not semantic recall. The constraint that will make embeddings the right call is Phase 2A's unbounded-scope features (`[B2A.7]` interpret-this-week, `[B2A.8]` related-entries on threads) where keyword-only retrieval would miss the entries that matter. The cost being paid in trade is ~200–400 LOC, a new local table, an embedding-model cost per commit, and a stale-embedding maintenance loop.

Key points to remember:
- A vector is a 1536-float (or similar) compression of meaning; same shape regardless of input length.
- Cosine similarity = angle between vectors; that's how "similar" gets quantified.
- The embedding model's training data IS the geometry — biases, missing concepts, language coverage all live there.
- Embeddings shine for semantic recall; they're weak on negation, numerical reasoning, and cross-language.
- For loopd, hand-picked SQL is fine for bounded scope; embeddings are required for unbounded scope.

---

## Interview defense

### What an interviewer is really asking
"Explain embeddings" tests whether the candidate has the geometric intuition (vectors, distance, learned axes) and the practical follow-through (which model, which storage, when not to use). Candidates who answer purely in terms of "AI magic" fail; candidates who pull out a 2D vector-space sketch and walk through cosine similarity pass.

### Likely questions

  [mid] Q: What's actually inside an embedding vector?
  A: 1536 floats — give or take, depending on the model — between roughly -1 and +1, with no individually meaningful axes. The vector is a learned compression of the input's meaning. Two semantically similar texts get nearby vectors; two semantically different texts get distant vectors. Distance is usually measured by cosine similarity, which ignores vector magnitude and just looks at the angle between them.
  Diagram:
  ```
  text  ──► [0.13, -0.42, 0.18, ..., 0.07]   ← 1536 floats
                          │
                          ▼  cosine vs another vector
                       similarity score ∈ [-1, 1]
  ```

  [senior] Q: Why doesn't loopd use embeddings today, and when will it have to?
  A: Three reasons it doesn't today. First, the corpus is bounded by recency — captions read last 5 entries, expand reads last 3 days, classify reads no context. Hand-picked SQL covers all of it. Second, embeddings are a real maintenance burden: stale-embedding tracking, re-embed on edit, a new storage layer. Third, the cost-benefit at solo scale is unclear. It *will* have to ship when Phase 2A lands `[B2A.7]` (interpret at week scope — can't hand-pick a week's worth of relevant entries) and `[B2A.8]` (related entries on threads — needs semantic similarity, not keyword overlap). Both features are in the spec; neither is built yet.
  Diagram:
  ```
  Picked: hand-picked SQL          Suggested: embed everything
  ────────────────────             ────────────────────────
  0 LOC, $0/mo                      ~300 LOC, ~$0.50/mo
  Works for bounded scope           Works for any scope
  Recall ≈ keyword only             Recall ≈ semantic
  Until Phase 2A: right             After [B2A.7]: required
  ```

  [arch] Q: What changes at 10× corpus size?
  A: At ~3650 entries (10× loopd's current solo-user year), the math shifts in two ways. First, the storage is still small (~20 MB local for 1536-dim float vectors), so storage isn't the bottleneck. Second, the cosine-search cost in pure JavaScript becomes meaningful — ~3650 dot products per query at ~5ms total is fine; at 100k entries it's ~150ms which starts being user-visible. The architectural fix is moving from JS-side cosine to `sqlite-vec` with an HNSW index, where query time stays sub-10ms regardless of corpus size.
  Diagram:
  ```
  ┌─ UI layer ──────────────────────┐
  │ "find similar entries" feature  │
  └─────────────────────────────────┘
              │
  ┌─ Service layer ─────────────────┐
  │ JS cosine search (today's plan) │  ← breaks first at ~100k
  │ → swap to sqlite-vec HNSW       │
  └─────────────────────────────────┘
              │
  ┌─ Storage layer ─────────────────┐
  │ entry_embeddings table          │  ← schema unchanged
  └─────────────────────────────────┘
  ```

### The question candidates always dodge
"How do you handle the stale-embedding problem?" Most candidates don't acknowledge it exists. The honest answer: every time an entry's text changes, its embedding is stale and must be re-computed before the next retrieval. Otherwise queries will surface entries based on what they *used to say*. In loopd's plan, `[B2A.4]` adds a `embedding_stale_at` column and re-embeds on idle pass. Without that tracker, the entire retrieval pipeline silently drifts as users edit prose.

```
Picked: stale_at tracker         Suggested: re-embed on every edit
─────────────────────────         ─────────────────────────────
+ 1 col, idle re-embed pass       Burns embed quota on every edit
Drift = small, bounded            No drift, but cost scales with edits
Right for journaling app          Right for static reference corpus
```

### One-line anchors
- Same shape, every time, every input. That's the abstraction.
- Cosine = angle, not magnitude. Use cosine for text.
- The model's training data is the worldview your search inherits.
- Negation, numbers, and cross-language are where embeddings get fooled.
- Embeddings replace "search by keyword" with "search by meaning."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file. Draw the 2D vector-space scatter showing journaling, fitness, and cooking clusters. Mark where "logged today's miles" lands and explain why.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) what an embedding vector is, (b) what cosine similarity computes, (c) why loopd doesn't use embeddings today, (d) the two Phase 2A features that will require them.

### Level 3 — Apply it to a new scenario
A user wants to add a feature: "show me everything I wrote about feeling stuck." This phrase appears in zero entries verbatim, but ~12 entries express the concept differently ("hit a wall," "couldn't get started," etc.). Without looking at the file, explain why hand-picked SQL fails here and what shape the embedding-based solution takes.

Open `[B2A.7]` in the curriculum and check whether your answer matches its design.

### Level 4 — Defend the decision you'd change
Today loopd plans to embed at commit time and re-embed on idle. If you were starting Phase 2A today, would you embed asynchronously instead (fire-and-forget, like `scheduleClassify`)? Defend your answer naming one specific failure mode each choice creates.

### Quick check — code reference test
- What file would the embed call live in?
- What table holds the vectors?

Answer: `src/services/ai/embed.ts` (target, not yet created). `entry_embeddings` (target, not yet created — schema in `[B2A.2]`).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (librarian-arranging-cards-on-a-table scenario, name the meaning-as-coordinates question, planned embed.ts/entry_embeddings stakes, before/after, single-line metaphor).
