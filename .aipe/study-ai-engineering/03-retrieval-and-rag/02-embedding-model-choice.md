# Embedding model choice

**Industry name(s):** Embedding model selection, vector encoder choice
**Type:** Industry standard

> Embedding model is a one-way decision — switching means re-embedding the entire corpus. Pick deliberately based on language, domain, dimensions, and host-vs-local trade-off.

**See also:** → [01-embeddings-geometrically](./01-embeddings-geometrically.md) · → [04-vector-databases](./04-vector-databases.md) · → [`01-llm-foundations/08-provider-abstraction`](../01-llm-foundations/08-provider-abstraction.md)

---

## Why care

### Move 1 — The grounded scenario

You're building buffr's `entry_embeddings` table. You pick `text-embedding-3-small` because it's the default OpenAI choice. Three months later, a new Anthropic embedding model launches with better recall on personal-journal corpora. Switching means re-embedding every entry buffr has stored — every column with `model = 'text-embedding-3-small'` is now obsolete.

### Move 2 — Name the question the pattern answers

That which-model-do-I-pick question is what embedding model choice answers. Not "what's the best embedding model" (workload-specific); just *what decision criteria apply, and how does the choice get committed in code*. The answer: pick on dimension count, language coverage, domain fit, hosting, and price; commit by storing `model` in the embedding table.

### Move 3 — Why answering that question matters

**What breaks without deliberate choice:** the default works until it doesn't, and "didn't" means a multi-day re-embed of the entire corpus. Buffr's planned `entry_embeddings.model` column is the canonical hedge — it lets you migrate by re-embedding only rows where `model` doesn't match the current choice.

### Move 4 — Concrete before/after

Without deliberate choice + model-tracking column:
- Hard-code one embedding model
- Switch later → can't tell which embeddings are old; re-embed everything

With deliberate choice + `model` column:
- Schema includes `model TEXT NOT NULL`
- Re-embedding job picks rows where `model != current`
- Migration is incremental, resumable

### Move 5 — The one-line summary

Pick on domain + language + dimensions + price; store the model name in the embedding row; re-embed by querying for stale rows when you change models.

---

## How it works

### Move 1 — The mental model

```
   Decision tree
   ─────────────

   ┌─ English, general purpose, hosted OK ──────────────┐
   │  → text-embedding-3-small (OpenAI)                  │
   │  → 1536 dim, $0.02/M tokens, strong baseline        │
   └─────────────────────────────────────────────────────┘

   ┌─ Multilingual or domain-specific ──────────────────┐
   │  → Cohere embed-v3 / multilingual-MiniLM           │
   └─────────────────────────────────────────────────────┘

   ┌─ Privacy / on-device ──────────────────────────────┐
   │  → sentence-transformers (local, smaller)          │
   └─────────────────────────────────────────────────────┘

   ┌─ Code or technical text ───────────────────────────┐
   │  → text-embedding-3-large or Voyage code-2         │
   └─────────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — what to optimise.** Three things matter most: recall on your domain (does similar-meaning text actually cluster?), dimensions (storage cost per row), price (per-million tokens). Test recall on a hand-curated query/expected-doc pair set before committing.

**Layer 2 — buffr's likely choice.** `text-embedding-3-small` is the planned default in the curriculum (`B2A.3`). 1536 dimensions × 4 bytes = ~6KB per row. For 10k journal entries: 60MB of vectors. Cheap to embed: 10k entries averaging ~300 tokens = 3M tokens = $0.06.

```
   Buffr's planned embedding profile
   ─────────────────────────────────
   model: text-embedding-3-small
   dimensions: 1536
   storage per entry: ~6KB
   embed cost: ~$0.06 for the full corpus (one-time)
   query cost: $0.000006 per query (one embedding call)
```

**Layer 3 — what changes by model.** Switching to `text-embedding-3-large` (3072 dim, $0.13/M) doubles storage and 6.5×s the cost for typically 5-10% better recall. Worth it for domains where every retrieval miss hurts; not worth it for personal journal corpora at buffr's scale.

### Move 3 — The principle

Embedding model is a deliberate, documented, version-tracked decision. The cost of getting it wrong is a corpus re-embed; the schema column for `model` is the hedge.

---

## Embedding model choice — diagram

```
┌─ Decision flow ────────────────────────────────────────────────────────┐
│                                                                        │
│   What's the use case?                                                 │
│       │                                                                │
│       ├── English, general, hosted ─→ text-embedding-3-small           │
│       ├── Multilingual ──────────────→ Cohere embed-v3 multilingual    │
│       ├── Privacy / on-device ──────→ sentence-transformers (local)    │
│       └── Code or technical text ───→ text-embedding-3-large / Voyage  │
│                                                                        │
│   For buffr: English-only journal prose, hosted is fine.               │
│   Choice: text-embedding-3-small (1536 dim, $0.02/M).                  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

   Migration shape (Case B):
   ─────────────────────────
   SELECT entry_id FROM entry_embeddings WHERE model != 'new-model';
   for each row: re-embed and update.
   incremental, resumable.
```

---

## In this codebase

**Case B — buffr has not committed to an embedding model yet.**

The Phase 2A `B2A.3` build is the deliberate choice. Default likely `text-embedding-3-small` based on:
- English-only corpus (buffr is English UI/data)
- Hosted is fine (no privacy concern beyond standard OpenAI ToS)
- 1536 dim is plenty for ~10k entries
- $0.02/M tokens makes both indexing and querying rounding-error cheap

The `entry_embeddings.model` column carries the choice and enables incremental migration if the choice changes.

---

## Elaborate

### Where this pattern comes from

The model-as-config pattern is standard in any vector-DB-shaped system. Pinecone's docs were the most prominent early documentation of "store the model with the vector" as a hedge against migration.

### The deeper principle

Any one-way decision should be tracked in the data so it's not also a one-way decision in the code.

### Where this breaks down

For very large corpora (>1M items), re-embedding becomes a multi-hour batch job — switching models is a planned migration, not a casual flip. For small corpora (buffr's 10k entries), switching is trivial.

### What to explore next

- [01-embeddings-geometrically](./01-embeddings-geometrically.md) — what an embedding actually is
- [09-stale-embeddings](./09-stale-embeddings.md) — staleness has the same shape as model-change (re-embed by query)
- [04-vector-databases](./04-vector-databases.md) — where the embeddings sit

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ text-embedding-3-small    │ text-embedding-3-large       │
├──────────────────┼───────────────────────────┼──────────────────────────────┤
│ Dimensions       │ 1536                      │ 3072                         │
│ Cost / M tokens  │ $0.02                     │ $0.13                        │
│ Storage/row      │ ~6KB                      │ ~12KB                        │
│ Recall (typical) │ baseline                  │ +5-10%                       │
└──────────────────┴───────────────────────────┴──────────────────────────────┘
```

### The breakpoint

Default to `text-embedding-3-small` for general English. Upgrade to `-large` when recall measurably matters (eval shows the smaller model misses queries the larger one catches at a rate that justifies the cost).

---

## Tech reference

- **`text-embedding-3-small`:** 1536 dim, $0.02/M tokens, OpenAI.
- **Cohere embed-v3:** ~1024 dim variants, multilingual, $0.10/M.
- **sentence-transformers (local):** MiniLM-L6 (384 dim), free, on-device.

---

## Project exercises

### B2A.3 — Pick the embedding model and document

- **Exercise ID:** `B2A.3`
- **What to build:** decision document at `docs/embedding-model-choice.md` naming the model, dimensions, cost, and revisit conditions.
- **Done when:** decision committed; future migration path described.
- **Estimated effort:** 1 hour.

---

## Summary

- Embedding model is a one-way decision; track in `entry_embeddings.model` to enable incremental migration.
- For buffr: likely `text-embedding-3-small` (English, hosted, 1536 dim, cheap).
- Upgrade conditions: eval-measured recall miss.

---

## Interview defense

**Q [mid]:** Why is the embedding model choice one-way?

**A:** Because vectors from different models aren't comparable — a query embedded with model A retrieves nothing useful from an index built with model B. Switching means re-embedding the entire corpus. The hedge is to store the model name with each row; the migration is then a query-and-rebuild.

**Q [senior]:** What criteria drive the choice?

**A:** Domain fit (test on a real query/expected-doc set), language coverage (English-only vs multilingual), dimensions (storage cost), hosting (API vs on-device), price. For buffr, all five point at `text-embedding-3-small`.

### One-line anchors

- One-way decision; store `model` per row to hedge.
- Buffr's planned default: `text-embedding-3-small`.
- Re-embed by query when model changes.

---

## Validate

### Quick check
- What column hedges against future model changes?
- What's the cost to embed buffr's full corpus once?
- What's the migration shape when changing models?
