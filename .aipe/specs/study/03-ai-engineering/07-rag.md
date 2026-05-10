# RAG — not used in loopd, but the seed exists

**Industry name:** Retrieval-augmented generation (RAG)
**Type:** Industry standard

> Retrieval Augmented Generation: embed user data, vector-search, stuff results into the prompt. Loopd uses hand-picked retrieval instead.

**See also:** → [03-context-window](./03-context-window.md) · → [06-tool-calling](./06-tool-calling.md)

---

## Quick summary
- **What:** RAG is the standard pattern for "let the LLM see relevant chunks of my data." Loopd doesn't do vector RAG — it hand-picks "last 3 days, 5 siblings, last 5 captions."
- **Why here:** the data is *small*. A user with a year of journaling has ~365 entries. Hand-picked context is plenty for the small operations the app runs today.
- **Tradeoff:** features that need "find anything semantically similar" can't be built without adding embeddings and a vector index.

---

## RAG — diagram

```
  RAG pattern (NOT loopd):             What loopd does instead:
  ──────────────────────               ─────────────────────────

   user question                        explicit context block in the prompt
        │                                       │
        ▼                                       ▼
   embed → vector search                 callsite hand-picks N items
        │                                (last 3 days, 5 siblings, 5 captions)
        ▼                                       │
   stuff into prompt                            ▼
        │                                stuff into prompt
        ▼                                       │
   LLM answers                                  ▼
                                         LLM answers
```

---

## How it works (in apps that do RAG, which loopd doesn't)

1. **Embed**: pass each chunk of data through an embedding model. Get a vector.
2. **Index**: store the vectors in a vector DB (pgvector, Pinecone, Qdrant).
3. **Query**: at request time, embed the user's query, find top-k nearest vectors, fetch the originals.
4. **Stuff**: put the retrieved chunks in the prompt with the user's question.
5. **Answer**: the LLM answers using the retrieved context.

Loopd skips all of this and uses hand-picked retrieval: `summarize.ts:buildCaptionInput()` grabs the last 5 captions for anti-repetition (and hands them to caption.ts); `expand.ts:buildContext()` grabs the last 3 days of entries plus their cached summaries.

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

- **Hand-picked retrieval** — gives: zero infrastructure, exact control. Costs: doesn't scale to "find anything semantically similar."
- **No embeddings yet** — gives: simple data layer. Costs: features needing semantic search can't be built without adding embedding pipeline.
- **Caps in code** — gives: predictable cost. Costs: if data shape changes, caps need updating.

---

## Interview defense

### What an interviewer is really asking
"Why no RAG?" is a check on whether I know what RAG is *for*. They want to see that I understand RAG is about retrieval over a corpus that exceeds the context budget — not a default. The candidate who says "we don't need a vector DB yet" without articulating *why* loses this question. The number I want to drop: this app is one user, ~365 entries per year, and the most context any chain assembles is "last 3 days plus 5 siblings plus 5 captions". Hand-picked retrieval is the right tool at this scale.

### Likely questions

[mid] Q: What hand-picked retrieval does this codebase actually do today?
      A: Two places. `src/services/ai/summarize.ts:buildCaptionInput()` (L111) calls `getRecentAISummaries(date, 5)` at L131 to grab the last 5 captions for anti-repetition, then hands the assembled input to `caption.ts:generateCaption()`. `expand.ts:147 buildContext()` pulls the last 3 days of entries plus their cached summaries plus ≤5 sibling todos. Both are SQL queries with explicit date filters and `slice(0, N)` caps. There's no embedding, no vector index, no pgvector — just structured retrieval over SQLite.

[senior] Q: Why not embed entries proactively, so RAG is ready when you need it?
         A: Because today's features don't need it and embedding has ongoing cost — every entry edit re-embeds, every model upgrade may need re-embedding. Adding the pipeline means an embed model choice, an embedding storage decision (SQLite blob? pgvector via Supabase?), a re-embedding strategy, and a chunking strategy. None of which pay back until I have a feature that needs semantic search. The seed of "what if RAG?" exists in the docs precisely so the day a feature lands, I know exactly what to add — `src/services/ai/embed.ts`, `entry_embeddings(entry_id, vector)`, nearest-neighbour step before prompt assembly. Until then, hand-picked retrieval is plenty.

[arch] Q: At what point does the corpus get too big for hand-picked retrieval?
       A: When the user asks a question whose answer requires "look across all entries" rather than "look at recent entries". A feature like "show me everything I wrote about Project X over three years" can't be served by date-range filters — it needs semantic search. That's the cliff. Or: when the user has so many entries per day that even one day blows the context window, hand-picked stops fitting. Today the user is one person with sporadic use; neither cliff is close.

### The question candidates always dodge
Q: What happens when the user has three years of entries and last-3-days context isn't enough?

A: Partly that's a "I haven't built it yet" answer, and I'll own that. But also: at one user with at most three days of context per chain, the steps ARE knowable in advance — what to expand uses what's near the entry, what to caption uses what's recent, what to summarise uses today. None of those tasks change when the archive grows. The new feature that *would* change is something like "trace the evolution of Project X" or "find the day I felt closest to how I feel today" — those need semantic recall over the whole archive and that's where RAG goes in. The day I ship that feature, it looks like: `embed.ts` with a chosen embedding model, `entry_embeddings` table, a nearest-neighbour step in a new service file, and the existing chains stay unchanged. I'd add RAG the day the steps stop being knowable in advance — for example, the day the user asks the model to find something across the full archive.

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
