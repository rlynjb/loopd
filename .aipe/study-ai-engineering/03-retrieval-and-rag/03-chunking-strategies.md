# Chunking strategies

**Industry name(s):** Chunking, document segmentation, passage splitting
**Type:** Industry standard

> Chunks are the unit of retrieval. Too small → no context; too large → diluted relevance. Three strategies: fixed-size, sentence-window, structural. Pick by content shape.

**See also:** → [01-embeddings-geometrically](./01-embeddings-geometrically.md) · → [11-rag](./11-rag.md) · → [`02-context-and-prompts/01-context-window`](../02-context-and-prompts/01-context-window.md)

---

## Why care

### Move 1 — The grounded scenario

You're embedding buffr's entries. A typical entry is 500 chars (~125 tokens) — short enough to embed whole. But some users write 5000-char days. Embed whole → one giant vector that semantically averages "everything in this day"; querying for a specific moment retrieves the whole day. Embed per-sentence → 30 chunks per long day; query retrieves a specific sentence with no context. Right shape is somewhere in between.

### Move 2 — Name the question the pattern answers

That what-unit-do-I-embed question is what chunking strategies answer. Not "how do I split a string" (trivial); just *what's the right granularity for retrieval given my content shape and query shape*. The answer: pick chunk size that matches the granularity of typical queries — too coarse misses specifics; too fine misses context.

### Move 3 — Why answering that question matters

**What breaks without thoughtful chunking:** retrieval returns either everything or nothing. Buffr's planned default (per the `B2A.5` curriculum item): per-entry whole-text embedding first. If eval reveals recall misses on long days, fall back to sentence-window chunking. Default to "as coarse as works."

### Move 4 — Concrete before/after

Without chunking discipline:
- Embed whole entries; long days dominate semantically; specific-moment queries miss

With chunking discipline:
- Default whole-entry; switch to sentence-window only when eval shows the miss

### Move 5 — The one-line summary

Three strategies: fixed-size (simple, cuts mid-sentence), sentence-window (clean boundaries), structural (highest quality, requires parser). Pick by content shape; default coarse; refine when eval shows the need.

---

## How it works

### Move 1 — The mental model

```
   ┌─ Fixed-size chunking ─────────────────────────┐
   │  Split every N tokens. Simple. Boundaries     │
   │  often land mid-sentence. Variable quality.   │
   └───────────────────────────────────────────────┘

   ┌─ Sentence-window chunking ────────────────────┐
   │  Split on sentence boundaries; group N        │
   │  sentences. Clean boundaries; better for       │
   │  prose; weaker for tables/code.                │
   └───────────────────────────────────────────────┘

   ┌─ Structural chunking ─────────────────────────┐
   │  Split on document structure (markdown        │
   │  headings, code blocks, JSON nesting).        │
   │  Highest quality; requires parsing.           │
   └───────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — chunk size rules of thumb.** Prose: 200–500 tokens per chunk. Code: per-function or per-class. JSON: per-record or per-top-level-key. Journal entries: typically embed whole (under 200 tokens).

**Layer 2 — overlap.** Sentence-window chunking with overlap (e.g., 3 sentences per chunk, slide by 1) catches relevant content that spans sentence boundaries. Cost: more chunks → more storage and more retrieval candidates.

```
   Sentence-window with overlap (size=3, stride=1)
   ───────────────────────────────────────────────
   sentences:    s1  s2  s3  s4  s5  s6
   chunk 1:      [s1, s2, s3]
   chunk 2:          [s2, s3, s4]
   chunk 3:              [s3, s4, s5]
   chunk 4:                  [s4, s5, s6]
```

**Layer 3 — chunk size and context window interact.** A 500-token chunk that retrieves top-10 for a query → 5000 tokens of context. Stay within budget (concept 02-01-context-window). For buffr's 200k window, comfortable; for tighter windows, smaller chunks or smaller top-k.

### Move 3 — The principle

Match chunk size to query granularity. Default coarse; refine when eval shows a miss. Overlap when relevance can span boundaries.

---

## Chunking — diagram

```
┌─ Buffr's planned chunking strategy ────────────────────────────────────┐
│                                                                        │
│   short entry (<500 tokens):                                            │
│     embed whole                                                         │
│                                                                        │
│   long entry (>500 tokens):                                             │
│     ┌── if eval shows recall miss ──┐                                  │
│     │                                │                                 │
│     ▼                                ▼                                 │
│     embed whole                 sentence-window (3 sentences,         │
│                                  slide 1) — chunks indexed with         │
│                                  parent entry_id for grouping            │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not chunk because it does not embed.**

`B2A.5` curriculum build: per-entry whole-text first; sentence-window only if eval shows recall miss on long entries. The `entry_embeddings.chunk_index` column in the planned schema is the hedge for incremental migration from whole-entry to chunked.

---

## Elaborate

### Where this pattern comes from

Information retrieval has used passage retrieval for decades; modern dense-vector chunking inherits the same trade-offs (specificity vs context) at a different granularity.

### The deeper principle

Retrieval granularity equals query granularity. Mismatch produces either over-retrieval (everything matches) or under-retrieval (nothing matches).

### Where this breaks down

For very structured content (code, tables), generic chunking fails — structural chunking is the only adequate strategy. For very short content (journal entries averaging 200 tokens), chunking adds complexity without value.

### What to explore next

- [01-embeddings-geometrically](./01-embeddings-geometrically.md) — chunks are what gets embedded
- [11-rag](./11-rag.md) — retrieval pipeline consumes chunks

---

## Tradeoffs

The breakpoint: default whole-entry; chunk only when eval shows recall on long entries is worse than recall on short entries.

---

## Tech reference

- **Implementation:** sentence-split via natural language splitter (sbd or compromise) or a simple regex on `[.!?]\s+`.

---

## Project exercises

### B2A.5 — Chunking strategy

- **Exercise ID:** `B2A.5`
- **What to build:** start with per-entry whole-text embedding; eval before adding chunking complexity.
- **Done when:** decision documented; chunking added only if eval justifies.
- **Estimated effort:** included in B2A.4.

---

## Summary

- Three strategies: fixed-size, sentence-window, structural.
- Default to coarsest unit that captures typical queries.
- Buffr likely starts with whole-entry; chunks only if eval shows the need.

---

## Interview defense

**Q [mid]:** When do you chunk vs embed whole?

**A:** Embed whole when content is short (under ~500 tokens) and the query granularity matches the document granularity (find similar entries, find similar code files). Chunk when content is long and queries are specific (find the section about auth in this 50-page doc). For buffr's short entries, whole-document is the right default.

### One-line anchors

- Chunks = retrieval unit; match to query granularity.
- Three strategies: fixed, sentence-window, structural.
- Default coarse; refine on eval.

---

## Validate

### Quick check
- What's the buffr default chunking choice?
- When do you add overlap?
- What's the symptom of chunks too small?
