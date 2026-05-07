# RAG — not used in loopd, but the seed exists

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

Loopd skips all of this and uses hand-picked retrieval: caption.ts grabs the last 5 captions for anti-repetition; expand.ts grabs the last 3 days of entries plus their cached summaries.

---

## Where RAG would land if added

"Expand this todo with context from any past entry that mentioned similar ideas" — that's the moment to embed the corpus. Today the codebase fakes it with `getRecentAISummaries(date, 5)` for the caption's anti-repetition, which is hand-picked retrieval, not embed-and-search.

If/when added:
- New service: `src/services/ai/embed.ts` to embed entries on commit.
- New table: `entry_embeddings(entry_id, vector)` (or stored in Supabase pgvector).
- New step in expand/caption: nearest-neighbour search before prompt assembly.

---

## In this codebase

- Hand-picked retrieval lives in:
  - `src/services/ai/caption.ts` → `getRecentAISummaries(date, 5)`.
  - `src/services/todos/expand.ts` → `buildContext()` pulls last 3 days of entries.
- No `embed.ts`, no vector index, no `pgvector` extension on Supabase.

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
