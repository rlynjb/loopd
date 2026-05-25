# Stale embeddings

**Industry name(s):** Stale embeddings, embedding freshness, re-embed-on-edit
**Type:** Industry standard

> When the underlying text changes, the old embedding still maps to old meaning. Retrieval succeeds against stale content. Mitigation: track `embedding_stale_at` per row, mark stale on text change, re-embed in an idle pass.

**See also:** → [01-embeddings-geometrically](./01-embeddings-geometrically.md) · → [10-incremental-indexing](./10-incremental-indexing.md) · → [11-rag](./11-rag.md)

---

## Why care

### Move 1 — The grounded scenario

Day 1: user writes "We use Sequelize ORM." Embedding gets stored. Day 30: user edits the entry to "We use Drizzle ORM." Buffr's embedding pipeline doesn't re-embed automatically. Query "what ORM do we use?" retrieves the day-1 embedding, which still maps to "Sequelize" — wrong answer.

### Move 2 — Name the question the pattern answers

That when-to-re-embed question is what stale embeddings answer. Not "how often should I re-embed everything" (wasteful); just *how do I know which specific rows need re-embedding and when*.

### Move 3 — Why answering that question matters

**What breaks without staleness tracking:** the index drifts silently. Retrieval returns confident-looking results based on outdated content. For buffr's planned `entry_embeddings`, the `embedding_stale_at` column is the marker; re-embed only rows where stale_at is non-null.

### Move 4 — Concrete before/after

Without staleness tracking:
- Edit entry → embedding stays stale → retrieval miss or wrong answer
- Mitigations: re-embed everything nightly (wasteful)

With staleness tracking:
- Edit entry → set `embedding_stale_at = now()`
- Idle pass: SELECT rows where stale_at IS NOT NULL → re-embed → clear stale_at
- Incremental, cheap

### Move 5 — The one-line summary

Track `embedding_stale_at` per row; mark stale on text change; re-embed in an idle pass; clear the flag on success.

---

## How it works

### Move 1 — The mental model

```
   Day 1:                    Day 30 (after edit, before re-embed):
   ──────                    ──────────────────────────────────────
   text: "Sequelize ORM"     text: "Drizzle ORM"
   embedding: e_v1           embedding: still e_v1   ← stale
   stale_at: null            stale_at: 2026-05-24    ← marked

   Idle pass:                Day 30 (after re-embed):
   ──────────                ─────────────────────────
   SELECT entries WHERE      text: "Drizzle ORM"
     embedding_stale_at IS   embedding: e_v2         ← fresh
     NOT NULL                stale_at: null
   re-embed; clear stale_at
```

### Move 2 — The layered walkthrough

**Layer 1 — schema and triggers.** `entry_embeddings.embedding_stale_at TEXT NULL`. Set to `now()` whenever the source `entries.text` is updated. Cleared to `NULL` after successful re-embed. In buffr's planned shape, the trigger is in the application code (the entry-update path also UPDATEs `entry_embeddings.embedding_stale_at = now()` in the same transaction).

**Layer 2 — when re-embeds happen.** Three patterns: (a) immediate (re-embed inline on text change — blocks the save); (b) idle pass (re-embed in a background task when app is idle — buffr's likely choice); (c) on-query (re-embed lazily when the row is retrieved — works for low-query corpora but bad UX during the re-embed). Buffr's local-first + small corpus → idle pass.

```
   Buffr's planned freshness flow
   ──────────────────────────────
   entries.text updated  →  UPDATE entry_embeddings
                              SET embedding_stale_at = datetime('now')
                            WHERE entry_id = ?

   Background idle task (every N minutes when app foregrounded):
     SELECT entry_id FROM entry_embeddings
     WHERE embedding_stale_at IS NOT NULL
     LIMIT 10;
     for each: embed; UPDATE with new embedding + stale_at = NULL.
```

**Layer 3 — coupling with sync.** When the embedding refreshes, sync to cloud (Postgres pgvector mirror) on the same `schedulePush()` debounce. Otherwise the cloud-side stays stale.

### Move 3 — The principle

Stale tracking is the difference between a useful index and a misleading one. Mark on change; re-embed lazily; clear on success.

---

## Stale embeddings — diagram

```
┌─ Lifecycle of an embedding row ────────────────────────────────────────┐
│                                                                        │
│   row created:      embedding = embed(text), stale_at = NULL           │
│         │                                                              │
│         │  entry.text updated                                          │
│         ▼                                                              │
│   stale:            embedding = old, stale_at = now()                  │
│         │                                                              │
│         │  idle pass picks up                                          │
│         ▼                                                              │
│   refreshing:       running embed(new_text)                            │
│         │                                                              │
│         │  re-embed succeeds                                           │
│         ▼                                                              │
│   fresh again:      embedding = new, stale_at = NULL                   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not have embeddings or staleness tracking.**

`B2A.2` schema includes `embedding_stale_at`. `B2A.4` build: embed on commit; mark stale on text change; re-embed in idle pass. The pattern matches buffr's broader "DB-first autosave + idle reconciler" architecture.

---

## Elaborate

### Where this pattern comes from

Cache invalidation is "one of the two hard things in computer science." Embedding-as-cache has the same shape: when source changes, invalidate the cache, re-compute when convenient.

### The deeper principle

Any derived data needs invalidation tracking. Whether it's a cache, an index, an embedding, or a search snapshot — the invariant is "when source changes, derived is wrong until refreshed."

### Where this breaks down

For very high-write corpora (every row updates daily), the constant re-embed cost may exceed the value. Threshold-based delays ("re-embed only after N updates") help. For buffr's append-mostly journal model (entries change rarely after the day), this isn't a problem.

### What to explore next

- [10-incremental-indexing](./10-incremental-indexing.md) — same shape, different operation
- [01-embeddings-geometrically](./01-embeddings-geometrically.md) — what gets re-computed

---

## Tradeoffs

The breakpoint: track staleness as soon as you have embeddings. There's no situation where "we'll skip stale tracking" is the right call.

---

## Tech reference

- **Column:** `embedding_stale_at TEXT NULL` (ISO timestamp or NULL).
- **Idle scheduler:** existing buffr pattern via `useFocusEffect` or an `AppState` listener.

---

## Project exercises

### B2A.4 — Embed on commit + idle re-embed pass

- **Exercise ID:** `B2A.4`
- **What to build:** wrap entry commit path to write/update `entry_embeddings`; add an idle task that picks up rows with stale_at; re-embeds.
- **Done when:** edits mark stale; idle pass clears stale within N minutes.
- **Estimated effort:** 4 hours.

---

## Summary

- Track `embedding_stale_at` per row.
- Mark stale on source text change.
- Re-embed in an idle pass; clear flag.
- Sync to cloud after refresh.

---

## Interview defense

**Q [mid]:** Why not re-embed everything nightly?

**A:** Wasteful at scale. 10k entries × $0.000002 per re-embed = trivial, but the compute and the user's battery on mobile aren't free, and the freshness-of-everything isn't actually needed. Incremental re-embed is cheaper AND more responsive (changes refresh in minutes, not on the next nightly cycle).

### One-line anchors

- Stale tracking = column per row.
- Mark on change; re-embed in idle pass; clear flag.
- Cache invalidation analogue at the embedding layer.

---

## Validate

### Quick check
- What column carries staleness?
- When does it get set?
- Who clears it?
