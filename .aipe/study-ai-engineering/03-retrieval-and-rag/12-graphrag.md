# GraphRAG

**Industry name(s):** GraphRAG, knowledge-graph retrieval, structured retrieval
**Type:** Industry standard

> Pre-extract entities and relationships into a graph; queries traverse the graph instead of (or alongside) embedding cosine. Wins when the relevant docs share structural relations but not vocabulary. Buffr's `#tag` threads are an explicit graph already — GraphRAG over them maps naturally.

**See also:** → [11-rag](./11-rag.md) · → [01-embeddings-geometrically](./01-embeddings-geometrically.md) · → [`ai-features-in-this-codebase`](../ai-features-in-this-codebase.md)

---

## Why care

### Move 1 — The grounded scenario

User asks: "what did I decide about auth in the design meetings about session management?" Vector RAG: embeds the query; retrieves chunks semantically close. May miss the design meeting if the relevant chunk doesn't mention "auth" verbatim — and the meeting was about sessions, with auth as a side topic. GraphRAG: walks the graph — auth relates_to session-management; session-management discussed_in design-meeting-#3; that meeting contains chunks. Traversal finds the right doc even with weak vocabulary overlap.

### Move 2 — Name the question the pattern answers

That structural-relationship question is what GraphRAG answers. Not "is GraphRAG better than vector RAG" (depends); just *when do relationships between entities matter more than text similarity, and how do I retrieve via graph traversal*.

### Move 3 — Why answering that question matters

**What breaks without graph-aware retrieval (when warranted):** queries about structurally-related docs that don't share vocabulary miss. For buffr's `#tag` threads — the user's `#auth` tag IS an explicit edge between todos, entries, and a thread node — vector retrieval treats the tag as a string; GraphRAG treats it as a relationship.

### Move 4 — Concrete before/after

Without GraphRAG (vector only):
- `#auth` thread → entries mentioning literal "auth" word
- Misses entries that talk about sessions but don't say "auth"

With GraphRAG (graph traversal):
- `#auth` thread node → linked entries via `thread_mentions` table
- Plus second-degree links via related threads
- Returns docs by relationship, not by vocabulary

### Move 5 — The one-line summary

GraphRAG retrieves via entity-and-relationship traversal; wins on docs that are structurally related but lexically dissimilar; buffr's `#tag` thread system is an explicit graph that maps naturally.

---

## How it works

### Move 1 — The mental model

```
   User asks: "What did I decide about auth in the design
              meetings about session management?"

   Plain RAG (vector cosine):
     embed query → top-k semantically similar chunks
     may miss the meeting if vocabulary doesn't overlap

   GraphRAG:
   ┌────────────────────────────────────────────────────┐
   │  Entities and relationships extracted upfront      │
   │                                                    │
   │  [auth] ──relates_to──→ [session management]      │
   │     │                                              │
   │     └──discussed_in──→ [design meeting #3]         │
   │                            │                       │
   │                            └──contains──→ [chunks] │
   └────────────────────────────────────────────────────┘

   Query traverses graph: find auth → walk to session-management →
   find meeting #3 → retrieve chunks.
```

### Move 2 — The layered walkthrough

**Layer 1 — buffr's existing graph.** Buffr's data model already contains an explicit graph: `threads` (nodes) + `thread_mentions` (edges to entries and todos). The graph is small (per user, dozens of threads) but real. GraphRAG over this graph is straightforward: from a thread node, walk edges to mentioned entries and todos.

```
   Buffr's existing thread graph
   ─────────────────────────────
   threads          → graph nodes
   thread_mentions  → graph edges (entry_id, todo_id, thread_id)
   entries          → leaf documents
   todos            → leaf documents

   Traversal: thread → mentions → entries/todos
```

**Layer 2 — when GraphRAG beats vector RAG.** When docs share explicit relationships but not vocabulary. Code repositories (function-calls graph), wikis (link graph), buffr's threads (tag graph). When docs share vocabulary but not relationships, vector RAG wins.

**Layer 3 — hybrid is the production shape.** Use the graph to narrow the candidate set; vector to rank within the candidates. For buffr: thread `related entries` could combine graph-walk (entries directly mentioned via `thread_mentions`) AND vector (entries semantically related to the thread's slug or recent prose), then fuse via RRF.

### Move 3 — The principle

Structural relationships are first-class signals; encode them in a graph; retrieve by traversal where the graph exists.

---

## GraphRAG — diagram

```
┌─ Buffr's thread-graph traversal (planned) ─────────────────────────────┐
│                                                                        │
│   user opens #auth thread                                              │
│         │                                                              │
│         ▼                                                              │
│   thread node: { id: auth, ... }                                       │
│         │                                                              │
│         ▼  walk thread_mentions edges                                  │
│   ┌──────────────────────────────────┐                                 │
│   │ first-degree: directly mentioned │                                 │
│   │   entries + todos with #auth     │                                 │
│   └──────────────┬───────────────────┘                                 │
│                  │  fuse with vector search                            │
│                  ▼                                                     │
│   ┌──────────────────────────────────┐                                 │
│   │ vector: semantically related     │                                 │
│   │   entries by embedding cosine    │                                 │
│   └──────────────┬───────────────────┘                                 │
│                  ▼                                                     │
│             RRF fusion → top-k related entries displayed                │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A (passive) — buffr has the graph but doesn't traverse it for retrieval yet.**

**Files:**
- `src/types/thread.ts` — Thread shape
- `supabase/migrations/0001_schema.sql` — `threads` and `thread_mentions` tables
- `src/services/threads/` — CRUD plus the staleness and touch logic

Phase 2A `B2A.8` ("related entries on thread detail") is the build that would exercise GraphRAG: combine `thread_mentions` (graph edges) with vector retrieval over `entry_embeddings`. The graph traversal part is already trivial (one JOIN); the vector part is the Case B work.

---

## Elaborate

### Where this pattern comes from

Microsoft Research's "GraphRAG" paper (2024) popularised the modern shape; the underlying idea (graph-based retrieval) is decades old in knowledge-graph systems.

### The deeper principle

When you have explicit structure, use it. Vector retrieval is what you reach for when you lack structure; if you have structure, prefer it.

### Where this breaks down

When the graph is sparse or under-maintained, traversal returns nothing. When the graph is dense but mostly noise, traversal returns too much. Both need vector retrieval to complement.

### What to explore next

- [11-rag](./11-rag.md) — the parent pattern
- [01-embeddings-geometrically](./01-embeddings-geometrically.md) — what fuses with graph traversal

---

## Tradeoffs

The breakpoint: GraphRAG when you already have a graph (buffr's threads) — it's cheap to add traversal on top. Pure GraphRAG (building the graph from scratch via entity extraction) is expensive and worth it only at scale.

---

## Tech reference

- **Buffr's graph:** `threads` + `thread_mentions` tables; existing.
- **Traversal:** SQL JOINs.

---

## Project exercises

### B2A.8 — Thread related entries (graph + vector hybrid)

- **What to build:** in the thread detail screen, display entries via two paths: direct mentions (`thread_mentions` JOIN) AND semantic matches (vector retrieval). Fuse via RRF.
- **Done when:** thread detail shows both kinds of related entries; quality compared on the same input.
- **Estimated effort:** included in Phase 2A work.

---

## Summary

- GraphRAG retrieves via entity/relationship traversal.
- Wins on structurally-related, lexically-dissimilar docs.
- Buffr already has the graph (`threads` + `thread_mentions`); hybrid with vector is the planned shape.

---

## Interview defense

**Q [mid]:** When does GraphRAG beat vector RAG?

**A:** When docs share explicit relationships but not vocabulary. Code-call graphs, wiki-link graphs, buffr's `#tag` threads. Vector retrieval treats relationships as string overlap; graph retrieval treats them as first-class edges. For buffr's thread system, the graph exists in the schema already; using it for retrieval is mostly a JOIN.

### One-line anchors

- Traverse the graph for retrieval.
- Wins on structural relationships, not vocabulary.
- Buffr's threads are an existing graph.
- Hybrid with vector is the production shape.

---

## Validate

### Quick check
- What's buffr's existing graph?
- What table holds the edges?
- When does GraphRAG complement vector RAG?
