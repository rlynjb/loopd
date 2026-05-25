# Incremental indexing

**Industry name(s):** Incremental indexing, delta indexing, live re-index
**Type:** Industry standard

> Two indexing patterns: full rebuild (re-embed everything periodically, swap) or incremental (embed only deltas, merge into index). Full rebuild is simple and correct; incremental is fast and complex. Pick by freshness needs and corpus size.

**See also:** → [09-stale-embeddings](./09-stale-embeddings.md) · → [04-vector-databases](./04-vector-databases.md) · → [11-rag](./11-rag.md)

---

## Why care

### Move 1 — The grounded scenario

Buffr's journal grows by a few entries per day. Every new entry needs an embedding. Two strategies: (a) full nightly rebuild — re-embed all 10k entries; takes hours of compute; freshness is one-day-stale at worst; (b) incremental — embed each new entry inline; freshness is realtime; harder to reason about consistency. For buffr's mobile, local-first architecture, incremental is the right shape — but the cost of "incremental" is that bugs in the path show up as silent staleness.

### Move 2 — Name the question the pattern answers

That when-do-I-rebuild question is what incremental indexing answers. Not "which is better" (workload-specific); just *what trade-offs apply between freshness, complexity, and consistency*.

### Move 3 — Why answering that question matters

**What breaks without thoughtful indexing strategy:** either nightly rebuild (slow freshness, simple) or incremental (fast freshness, easy to silently break). Buffr's planned approach is incremental: embed on entry-commit; mark stale on edit; refresh in idle pass.

### Move 4 — Concrete before/after

Without incremental indexing:
- Nightly rebuild → new entry not retrievable until tomorrow
- User searches for what they wrote 5 minutes ago → miss
- Reasonable for batch workloads; bad for journal UX

With incremental indexing:
- Entry created → embed inline → index updated immediately
- Edit entry → mark stale → re-embed in idle pass
- Realtime freshness

### Move 5 — The one-line summary

Full rebuild: simple, slow freshness. Incremental: fast freshness, harder to debug. Buffr → incremental (matches the broader local-first + idle-reconciler architecture).

---

## How it works

### Move 1 — The mental model

```
   ┌─ Full rebuild ────────────────────────────────┐
   │  Walk entire corpus → re-embed everything →    │
   │  swap index. Simple, correct, expensive.       │
   │  Run nightly or weekly.                        │
   └────────────────────────────────────────────────┘

   ┌─ Incremental indexing ────────────────────────┐
   │  Track changes (created, updated, deleted) →   │
   │  embed only the deltas → merge into index.     │
   │  Fast, complex, has consistency edge cases.    │
   └────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — incremental events.** Three event types: created, updated, deleted. Each triggers different index work. Created: embed and INSERT. Updated: mark stale (concept 09) and re-embed in idle pass. Deleted: soft-delete — set `entry_embeddings.deleted_at` to match the source. Queries filter `WHERE deleted_at IS NULL` (buffr's existing soft-delete pattern extends naturally to the embedding table).

```
   Buffr's planned event mapping
   ─────────────────────────────
   entry created:    embed inline at entry commit
                     INSERT INTO entry_embeddings (...)
   entry updated:    UPDATE entry_embeddings SET stale_at = now()
                     (idle pass picks up; concept 09)
   entry deleted:    UPDATE entry_embeddings SET deleted_at = now()
                     (queries filter via WHERE deleted_at IS NULL)
```

**Layer 2 — when full rebuild still earns its place.** When the embedding model changes (concept 02), every row needs re-embedding — that's a full rebuild whether you call it one or not. Make the migration idempotent and resumable: track `model` per row, query for rows where `model != current`, embed in batches, commit per batch.

**Layer 3 — consistency edge cases.** Race conditions: entry edited mid-embed; the in-flight embed succeeds with the old text, then stale_at gets set after, then idle pass finds it stale — this works but feels confusing. Use a single transaction for "set stale + start work" to avoid lost updates.

### Move 3 — The principle

Incremental for freshness-critical paths; full rebuild for migrations and disaster recovery. Buffr is incremental day-to-day; the migration path is full rebuild query-driven.

---

## Incremental indexing — diagram

```
┌─ Buffr's planned indexing events ──────────────────────────────────────┐
│                                                                        │
│   entry created (commit)                                               │
│         │                                                              │
│         ▼ inline                                                       │
│   INSERT INTO entry_embeddings (entry_id, embedding, model, stale_at)  │
│                                                                        │
│   entry updated                                                        │
│         │                                                              │
│         ▼                                                              │
│   UPDATE entry_embeddings SET stale_at = now() WHERE entry_id = ?      │
│         │                                                              │
│         ▼ idle pass picks up                                           │
│   re-embed → UPDATE embedding, stale_at = NULL                         │
│                                                                        │
│   entry deleted (soft)                                                 │
│         │                                                              │
│         ▼                                                              │
│   UPDATE entry_embeddings SET deleted_at = now() WHERE entry_id = ?    │
│                                                                        │
│   Model migration (rare)                                               │
│         │                                                              │
│         ▼                                                              │
│   SELECT entry_id FROM entry_embeddings WHERE model != current         │
│   batch re-embed all                                                   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not index today.**

`B2A.4` and `B2A.12` cover incremental indexing. The deletion handling extends buffr's existing soft-delete pattern (every entity has `deleted_at`); the embedding table will follow the same shape.

---

## Elaborate

### Where this pattern comes from

Search-engine indexing has used both patterns for decades; Lucene's segment-based design is incremental with periodic merges (the closest cross-domain analogue).

### The deeper principle

Incremental wins on freshness; batch wins on simplicity. Most production systems are incremental + periodic background merge.

### Where this breaks down

For very small corpora where re-embed cost is trivial, full rebuild on every change is simpler. For very high-write corpora, incremental events can swamp the idle reconciler.

### What to explore next

- [09-stale-embeddings](./09-stale-embeddings.md) — the "updated" event detail
- [04-vector-databases](./04-vector-databases.md) — where the index lives

---

## Tradeoffs

The breakpoint: incremental for live-freshness needs; batch when stale-by-N-hours is acceptable.

---

## Tech reference

- **Soft delete:** existing buffr pattern via `deleted_at` columns.
- **Idle scheduling:** existing buffr pattern via `AppState` and `useFocusEffect`.

---

## Project exercises

### B2A.4 + B2A.12 — Incremental embed events

- **What to build:** wire entry create/update/delete to the corresponding embedding-table operations.
- **Done when:** all three events propagate to the embedding table within expected windows.
- **Estimated effort:** included in B2A.4.

---

## Summary

- Incremental: freshness, complexity.
- Batch: simplicity, slow freshness.
- Buffr → incremental, matches broader architecture.
- Model migration is the one batch case.

---

## Interview defense

**Q [mid]:** Why incremental for buffr but not for everyone?

**A:** Buffr is local-first with mobile compute constraints and user-visible journal entries. Realtime freshness matters (user searches for what they just wrote); battery cost of nightly rebuilds isn't worth it. For a server-side batch system processing logs, the opposite — nightly rebuild is fine because freshness in minutes isn't required.

### One-line anchors

- Three events: created, updated, deleted.
- Each maps to an index operation.
- Incremental for freshness; batch for migrations.

---

## Validate

### Quick check
- What three events drive the index?
- How does buffr handle soft deletes in the embedding table?
- When does full rebuild apply?
