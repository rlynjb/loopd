# RAG — not used in loopd, but the seed exists

**Industry name(s):** Retrieval-augmented generation (RAG)
**Type:** Industry standard

> Retrieval Augmented Generation: embed user data, vector-search, stuff results into the prompt. Loopd uses hand-picked retrieval instead.

**See also:** → [03-context-window](./03-context-window.md) · → [06-tool-calling](./06-tool-calling.md)

---

## Why care

A model was trained on the public internet two years ago. You want it to answer questions about your company's internal docs, your customer's order history, or yesterday's Slack thread — none of which it has ever seen. Fine-tuning is slow and expensive; stuffing all your data into the prompt doesn't fit. So what's left? Retrieve only the few chunks that are actually relevant to the question, paste them into the prompt, and let the model answer from the documents in front of it instead of from memory.

Retrieval-augmented generation is the pattern that lets a generic model answer specific questions about data it wasn't trained on, by treating retrieval and generation as two separate steps. It belongs to the family of "lookup before compute" patterns — the same shape as database query planners, search engines that rank before they snippet, and recommender systems that retrieve candidates before scoring. You've already seen it in every "chat with your PDF" product, in ChatGPT's enterprise connectors, in LangChain and LlamaIndex RAG pipelines, and in vector databases like Pinecone, Weaviate, and pgvector that exist almost entirely to serve this pattern. Not every app needs the full RAG stack — small datasets are often better served by hand-picked retrieval. How it works generally is in the next block.

---

## How it works

A library where you don't know what book you want, you only know what you want to read about. RAG is the librarian who runs your topic through a "meaning catalogue" (an index of book-themes, not titles), pulls the top-5 books closest in meaning, and hands them to you to read. Loopd doesn't have that librarian because it doesn't need one — the codebase already knows which entries are relevant (last 5 captions, last 3 days) and grabs them by date, not by meaning. The pattern is documented here because understanding what loopd *doesn't* do is what makes the decision visible.

### The RAG pipeline — embed, index, query, stuff, answer

The five stages of RAG, in order:

1. **Embed:** every chunk of source data (paragraph, document, code block) goes through an embedding model — a separate ML model that produces a 1024-or-so-dimensional vector representing the chunk's meaning.
2. **Index:** vectors get stored in a vector database (pgvector, Pinecone, Qdrant, Weaviate). The index supports k-nearest-neighbour search.
3. **Query:** at request time, the user's question gets embedded the same way. The vector DB returns top-k chunks whose vectors are closest in meaning.
4. **Stuff:** the retrieved chunks get pasted into the LLM prompt alongside the user's question.
5. **Answer:** the LLM produces an answer grounded in the retrieved context.

If you're coming from frontend, this is the same shape as building a search-with-suggestions feature where the suggestion engine is a separate service that returns "top-5 things relevant to what you typed" — except the relevance metric is vector similarity in meaning-space, not keyword overlap. Concrete consequence: an app like Notion AI or Glean uses RAG because the user could ask about *any* document and the system has to find the relevant one without knowing in advance which it is. Embed cost is one-time per chunk; query cost is one embedding + one vector search per user prompt; storage cost is sized to the corpus. Boundary: RAG quality depends entirely on the embedding model's notion of similarity and the retriever's top-k tuning — get either wrong and the LLM gets unhelpful chunks pasted into the prompt.

### What loopd does instead — hand-picked deterministic retrieval

Loopd's chains know exactly which past data is relevant: `caption.ts` always wants the last 5 captions (anti-repetition), `expand.ts` always wants the last 3 days of entries plus their cached summaries. These are time-based predicates against SQLite, not similarity searches. Think of it like a typed SQL query that always knows its `WHERE created_at > NOW() - INTERVAL '3 days' LIMIT 5` — deterministic, fast, no separate ML pipeline. Concrete consequence: `expand.ts:buildContext` runs `SELECT * FROM entries WHERE date >= today - 3 days ORDER BY date DESC LIMIT 3`. The query takes microseconds, costs zero, returns exactly the rows the chain knows it needs. No embedding model, no vector DB, no top-k tuning, no "is this similar enough?" judgment call. Boundary: this only works because the codebase *knows in advance* what context each chain needs. The day a chain needs "the most relevant entries about topic X" — where the topic is supplied at runtime — RAG becomes the load-bearing approach.

### Why loopd can skip RAG — the corpus shape

The user's journal is *small and time-shaped*. A heavy month is 50 entries; an active year is ~365. RAG's value scales with corpus size — at 50 entries, top-k vector search doesn't outperform "give me the last 5"; at 50,000 entries, RAG's similarity match becomes essential because nobody can scroll-find what they want. The codebase's corpus profile is "small enough that recency + thread tags do the relevance job." If you've worked with a search bar that just queries `LIKE %query%` for small datasets and only graduates to Elasticsearch when the dataset crosses some threshold, this is the same instinct — the cheap shape works as long as the corpus stays small. Concrete consequence: at 365 entries × 200 words = ~75K tokens of full corpus, the entire journal could fit in Claude's context window twice over. The choice between "stuff the whole corpus" and "retrieve relevant chunks" isn't pressing yet. Boundary: the codebase's threshold for adding RAG is "the day a chain needs query-time relevance over a corpus too large to stuff." Until then, hand-picked retrieval wins.

This is what people mean by "RAG is a tradeoff, not a requirement." The pattern is essential when the corpus is large and the query is unpredictable; the pattern is overhead when the corpus is small and the relevance rule is deterministic. The codebase ships an LLM application without RAG because the application's shape — small corpus, time-shaped relevance, fixed chains — doesn't earn the operational cost of an embedding pipeline + vector DB. Every team that has ever paid for a vector DB it didn't need has learned this in retrospect; saving the cost up front is the rarer move. The full picture is below.

---

## RAG — diagram

```
  RAG pattern (NOT loopd):                     What loopd does instead:
  ──────────────────────                       ─────────────────────────

  ┌─ App layer ──────────────┐                 ┌─ App layer ───────────────────────┐
  │  user question           │                 │  callsite hand-picks N items      │
  └────────────┬─────────────┘                 │  (last 3 days, 5 siblings,        │
               │                               │   5 captions) via SQL             │
               ▼                               └──────────────┬────────────────────┘
  ┌─ Provider (embed model) ─┐                                │
  │  embed query → vector    │                                ▼
  └────────────┬─────────────┘                 ┌─ App layer ───────────────────────┐
               │                               │  stuff into prompt                │
               ▼                               └──────────────┬────────────────────┘
  ┌─ Storage (vector DB) ────┐                                │
  │  top-k nearest vectors   │                                ▼
  └────────────┬─────────────┘                 ┌─ Provider (LLM) ──────────────────┐
               │                               │  LLM answers                      │
               ▼                               └───────────────────────────────────┘
  ┌─ App layer ──────────────┐
  │  stuff into prompt       │
  └────────────┬─────────────┘
               │
               ▼
  ┌─ Provider (LLM) ─────────┐
  │  LLM answers             │
  └──────────────────────────┘
```

---

## Where RAG would land if added

"Expand this todo with context from any past entry that mentioned similar ideas" — that's the moment to embed the corpus. Today the codebase fakes it with `getRecentAISummaries(date, 5)` (called in `src/services/ai/summarize.ts:buildCaptionInput()` at L131) for the caption's anti-repetition, which is hand-picked retrieval, not embed-and-search.

If/when added:
- New service: `src/services/ai/embed.ts` to embed entries on commit.
- New table: `entry_embeddings(entry_id, vector)` (or stored in Supabase pgvector).
- New step in expand/caption: nearest-neighbour search before prompt assembly.

---

## In this codebase

_Vector RAG not implemented — intentionally absent._ Hand-picked retrieval lives in:

**Caption anti-repeat:**  `src/services/ai/summarize.ts` → `buildCaptionInput()` L111–L163 invokes `getRecentAISummaries(date, 5)` at L131 — the 5-most-recent prior captions, fetched by SQL date filter; the assembled input is then passed to `caption.ts:generateCaption()` L201–L223
**Expand context:**       `src/services/todos/expand.ts` → `buildContext()` L147–L199 pulls last 3 days of entries plus their cached summaries plus ≤5 sibling todos via SQL queries with explicit `.slice(0, N)` caps
**Architectural anchor:** no `src/services/ai/embed.ts`, no `entry_embeddings` table, no `pgvector` extension on the Supabase schema (`supabase/migrations/0001_initial_schema.sql`). The seed for adding RAG lives in this concept file, not in code.

---

## Elaborate

### Where this pattern comes from
RAG came out of dense-retrieval research (DPR, REALM) and was popularised in 2023 by tools like LlamaIndex and LangChain. The killer use case is "answer questions over a body of documents the model wasn't trained on" — exactly the gap LLMs leave.

### The deeper principle
**Use retrieval when the corpus exceeds the context budget; use hand-picked context when it doesn't.** Vector search is a retrieval mechanism — it's only worth the complexity when there's too much data to send everything.

### Where this breaks down
- Tiny corpora where vector search is overkill (loopd today).
- Cases where keyword/SQL retrieval is more precise than embeddings (structured filters, dates, tags). Loopd's hand-picked retrieval is essentially this.

### What to explore next
- [03-context-window](./03-context-window.md) → the cap structure that hand-picked retrieval lives inside.
- pgvector → for when embeddings are added.
- BM25 / keyword retrieval → the often-overlooked baseline.

---

## Tradeoffs

We traded the semantic-search capability of vector RAG for zero embedding infrastructure and exact, queryable control over what context each chain sees — at the cost of every "find anything semantically similar" feature staying unbuildable until the pipeline lands.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (hand-picked SQL)   │ Alternative (vector RAG)       │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Infrastructure   │ zero — SQL on existing tables  │ embed model + vector store     │
│                  │                                │ (pgvector / Pinecone) +        │
│                  │                                │ re-embed pipeline on edit      │
│ Money            │ $0 retrieval — just SQL        │ ~$0.0001 per entry embed       │
│ ($/retrieval)    │                                │ at OpenAI's pricing; cents/yr  │
│                  │                                │ at single-user scale           │
│ Latency          │ ~5-20ms SQLite query           │ ~50-200ms: embed query +       │
│                  │                                │ ANN search + fetch originals   │
│ Recall ceiling   │ "last 3 days" / "5 siblings"   │ "top-k most semantically       │
│                  │ — date-bound, can't span time  │ similar across whole archive"  │
│ Precision        │ exact: date filters, .slice()  │ approximate — embedding model  │
│                  │ — caller controls every row    │ judges similarity; tunable but │
│                  │                                │ never deterministic            │
│ Cognitive load   │ "read SQL + .slice() cap" —    │ "embed model + chunking +      │
│                  │ stays in one mental model      │ index + similarity threshold"  │
│                  │                                │ — 4 new mental models          │
│ Capability       │ ceiling: corpus < context      │ unbounded — corpus can be      │
│ ceiling          │ window, time-local features    │ years of data, semantic recall │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up semantic recall over the archive. Today every chain's retrieval is structurally bound: caption sees the last 5 captions (date-filtered), expand sees the last 3 days plus 5 siblings (date + entry-id filtered). A user asking "find me the day I felt most like today" or "show me everything I wrote about Project X over three years" can't be served — those queries need semantic similarity over the whole journal, not "the last N by date". The cliff is hard: a feature like that requires a new embedding pipeline, a vector index, and a nearest-neighbour step before prompt assembly — none of which exist.

We also accepted that the caps live in code (`.slice(0, 5)` for captions, `.slice(0, 3)` for entries, `MAX_INPUT_CHARS = 2000` for interpret). Each cap is a literal in the source; tuning means a code change and a redeploy. At one user with sporadic use, this is fine — but if usage patterns shift (very long entries, many siblings), the caps need updating. A vector-RAG path would replace this with a similarity threshold + top-k, which is more flexible but introduces its own tuning problem.

The maintenance cost is genuinely low: `getRecentAISummaries(date, 5)` + the `.slice` caps are ~30 LOC of plumbing across all 5 chains. That's the win.

### What the alternative would have cost

A vector-RAG pipeline would have added four moving parts: (1) an embed-on-commit hook that runs whenever `entries.text` changes (debounced, like the 5s sync push) and writes vectors to a new table or pgvector extension; (2) a re-embed strategy when the embed model upgrades (do we re-embed everything? lazily on next access? we'd need to decide); (3) a chunking strategy because some entries are 3 lines and some are 3000 chars (whole-entry vs paragraph-level vs sentence-level — each has tradeoffs); (4) a similarity-threshold + top-k tuning loop that requires real user behaviour to calibrate.

The dollar cost at single-user scale is trivial — ~$0.0001 per entry embed × ~365 entries/year = ~4 cents/year. The hidden cost is operational: choosing an embedding model commits you to its semantic space, and switching models means a full re-embed. We'd have to track which embed model produced which vectors, run re-embed migrations on upgrade, and accept that "similarity" means slightly different things across model versions.

Cross-cutting infrastructure: a new column or table for vectors, a new Supabase migration, the `pgvector` extension on the cloud schema, and a sync-mapper update so vectors round-trip to Supabase. The current sync layer doesn't move vectors and would need extension. None of which pays back until a feature needs semantic search.

### The breakpoint

The pattern flips the day a feature is asked that can't be served by date filters. Concrete trigger shapes: "find every day I wrote about Project X over three years" (corpus-wide semantic recall), "find the day I felt most like today" (similarity search by mood), "show me all entries where I mentioned anyone named like a habit" (cross-reference by semantic field). The cliff is binary — none of these can be expressed as a SQL WHERE clause, and stuffing the whole archive into the prompt is impossible past ~50 entries even with a 200K-token context window.

A secondary trigger: if entries grow past the truncation cap consistently. `MAX_INPUT_CHARS = 2000` on interpret means a 5000-char entry loses 3000 chars of context. If users routinely write essays, RAG-on-the-entry (chunk the entry, retrieve the relevant chunks) starts paying back — but that's a different shape of RAG (intra-entry, not cross-entry).

The day RAG lands, it goes in a new service file (`src/services/ai/embed.ts`), a new table (`entry_embeddings(entry_id, vector)` or a pgvector column), a new migration, and a nearest-neighbour step before prompt assembly in *one* chain initially — probably expand, since it already has the most context plumbing.

### What wasn't actually a tradeoff

BM25 / keyword search vs vector embeddings was never a real choice today. The corpus is small enough that even FTS5 (SQLite's full-text search) isn't needed — `WHERE text LIKE '%project x%'` runs in milliseconds on 365 rows. Both BM25 and embeddings are answers to "the corpus is too big for prompt-stuffing", and our corpus isn't.

---

## Tech reference (industry pairing)

### RAG retrieval libraries (LangChain.js / LlamaIndex)

- **Codebase uses:** none — no RAG implemented; hand-picked SQL retrieval is used instead.
- **Why it's here:** the file names LangChain and LlamaIndex as the popularisers of the RAG pattern and the tools the codebase would reach for first.
- **Leading today:** LangChain.js / LlamaIndex — `adoption-leading`, 2026.
- **Why it leads:** broadest retriever ecosystem (pgvector, Pinecone, Qdrant, Weaviate, BM25 all behind one interface); most RAG tutorials and production references use one of these two.
- **Runner-up:** Vercel AI SDK + pgvector — `innovation-leading` typed end-to-end, edge-native, direct pgvector integration without a separate orchestration layer.

### pgvector

- **Codebase uses:** not yet — named as the planned vector store (Supabase pgvector extension) for when RAG is added; `entry_embeddings(entry_id, vector)`.
- **Why it's here:** the file specifically calls out pgvector via Supabase as the implementation path when the embedding pipeline lands.
- **Leading today:** `pgvector` — `adoption-leading` for on-Postgres vector search, 2026.
- **Why it leads:** runs inside existing Postgres/Supabase instances with no new infrastructure; ANN index (HNSW) added in recent versions closes the performance gap with dedicated stores.
- **Runner-up:** Pinecone — managed, purpose-built vector DB; fastest ANN at scale; costs more than `pgvector` for small corpora.

---

## Project exercises

The current file describes the "hand-picked, no RAG" decision. The curriculum's Phase 2A turns that into a *bounded* statement: hand-picked stays for the bounded chains, embeddings come in for unbounded scope. This file's exercises set up the decision boundary; the Case B files [24-embeddings-geometric.md](./24-embeddings-geometric.md) through [34-graphrag.md](./34-graphrag.md) own the implementation details.

### [B1.4] Update principle #11 via /aipe:refactor

- **Exercise ID:** `[B1.4]`
- **What to build:** A `loopd/.aipe/specs/refactor/principle-11-update.md` produced via `/aipe:refactor`. Replaces the current "No RAG" wording with the updated principle: *"RAG above threshold. The expand chain stays hand-picked (recency-based, ≤ 1000 chars per source) because the corpus is bounded by today. The interpret chain at week/month scope and the 'find related entries' feature on threads use embeddings + cosine search. The threshold is documented per-feature; default is no RAG until a feature provably needs it."*
- **Why it earns its place:** unblocks every Phase 2A build item. Until the principle is updated, the codebase reads as "we don't do RAG"; after the update, the reader knows exactly which chains stay hand-picked and which earn RAG.
- **Files to touch:** new `loopd/.aipe/specs/refactor/principle-11-update.md`; eventual edit of `loopd/docs/spec.md` §10 Principle 11.
- **Done when:** the refactor spec exists; `docs/spec.md` Principle 11 is updated; this file's Tradeoffs breakpoint is rephrased to match.
- **Estimated effort:** `1–4hr`.

### [B2A.7] Ship "interpret this week" feature (Phase 2A primary buildable)

- **Exercise ID:** `[B2A.7]`
- **What to build:** A 7-day-scope variant of `interpret` that takes a week of entries, retrieves the top-k semantically-similar entries from the rest of the corpus (via embeddings from `[B2A.1]`), and feeds both into the interpret prompt. UI: a "this week" entry point alongside the existing per-entry interpret modal.
- **Why it earns its place:** this is the *first* feature in loopd that crosses the bounded-corpus threshold — a week is too big to hand-pick. It's the smallest possible buildable surface that justifies the entire Phase 2A RAG pipeline.
- **Files to touch:** new `src/services/ai/interpretWeek.ts`; depends on `entry_embeddings` table from `[B2A.2]`; UI entry in `app/journal/[date].tsx` or a new `app/interpret/week.tsx`.
- **Done when:** the feature ships end-to-end on device; eval set from `[B2A.9]` shows top-k hits include at least 3 thematically-relevant entries per week-scope query on the 20-30 (query, expected entry ID) pairs.
- **Estimated effort:** `≥1 week`.

### [B2A.8] Ship "related entries" on thread detail (Phase 2A — GraphRAG seed)

- **Exercise ID:** `[B2A.8]`
- **What to build:** A "related entries" rail on the thread-detail screen that surfaces entries semantically similar to the thread's prose mentions but not yet `#tag`-linked. Uses the same embedding pipeline as `[B2A.7]`.
- **Why it earns its place:** loopd's `#tag` system is already a *graph* over entries; adding semantic neighbours turns it into a real GraphRAG-shaped surface. The interview answer "tell me about a GraphRAG you shipped" becomes concrete.
- **Files to touch:** `app/threads/[id].tsx`, `src/services/threads/getThreadDetail.ts`, new `getRelatedEntries.ts`.
- **Done when:** the rail renders; user can tap a related entry to add a `#tag` link to that thread; the action propagates through soft-delete and sync.
- **Estimated effort:** `1–2 days`.

---

## Summary

Retrieval-augmented generation is the standard pattern for letting a generic LLM answer specific questions about data it wasn't trained on, by embedding a corpus, vector-searching at request time, and stuffing the nearest chunks into the prompt. This codebase doesn't do vector RAG — `summarize.ts:buildCaptionInput()` calls `getRecentAISummaries(date, 5)` at L131 for caption anti-repetition, and `expand.ts:buildContext()` at L147 pulls last 3 days plus ≤5 sibling todos via SQL with explicit `.slice(0, N)` caps. The constraint that drove it is that the corpus is tiny — one user with ~365 entries per year, and the most context any chain assembles is "last 3 days plus 5 siblings plus 5 captions", which fits in the budget without semantic search. The cost is that features needing "find anything semantically similar" can't be built without adding an embedding pipeline, a vector index, and a nearest-neighbour step — none of which exist today.

Key points to remember:
- No vector RAG: no `src/services/ai/embed.ts`, no `entry_embeddings` table, no `pgvector` extension on the Supabase schema.
- Hand-picked retrieval is just SQL with date filters and `.slice(0, N)` caps — `getRecentAISummaries(date, 5)` for captions, `buildContext()` for expand.
- Use retrieval (vector) when the corpus exceeds the context budget; use hand-picked when it doesn't.
- The seed for adding RAG lives in this concept file — `embed.ts`, `entry_embeddings(entry_id, vector)`, nearest-neighbour before prompt assembly.
- The cost is no semantic search: a feature like "find everything I wrote about Project X over three years" can't be served by date filters and triggers the build.

---

## Interview defense

### What an interviewer is really asking
"Why no RAG?" is a check on whether I know what RAG is *for*. They want to see that I understand RAG is about retrieval over a corpus that exceeds the context budget — not a default. The candidate who says "we don't need a vector DB yet" without articulating *why* loses this question. The number I want to drop: this app is one user, ~365 entries per year, and the most context any chain assembles is "last 3 days plus 5 siblings plus 5 captions". Hand-picked retrieval is the right tool at this scale.

### Likely questions

[mid] Q: What hand-picked retrieval does this codebase actually do today?
      A: Two places. `src/services/ai/summarize.ts:buildCaptionInput()` (L111) calls `getRecentAISummaries(date, 5)` at L131 to grab the last 5 captions for anti-repetition, then hands the assembled input to `caption.ts:generateCaption()`. `expand.ts:147 buildContext()` pulls the last 3 days of entries plus their cached summaries plus ≤5 sibling todos. Both are SQL queries with explicit date filters and `slice(0, N)` caps. There's no embedding, no vector index, no pgvector — just structured retrieval over SQLite.

```
[hand-picked retrieval — current shape]

  expand fires for todo X
        │
        ▼  buildContext(entry, meta)
  SELECT ... WHERE date BETWEEN today-3 AND today  ← date filter
        │   .slice(0, 3) days of entries
        ▼
  SELECT ... FROM ai_summaries WHERE date IN (...)  ← cached summaries
        │
        ▼  siblings: same entry's todos_json, .slice(0, 5)
  pack into prompt → call Sonnet/4o
```

[senior] Q: Why not embed entries proactively, so RAG is ready when you need it?
         A: Because today's features don't need it and embedding has ongoing cost — every entry edit re-embeds, every model upgrade may need re-embedding. Adding the pipeline means an embed model choice, an embedding storage decision (SQLite blob? pgvector via Supabase?), a re-embedding strategy, and a chunking strategy. None of which pay back until I have a feature that needs semantic search. The seed of "what if RAG?" exists in the docs precisely so the day a feature lands, I know exactly what to add — `src/services/ai/embed.ts`, `entry_embeddings(entry_id, vector)`, nearest-neighbour step before prompt assembly. Until then, hand-picked retrieval is plenty.

```
                  Path taken (hand-picked, lazy)      Alternative (embed proactively)
                  ──────────────────────────────      ───────────────────────────────
infrastructure    0 — SQL on existing tables          embed model + vector store +
                                                      re-embed-on-edit pipeline
$ per entry       $0                                  ~$0.0001 embed cost; ~$0.04/yr
                                                      total at single-user scale
re-embed when     N/A                                 every entry edit; every model
                                                      upgrade (full re-embed migration)
chunking decision N/A                                 must pick: whole-entry vs
                                                      paragraph vs sentence
features unlocked none today                          semantic search, similarity
                                                      ranking — but no consumer yet
when this flips   never — RAG without consumer        the day a feature needs corpus-
                  is YAGNI                            wide semantic recall
maintenance       low — 30 LOC of SQL plumbing        ongoing — pipeline + index +
                                                      tuning loop
```

[arch] Q: At what point does the corpus get too big for hand-picked retrieval?
       A: When the user asks a question whose answer requires "look across all entries" rather than "look at recent entries". A feature like "show me everything I wrote about Project X over three years" can't be served by date-range filters — it needs semantic search. That's the cliff. Or: when the user has so many entries per day that even one day blows the context window, hand-picked stops fitting. Today the user is one person with sporadic use; neither cliff is close.

```
At 3+ years of entries + corpus-wide queries needed:

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — chains still call buildContext  │
  └─────────────────────────────────────────────┘
              │
  ┌─ Hand-picked retrieval (SQL) ───────────────┐
  │ "last 3 days" / "5 siblings" — date-bound   │  ◀── BREAKS FIRST
  │ can't answer "every day about Project X     │     (corpus query needs
  │ over 3 years"                                │      semantic recall;
  │                                              │      SQL WHERE not enough)
  └─────────────────────────────────────────────┘
              │ needs replacement
              ▼
  ┌─ NEW: vector RAG layer ─────────────────────┐
  │ src/services/ai/embed.ts (embed on commit)  │
  │ entry_embeddings(entry_id, vector) +        │
  │ pgvector extension on Supabase              │
  │ nearest-neighbour step before prompt build  │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: What happens when the user has three years of entries and last-3-days context isn't enough?

A: Partly that's a "I haven't built it yet" answer, and I'll own that. But also: at one user with at most three days of context per chain, the steps ARE knowable in advance — what to expand uses what's near the entry, what to caption uses what's recent, what to summarise uses today. None of those tasks change when the archive grows. The new feature that *would* change is something like "trace the evolution of Project X" or "find the day I felt closest to how I feel today" — those need semantic recall over the whole archive and that's where RAG goes in. The day I ship that feature, it looks like: `embed.ts` with a chosen embedding model, `entry_embeddings` table, a nearest-neighbour step in a new service file, and the existing chains stay unchanged. I'd add RAG the day the steps stop being knowable in advance — for example, the day the user asks the model to find something across the full archive.

```
                  Path taken (hand-picked today)       Suggested (build RAG now)
                  ──────────────────────────────       ─────────────────────────
features served   summarize / caption / classify /     same 5 + nothing new (no
                  expand / interpret — all served      consumer for semantic search)
$ infrastructure  $0                                   ~$0.04/yr embed + pgvector
                                                       extension + sync migration
new mental models 0                                    4: embed model + chunking +
                                                       index + similarity threshold
new failure modes 0                                    embed model upgrade requires
                                                       full re-embed; similarity
                                                       drift across model versions
when this pays    never with current features          day a feature can't be
back                                                   answered by date filters
3-year archive    chains still work — they're          would benefit from RAG, but
specifically      time-local by design                 only if the new feature needs
                                                       cross-time semantic recall
honest framing    YAGNI is the right answer            shipping it pre-need is the
                  until the consumer exists            more expensive mistake
```

### One-line anchors
- "Use retrieval when the corpus exceeds the context budget. Mine doesn't."
- "Hand-picked retrieval is just SQL with `slice(0, N)`."
- "Embeddings are zero infrastructure today. The day a feature needs them, the seed is in the docs."
- "Three years of entries plus 'find anything semantically similar' is the cliff. Not yet."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram (RAG vs hand-picked retrieval) from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "why no RAG (yet)" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/expand.ts:buildContext` and `src/services/ai/summarize.ts:buildCaptionInput` (which calls `getRecentAISummaries` at L131)
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user has 600 days of journal entries (~1.8M tokens of prose). The expand chain wants the most relevant 3 prior entries when expanding a todo about Project X. Today, `buildContext` pulls the *most recent* 3 days regardless of relevance. Walk: under what condition does that current behaviour stop being good enough? When the cliff hits, what 3 things would you add (file, table, step) to introduce real RAG, and which existing chain would consume the new retrieval first?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/expand.ts` L147–L199 to verify what `buildContext` actually fetches.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/expand.ts:buildContext` (the SQL-with-`.slice` shape) to support what exists
→ Point to where a new `src/services/ai/embed.ts` + `entry_embeddings` table + a Supabase migration adding `pgvector` would land if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly (or correctly named that no embeddings file exists)
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0). Vector RAG is intentionally absent — anchored on hand-picked retrieval sites.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block; re-attributed `getRecentAISummaries(date, 5)` to `summarize.ts:buildCaptionInput()` L131 (was wrongly placed in `caption.ts:generateCaption()`); updated Level 2 hint and codebase anchor accordingly.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram; added App / Provider / Storage layer labels to the contrast diagram since it crosses boundaries.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for LangChain.js / LlamaIndex (RAG retrieval libraries), pgvector.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (librarian-with-meaning-catalogue metaphor opening / 3 layered sub-sections — the RAG pipeline, what loopd does instead, why loopd can skip RAG — each with frontend bridges and concrete consequences / principle paragraph on RAG-as-tradeoff-not-requirement).
