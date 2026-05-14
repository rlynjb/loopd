# GraphRAG

**Industry name(s):** GraphRAG, knowledge-graph-augmented retrieval, structured retrieval
**Type:** Industry standard

> When your corpus already has structure, why throw it away — and use both the graph AND the vectors.

**See also:** → [24-embeddings-geometric](./24-embeddings-geometric.md) · → [28-hybrid-retrieval-rrf](./28-hybrid-retrieval-rrf.md) · → [07-rag](./07-rag.md)

---

## Why care

A reference librarian gets two kinds of questions every morning. The first kind comes with a starting point: "show me everything in the cardiology section published since 2020." She walks to a known shelf, reads down the spines, hands over the stack — no judgement calls. The second kind comes with a vibe: "I'm looking for something about the lonely side of long marriages." She walks the fiction floor, thumbs through opening pages, makes a similarity call. The tricky questions blend both: "lonely-side-of-marriage books, but in the Spanish-language section." She runs the structured filter first, then the similarity search inside it.

The implicit question is "should the lookup traverse explicit relationships, score by learned similarity, or both?" GraphRAG is the name for the third answer — combine graph traversal with vector retrieval so each stage handles the access pattern it's good at. Three composition shapes: pre-filter by graph then vector-rank, vector-search then expand via graph, or graph as a re-ranker on vector candidates. The architecture is "use both signals because both exist" — throwing away explicit edges to embed everything as text is leaving authoritative information on the table.

**What depends on getting this right:** retrieval precision on questions that mix structured and unstructured intent, and whether existing graphs in the codebase earn their keep. For loopd the planned `src/services/threads/getRelatedEntries.ts` for `[B2A.8]` filters via the existing `thread_mentions` table (graph: entries NOT yet linked to this thread) and ranks the candidates via planned `entry_embeddings` (cosine to the thread's prose). The graph half is already real, maintained by two-pass reconciliation; skip the filter and the "related entries" rail surfaces entries the user has already tagged — useless suggestions dressed as helpful ones.

Without GraphRAG:
- Thread detail page renders "related entries" by cosine alone → top-5 includes entries already tagged `#loopd`, plus near-duplicates
- User reads the rail, recognises every suggestion as something they already filed, dismisses the feature
- Vector-only treats `thread_mentions` as decoration; the ground-truth edge gets approximated, badly, by similarity

With GraphRAG:
- Graph stage: SQL JOIN excludes entries already in `thread_mentions` for this thread — ~300 candidates remain from 365
- Vector stage: embed the thread prose (slug + recent mentions), cosine vs candidate embeddings, top-5
- User sees 5 thematically-related but not-yet-tagged entries; tap to `insertThreadMention()`; graph grows; next query reflects the new edge
- Breaks the day `thread_mentions` reconciliation drifts — stale graph turns the filter into noise

Graphs say "this IS connected"; vectors say "this might be similar" — use both when both apply.

---

## How it works

The fundamental observation: structured data and unstructured data answer different question shapes. Graphs are great at "traverse from a known starting point" (find all entries in project X, find all friends of Alice). Vectors are great at "find the most similar thing" (find entries semantically like this query). Many real questions need both.

### loopd's existing graph

```
The graph that already exists in loopd

  threads ──────► thread_mentions ◄────── entries
  ─────                   │                ─────
  slug                    │                text
  title                   │                date
                          ▼                
                    (entry_id, thread_id)  
                    (or todo_id, thread_id)

  Examples:
    thread #loopd mentioned in entries 247, 289, 301
    thread #journal mentioned in entries 247, 312, 401
    entries 247, 289 both mention multiple threads
```

If you're coming from frontend, this is the same shape as React Context's component tree — you have a hierarchical/graphed structure that lets you ask "who consumes Context X?" cheaply, even without searching.

### Three GraphRAG patterns

1. **Pre-filter by graph, then vector-search the filtered set.** "Find entries about anxiety, scoped to the #loopd project." Step 1: graph traversal pulls entries linked to #loopd (~30 entries). Step 2: vector search on those 30. Cheap; precise on the filter; semantically smart on the result.

2. **Vector-search, then expand via graph.** "Find entries semantically like this, plus their thread-neighbours." Step 1: vector search returns top-5 entries. Step 2: graph walk finds threads those entries mention, plus other entries in those threads. The result is a *cluster*, not a list.

3. **Graph as a re-ranker.** Vector search returns 50 candidates; rerank by "how many threads in common with the query's threads?" Boosts the candidates that share structural context.

### The practical consequence — loopd's `[B2A.8]` is GraphRAG

`[B2A.8]` ships a "related entries" feature on the thread detail screen — surface entries semantically similar to a thread's prose, *but limited to entries not yet `#tag`-linked to that thread.* That's pattern 1 (graph as filter) plus pattern 2 (vector search to find candidates) combined. It's textbook GraphRAG, even though the file uses the more pedestrian word "related."

### Where graph helps, where vectors help

```
Question type                          Graph wins?   Vector wins?
─────────────────────────────────       ───────────   ────────────
"All entries in project X"              ✓             ✗
"All friends of Alice"                  ✓             ✗
"Entries semantically like this one"    ✗             ✓
"Entries about feeling stuck"           ✗             ✓
"Stuck entries in the loopd project"    Both          Both
"What have I been thinking lately?"     Both          Both
```

The bottom two question types are why GraphRAG exists.

### Where it breaks down

GraphRAG presumes the graph is well-maintained. In loopd specifically, two-pass matching builds the `thread_mentions` graph from prose mentions — and the staleness mechanic for that graph (`thread_mentions` reconciliation) has to keep up. If the graph drifts (a `#tag` was renamed; old mentions point to nothing), GraphRAG's graph-side filter starts returning empty results for valid queries.

### This is what people mean by "structure is information"

A graph of relationships you've already built is *free signal* that pure vector search throws away. Using it costs little (a SQL JOIN) and adds a category of precision that embeddings can't deliver. The principle generalises: any application with explicit structure should use it alongside, not instead of, learned representations. Here's the picture of how the two combine.

---

## GraphRAG — diagram

```
loopd's "related entries on thread" — pattern 1 + 2 combined

  User on thread detail page for #loopd
            │
            ▼  query: thread.prose (slug + recent mentions)
  ┌─ Graph stage (filter) ──────────────────────────────┐
  │  Find candidate set: entries NOT yet linked to      │
  │  this thread                                         │
  │                                                      │
  │  SELECT e.* FROM entries e                          │
  │   WHERE NOT EXISTS (                                │
  │     SELECT 1 FROM thread_mentions tm                │
  │     WHERE tm.entry_id = e.id                        │
  │       AND tm.thread_id = :thread.id                 │
  │   )                                                  │
  │   AND e.deleted_at IS NULL                          │
  └─────────────────────────────────────────────────────┘
            │
            ▼  candidates: ~300 entries (vs 365 total)
  ┌─ Vector stage (rank) ───────────────────────────────┐
  │  Embed thread prose; cosine vs candidate embeddings │
  │  Return top-5 by cosine                             │
  └─────────────────────────────────────────────────────┘
            │
            ▼  top 5 "candidate" entries
       User: "I want to tag this #loopd"
            │
            ▼  insertThreadMention(entry, thread)
       Graph grows; next query reflects the new edge
```

```
Architectural layer view

┌─ UI layer ──────────────────────────────────────────────┐
│  ThreadDetailScreen — "Related entries" rail            │
└─────────────────────────────────────────────────────────┘
            │
            ▼  getRelatedEntries(threadId)
┌─ Service layer ─────────────────────────────────────────┐
│  Graph filter (SQL) + Vector rank (sqlite-vec)          │
│  Return top-K candidate entries                         │
└─────────────────────────────────────────────────────────┘
            │
            ▼
┌─ Storage layer ─────────────────────────────────────────┐
│  thread_mentions (graph) ◄────► entry_embeddings (vec)  │
│  entries (text)                                         │
└─────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Status:** Case B — no GraphRAG today.

The graph half *exists*: `thread_mentions` is a real table maintained by two-pass scanning of prose. The vector half doesn't exist yet (Phase 2A's `[B2A.2]`). `[B2A.8]` combines them once both are in place.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, lives in `src/services/threads/getRelatedEntries.ts`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
GraphRAG as a named pattern emerged in 2023-2024 (Microsoft's "GraphRAG" paper and similar from LangChain/LlamaIndex) when production RAG systems hit the wall of vector-only retrieval. The underlying idea — combine structured retrieval with learned retrieval — is much older; it goes back to information-retrieval systems that used a curated taxonomy alongside lexical search.

### The deeper principle
Existing structure in your data is free signal. Throwing it away to embed everything as text is leaving information on the table. The principle generalises beyond retrieval: in classification, in recommendation, in any ML system, "what known relationships exist?" is a question worth asking before "what can the model learn?"

### Where this breaks down
GraphRAG depends on the graph being well-maintained. If the relationships are stale, ambiguous, or sparse, the graph half adds noise instead of signal. For loopd, the `thread_mentions` graph is well-maintained via two-pass reconciliation — but a new structural feature with weaker maintenance would not earn this kind of architectural use.

### What to explore next
- [28-hybrid-retrieval-rrf](./28-hybrid-retrieval-rrf.md) → another way to combine two retrieval signals
- loopd's two-pass `thread_mentions` reconciliation in `src/services/threads/` — the graph maintenance
- Microsoft GraphRAG paper — the canonical reference for the named pattern

---

## Tradeoffs

### Comparison table — vector-only vs GraphRAG for loopd's related-entries

```
┌─────────────────────────┬───────────────────┬────────────────────────┐
│ Cost dimension          │ Vector-only       │ GraphRAG (target)      │
├─────────────────────────┼───────────────────┼────────────────────────┤
│ Filter precision        │ None              │ Hard exclusions        │
│ Surfacing already-tagged│ Yes (noisy)       │ No (filtered out)      │
│ Per-query latency       │ ~50ms             │ ~50ms + small SQL      │
│ Implementation effort   │ Vector search only│ + Graph SQL join       │
│ Graph maintenance burden│ N/A               │ Existing (reuse)       │
│ Handles "find unrelated"│ No                │ Yes                    │
│ Recall on broad queries │ High              │ Same (graph is filter, │
│                         │                   │ not a hard floor)      │
└─────────────────────────┴───────────────────┴────────────────────────┘
```

### Sub-block 1 — what GraphRAG gives up

A SQL JOIN per query — negligible cost. Some additional complexity in the query function: now you compose two stages (graph filter, then vector rank) instead of one. The biggest cost is *cognitive*: future contributors have to know that retrieval combines structured and unstructured signals; one without the other gives wrong results.

### Sub-block 2 — what vector-only would have cost

Noise. For the related-entries feature, the user is on a thread detail page looking for entries NOT yet linked to the thread. Vector-only would surface the highest-similarity entries — including ones already `#tagged` to this thread, which the user would correctly recognise as useless suggestions. The graph filter is the difference between a useful feature and a noisy one.

### Sub-block 3 — the breakpoint
GraphRAG stops being the right call if the graph half becomes unreliable (mention reconciliation breaks, slugs collide, etc.) or if a feature genuinely doesn't need the graph (a plain "find entries about X" doesn't — that's pure vector retrieval).

### What wasn't actually a tradeoff
Throwing away the existing `thread_mentions` graph and storing everything as embeddings was never an option. The graph is already there, maintained, and authoritative.

---

## Tech reference (industry pairing)

### Custom SQL graph filter + sqlite-vec ranker

- **Codebase uses:** target plan — reuse existing `thread_mentions` join + new `entry_embeddings` cosine.
- **Why it's here:** both halves live in SQLite; one query can express both stages.
- **Leading today:** SQL-composed GraphRAG — `adoption-leading` for small-scale GraphRAG, 2026.
- **Why it leads:** zero new services; everything in one DB; transactional consistency between graph and vector reads.
- **Runner-up:** dedicated graph DB (Neo4j) + vector DB (Pinecone) — `innovation-leading` at very large scale; needed only when graph reasoning is the dominant workload.

### Microsoft GraphRAG (LLM-extracted entities)

- **Codebase uses:** not relevant; loopd's graph is already explicit.
- **Why it's here:** the canonical "build the graph automatically from prose using an LLM" pattern. Useful when the corpus has implicit structure that's worth surfacing.
- **Leading today:** Microsoft GraphRAG — `innovation-leading` for implicit-graph extraction, 2026.
- **Why it leads:** automates the most expensive part of GraphRAG (building the graph) for corpora that don't already have explicit relationships.
- **Runner-up:** explicit-graph systems (loopd's `#tag` system, Roam, Obsidian) — `adoption-leading` for tools where users create the graph themselves.

---

## Project exercises

### [B2A.8] Ship "related entries" on thread detail (Phase 2A)

- **Exercise ID:** `[B2A.8]`
- **What to build:** A new "related entries" rail on `app/threads/[id].tsx`. Service function `getRelatedEntries(threadId)` in `src/services/threads/getRelatedEntries.ts` that:
  1. Pulls thread metadata (slug, recent mentions).
  2. Filters entries NOT yet linked to this thread via a SQL JOIN against `thread_mentions`.
  3. Ranks remaining candidates by cosine similarity to the thread's prose (composed from slug + last 5 mentioned-entry texts).
  4. Returns top-5.

  Tap on a related entry → user can confirm "tag this entry to thread" → calls `insertThreadMention()` and the rail re-renders without that entry.
- **Why it earns its place:** loopd's first true GraphRAG feature. Surfaces the interview answer "I shipped a system that combines graph traversal with vector retrieval." Concrete, user-visible, and uses both Phase 2A's vector pipeline and the existing thread system.
- **Files to touch:** new `src/services/threads/getRelatedEntries.ts`; UI rail in `app/threads/[id].tsx`; depends on `[B2A.2]` `entry_embeddings`.
- **Done when:** the rail renders on device; tapping an entry shows the confirmation; the action propagates through soft-delete and sync; eval set shows the surfaced entries are thematically related (rubric judge or manual review on 20 cases).
- **Estimated effort:** `1–2 days`.

---

## Summary

GraphRAG is the family of patterns that combines graph traversal with vector retrieval — using explicit structure alongside semantic similarity. In loopd this is not yet implemented; `[B2A.8]` will be loopd's first GraphRAG feature, combining the existing `thread_mentions` graph (filter stage) with the planned `entry_embeddings` vectors (rank stage). The constraint that makes GraphRAG the right call is that the graph already exists, well-maintained by two-pass reconciliation, and using it costs only a SQL JOIN. The cost being paid is cognitive: future contributors have to remember that retrieval combines structured and unstructured signals.

Key points to remember:
- Graphs answer "traverse from a known starting point"; vectors answer "find similar."
- Many real queries need both.
- Three patterns: pre-filter by graph; expand via graph; graph as re-ranker.
- loopd's `#tag` system is already a graph — use it.
- The graph half must be well-maintained; stale graphs add noise instead of signal.

---

## Interview defense

### What an interviewer is really asking
"Tell me about GraphRAG" tests whether the candidate sees structure as signal vs noise. Candidates who treat all data as "stuff to embed" miss the point; candidates who can name three GraphRAG patterns separate themselves.

### Likely questions

  [mid] Q: What's GraphRAG?
  A: GraphRAG is the family of retrieval patterns that combines graph traversal with vector similarity. The graph holds explicit relationships (entities, edges, hierarchies); the vectors hold semantic meaning. Many real questions need both — "find anxiety entries scoped to the loopd project" is graph (project membership) plus vector (semantic similarity). The three patterns are: filter-by-graph-then-rank, vector-search-then-expand-via-graph, and graph-as-reranker.
  Diagram:
  ```
  question type                  graph?    vector?
  "all entries in project X"     ✓         ✗
  "entries about anxiety"        ✗         ✓
  "anxiety in project X"         both      both
  ```

  [senior] Q: Why is loopd a natural GraphRAG case?
  A: Because the graph already exists. `thread_mentions` is a real SQL table maintained by two-pass scanning of prose — every `#tag` mention creates an edge, and the graph is queryable. For the `[B2A.8]` related-entries feature on thread detail pages, GraphRAG composes naturally: filter entries to "not yet linked to this thread" (graph), then rank the remainder by cosine to the thread's prose (vector). Vector-only would surface entries already in the thread as top results — noise.
  Diagram:
  ```
  Picked: GraphRAG                 Suggested: vector-only
  ──────────────────                ───────────────────────
  SQL JOIN filter + cosine          Cosine over all entries
  Top-5 not-yet-tagged entries      Top-5 incl. already-tagged
  Useful suggestions                Noisy suggestions
  ```

  [arch] Q: When does GraphRAG break?
  A: When the graph half is unreliable. If `thread_mentions` reconciliation breaks (a `#tag` is renamed and old mentions point to nothing, or two threads with the same slug collide), the graph filter starts returning empty or wrong results. The mitigation in loopd is the slug-as-local-canonical rule plus the two-pass reconciliation that already runs on commit. The architectural rule: GraphRAG is only as good as the graph; invest in graph maintenance before adding more GraphRAG features.
  Diagram:
  ```
  ┌─ Service layer ─────────────────┐
  │ GraphRAG retrieval              │
  │  ├─ graph filter (SQL JOIN)     │  ← breaks if graph stale
  │  └─ vector ranker               │
  └─────────────────────────────────┘
            │
  ┌─ Storage layer ─────────────────┐
  │ thread_mentions (must be fresh) │
  │ entry_embeddings (must be fresh)│
  └─────────────────────────────────┘
  ```

### The question candidates always dodge
"Why use the graph at all when vectors can learn the relationships?" The honest answer: a learned representation of "entry A is tagged to thread B" is *strictly worse* than the explicit row in `thread_mentions`. Embeddings approximate; the row is ground truth. Using the embedding to infer the relationship loses information AND requires more compute. Use the graph because it's already there and authoritative.

```
Picked: use existing graph         Suggested: learn from text alone
──────────────────────────         ─────────────────────────────
Ground truth from explicit edges    Approximate from prose patterns
Free signal                         Costs embed call + cosine
Right when graph exists             Right when graph doesn't exist
```

### One-line anchors
- Graphs say "this IS connected"; vectors say "this might be similar."
- Use both when both apply.
- loopd's `#tag` system is a real graph — use it.
- The graph must be maintained; stale graphs add noise.
- GraphRAG is composing, not replacing.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and draw the related-entries flow: thread → graph filter → candidate set → vector rank → top-5. Annotate which layer (graph vs vector) does what.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the three GraphRAG patterns, (b) why loopd is a natural GraphRAG case (existing `thread_mentions`), (c) what breaks if the graph is stale, (d) the related-entries feature `[B2A.8]`.

### Level 3 — Apply it to a new scenario
A user asks "show me entries about anxiety related to my work project." Without looking, design the GraphRAG query: which stage uses graph, which uses vector, in what order.

Open the diagram and check whether your design composes the two stages correctly.

### Level 4 — Defend the decision you'd change
Today the plan for `[B2A.8]` is graph-filter-first, vector-rank-second. If you were starting today, would you do vector-rank-first then graph-filter (pattern 2)? Defend your answer naming one specific failure mode.

### Quick check — code reference test
- What existing table is loopd's graph?
- What new table is the vector half?

Answer: `thread_mentions` (already in production). `entry_embeddings` (target — `[B2A.2]`).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (reference-librarian-two-question-types scenario → "graph or vector or both" pattern naming → bolded "what depends on getting this right" with `getRelatedEntries.ts` / `thread_mentions` / `entry_embeddings` / `[B2A.8]` stakes → without/with bullets walking the thread-detail rail → one-line "graphs say IS connected, vectors say might be similar" metaphor).
