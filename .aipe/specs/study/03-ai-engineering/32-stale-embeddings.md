# Stale embeddings

**Industry name(s):** Stale-embedding problem, embedding freshness, vector-text drift
**Type:** Industry standard

> The bug nobody writes about until they've shipped RAG: queries returning what your entries USED to say.

**See also:** → [24-embeddings-geometric](./24-embeddings-geometric.md) · → [33-incremental-indexing](./33-incremental-indexing.md) · → [30-vector-databases](./30-vector-databases.md)

---

## Why care

A user edits an entry. They added a paragraph about a project pivot. The next week, they search for "pivot" — and the entry doesn't show up. The text says "pivot" right there. What happened? You forgot to re-embed when the text changed. The vector still represents what the entry said *before*. The retrieval pipeline is silently drifting.

The stale-embedding problem is the gap between "the text" and "the vector representing the text." Every system that embeds editable content has this problem. The pattern is the same shape as database index staleness, image-thumbnail caching, or pre-computed search snippets — derived state needs an invalidation mechanism. Without one, the derived state slowly diverges from truth and the system silently degrades. Here's how to track and fix it.

---

## How it works

The model is simple: every embedding is a fingerprint of one specific text. If the text changes, the fingerprint is wrong until you re-compute it. The engineering is making sure you don't forget.

### Two halves: detection and re-embedding

```
Half 1: Detection (mark stale)
  When user edits entry text:
    UPDATE entry_embeddings
    SET embedding_stale_at = NOW()
    WHERE source_id = entry.id

Half 2: Re-embedding (clear stale)
  Periodic job (idle pass, on app foreground, etc.):
    SELECT * FROM entry_embeddings WHERE embedding_stale_at IS NOT NULL
    For each: re-embed the current text → update embedding, NULL embedding_stale_at
```

If you're coming from frontend, this is the same shape as React Query's `staleTime`/`refetchOnMount` — mark as stale on mutation; refetch on next access. The discipline is just remembering to mark stale.

### Mark-stale-on-write — the load-bearing rule

The single highest-impact rule: *every write that changes embedded text must mark the embedding stale*. In loopd that's every path that mutates `entries.text` — currently the autosave on every keystroke (DB-first, see Principle 3 in `docs/spec.md`). The mark itself is cheap: one UPDATE per entry per edit-session, gated by some debounce.

If you skip mark-stale on even one write path, that path's edits silently drift in retrieval. The fix is to centralise — every entry-write goes through one function, and that function marks stale.

### Re-embed on idle — not on edit

Re-embedding on the keystroke that marked stale is bad — autosave runs on every keystroke; you'd re-embed dozens of times during a single edit session. The right shape is "mark stale immediately, re-embed later when idle." Options for "later":

1. **On app foreground** — every time the app comes to the foreground, kick off a background re-embed pass. Cheap, predictable.
2. **On idle timer** — fire a re-embed pass after N seconds of editor inactivity. More responsive; harder to test.
3. **On retrieval** — re-embed any stale entry lazily right before a query needs it. Worst — adds latency to every query.

The curriculum's `[B2A.4]` picks idle-pass shape. In loopd's existing async-classification pattern (`scheduleClassify`), there's already a model for "fire-and-forget the slow thing, write back when done" — re-embedding fits the same shape.

### What "stale" actually corrupts

The retrieval pipeline returns ranked entry IDs based on cosine similarity to the query. If the entry's vector represents *what it used to say*, the ranking is wrong by exactly the amount of drift. Three real cases:

1. **Topic added** — entry now mentions "pivot" but vector doesn't reflect it. Query for "pivot" misses it.
2. **Topic removed** — entry no longer mentions "Spice House" but vector still does. Query for "Spice House" surfaces an entry that no longer talks about it.
3. **Tone shifted** — entry was negative, user edited it to positive. Query for "good days" still ranks it as a bad-day entry.

### This is what people mean by "derived state must be invalidated"

The vector is derived state. Any derived state without an invalidation mechanism eventually lies. The principle generalises across caches, indexes, materialised views, and ML features — every "compute once, read many" pattern needs a way to know when "once" wasn't enough.

Here's the picture of the invalidate-then-recompute loop.

---

## Stale embeddings — diagram

```
The invalidate-then-recompute loop

  ┌─ UI layer ──────────────────────────────────────────┐
  │  User edits entry text                              │
  │  (autosave on keystroke, debounced)                 │
  └─────────────────────────────────────────────────────┘
              │
              ▼  writeEntry(entry.id, newText)
  ┌─ Service layer ─────────────────────────────────────┐
  │  UPDATE entries SET text = ..., updated_at = NOW()  │
  │  UPDATE entry_embeddings                            │
  │    SET embedding_stale_at = NOW()                   │
  │    WHERE source_id = entry.id                       │
  │  schedulePush() — cloud mirror                      │
  └─────────────────────────────────────────────────────┘
              │
              │  (later, on app idle or foreground)
              ▼
  ┌─ Background job ────────────────────────────────────┐
  │  SELECT * FROM entry_embeddings                     │
  │    WHERE embedding_stale_at IS NOT NULL             │
  │    ORDER BY embedding_stale_at ASC                  │
  │    LIMIT 5                                          │
  │  For each row:                                      │
  │    text = fetch entries.text                        │
  │    vector = embed(text)                             │
  │    UPDATE embedding = vector,                       │
  │           embedding_stale_at = NULL,                │
  │           model = "text-embedding-3-small"          │
  │    schedulePush()                                   │
  └─────────────────────────────────────────────────────┘
              │
              ▼  (rejoins normal query path, fresh)
       Retrieval queries now use up-to-date vectors
```

---

## In this codebase

**Status:** Case B — not implemented today (no embeddings yet).

The plan: `[B2A.4]` introduces the `embedding_stale_at` column on `entry_embeddings`, the mark-stale-on-write hook in `writeEntry()`, and the idle re-embed pass. The column shape mirrors the existing `synced_at`/`deleted_at` pattern — a TEXT timestamp that's either NULL (clean) or set (needs work).

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, mark-stale lives in `src/services/database.ts:writeEntry()`; re-embed pass in `src/services/ai/embedRefresh.ts`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Stale-derived-state invalidation is one of the oldest patterns in computer science — database materialised views, OS file caches, CPU caches. Embeddings are a recent surface for the same problem.

### The deeper principle
Any "compute once, read many" derived state needs an invalidation channel. The principle generalises beyond embeddings: image thumbnails, search snippets, recommendation models, summary caches — all of them silently lie if you don't invalidate.

### Where this breaks down
Mark-stale doesn't help if your write path doesn't actually trigger it. In loopd, autosave-on-keystroke means every keystroke writes; the stale mark needs to be inside the write path, not at editor-blur — otherwise an app crash mid-edit can leave a fresh text with a stale vector. The fix is mark-stale-with-text-update in one transaction.

### What to explore next
- [33-incremental-indexing](./33-incremental-indexing.md) → the re-embed pass mechanics
- [30-vector-databases](./30-vector-databases.md) → where the stale flag lives
- loopd's existing `synced_at` pattern in `sync_meta` — the closest existing analogue

---

## Tradeoffs

### Comparison table — stale-tracking strategies

```
┌─────────────────────────┬──────────────────┬─────────────────────┬──────────────────────┐
│ Cost dimension          │ Mark-stale + idle│ Re-embed on every   │ Re-embed on query    │
│                         │ pass (target)    │ edit                │ (lazy)               │
├─────────────────────────┼──────────────────┼─────────────────────┼──────────────────────┤
│ Per-edit cost           │ ~1 UPDATE        │ ~1 embed call       │ 0                    │
│ Per-keystroke cost      │ ~1 UPDATE        │ Many embed calls    │ 0                    │
│ Per-query cost          │ ~0               │ 0                   │ Possibly 1 embed     │
│ Embed call volume       │ ~1 per edit-sess │ ~N per keystroke    │ ~1 per stale query   │
│ Window of staleness     │ ~minutes         │ ~0                  │ ~0                   │
│ Query latency drift     │ ~0               │ 0                   │ +500-1500ms          │
│ Storage overhead        │ 1 timestamp col  │ 0                   │ 0                    │
│ Sync overhead           │ ~1 push per edit │ Many pushes         │ ~0 (lazy)            │
└─────────────────────────┴──────────────────┴─────────────────────┴──────────────────────┘
```

### Sub-block 1 — what mark-stale + idle pass gives up

A short window of staleness — edits made in the last few minutes may still be searched against the previous vector until the idle pass runs. For a daily journal with 30-second-grained edits and weekly retrieval queries, this window is invisible. For real-time semantic search the window would matter.

### Sub-block 2 — what re-embed-on-every-edit would have cost

Embed-call volume. loopd's autosave fires on every keystroke; embedding on every write would mean dozens of LLM provider round-trips per edit session, at non-trivial cost and latency. The first edit fires an embed; the second edit invalidates the in-flight embed and fires another. The pattern fights the existing autosave architecture.

### Sub-block 3 — the breakpoint
Mark-stale + idle pass stops being right when (a) retrieval latency tolerance hits zero (real-time UX), or (b) the staleness window starts causing visible "search misses" complaints. Neither holds for loopd.

### What wasn't actually a tradeoff
Skipping stale tracking entirely was never an option once embeddings ship. The drift would compound silently and undo every retrieval-quality investment.

---

## Tech reference (industry pairing)

### Custom mark-stale + idle pass

- **Codebase uses:** target plan.
- **Why it's here:** integrates with loopd's existing patterns (autosave write paths, fire-and-forget async-classification, `schedulePush`).
- **Leading today:** custom invalidation in your own service layer — `adoption-leading` for application-controlled freshness, 2026.
- **Why it leads:** colocated with the write path; debuggable in your own logs; no separate service.
- **Runner-up:** event-stream-based invalidation (CDC) — `innovation-leading` for multi-service architectures where the embed pipeline lives in a separate service; overkill for loopd.

### Postgres `tsvector` for the BM25 sparse half

- **Codebase uses:** target if BM25 ships in Supabase mirror.
- **Why it's here:** Postgres's full-text-search index has the same staleness problem; it's auto-maintained by triggers in modern Postgres but worth knowing.
- **Leading today:** Postgres `tsvector` — `adoption-leading` for sparse-side staleness in Postgres, 2026.
- **Why it leads:** trigger-maintained — write to the text column and the index updates atomically.

---

## Project exercises

### [B2A.4] Embed on commit; mark stale on text change; re-embed on idle pass

- **Exercise ID:** `[B2A.4]`
- **What to build:** Three things. (1) On entry commit, embed the text and store; (2) on entry text update, mark `embedding_stale_at = NOW()`; (3) an idle pass — a `processEmbedRefresh()` function that runs on app foreground (or via a scheduled hook), picks up stale entries oldest-first, re-embeds in batches of 5, clears the stale flag.
- **Why it earns its place:** the load-bearing freshness mechanism. Without it, every retrieval query slowly degrades.
- **Files to touch:** `src/services/database.ts:writeEntry()` (mark-stale hook); new `src/services/ai/embedRefresh.ts` (idle pass); migration adding `embedding_stale_at` to `entry_embeddings`.
- **Done when:** editing an entry's text marks its embedding stale; the idle pass picks up the entry and re-embeds; cloud mirror sees the new vector; queries against the new vector reflect the updated text.
- **Estimated effort:** `1–2 days`.

---

## Summary

Stale embeddings are the invariant-breaking gap between an entry's current text and its current vector. In loopd this is not yet implemented; `[B2A.4]` introduces the standard mark-stale-on-write + idle re-embed pattern, mirroring loopd's existing `synced_at`/`deleted_at` shape. The constraint that makes this the right call is loopd's autosave-on-keystroke architecture — re-embedding on every keystroke is wasteful; mark-stale-then-refresh-later is the right shape. The cost being paid is a short window of staleness (minutes) during which retrieval may use the previous vector.

Key points to remember:
- Every editable embedded text needs an invalidation mechanism.
- Mark-stale on write; re-embed on idle pass; clear stale on success.
- Mark must happen *in the same transaction* as the text update.
- A short staleness window is fine for journaling; not fine for real-time search.
- One `embedding_stale_at` column carries the whole pattern.

---

## Interview defense

### What an interviewer is really asking
"How do you handle text updates after you've embedded?" tests whether the candidate knows the stale-embedding problem exists. Candidates who say "we just re-embed on every edit" reveal they haven't shipped this at any volume.

### Likely questions

  [mid] Q: What happens to embeddings when a user edits an entry?
  A: The text changes; the vector doesn't, until we re-embed. Without an invalidation mechanism, the vector silently drifts from truth — queries return what the entry USED to say. The fix is mark-stale-on-write plus an idle re-embed pass: on every text update, set `embedding_stale_at = NOW()`; periodically a background job picks up stale rows, re-embeds them, and clears the flag.
  Diagram:
  ```
  edit → writeEntry()
              ├─ UPDATE entries SET text=...
              └─ UPDATE entry_embeddings SET embedding_stale_at=NOW()
  
  later (idle):
       processEmbedRefresh()
              └─ for each stale: embed → UPDATE embedding, stale=NULL
  ```

  [senior] Q: Why not re-embed on every edit?
  A: Three reasons. First, loopd autosaves on every keystroke — embedding per keystroke would mean dozens of LLM provider calls per edit session. Second, it fights the autosave architecture: the first edit fires an embed; the second invalidates the first; you have in-flight calls that you have to cancel. Third, the cloud sync layer would push every intermediate vector. Mark-stale-then-refresh-on-idle batches the work into one embed per edit *session* instead of one per *keystroke* — orders-of-magnitude less work for negligible UX cost.
  Diagram:
  ```
  Picked: mark-stale + idle pass     Suggested: re-embed every edit
  ───────────────────────────         ─────────────────────────────
  ~1 embed per edit session           ~N embeds per edit session
  ~minutes of staleness               ~0 staleness
  Fits autosave architecture          Fights it
  Right for journaling                Right for real-time search
  ```

  [arch] Q: What changes at 10× corpus?
  A: The idle-pass scan grows linearly: SELECT WHERE embedding_stale_at IS NOT NULL becomes more expensive on a larger table. The fix is indexing `embedding_stale_at` and processing in fixed-size batches (5-20 rows per pass) so the per-pass cost stays bounded regardless of how many rows are stale. At 100× scale this is a job-queue pattern: stale-entry IDs go onto a queue, workers consume them.
  Diagram:
  ```
  Today (365 entries)         →  Simple SELECT WHERE stale + LIMIT 5
  10× (~3650 entries)         →  + index on embedding_stale_at
  100× (~36k entries)         →  + per-batch processing with backpressure
  1000× (multi-tenant)        →  Job queue + dedicated workers
  ```

### The question candidates always dodge
"What if the user edits while the re-embed is in flight?" The honest answer: there's a race. The re-embed reads the entry text at time T1, calls the embedding API for ~500ms, and writes the vector at T2 — if the user edited between T1 and T2, the vector now represents an out-of-date text and the row is back to stale. The fix is to *re-mark stale on every edit unconditionally*, even if the row is currently being processed. The next idle pass picks it up again.

```
Picked: re-mark always               Suggested: skip if in-flight
─────────────────────────             ──────────────────────────
Always converges                      Race window swallows edits
~1 extra embed per race               Lost stale marks
Right for correctness                 Right for nothing
```

### One-line anchors
- The vector represents what the text USED to say.
- Mark stale on write; re-embed on idle.
- One column carries the invariant.
- Skip re-embed-per-keystroke — it fights autosave.
- Re-mark stale even if a re-embed is in flight.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the invalidate-then-recompute loop. Label the three pieces: write path (marks stale), idle job (processes), retrieval (uses fresh vectors).

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) what stale-embedding means, (b) why mark-stale-then-refresh beats re-embed-per-edit, (c) the race condition and its fix, (d) where the `embedding_stale_at` column lives.

### Level 3 — Apply it to a new scenario
A user edits an entry to remove a paragraph about a project. They then search for the project's name. With your design, what does retrieval return in the first 30 seconds after the edit? In the first 30 minutes? Why?

Open the diagram and check against the "Half 1: Detection" and "Half 2: Re-embedding" split.

### Level 4 — Defend the decision you'd change
Today the plan is idle-pass refresh. If you were starting today, would you re-embed on entry-blur (when the user navigates away) instead? Defend your answer naming one specific failure mode.

### Quick check — code reference test
- What column tracks staleness?
- What function would re-embed stale entries?

Answer: `embedding_stale_at` (target — `[B2A.4]`). `processEmbedRefresh()` in `src/services/ai/embedRefresh.ts` (target, not yet created).
