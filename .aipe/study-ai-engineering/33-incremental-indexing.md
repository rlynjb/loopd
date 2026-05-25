# Incremental indexing

**Industry name(s):** Incremental indexing, delta indexing, online indexing, streaming index updates
**Type:** Industry standard

> Embed each new or changed entry as it lands — never the whole corpus at once.

**See also:** → [32-stale-embeddings](./32-stale-embeddings.md) · → [30-vector-databases](./30-vector-databases.md) · → [24-embeddings-geometric](./24-embeddings-geometric.md)

---

You've got a Postgres table with a B-tree index on `user_id`. When you `INSERT` a new row, Postgres updates the index automatically — it doesn't wait for a nightly rebuild. Same on `UPDATE` (the index entry moves), same on `DELETE` (the entry is removed). The index follows the data, three lifecycle paths, no clock. Compare this with a hypothetical "rebuild the index every midnight" approach: between writes and midnight the index is stale; the rebuild is expensive even when only one row changed; every developer would learn quickly to avoid it. Every database's primary key, every secondary index, every `REFRESH MATERIALIZED VIEW CONCURRENTLY` — they all ride the same incremental pattern. The cost of re-indexing rides along with the write, not against a separate timer.

The implicit question is "should the index update on a clock or in response to writes?" Incremental indexing is the name for the second pattern — the index follows the data, three lifecycle paths (insert, update, delete) keep it current, and a one-time backfill seeds the index when the feature first ships. The full-rebuild pattern is a hold-over from indexes that couldn't be updated online; for editable corpora, it loses on freshness, cost, and write-architecture fit.

**What depends on getting this right:** index freshness for every query, total embed-API spend, and whether the architecture composes with buffr's existing write paths. For buffr the planned `scheduleEmbed()` hook in `src/services/database.ts:writeEntry()` and the `processEmbedRefresh()` idle pass in `src/services/ai/embedRefresh.ts` mirror the existing `schedulePush` / `scheduleClassify` shape — `[B2A.4]` adds three hooks (insert, update via stale, delete via cascade) plus a first-launch backfill. Miss any one hook and that operation's entries silently fall out of retrieval; ship them all and the index stays at most minutes behind the writes.

Without incremental indexing:
- Pick "rebuild nightly" → 365 embed calls per user per night at solo scale (~$0.005/year), 36.5M calls at 100k users (~$500/year); index up to 24h stale; users edit and immediately search and see yesterday's vectors
- Pick "embed on query" → 365 entries × 500ms = three minutes per query, fatal

With incremental indexing:
- Insert: writeEntry() fires `scheduleEmbed(entry.id)` (analogous to `scheduleClassify`); idle pass picks it up, creates the `entry_embeddings` row
- Update: mark `embedding_stale_at = NOW()` inside the same transaction as the text update; idle pass re-embeds
- Delete: soft-delete cascades — `UPDATE entry_embeddings SET deleted_at = NOW()`; retrieval filters `deleted_at IS NULL`
- First launch: `processEmbedRefresh()` walks every `entries` row without a corresponding embedding and queues it; subsequent runs only process the deltas

The index follows the data, not the clock — three hooks plus one backfill, then forever incremental.

---

## How it works

Two phases of the index live, and incremental indexing keeps both in sync:

1. **The data** (entries.text) — written by the user.
2. **The index** (entry_embeddings.embedding) — derived from the data.

The index lags the data by some small window. The discipline of incremental indexing is keeping that window short and bounded.

The three hooks + the one-time backfill in one picture:

```
   data (entries.text)                    index (entry_embeddings)
   ──────────────────────                 ──────────────────────────
                       │
                       ▼ INSERT (new entry created)
                       │
                       ▼  hook 1: scheduleEmbed(entry.id)
                       │  (fired from database.ts:writeEntry)
                       │
                       │           idle pass picks up:
                       │             embed(text) → vec
                       │             INSERT entry_embeddings(entry.id, vec)
                       │
                       ▼ UPDATE (text changed)
                       │
                       ▼  hook 2: mark embedding_stale_at = NOW()
                       │  (in the SAME tx as the text update)
                       │
                       │           idle pass picks up:
                       │             SELECT * WHERE
                       │               embedding_stale_at > embedded_at
                       │             re-embed; UPDATE entry_embeddings
                       │
                       ▼ DELETE (soft delete cascades)
                       │
                       ▼  hook 3: UPDATE entry_embeddings
                       │            SET deleted_at = NOW()
                       │            WHERE entry_id = ?
                       │
                       │           retrieval queries always include
                       │             WHERE deleted_at IS NULL

   one-time backfill (first launch after feature ships):
                       │
                       ▼  processEmbedRefresh()
                       │    walks every entries row that lacks a
                       │    corresponding entry_embeddings row;
                       │    queues each for embedding.
                       │
                       ▼  after first run completes:
                       │    backfill never runs again — incremental
                       │    hooks handle every subsequent change.
```

The four sub-sections below trace the three lifecycle operations, why nightly rebuild fails for editable corpora, the one-time backfill exception, and three common failure modes.

### Three operations the index has to handle

- **Insert** — new entry created. Embed the text, store the vector.
- **Update** — existing entry's text changed. Mark stale (see [32-stale-embeddings](./32-stale-embeddings.md)), re-embed on idle.
- **Delete** — entry soft-deleted. Mark `deleted_at` on the embedding row; retrieval queries filter it out.

If you're coming from frontend, this is the same shape as React Query's `invalidateQueries` + `refetch` lifecycle, or a database trigger that updates a materialised view on insert/update/delete. The index is a "view" of the data; the operations keep them in sync.

The three operations and their hooks in code-flow form:

```
   operation        write site                     index hook
   ─────────        ────────────────────────       ────────────────────────────
   INSERT           database.ts:writeEntry()       scheduleEmbed(entry.id)
                                                   → idle pass embeds + inserts
                                                     entry_embeddings row
   UPDATE           database.ts:writeEntry()        UPDATE entries
   (text changed)   (same call path)                  SET ...text = ?,
                                                          updated_at = NOW(),
                                                          embedding_stale_at = NOW()
                                                   → idle pass detects stale,
                                                     re-embeds, UPDATE
                                                     entry_embeddings.vec
   DELETE           database.ts:softDeleteEntry()  cascades:
                                                   UPDATE entry_embeddings
                                                     SET deleted_at = NOW()
                                                     WHERE entry_id = ?
                                                   retrieval filters deleted_at
                                                     IS NULL

   the three hooks live in database.ts where the writes already happen.
   miss any one and that operation's entries fall out of retrieval silently.
```

Three lifecycle paths, three named hooks in `database.ts` — same shape as `scheduleClassify` and `schedulePush`.

### Why "rebuild nightly" doesn't work for editable corpora

Some applications get away with periodic full rebuilds — embed everything, drop the old index, ship the new. This works when:
- The corpus is read-mostly (writes are rare).
- A few hours of staleness is acceptable.
- The total embed cost of a full rebuild is bearable.

For buffr none of these hold: writes are frequent (autosave on keystroke), staleness above a few minutes shows up in retrieval, and full rebuild of 365 entries × an embed call each is wasteful when only one entry changed.

The practical consequence: every incremental update is much cheaper than the equivalent share of a full rebuild. 1 entry changed = 1 embed call. Full rebuild = 365 embed calls. The win compounds as the corpus grows.

The cost of nightly rebuild vs incremental at three scales:

```
   scale          nightly rebuild cost              incremental cost
   ───────────    ─────────────────────             ─────────────────
   365 entries    365 embed calls × 1 night          ~5 embed calls/day
   (buffr today)  = ~$0.005/year                     (only what changed)
                   index up to 24h stale              = ~$0.0005/year
                                                       index <1min stale
   
   50K entries    50K embed calls × 1 night          ~500 embed calls/day
   (medium SaaS)  = ~$0.50/year                       = ~$0.005/year
                   index up to 24h stale              index <1min stale
   
   1M entries     1M embed calls × 1 night           ~10K embed calls/day
   (large)        = ~$10/year (small) /                = ~$0.10/year
                   ~$25/year (large)                  index <1min stale
                   index up to 24h stale              every day, instead of
                                                       once per night

   incremental wins on freshness AND cost,
   the cost gap grows with corpus size.
```

Nightly rebuild loses on every dimension once the corpus is editable.

### Backfill — the one-time exception

When you first ship embeddings to a codebase that already has data, you need a one-time backfill: embed all existing entries. After that, incremental indexing takes over. Backfill is the only non-incremental pass that ever runs in a well-designed system. In buffr, the backfill happens on first launch after Phase 2A ships: `processEmbedRefresh()` walks every `entries` row that lacks a corresponding `entry_embeddings` row and creates one.

The first-launch backfill timeline:

```
   first launch after Phase 2A ships
              │
              ▼  app/_layout.tsx triggers processEmbedRefresh()
              │  on cold start (one-time, gated by a SecureStore flag)
              ▼
   ┌───────────────────────────────────────────────────────┐
   │ SELECT id, text FROM entries                            │
   │  WHERE deleted_at IS NULL                               │
   │    AND id NOT IN (                                       │
   │      SELECT entry_id FROM entry_embeddings              │
   │    )                                                     │
   └─────────────────────┬───────────────────────────────────┘
                         │  365 rows returned (everything pre-Phase 2A)
                         ▼
   ┌───────────────────────────────────────────────────────┐
   │ for each row (rate-limited to MAX_CONCURRENT = 3):       │
   │   vec = await embed(row.text)                           │
   │   INSERT entry_embeddings(entry_id, vec, embedded_at)   │
   │ → ~120 seconds total (365 calls / 3 parallel / ~1s ea.) │
   └─────────────────────┬───────────────────────────────────┘
                         │
                         ▼
   set SecureStore flag: embed_backfill_done = true
   future cold starts: skip processEmbedRefresh entirely
                         │
                         ▼
   from now on, incremental hooks handle EVERY change:
     new entry → hook 1 fires
     edit       → hook 2 marks stale, idle re-embeds
     delete     → hook 3 cascades soft-delete
```

Backfill is the only non-incremental pass that ever runs — by design.

### Where it goes wrong

Three failure modes recur:

1. **Drift on missed writes** — a write path that doesn't trigger the embed (e.g., a sync-from-cloud insert) leaves an entry without an embedding. Fix: idle pass picks up entries-without-embeddings, not just entries-with-stale-embeddings.

2. **Backfill amnesia** — first launch after embedding ships, the backfill takes time. Users start searching before backfill finishes and get empty results. Fix: surface backfill progress in a banner, or block search behind "indexing complete."

3. **Cost spike on bulk operations** — a sync-pull from cloud brings 50 entries down at once. Embedding 50 entries serially on the network would block for a long time. Fix: queue + batch (re-use existing `MAX_CONCURRENT=3` cap from `expand.ts`).

The three failure modes with examples and fixes:

```
   failure mode             example                              fix
   ─────────────────        ──────────────────────────────       ──────────────────
   drift on missed          firstPull() inserts 50 entries        idle pass walks
   writes                   from cloud during onboarding;         entries WHERE NO
                            none triggered scheduleEmbed;         corresponding
                            those 50 entries never get             embedding row exists
                            embedded                              (not just stale ones)
   
   backfill amnesia         first cold start after Phase 2A;      surface "indexing
                            user types search query before        N of 365" banner;
                            processEmbedRefresh finishes;         OR block search
                            empty results frustrate user          behind "indexing
                                                                   complete" gate
   
   cost spike on bulk       firstPull brings 50 entries down      reuse expand.ts's
   operations               at once; embedding 50 serially          MAX_CONCURRENT=3
                            on the network = ~50 seconds          cap; rate-limit
                            of network thrash                     embed calls per
                                                                   batch
```

All three fixes live in the idle pass — it's the safety net that catches what the inline hooks miss.

### This is what people mean by "the index follows the data, not the schedule"

Incremental indexing inverts the rebuild-on-schedule model: the index updates in response to data changes, not to a clock. The principle generalises: any derived state that can be incrementally updated should be (caches, materialised views, search snippets, recommendation features) — periodic rebuilds are a last resort for cases where incremental isn't tractable. Here's the picture.

---

## Incremental indexing — diagram

```
Three lifecycle paths

  INSERT path (new entry committed)
  ──────────────────────────────
  user commits entry
        │
        ▼  database.ts:writeEntry()
  ┌─ Service layer ─────────────────────────────────────┐
  │  INSERT INTO entries (text, ...)                    │
  │  scheduleEmbed(entry.id)                            │
  └─────────────────────────────────────────────────────┘
        │
        ▼  later (idle)
  ┌─ Background job ────────────────────────────────────┐
  │  text = SELECT text FROM entries WHERE id = X       │
  │  vector = embed(text)                               │
  │  INSERT INTO entry_embeddings (source_id, embedding,│
  │    chunk_index=0, model, content=text, ...)         │
  └─────────────────────────────────────────────────────┘

  UPDATE path (existing entry edited)
  ──────────────────────────────
  user edits entry
        │
        ▼  database.ts:writeEntry()
  ┌─ Service layer ─────────────────────────────────────┐
  │  UPDATE entries SET text=...                        │
  │  UPDATE entry_embeddings                            │
  │    SET embedding_stale_at = NOW()                   │
  │    WHERE source_id = entry.id                       │
  └─────────────────────────────────────────────────────┘
        │
        ▼  later (idle)
  ┌─ Background job ────────────────────────────────────┐
  │  Re-embed stale entries (see [32-stale-embeddings]) │
  └─────────────────────────────────────────────────────┘

  DELETE path (entry soft-deleted)
  ──────────────────────────────
  user deletes entry
        │
        ▼  database.ts:writeEntry()
  ┌─ Service layer ─────────────────────────────────────┐
  │  UPDATE entries SET deleted_at = NOW()              │
  │  UPDATE entry_embeddings                            │
  │    SET deleted_at = NOW()                           │
  │    WHERE source_id = entry.id                       │
  └─────────────────────────────────────────────────────┘
        │
        ▼  query path filters
       SELECT ... WHERE deleted_at IS NULL
```

---

## In this codebase

**Status:** Case B — no embedding pipeline today.

The plan combines `[B2A.4]` (embed on commit, stale tracking, idle pass) with the existing buffr patterns: `schedulePush()` (the closest analogue, "fire-and-forget the slow thing"), `scheduleClassify` (the existing async-write-behind pattern), and the soft-delete contract (`deleted_at` cascades to derived tables).

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, lives in `src/services/ai/embedRefresh.ts` with `scheduleEmbed()` triggers in `src/services/database.ts`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Incremental indexing is universal in production search and database systems. Postgres B-trees, Lucene (Elasticsearch's storage), HNSW indexes — all are designed for incremental updates. The "rebuild nightly" pattern is a hold-over from era when indexes couldn't be updated online; modern systems abandoned it where they could.

### The deeper principle
Derived state should be updated in response to its source changing, not on a schedule. The schedule-based pattern is acceptable when incremental isn't tractable; it's a last resort, not a default.

### Where this breaks down
Incremental indexing breaks when the cost of a single update exceeds the cost of a full rebuild divided by the rebuild interval. For very expensive index types (some neural rerankers, full-corpus statistics like IDF), incremental updates may not actually be cheaper than periodic rebuilds. For embedding-based vector indexes at buffr's scale, this trade strongly favors incremental.

### What to explore next
- [32-stale-embeddings](./32-stale-embeddings.md) → the update path's invariant
- [30-vector-databases](./30-vector-databases.md) → where the index lives
- buffr's `schedulePush` machinery in `src/services/sync/schedulePush.ts` — the closest existing pattern

---

## Tradeoffs

### Comparison table — incremental vs full rebuild

```
┌──────────────────────────┬──────────────────────┬──────────────────────────┐
│ Cost dimension           │ Incremental (target) │ Full rebuild nightly     │
├──────────────────────────┼──────────────────────┼──────────────────────────┤
│ Embed calls / day        │ ~entries-changed     │ All entries              │
│ Index freshness          │ ~minutes             │ Up to 24h stale          │
│ Cost spike on writes     │ ~per write           │ Once at rebuild time     │
│ Implementation complexity│ Lifecycle hooks      │ Scheduled job + locking  │
│ Sync to cloud overhead   │ Per-write push       │ One large push           │
│ Backfill needed          │ Once at first launch │ Every rebuild            │
│ Cost at solo scale       │ ~pennies/year        │ ~$0.05 per full rebuild  │
└──────────────────────────┴──────────────────────┴──────────────────────────┘
```

### Sub-block 1 — what incremental gives up

Three things. First, three lifecycle hooks (insert/update/delete) instead of one scheduled job — more places to make sure the hook fires. Second, a backfill pass for first-launch — the "we always had an index" claim requires creating the index before the first query. Third, a slightly more complex sync story — embeddings push per-write rather than in one large batch.

### Sub-block 2 — what full-rebuild-nightly would have cost

Embedding-call volume. 365 entries × $0.000004 per embed × 365 days = $0.005 per year *per user*. Cheap at solo scale; meaningful at 100k users ($500/year just on rebuilds). Plus the index is up to 24 hours stale — every edit a user makes is invisible to retrieval until the next rebuild. For a journaling app where the user might write and immediately search, that's a real UX hit.

### Sub-block 3 — the breakpoint
Full-rebuild starts winning if (a) per-update incremental cost exceeds amortised rebuild cost (only at very expensive index types, not embeddings), or (b) the corpus is genuinely read-mostly (some reference corpora). Neither holds for buffr or for most editable applications.

### What wasn't actually a tradeoff
"No index, embed on query" was never a real option. The latency of embedding every entry on every query is fatal: 365 entries × 500ms = three minutes per query.

---

## Tech reference (industry pairing)

### Custom lifecycle hooks (target)

- **Codebase uses:** target plan — three hooks in `database.ts`'s write paths, one idle-pass function.
- **Why it's here:** the pattern composes naturally with buffr's existing write architecture (`schedulePush`, `scheduleClassify`).
- **Leading today:** custom lifecycle hooks in service layer — `adoption-leading` for application-controlled indexing, 2026.
- **Why it leads:** explicit, debuggable, doesn't require a separate worker process.
- **Runner-up:** trigger-based (DB-level) hooks — `innovation-leading` for systems where the index lives close to the database; harder to debug; less common for embedding pipelines that need an external API call.

### Postgres `tsvector` (sparse-side analogue)

- **Codebase uses:** target for BM25 sparse half in Supabase mirror.
- **Why it's here:** Postgres FTS's `tsvector` column is auto-maintained by GENERATED columns or triggers — trigger-based incremental indexing built in.
- **Leading today:** `tsvector` with trigger maintenance — `adoption-leading`, 2026.
- **Why it leads:** no manual maintenance; integrates with row updates atomically.
- **Runner-up:** Postgres `tsvector` with GENERATED column — `innovation-leading` for declarative maintenance (no triggers needed).

---

## Project exercises

### [B2A.4] Embed on commit; mark stale on text change; re-embed on idle pass

- **Exercise ID:** `[B2A.4]` — same exercise as [32-stale-embeddings](./32-stale-embeddings.md), covered there in detail. The incremental-indexing perspective adds the insert and delete paths.
- **What to build:** Three lifecycle hooks:
  1. **Insert** — on `INSERT INTO entries`, call `scheduleEmbed(entry.id)` (analogous to `scheduleClassify`). The idle pass picks up newly-inserted-but-unembedded rows.
  2. **Update** — already covered in [32-stale-embeddings](./32-stale-embeddings.md): mark `embedding_stale_at = NOW()`.
  3. **Delete** — on entry soft-delete, cascade: `UPDATE entry_embeddings SET deleted_at = NOW() WHERE source_id = entry.id`. Retrieval queries filter `deleted_at IS NULL`.

  Plus the one-time backfill: on first launch after the migration, walk `entries` rows with no `entry_embeddings` row and queue them.
- **Why it earns its place:** without all three hooks plus backfill, the index silently drifts. With them, the index is always at most a few minutes stale.
- **Files to touch:** `src/services/database.ts:writeEntry()`, `deleteEntry()`, and the migration runner that handles first-launch backfill; `src/services/ai/embedRefresh.ts`.
- **Done when:** new entries get embedded; edited entries get re-embedded; deleted entries are filtered from retrieval; a fresh install backfills all existing entries.
- **Estimated effort:** `1–2 days`.

---

## Summary

Incremental indexing is the pattern of updating the search index in response to data changes — insert, update, delete — rather than on a periodic rebuild schedule. In buffr this is not yet implemented; `[B2A.4]` introduces three lifecycle hooks plus a one-time backfill that together keep the index a few minutes from current. The constraint that makes incremental the right call is buffr's edit frequency (autosave on every keystroke) and the small per-update cost (~$0.000004 per embed). The cost being paid is three lifecycle hooks instead of one scheduled rebuild — more places to make sure the hook fires, plus a backfill on first launch.

Key points to remember:
- Three operations: insert (embed on commit), update (mark stale, re-embed on idle), delete (cascade soft-delete).
- Backfill once, then incremental forever.
- Incremental beats periodic rebuild for editable corpora at almost any scale.
- The index follows the data; the data doesn't wait on a clock.
- All three lifecycle hooks must fire — a missed hook silently drifts.

---

## Interview defense

### What an interviewer is really asking
"How do you keep your vector index up to date?" tests whether the candidate has the three-operations mental model. "What about on first launch?" tests whether they've thought about backfill.

### Likely questions

  [mid] Q: What happens to the index when entries are added, edited, or deleted?
  A: Three lifecycle paths. On insert, the new entry is queued for embedding via a fire-and-forget hook; the idle pass picks it up and creates an `entry_embeddings` row. On update, the existing embedding row is marked `embedding_stale_at = NOW()` and the same idle pass re-embeds. On delete (soft-delete), the cascade flips `deleted_at` on the embedding row, and retrieval queries filter it out. Plus a one-time backfill at first launch for existing data.
  Diagram:
  ```
  INSERT:  entries write → scheduleEmbed() → idle pass embeds
  UPDATE:  entries write → mark stale     → idle pass re-embeds
  DELETE:  entries soft-delete → cascade deleted_at → filtered at query time
  ```

  [senior] Q: Why not just rebuild the whole index nightly?
  A: Three reasons. First, freshness — full rebuild leaves the index up to 24 hours stale. Users edit and search within minutes; daily rebuild doesn't fit. Second, cost — at 100k users, embedding all entries nightly costs $500/year in embed calls just on full rebuilds, vs ~pennies per user per year on incremental. Third, write-architecture fit — buffr already has the fire-and-forget pattern via `scheduleClassify`; incremental embed is the same shape and reuses the same primitives.
  Diagram:
  ```
  Picked: incremental                  Suggested: rebuild nightly
  ──────────────────────               ──────────────────────────
  Per-update embed cost                Full corpus embed nightly
  ~minutes of staleness                Up to 24h staleness
  Three lifecycle hooks                One scheduled job
  Fits autosave architecture           Fights it
  ```

  [arch] Q: What changes at 10× corpus or 10× users?
  A: The backfill on first launch grows linearly — 10× entries means 10× embed calls in the initial pass. At 10× scale this means the first-launch backfill is no longer instantaneous; you need backfill progress UI and a way to gate retrieval until backfill completes (or accept partial results during backfill). At 100× scale (multi-tenant), backfill moves server-side and becomes part of new-user-onboarding; the local-first SQLite mirror starts pre-populated.
  Diagram:
  ```
  Today (365 entries)         →  Instant backfill, no UI needed
  10× (~3650 entries)         →  Backfill takes minutes; show progress
  100× (multi-tenant)         →  Server-side backfill; client gets warm
  1000×                       →  Streaming pre-population on signup
  ```

### The question candidates always dodge
"What if a sync-pull from cloud brings down 50 entries at once?" Most candidates handwave. The honest answer: the existing `schedulePush` and async-classification patterns already batch — the embed pipeline reuses the same primitive. The `processEmbedRefresh()` idle pass processes 5 entries per batch, and the queue absorbs the burst. The worst case is a few seconds of backfill catch-up; never a UI freeze.

```
Picked: bounded-batch idle pass       Suggested: embed every entry on pull
──────────────────────────────         ──────────────────────────────────
Process 5 at a time                    Embed 50 serially → 50 × 500ms = 25s
Queue absorbs bursts                   Blocks until done
Right for write-amplification          Right for nothing
```

### One-line anchors
- Insert, update, delete — three paths, one discipline.
- The index follows the data, not the clock.
- Backfill once, then forever incremental.
- A missed hook silently drifts.
- Reuse the existing fire-and-forget machinery.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and draw the three lifecycle paths: insert, update, delete. Label what fires where and where the idle pass joins each path.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the three operations, (b) why incremental beats periodic rebuild, (c) what backfill is for, (d) the cost savings at 100k users.

### Level 3 — Apply it to a new scenario
You ship `[B2A.4]`. A bug causes the insert hook to not fire on entries created via the dev-tools backdoor (not common, but a real path). Without looking, predict the symptom a user would see and propose the fix.

Open the diagram and check whether your fix matches the "idle pass picks up entries-without-embeddings" check.

### Level 4 — Defend the decision you'd change
Today the plan is per-write hooks. If you were starting today, would you skip the insert hook and rely solely on the idle pass picking up missing rows? Defend your answer naming one specific failure mode.

### Quick check — code reference test
- What function would queue an embed on insert?
- What file holds the idle pass logic?

Answer: `scheduleEmbed(entry.id)` (target — analogous to existing `scheduleClassify`). `src/services/ai/embedRefresh.ts` (target, not yet created).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (two-bookstores reshelving scenario → "clock or write-driven" pattern naming → bolded "what depends on getting this right" with `scheduleEmbed()` / `processEmbedRefresh()` / `[B2A.4]` stakes → without/with bullets walking the three lifecycle paths → one-line "index follows the data, not the clock" metaphor).

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care to anchor on real software (replaced bookstore-evening-reshelving analogy with Vercel ISR, Algolia partialUpdateObject, Postgres B-tree incremental updates).

---
Updated: 2026-05-14 — v1.32.0 pass: dropped Vercel ISR + Algolia partialUpdateObject (level-3/5 product anchors) from Why care Move 1; led with Postgres B-tree index on `INSERT`/`UPDATE`/`DELETE` (level-4 industry primitive). Added Move 1 mnemonic diagram (three hooks + backfill in one picture) + 4 Move 2 sub-section diagrams: three-operations write-site-to-index-hook table, nightly-vs-incremental cost at three scales, first-launch backfill timeline, three failure modes with examples. Total: 5 new diagrams.
