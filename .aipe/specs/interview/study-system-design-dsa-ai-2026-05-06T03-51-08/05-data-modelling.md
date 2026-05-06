# Chapter 5 — Data modelling

The data model is **12 SQLite tables, 10 of which mirror to Supabase Postgres, with a 1:1 application-enforced invariant between `entries.todos_json` and `todo_meta`**. There is no ORM. Every table has its own typed CRUD functions in `src/services/database.ts` and its own `SyncableTable<TLocal, TCloud>` definition in `src/services/sync/tables/<name>.ts`. The schema is deliberately denormalized in places (todos live in JSON inside `entries`) and deliberately normalized in others (each thread mention is its own row). Every choice has a reason; every reason is a workload.

```
                 SQLite (loopd.db, WAL mode)
  ┌────────────────────────────────────────────────────┐
  │  ENTRIES        ◄── canonical for prose            │
  │   id, date, text, habits_json, todos_json,         │
  │   clips_json, clip_uri, mood,                      │
  │   updated_at, synced_at, deleted_at                │
  │                                                     │
  │  TODO_META      ◄── 1:1 with TodoItem in           │
  │   todo_id (PK)       entries.todos_json             │
  │   entry_id, entry_date,                            │
  │   type, expanded_md, classifier_confidence,        │
  │   user_overridden_type, pinned                     │
  │   stage (DEAD), position (DEAD)                    │
  │                                                     │
  │  HABITS, NUTRITION, PROJECTS, VLOGS, AI_SUMMARIES, │
  │  DAY_META, THREADS, THREAD_MENTIONS                 │
  │                                                     │
  │  SYNC_META          ◄── local-only ledger           │
  │  SYNC_DELETIONS     ◄── deprecated, kept on schema  │
  └────────────────────────────────────────────────────┘
                       │
                       │ 5s debounced push / boot pull
                       ▼
                 Supabase Postgres
  ┌────────────────────────────────────────────────────┐
  │  Mirror of the 10 synced tables.                   │
  │  Composite PK: (user_id, id) on every table.       │
  │  RLS scaffolded but disabled in Phase A —          │
  │  the schema PK is the cross-user isolation.        │
  │  Migrations: 0001_schema, 0002_rls,                │
  │              0003_server_time_rpc,                 │
  │              0004_relax_fks, 0005_pinned           │
  └────────────────────────────────────────────────────┘
```

The most interesting modeling decision is **denormalizing todos into `entries.todos_json` while keeping `todo_meta` as a real table**. Todos-as-JSON is a *deliberate denormalization* because the canonical source is the prose, the scanner regenerates the array on every commit, and the only consumer that needs sub-array access is the dashboard's flatten. `todo_meta` is a real table because the AI classification, the expansion markdown, and the user-override flag have lifecycles that outlive the prose — a user editing the line shouldn't lose the LLM's classification of it. The 1:1 between them is enforced by `reconcileTodoMetaForEntry` because SQLite can't FK to a JSON-array element.

## Concept 1 — JSON column for todos, real table for meta

**Shape.** Three pieces: `entries.todos_json` (TEXT column carrying a JSON array of `TodoItem`), `todo_meta` (a real table with `todo_id` as primary key), and `reconcileTodoMetaForEntry` (the application-level reconciler that maintains the 1:1).

**Rule.** The JSON array is *generated* — it's the scanner's output, not the user's input. The user types prose; the scanner emits `TodoItem[]`. Every read of `entries.todos_json` is reading a derived projection. The meta rows, by contrast, are *user-touched* state — type overrides, pinned flag, expansion markdown. The split aligns storage with mutability frequency.

**Failure mode.** The "fully denormalize" version puts pinned/type/expanded inside the JSON. The failure: every classifier update or pin toggle has to read the whole entry, parse the JSON, mutate one element, serialize, and write. With concurrent edits (a journal autosave coinciding with a classifier completion), the classifier's update can be wholesale overwritten by the journal's stale-text write. The "fully normalize" version makes each todo a row in a `todos` table with `entry_id` FK. The failure: the prose is no longer canonical — the scanner has to UPDATE / INSERT / DELETE rows in a real table on every commit, and a corruption of the scanner's logic loses the user's todos directly. The hybrid avoids both: the prose stays canonical (scanner regenerates the JSON), the meta is in its own table where each field's update is independent.

**Contrast.** Habits use a similar split: `entries.habits_json` carries today's check-ins (denormalized into the entry), and `habits` is a separate table with cadence + slug + time-of-day metadata. The constraint that distinguishes them from todos: there's no "habit meta" outside the `habits` table — no AI classifier, no expansion. So the split is one tier shallower (entry-day check-ins as JSON, habit definitions as table), not two tiers as with todos+meta. The deeper structural similarity: hot mutable per-day state lives in the JSON column, cold long-lived state lives in a real table.

## Concept 2 — Soft delete with `deleted_at`

**Shape.** Three pieces: every synced table has a `deleted_at TEXT` column nullable; `database.ts` wraps every read with `WHERE deleted_at IS NULL`; the sync layer's `localQueryDirty` *includes* soft-deleted rows so tombstones propagate to the cloud.

**Rule.** Delete operations stamp `deleted_at = <now>` and bump `updated_at`. They never run `DELETE FROM`. Reads filter the tombstones. Sync propagates them. Hard delete is reserved for a future 30-day vacuum that's been deferred.

**Failure mode.** Hard delete on a multi-device sync model is catastrophic. Device A deletes a row, the row is `DELETE FROM`'d locally, the next push sends "this row is gone" — but Supabase's REST API doesn't have a clean "absent row" semantic for upsert-based sync. Device B's pull sees the row is missing and... what? Re-creates it from local state? Drops it? The semantic is genuinely ambiguous without a tombstone. With `deleted_at`, the tombstone *is* the row; both devices converge on "this row is deleted at <timestamp>" via the same last-write-wins resolver as any other field.

**Contrast.** The legacy `sync_deletions` table (`docs/spec.md` calls it "Notion-era outbox") is the *opposite* approach — a separate table tracking which rows had been hard-deleted, replayed to the remote on each sync. That model worked for the deleted Notion sync layer (Notion's API didn't have soft-delete primitives so the device had to remember). It was wrong for Supabase, where soft-delete is just another column. The migration left `sync_deletions` on the schema (it's not written to anymore) as a deliberate "deprecated but kept" — dropping it requires a migration and there's no operational gain, so it stays.

## Concept 3 — Composite `(user_id, id)` PK on every cloud table

**Shape.** Three pieces: every Supabase table's PK is `(user_id TEXT, id TEXT)` not just `id`; `localToCloud` mappers add `user_id: PHASE_A_USER_ID` to every pushed row; the sync `cloudConflictColumns` is `['user_id', 'id']` so the upsert's `onConflict` clause matches the PK.

**Rule.** Cross-user isolation is *schema-enforced*, independent of RLS. Even with RLS disabled (Phase A), it is impossible to write a row that conflicts with another user's row on `id` alone — they're keyed on `(user_id, id)` and never collide.

**Failure mode.** With `id`-only PK, RLS is the *only* gate. A malformed query that bypasses RLS (or RLS being mis-configured during a migration) means user A's writes can collide with user B's `id`. The Postgres `INSERT ... ON CONFLICT` would update user B's row when user A intended to insert a new row. With composite PK, the worst case of a malformed query is "user A creates a row in user B's namespace" (still wrong, but no overwrite); the row is segregated by `user_id` partition.

**Contrast.** SQLite locally uses `id`-only PK because there's no concept of a `user_id` on the device (Phase A is single-user; there's no row that doesn't belong to the only user). The constraint that distinguishes is *whether multiple tenants share storage*. The cloud has shared storage at the project level; the device has dedicated storage. Same canonical entity, different PK shape, because the failure modes differ.

## Concept 4 — Append-only Supabase migrations

**Shape.** Three pieces: `supabase/migrations/<NNNN>_<name>.sql` (numbered by ascending integers, never re-numbered), `scripts/db-migrate.mjs` (the Node-based runner that applies pending migrations using `pg`), the rule from `.aipe/project/rules.md`: "Supabase migrations are append-only. Never edit a committed migration file."

**Rule.** A committed migration file is immutable. Schema changes always become a new migration file with an incremented number. Rolling back means writing a forward migration that reverses the change.

**Failure mode.** Editing migration `0001_schema.sql` after it's been applied means production Supabase has the old version, the file says the new version, and `db-migrate.mjs` thinks the migration was already applied (filename hash check or registry table). The two diverge silently. A new dev cloning the repo applies the *new* version, gets a different schema than production, and a same-day push corrupts production data. Append-only means every database state in history can be recreated by replaying migrations in order — there's no version drift.

**Contrast.** SQLite's local migrations in `database.ts` are *idempotent ALTER statements* — they check `PRAGMA table_info` and only ALTER if the column is missing. The constraint that distinguishes: SQLite migrations run on every device, every cold start, against an unknown current schema (could be a fresh install, could be three versions behind). Idempotent feels-forward is the only sane pattern. Postgres migrations run once per database, in a controlled CI step, against a known prior version — append-only is the cleaner discipline there.

## Three interview questions

### `[mid]` — "Walk me through the schema for an entry and explain why some fields are JSON and some are columns."

The `entries` table has the typical scalar fields — `id`, `date`, `text` (the prose), `created_at`, `updated_at`, `synced_at`, `deleted_at`, `mood`. It also has three JSON columns: `habits_json` (today's habit check-ins as a string array), `todos_json` (a JSON array of `TodoItem` objects with `id`, `text`, `done`, `completedAt`, `createdAt`, `sourceLine`), and `clips_json` (an array of clip metadata for the day). Plus a legacy `clip_uri` from before clips moved to JSON.

The reason for the split: the JSON columns hold per-day state that's *only ever accessed alongside the entry*. There's no query in the app that says "find me all todos with text starting with 'call'" or "find me all habits checked in March." Every query is rooted at an entry — `getEntryById`, `getEntriesByDate`, `getAllEntries`. So denormalizing into JSON saves a JOIN at every read, which is the dominant access pattern. The cost is filtering or aggregating across days — that has to flatten in TypeScript. With a few thousand entries that's fast; with millions it'd hurt.

The fields that *aren't* JSON are the ones with a different access pattern. `todo_meta` is a real table because the LLM classifier writes to individual rows asynchronously — putting it inside `entries.todos_json` would mean every classifier update reads the whole entry, parses the JSON, mutates one element, and writes the whole thing back. That's racy with the user's autosave (which writes the same row). Splitting `todo_meta` out lets each system update its own slice independently. Same logic for `nutrition` (one row per `**` line), `thread_mentions` (one row per `#tag`), and the per-day `ai_summaries` cache.

The principle, stated cleanly: **denormalize when access is co-located; normalize when mutations are independent.** The interview answer that's wrong is "JSON columns for flexibility" — flexibility isn't free and isn't the reason; the reason is access pattern.

### `[senior]` — "How do you keep `entries.todos_json` and `todo_meta` in sync without a foreign key?"

There is no FK because SQLite can't FK to an element inside a JSON array. So I enforce the 1:1 in code, in `src/services/todos/reconcileMeta.ts:reconcileTodoMetaForEntry`. The function is called after every entry-write path that could change the todos array — which is essentially "every commit point in the journal screen plus every direct `addTodo` / `updateTodo` / `deleteTodo` call from the dashboard or `/todos` page."

The reconciler does a three-way diff in O(todos) time. It loads the current `todo_meta` rows for the entry (`getTodoMetasByEntry`), builds a `Map<todoId, TodoMeta>` of existing rows, and walks the entry's current `todos` array. For each todo in the array: if it has a matching meta row, leave it alone (preserves type, classifier_confidence, pinned, etc.). If it doesn't, INSERT a fresh meta row with `type` from the heuristic classifier inline, and if the heuristic returned null, schedule an async LLM classification via `scheduleClassify(todoId, text)`. After walking the todos array, walk the existing meta map: any meta whose `todoId` isn't in the current `todos.id` set gets DELETEd.

The reconciler is *self-healing*. The whole function is wrapped in try/catch; failures log and swallow. If a previous run died mid-way leaving an orphan meta row, the next reconcile sees the orphan in the diff and deletes it. If a previous run died before inserting a meta, the next sees the missing entry and inserts. Eventual consistency where the next commit is the consistency point. The risk class this leaves open is *"classifier completes for a todo that was deleted between schedule and completion"* — `updateTodoMeta(todoId, ...)` would throw or no-op on a missing row; the code logs a warning and continues. That's acceptable: the worst case is wasted Haiku spend on a todo that no longer exists.

What I'd change at scale: switch to a single SQL diff using SQLite's JSON1 functions. `INSERT INTO todo_meta SELECT json_extract(...) FROM entries WHERE id = ? AND json_each(todos_json) NOT IN (SELECT todo_id FROM todo_meta WHERE entry_id = ?)`. Faster than the procedural diff. Not done because the procedural version is easier to read and the perf isn't dominant.

### `[arch]` — "What are the ways this data model breaks at 1M users with cross-device sync?"

Three failure points, in priority order.

First, **last-write-wins on `entries.text` corrupts collaborative edits.** With 1M users, some fraction will edit the same entry from multiple devices in close succession (phone in the morning, desktop at lunch). `chooseWinner` resolves by `updated_at` — the later write entirely overwrites the earlier. For structured fields (`habits_json`, `mood`) this is fine; for prose this means morning words are gone if the lunch edit didn't include them. The fix is a CRDT or operational-transform layer on `entries.text` — Yjs is what I'd reach for. The schema gains an `entries.text_crdt` column carrying the binary doc; the scanner runs on the materialized text instead of the prose blob; the sync protocol upserts the CRDT delta instead of the full text. That's a real migration, not a flag flip.

Second, **the dirty-row push doesn't scale to high-write tables under shared multi-device.** Today's `localQueryDirty` does `WHERE updated_at > synced_at` and the next push fires every 5 seconds. With 1M users averaging 10 writes per day across 2 devices, the steady-state push QPS at peak hours is in the thousands. Supabase pro caps at hundreds. The architecture has to grow batched delta sync at the protocol level: a delta-log table per user that the device appends to and pushes as a batch, rather than per-row upserts. Reads stay local. The sync protocol changes; the local model doesn't.

Third, **the `(user_id, id)` PK partitions linearly but doesn't isolate hot users from each other.** A power user with 100K entries has 100K rows in the shared `entries` table, which competes for index pages with everyone else. Postgres handles this OK to a point, but at 1M users I'd want logical partitioning by user_id range — declarative partitioning in Postgres, or sharding across Supabase projects. The composite PK makes that migration much easier than it would be with `id`-only — the partition key is already in the PK.

What stays. The denormalize-for-co-location pattern stays — that's an access-pattern decision, not a scale decision. Soft delete via `deleted_at` stays — there's no scale at which hard delete becomes correct for sync. The schema-level `(user_id, id)` PK guarantee stays — it's belt-and-suspenders alongside RLS, and at 1M users I want both. The sync orchestrator's `REGISTRY[]` walk stays — adding a partition layer underneath doesn't change the per-table abstraction.

## The hard question — "There are 'dead' columns on `todo_meta` (stage, position) and on every entity table (notion_page_id, notion_last_synced). Why are they still there?"

Because dropping them has a non-zero cost and zero benefit. Every drop is a Supabase migration and a local SQLite migration — call it a half-day of work to write, test, and verify both don't regress on existing data. The benefit is "the schema is slightly cleaner." That's not zero, but it's also not enough to crowd out feature work.

Specifically. `todo_meta.stage` was the old "todo lifecycle stage" enum (`todo`, `working`, `done`) replaced by the simpler `done` flag on the `TodoItem` itself, commit `a7d6044`. The column has a CHECK constraint (3 values) and a DEFAULT 'todo' so it round-trips on reads, but no UI consumes it. `todo_meta.position` was the old manual reorder column, replaced by `pinned` (commit `a7d6044`) — null on every row, no UI consumes it. `notion_page_id` and `notion_last_synced` on entity tables were from the deleted Notion sync layer, dropped in commit `dc8483a`. The Postgres mirror has them too; same reason they're still there.

The cost of leaving them is bounded. Each adds 8-16 bytes per row for a NULL value (Postgres NULL bitmap is small; SQLite is tighter). At my row counts that's negligible. They aren't read in any code path. They aren't written by any code path. The TypeScript types in `src/types/todoMeta.ts` and `src/services/sync/tables/todoMeta.ts` reflect their presence so nothing crashes on a row that has them set; the mappers ignore them.

The one real risk: a new engineer joining sees `position` and writes code that reads it, assuming it's load-bearing. That's why the project context document (`.aipe/project/context.md`) explicitly lists them as "dead-but-kept." The doc is the mitigation; the schema is the artifact.

What I'd actually do differently: drop them when I'm already shipping a migration in that table for unrelated reasons. Migration `0006_drop_dead_columns.sql` is the kind of thing that would land bundled with the next real schema change as a "while we're here" — not as its own ticket. Until then, the cost-vs-benefit math says leave them.
