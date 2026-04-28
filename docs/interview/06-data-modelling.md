# 06 — Data modelling

> **Nine tables, but only three architecturally interesting ones.** This chapter tells you which three matter and why the schema is shaped the way it is.

The schema in [`src/services/database.ts`](../../src/services/database.ts) is nine tables: `entries`, `habits`, `projects`, `vlogs`, `day_meta`, `sync_deletions`, `ai_summaries`, `nutrition`, `todo_meta`. A lot of those exist because each represents a distinct *concept with its own lifecycle* — they're not normalization choices, they're domain boundaries. The three that matter architecturally are `entries`, `todo_meta`, and `sync_deletions`. Everything else falls out of those.

`entries` is the canonical source. Prose text, habits-by-id, a JSON column for clip references, a JSON column for todos. The JSON columns are deliberate. I could have normalized todos into a separate table with foreign keys back to entries, and at first glance that's what an interviewer expects. I chose not to, because the entry-edit path is the hot loop in this app — every keystroke writes through it — and I didn't want autosave to fight a relational lock. The JSON column is one column write per entry update; a normalized todos table would be N inserts/deletes plus the entry update, all in one transaction.

`todo_meta` is the flip side of that decision. Each `TodoItem` inside `entries.todos_json` has exactly one `todo_meta` row holding the AI-derived attributes (type, classifier_confidence, expanded_md, stage, position). I split this from `todos_json` because the meta fields are *queryable* (filter by type), the `position` column is *indexable* for sort, and the classifier writes happen async without colliding with the entry's text-save path. The cost is a 1:1 invariant I have to enforce in application logic — SQLite can't FK to a JSON-array element. The reconciler at [`reconcileMeta.ts`](../../src/services/todos/reconcileMeta.ts) is what enforces it.

`sync_deletions` is the outbox. When a synced row is locally deleted, the body is gone but the Notion page still exists; we capture the `notion_page_id` in this queue with an `entity_type` discriminator so one queue serves entries, todos, habits, and nutrition cleanly. The discriminator pattern means new entity types add zero schema; they just push rows with their new type tag.

```
              loopd schema — 9 tables, 1:1 invariant enforced

        ┌────────────┐                            ┌──────────────────┐
        │  habits    │◄── habits_json (id refs)──│     entries      │
        │  (vocab)   │                            │  CANONICAL:      │
        └────────────┘                            │  text + json     │
                                                  └────────┬─────────┘
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
└─────────┘ └──────────┘ └─────────────┘ └──────────┘ └─────────┘
   │             │
   │             │
   └──────┬──────┘
          ▼
  ┌─────────────────────────┐
  │  sync_deletions         │
  │  (FIFO outbox queue)    │
  │                         │
  │  entity_type ←──────────│ discriminator: many producers,
  │  entity_id              │              one queue
  │  notion_page_id         │
  │  deleted_at             │
  └─────────────────────────┘

  Invariants:
  • prose in entries.text is canonical for todos / nutrition
  • todo_meta is 1:1 with each TodoItem (enforced by reconcileMeta)
  • CHECK constraints validate enums at INSERT time
  • notion_page_id lives on TodoItem only — todo_meta has no
    duplicate field; sync code joins TodoItem ↔ TodoMeta and
    uses the single id (avoids drift)
```

## Interview questions

### Q1 [mid] Walk me through the schema. Nine tables for a journaling app feels like a lot.

Each table represents a distinct *concept*, not a normalization choice. Let me name them by purpose.

`entries` is the canonical source — every journal entry is one row, with prose text plus JSON columns for clips and todos. `habits` holds the user's repeatable habits as a vocabulary; entries reference habits by ID. `day_meta` is per-day user metadata (a renamable title), keyed by date. These are the three core domain tables.

`todo_meta` is 1:1 with each TodoItem inside `entries.todos_json` — it holds the AI-derived attributes (type, stage, classifier_confidence, position, expanded_md). I split it out because it's queryable and indexable; storing it inside the JSON column would force a full-row read for every type filter on `/todos`.

`nutrition` is row-per-line for `** food N kcal` lines in entry text — a separate table because it's queryable independently and indexed by name with `COLLATE NOCASE` for the autocomplete. `projects` holds editor scratch state per date (clip trims, text overlays). `vlogs` is the export archive after a vlog renders.

`sync_deletions` is an outbox queue with `entity_type` discriminator — entries, todos, habits, and nutrition all enqueue here when they're locally deleted. `ai_summaries` caches LLM-generated daily summaries by date so the vlog editor's auto-compose doesn't re-call the LLM on every render.

The number isn't the point; the *boundaries* are. Each table has its own lifecycle and its own queries. Combining them would create the kind of god-table that's annoying to migrate.

### Q2 [senior] Explain the 1:1 invariant between `todos_json` and `todo_meta`. Why no foreign key?

SQLite would let me declare a foreign key on `todo_meta.todo_id` — but the *target* of that FK is a JSON-array element inside `entries.todos_json`, not a relational row. SQL foreign keys can't reference JSON elements. So the invariant is enforced by application logic in [`reconcileMeta.ts:48-90`](../../src/services/todos/reconcileMeta.ts#L48-L90).

The reconciler walks the join: for each TodoItem with no meta row, INSERT a fresh meta with heuristic-classified type. For each meta row whose `todo_id` no longer appears in any entry's `todos_json`, DELETE the orphan. It's idempotent — re-running on the same input is a no-op. Self-healing — a failed mid-loop run leaves a deterministic gap that the next run patches.

The honest tradeoff: I lose DB-enforced integrity. In exchange, I keep the editing surface fast — `todos_json` is one column write per entry update. A normalized `todos` table with a true FK would give integrity for free, but every text edit would mean parsing the prose, computing diff against the table, and the autosave path would fight a relational lock.

At larger scale, I'd revisit this. Once the entry-edit path is no longer the hot loop — likely when collaborative editing forces a CRDT layer anyway — moving todos to a normalized table is the right call. For now, the application-enforced invariant is correct, well-tested in practice, and self-heals on failure.

### Q3 [arch] How do you guarantee an enum value at the database layer?

SQLite CHECK constraints. [`database.ts:155-179`](../../src/services/database.ts#L155-L179) shows three on `todo_meta`:

```sql
CHECK (type IN ('todo','idea','bug','question','decision','knowledge','content')),
CHECK (stage IN ('todo','in_progress','backlog')),
CHECK (classifier_confidence IS NULL OR classifier_confidence IN
       ('high','medium','low','heuristic'))
```

These are kept in lockstep with the TypeScript literal-union types in [`src/types/todoMeta.ts`](../../src/types/todoMeta.ts). The principle: *push validation as close to storage as possible*. A typo like `'in-progress'` (with a hyphen) won't pass typecheck, won't pass the CHECK constraint, won't reach the renderer. New contributor bugs and future-me bugs fail in dev, not at render time when a badge mysteriously doesn't appear.

The cost: type-and-schema coupling has to be maintained manually. If I add a new `TodoType`, I have to update both the TS union and the SQL CHECK. There's no codegen tying them together. **What I'd do at scale:** extract a single source of truth — one TypeScript file that exports both `type TodoType = ...` and `export const TODO_TYPE_CHECK = "type IN (...)"`. The migration generator would consume the const; the type system would consume the union. This is a 2-3 hour refactor I haven't done because I add types rarely.

What I *don't* enforce CHECK constraints on: Notion-side enum values like the Type and Confidence selects on the user's Todos DB. Notion doesn't expose a way to constrain select options programmatically, so I do best-effort validation in the parser at [`todosMapper.ts`](../../src/services/notion/todosMapper.ts) — `parseTodoType` and `parseConfidence` reject unknown values silently. That's the *tolerant reader* pattern: accept what you understand, ignore the rest, never crash. The local CHECK plus the Notion tolerant reader together give me both ends covered.

## The hard question

> "Why JSON columns instead of properly normalized tables? You're losing query power and ACID guarantees."

I'm not losing ACID — SQLite is fully ACID and `todos_json` is one column in a transaction. I am losing query power, which is real. I can't filter for "all todos done in the last week across all entries" with a single SQL query; I have to load all entries and filter in JavaScript.

The reason I made the tradeoff: the entry-edit path is the *hot loop* in this app. Every keystroke writes to `entries`. If `todos_json` were a normalized table, every text edit would mean: parse the new prose, compute the todo diff (insert/update/delete) against the existing rows, run those statements, then write the entry. That's a lot of work per keystroke compared to "stringify the new array, write one column."

The deeper reason: in this app, todos aren't *queried independently from their parent entry* very often. The dashboard shows a flat list, but the data it needs is always entry-anchored (the entry's date, the entry's createdAt). A normalized table would force me to JOIN back to entries for nearly every query, which negates the supposed perf win.

What I'd do differently if the query patterns shifted: if I started writing analytics that asked "show me all my decision-type todos this quarter, regardless of which entry they came from," I'd reach for normalized storage. Today that query doesn't exist. The principle is *normalize when the query patterns demand it, not when the schema textbook demands it*.

The thing I'm watching for: nutrition is already a normalized table because the autocomplete *needs* to query distinct food names across all entries — that pattern doesn't fit JSON. When the same pattern shows up for todos (e.g., "show me all bugs across my whole journal"), I'll migrate. Until then, JSON-on-entries is the right shape.

→ [07 — Reliability and error handling](./07-reliability.md)
