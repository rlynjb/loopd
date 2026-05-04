# 06 — Data modelling

> **Eleven tables, but only four architecturally interesting ones.** This chapter tells you which four matter and why the schema is shaped the way it is.

The schema in [`src/services/database.ts`](../../../src/services/database.ts) is eleven tables: `entries`, `habits`, `projects`, `vlogs`, `day_meta`, `sync_deletions`, `ai_summaries`, `nutrition`, `todo_meta`, `threads`, `thread_mentions` — plus a twelfth, `sync_meta`, added when cloud sync shipped. A lot of those exist because each represents a distinct *concept with its own lifecycle* — they're not normalization choices, they're domain boundaries. The four that matter architecturally are `entries`, `todo_meta`, `thread_mentions`, and the cloud-sync columns layered on top of every table. Everything else falls out of those.

Two columns were added to every synced table when the cloud-sync work landed: `deleted_at` (soft-delete timestamp; rows hide via `WHERE deleted_at IS NULL` instead of being removed) and `synced_at` (last successful push timestamp; local-only, the cloud doesn't carry it). Plus `sync_meta` is a separate local-only ledger keyed by `table_name` that tracks `last_pull_at`, `last_push_at`, and `last_error` per table. None of those carry into the Postgres mirror — they're the local sync state. The old `sync_deletions` table is now schema cruft: it backed the Notion outbox queue, no longer written to since soft-delete propagates as a normal sync event. Kept around because dropping a SQLite table on every install adds risk for no real benefit.

`entries` is the canonical source. Prose text, habits-by-id, a JSON column for clip references, a JSON column for todos. The JSON columns are deliberate. I could have normalized todos into a separate table with foreign keys back to entries, and at first glance that's what an interviewer expects. I chose not to, because the entry-edit path is the hot loop in this app — every keystroke writes through it — and I didn't want autosave to fight a relational lock. The JSON column is one column write per entry update; a normalized todos table would be N inserts/deletes plus the entry update, all in one transaction.

`todo_meta` is the flip side of that decision. Each `TodoItem` inside `entries.todos_json` has exactly one `todo_meta` row holding the AI-derived attributes (`type`, `stage`, `classifier_confidence`, `classifier_model`, `expanded_md`, `user_overridden_type`, `position`). I split this from `todos_json` because the meta fields are *queryable* (filter by type), the `position` column is *indexable* for sort, and the classifier writes happen async without colliding with the entry's text-save path. The cost is a 1:1 invariant I have to enforce in application logic — SQLite can't FK to a JSON-array element. The reconciler at [`reconcileMeta.ts`](../../../src/services/todos/reconcileMeta.ts) is what enforces it. `position` is added late; it's the manual-reorder column with a deliberate **NULL-first sparse-then-dense** convention — newly inserted rows leave `position` NULL and sort by `created_at`, while a manual reorder writes integer positions only to the affected slice (no full-table renumber).

`threads` and `thread_mentions` are the newest pair. `threads` is the project-attribution vocabulary (`name`, `slug` with a UNIQUE index for case-insensitive uniqueness, `icon`, `color`, `target_cadence_days`, `archived`, `pinned`, `time_of_day`, plus `notion_page_id` and `notion_last_synced` for the optional Threads-DB sync). `thread_mentions` is the junction: one row per `#tag` occurrence in prose or in a `[]` todo line. Both `entry_id` and `todo_id` are nullable, and the app-level invariant is *at least one is set* — except for one deliberate exception (see Q3). `thread_mentions` is derived state by Principle 11; the reconciler in [`scanThreads.ts`](../../../src/services/threads/scanThreads.ts) rebuilds it from prose at commit time using the same two-pass idiom (`(thread_id, source_line)` exact, then `(thread_id, tag_text)` within ±3 lines).

`habits` grew up too. It now carries `slug`, `icon`, `color`, `cadence_type` ('daily' | 'weekdays' | 'weekly' | 'specific_days' | 'n_per_week'), `cadence_days` (JSON array of weekday indices), `cadence_count` (for `n_per_week`), `archived` (still on the row but not surfaced in UI), `time_of_day` ('morning' | 'midday' | 'evening' | 'anytime'), and `notion_last_synced`. The cadence engine in [`habits/cadence.ts`](../../../src/services/habits/cadence.ts) is a pure function over those columns; the dashboard buckets habits + threads by `time_of_day` into a single DAILY SCHEDULE strip.

`sync_deletions` was the Notion-era outbox. When the Notion sync still ran, locally-deleted rows would leave a row here keyed by `notion_page_id` with an `entity_type` discriminator so one queue served all five entity classes. The discriminator pattern was nice — new entity types added zero schema; adding `'thread'` was a one-line change. The whole table is **deprecated** now. Cloud sync replaces it with soft delete: every CRUD delete in [`database.ts`](../../../src/services/database.ts) stamps `deleted_at` and bumps `updated_at`, so the deletion propagates through the regular sync push as a row update. No separate queue, no archive operation, no discriminator. The table itself stays in the schema (dropping a SQLite table mid-flight adds risk; a future migration can clean it up).

```
              loopd schema — 11 tables, 1:1 invariant enforced

        ┌────────────┐                            ┌──────────────────┐
        │  habits    │◄── habits_json (id refs)──│     entries      │
        │  + cadence │                            │  CANONICAL:      │
        │  + slug    │                            │  text + json     │
        └────────────┘                            └────────┬─────────┘
                                                           │
        ┌────────────┐                                     │
        │ day_meta   │◄── date PK ────────────────────────►│
        │ (per-day   │                                     │
        │  title)    │                                     │
        └────────────┘                                     │
                                                           │
   ┌────────────┬───────────────┬─────────────┬────────────┤
   ▼            ▼               ▼             ▼            ▼
┌─────────┐ ┌──────────┐ ┌─────────────┐ ┌──────────┐ ┌─────────┐
│todo_meta│ │nutrition │ │  projects   │ │  vlogs   │ │ai_summa-│
│         │ │ (1 row   │ │ (editor     │ │ (export  │ │ ries    │
│ 1:1 w/  │ │  per "** │ │  state per  │ │  archive)│ │ (LLM    │
│ each    │ │  N kcal" │ │  date)      │ │          │ │  cache, │
│ TodoItem│ │  line)   │ │             │ │          │ │  date PK│
│ in      │ │          │ │             │ │          │ │         │
│ todos_  │ │          │ │             │ │          │ │         │
│ json    │ │          │ │             │ │          │ │         │
│         │ │          │ │             │ │          │ │         │
│ type,   │ │ name,    │ │             │ │          │ │         │
│ stage,  │ │ kcal,    │ │             │ │          │ │         │
│ position│ │ source_  │ │             │ │          │ │         │
│ classi- │ │ line     │ │             │ │          │ │         │
│ fier_*, │ │          │ │             │ │          │ │         │
│ user_   │ │          │ │             │ │          │ │         │
│ over-   │ │          │ │             │ │          │ │         │
│ ridden  │ │          │ │             │ │          │ │         │
└────┬────┘ └────┬─────┘ └─────────────┘ └──────────┘ └─────────┘
     │           │
     │           │            ┌───────────────────┐
     │           │            │     threads       │
     │           │            │  (project vocab)  │
     │           │            │                   │
     │           │            │  slug UNIQUE      │◄─┐
     │           │            │  icon, color      │  │
     │           │            │  target_cadence_  │  │ matched by
     │           │            │    days           │  │ slug at scan
     │           │            │  archived, pinned │  │ time
     │           │            │  time_of_day      │  │
     │           │            │  notion_*         │  │
     │           │            └─────────┬─────────┘  │
     │           │                      │            │
     │           │                      ▼            │
     │           │            ┌───────────────────┐  │
     │           │            │ thread_mentions   │  │
     │           │            │ (junction;        │──┘
     │           │            │  derived from     │
     │           │            │  prose via        │
     │           │            │  scanThreads)     │
     │           │            │                   │
     │           │            │  thread_id        │
     │           │            │  entry_id NULLable│
     │           │            │  todo_id NULLable │
     │           │            │  source_line      │
     │           │            │  tag_text         │
     │           │            └─────────┬─────────┘
     │           │                      │
     └─────┬─────┴──────────────────────┘
           ▼
  ┌─────────────────────────┐
  │  sync_deletions         │ DEPRECATED
  │  (Notion-era outbox;    │ replaced by soft delete
  │   no longer written)    │ (deleted_at on every table)
  └─────────────────────────┘

  ┌─────────────────────────┐
  │  sync_meta              │ LOCAL-ONLY (not in Postgres)
  │                         │
  │  table_name PK          │ per-table ledger driving
  │  last_pull_at           │ incremental cloud sync.
  │  last_push_at           │ updated by sync/syncMeta.ts.
  │  pending_pushes         │
  │  last_error / _at       │
  └─────────────────────────┘

  Cloud-sync columns added to EVERY synced table:
    synced_at   — last successful push timestamp (LOCAL ONLY)
    deleted_at  — soft-delete timestamp; reads filter NULL

  Invariants:
  • prose in entries.text is canonical for todos / nutrition / mentions
  • todo_meta is 1:1 with each TodoItem (enforced by reconcileMeta)
  • thread_mentions: at least one of (entry_id, todo_id) is set —
    EXCEPT for the manual-touch deviation (both NULL, written by
    toggleThreadTouchToday from the dashboard tracker)
  • CHECK constraints validate enums at INSERT time
  • threads.slug UNIQUE — case-insensitive enforced at the index
  • Cloud mirror PK is composite (user_id, id) — Postgres-side; local
    SQLite has just id since there's only one user
  • Reads filter WHERE deleted_at IS NULL on every synced table;
    sync layer queries skip the filter (need to see deletions)
```

## Interview questions

### Q1 [mid] Walk me through the schema. Eleven tables for a journaling app feels like a lot.

Each table represents a distinct *concept*, not a normalization choice. Let me name them by purpose.

`entries` is the canonical source — every journal entry is one row, with prose text plus JSON columns for clips and todos. `habits` holds the user's repeatable habits as a vocabulary, now with cadence (`cadence_type`, `cadence_days`, `cadence_count`), `time_of_day`, and color/icon metadata; entries reference habits by ID via `habits_json`. `day_meta` is per-day user metadata (a renamable title), keyed by date. These are the three core domain tables.

`todo_meta` is 1:1 with each TodoItem inside `entries.todos_json` — it holds the AI-derived attributes (`type`, `stage`, `classifier_confidence`, `expanded_md`, `user_overridden_type`) plus the `position` column for manual reorder. I split it out because it's queryable and indexable; storing it inside the JSON column would force a full-row read for every type filter on `/todos`.

`threads` and `thread_mentions` are the newest pair, supporting the `#tag` project-attribution layer. `threads` holds the metadata for each project (slug — UNIQUE — name, color, target cadence, time-of-day bucket, archived/pinned flags). `thread_mentions` is the junction: one row per `#tag` occurrence, with both `entry_id` and `todo_id` nullable so a single row can attribute either a prose line or a `[]` todo line to a thread.

`nutrition` is row-per-line for `** food N kcal` lines in entry text — a separate table because it's queryable independently and indexed by name with `COLLATE NOCASE` for the autocomplete. `projects` holds editor scratch state per date (clip trims, text overlays). `vlogs` is the export archive after a vlog renders.

`sync_deletions` is dead code from the Notion era — soft delete replaced it (every synced table has a `deleted_at` column now; deletions propagate via the normal cloud-sync push). `sync_meta` is the new local-only ledger that tracks `last_pull_at` / `last_push_at` per synced table for the incremental cloud-sync layer. `ai_summaries` caches LLM-generated daily summaries by date so the vlog editor's auto-compose doesn't re-call the LLM on every render.

The number isn't the point; the *boundaries* are. Each table has its own lifecycle and its own queries. Combining them would create the kind of god-table that's annoying to migrate.

### Q2 [senior] Explain the 1:1 invariant between `todos_json` and `todo_meta`. Why no foreign key?

SQLite would let me declare a foreign key on `todo_meta.todo_id` — but the *target* of that FK is a JSON-array element inside `entries.todos_json`, not a relational row. SQL foreign keys can't reference JSON elements. So the invariant is enforced by application logic in [`reconcileMeta.ts`](../../../src/services/todos/reconcileMeta.ts).

The reconciler walks the join: for each TodoItem with no meta row, INSERT a fresh meta with heuristic-classified type. For each meta row whose `todo_id` no longer appears in any entry's `todos_json`, DELETE the orphan. It's idempotent — re-running on the same input is a no-op. Self-healing — a failed mid-loop run leaves a deterministic gap that the next run patches.

The same pattern recurs in `thread_mentions`: there too, `entry_id` and `todo_id` could in principle be true foreign keys, but `todo_id` points to a JSON-array element, so the per-todo half is application-enforced. The pattern generalizes: *when the source of truth is prose-derived, application reconcilers replace SQL FKs and run idempotently on every commit*.

The honest tradeoff: I lose DB-enforced integrity. In exchange, I keep the editing surface fast — `todos_json` is one column write per entry update. A normalized `todos` table with a true FK would give integrity for free, but every text edit would mean parsing the prose, computing diff against the table, and the autosave path would fight a relational lock.

At larger scale, I'd revisit this. Once the entry-edit path is no longer the hot loop — likely when collaborative editing forces a CRDT layer anyway — moving todos to a normalized table is the right call. For now, the application-enforced invariant is correct, well-tested in practice, and self-heals on failure.

### Q3 [arch] You've said `thread_mentions` is derived from prose, but you also write rows from a dashboard toggle with both `entry_id` and `todo_id` set to NULL. How do you reconcile that with Principle 11, and what's the case-insensitive slug story?

Two questions in one — they touch the same place but in different ways. Take them in order.

**The manual-touch deviation.** Principle 11 says *mentions are derived; metadata is stored*. The reconciler at [`scanThreads.ts`](../../../src/services/threads/scanThreads.ts) rebuilds `thread_mentions` from prose at every commit, deleting unmatched rows. So a row with `entry_id IS NULL AND todo_id IS NULL` would normally be unreachable from the prose pass and get deleted. I exempt those rows explicitly: the per-thread reconcile scopes to `WHERE entry_id = ? AND todo_id IS NULL` for prose mentions and `WHERE todo_id = ?` for todo-line mentions, so manual-touch rows (both NULL) are never in scope and never deleted by the scanner.

This row is written by [`toggleThreadTouchToday`](../../../src/services/threads/touch.ts) when the user taps a thread row on the dashboard's DAILY SCHEDULE tracker. The justification is three-part: (a) the schema permits it — the columns are nullable; (b) the staleness math + 14-day strip in [`getThreadCards.ts`](../../../src/services/threads/getThreadCards.ts) compose uniformly across all mention shapes (a manual touch is just a mention with no source pointer); (c) toggling off the same day deletes only the manual row, leaving prose-derived mentions untouched.

The cost is real: it's a documented exception to Principle 11, and a future contributor reading just the principle without reading [`touch.ts`](../../../src/services/threads/touch.ts) would be confused. I mitigate that by inlining the reasoning in both the principle text and the function's docstring. The alternative — synthesizing a fake entry to host the mention — would have been a *bigger* invariant break (it would create entries the user didn't write).

There's a related, deliberate scoping decision on the dashboard side: the `ThreadCard.activeDates: Set<string>` that drives the 14-cell strip is *manual-touch-only*. Prose `#tag` mentions don't light up the strip. The reasoning: prose mentions show up on the per-thread detail page (where mentions are the whole point), but the dashboard strip is the user's "did I touch this today" indicator, which is an explicit-action signal. Conflating the two would mean any prose mention silently checks the box, which defeats the gesture. The thread detail page surfaces both kinds; the dashboard strip surfaces only the deliberate ones.

**Case-insensitive slug uniqueness.** The `threads.slug` column has a UNIQUE index, and slugs are stored lowercased on insert (via `crud.ts`). The scanner in [`scanThreads.ts`](../../../src/services/threads/scanThreads.ts) lowercases the captured tag before lookup, so `#Loopd`, `#loopd`, `#LOOPD` all resolve to the same row. The display name (`tag_text` on the mention, `name` on the thread) preserves the user's original casing for rendering. This is the "fold case at the *boundary*, render at the *edge*" idiom — the storage layer canonicalizes, the UI layer respects user intent. It also keeps the UNIQUE index simple: a plain index on a lowercased column, no `COLLATE NOCASE` shenanigans, no surprise ordering quirks.

Slug is *local-canonical* in the cloud-sync flow too. The Postgres mirror does store the slug column (it has to — the UNIQUE index `idx_threads_user_slug` on `(user_id, LOWER(slug))` enforces case-insensitive uniqueness server-side too), but the slug is never *meaningfully* edited from the cloud side. If a future device were to pull a thread row with a different slug than local has, the LWW conflict resolution would let cloud win — but the manual-touch deviation and the prose-derived mentions still match by `thread_id`, not slug, so the existing rows survive the rename. The Notion-era "reject slug edits on pull" rule was about a sync target where humans could edit text fields directly (Notion's UI); Postgres doesn't have that surface.

### `Thread`, `ThreadMention`, `ThreadCard`, `Staleness` — the type surface

A note on the TS types since the table layout alone doesn't capture how the dashboard reads this data. `Thread` mirrors the row. `ThreadMention` mirrors the junction row. `ThreadCard` is the *computed view shape* the dashboard consumes — it's not a table. It bundles `{ thread, lastMentionAt, daysSinceLast, staleness, entriesThisWeek, openTodos, recentTodos, activeDates }` where `activeDates` is the manual-touch-only `Set<string>` driving the 14-cell strip discussed above. `Staleness` is `'fresh' | 'aging' | 'stale' | 'cold'`, computed from days-since-last-mention against the optional `targetCadenceDays` or default 1/3/7-day thresholds. `CadenceType` and `TimeOfDay` are the literal-union types that mirror the `habits` (and partially `threads`) CHECK constraints.

The pattern: *DB columns store atoms; TS view types compose atoms into screen-ready shapes*. Aggregators like [`getThreadCards.ts`](../../../src/services/threads/getThreadCards.ts) own the join. The component layer never queries SQLite directly.

## The hard question

> "Why JSON columns instead of properly normalized tables? You're losing query power and ACID guarantees."

I'm not losing ACID — SQLite is fully ACID and `todos_json` is one column in a transaction. I am losing query power, which is real. I can't filter for "all todos done in the last week across all entries" with a single SQL query; I have to load all entries and filter in JavaScript. (Though `todo_meta` partly compensates: `type`-and-`stage`-filtered queries DO go through SQL on the meta table, joined back to the JSON only for text.)

The reason I made the tradeoff: the entry-edit path is the *hot loop* in this app. Every keystroke writes to `entries`. If `todos_json` were a normalized table, every text edit would mean: parse the new prose, compute the todo diff (insert/update/delete) against the existing rows, run those statements, then write the entry. That's a lot of work per keystroke compared to "stringify the new array, write one column."

The deeper reason: in this app, todos aren't *queried independently from their parent entry* very often. The dashboard shows a flat list, but the data it needs is always entry-anchored (the entry's date, the entry's createdAt). A normalized table would force me to JOIN back to entries for nearly every query, which negates the supposed perf win.

What I *do* normalize: nutrition (because the autocomplete needs distinct food names across all entries), `todo_meta` (because `type` and `stage` filters on `/todos` need to be SQL), and `thread_mentions` (because the per-thread detail page needs every mention across every entry). The principle I follow: *normalize when the query patterns demand it, not when the schema textbook demands it*. Each of those three was driven by a specific cross-entry query that would have been miserable in JavaScript.

What I'd do differently if the query patterns shifted: if I started writing analytics that asked "show me all my decision-type todos this quarter, regardless of which entry they came from," I'd already have what I need via `todo_meta`. The next normalization frontier is probably the prose itself — splitting entries into paragraph-level rows for searchability — and I'll cross that bridge when search becomes a real feature instead of a loose plan.

→ [07 — Reliability and error handling](./07-reliability.md)
