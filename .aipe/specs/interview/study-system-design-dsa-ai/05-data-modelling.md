# Chapter 5 — Data Modelling

## Opening — what you're looking at

Eleven SQLite tables in `buffr.db`, defined in `src/services/database.ts`. Ten of them sync to Supabase Postgres with the schema mirrored. The eleventh, `sync_meta`, is a local-only ledger of per-table `last_pull_at`, `last_push_at`, and `last_error`. The schema has three layers of objects: *first-class entities* (habits, threads), *journal artifacts* (entries, projects, vlogs, day_meta, ai_summaries), and *derived projections of prose* (todo_meta, nutrition, thread_mentions). The last layer is the interesting one — those rows are not what the user typed, they are what the scanners projected from what the user typed.

Three relationships carry most of the schema's weight. The first is `entries.todos_json ↔ todo_meta`, a 1:1 invariant where the JSON column carries the user-visible todo (text, done, completed timestamp) and the meta row carries the system-derived state (type, stage, classifier confidence, expansion). The second is `threads ↔ thread_mentions`, a junction where a mention can attach to an entry, a todo, or neither (the manual-touch deviation). The third is `entries.text → all three scanners`, the implicit relationship that says prose is the source and the typed columns are projections.

Indexes are deliberate, not generated. `entries(date)`, `todo_meta(type)`, `todo_meta(stage)`, `thread_mentions(thread_id, created_at)`, `threads(slug) UNIQUE`. Each one is justified by a query in the read path: `getEntriesByDate` hits `entries(date)`, the type filter chip hits `todo_meta(type)`, the thread detail screen's mention list hits `thread_mentions(thread_id, created_at)`. There is no ORM. There is no migration tool — the migration runner is hand-rolled at the top of `database.ts` and runs an idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` sequence on boot.

### ASCII diagram — entity relationship

```
┌──────────────┐
│  habits      │ first-class. user CRUDs in /more/habits.
│  id (PK)     │ archived/deleted_at flags.
│  slug, label │ cadence_type, cadence_days[], cadence_count
│  time_of_day │
└──────┬───────┘
       │ referenced by id (string) inside entries.habits_json
       ▼ (no FK — past-day refs may dangle harmlessly)

┌──────────────────────────────┐
│  entries                     │ canonical. prose lives here.
│  id (PK), date, text         │
│  habits_json   (string[])    │
│  clips_json    (ClipItem[])  │
│  todos_json    (TodoItem[])  │ ◀──┐
│  notion_page_id (legacy)     │    │ 1:1 invariant
│  updated_at, deleted_at      │    │
└──────┬───────────────────────┘    │
       │ id (FK) ──────────┐        │
       │                   │        │
       │                   ▼        │
       │           ┌──────────────┐ │
       │           │  todo_meta   │ │
       │           │  todo_id PK  │─┘  enforced by reconcileMeta.ts
       │           │  entry_id FK │    runs after every entry commit
       │           │  type/stage  │
       │           │  expanded_md │
       │           │  user_overridden_type
       │           └──────────────┘
       │
       │ id (FK)
       ▼
┌──────────────┐    ┌──────────────────────────────────┐
│  nutrition   │    │  thread_mentions                 │
│  entry_id FK │    │  entry_id FK (nullable)          │
│  source_line │    │  todo_id  FK (nullable)          │
│  name, kcal  │    │  source_line, tag_text           │
└──────────────┘    │  thread_id FK ──┐                │
                    └─────────────────┼────────────────┘
                                      ▼
                              ┌──────────────┐
                              │  threads     │ first-class.
                              │  id (PK)     │ slug UNIQUE.
                              │  slug, name  │ target_cadence_days
                              └──────────────┘

   projects, vlogs, day_meta, ai_summaries — keyed by date,
   not directly related to the prose-derived layer.

   Manual touch deviation:
     thread_mentions row with entry_id IS NULL AND todo_id IS NULL
     written by toggleThreadTouchToday in services/threads/touch.ts
```

The 1:1 invariant between `entries.todos_json` and `todo_meta` is the single non-negotiable in this data model. Any feature that inserts into `todos_json` must trigger `reconcileTodoMetaForEntry` to create the paired meta row; any feature that deletes from `todos_json` must let the reconcile pass clean up the orphan.

---

## Concepts (four-part structure)

### 1. Hybrid relational + JSON column model

**Shape.** Three storage shapes coexist in the schema. Pure relational columns (`entries.date`, `entries.id`, `todo_meta.type`) for fields that need to be indexed or filtered. JSON-encoded columns (`entries.todos_json`, `entries.habits_json`, `entries.clips_json`) for ordered lists of structured items that the application reads as a unit. A 1:1 relational sidecar table (`todo_meta`) for fields that need their own indexes (`type`, `stage`, `position`) and their own write paths (the LLM classifier mutates `type` independently of the prose).

**Rule.** A field goes in a JSON column when: (a) it's part of a list whose order matters and is per-entry, (b) it doesn't need to be filtered or indexed across all entries, and (c) the application always reads the whole list at once. A field goes in a sidecar table when: (a) it needs its own indexes, (b) it has a different write cadence than the parent (LLM classifier vs user typing), or (c) the cardinality across all entries is large enough to make `JSON_EACH` queries expensive.

**Failure mode.** If `todo_meta` were merged back into `todos_json`, the `/todos` page's filter chips (status, type, thread) would have to do a `JSON_EACH(todos_json)` scan across every entry to build the list. That's `O(N entries × M todos per entry)` on every render, no index. With the sidecar, the same query is `SELECT … FROM todo_meta WHERE type = ?` against an indexed column. At 200 entries × 30 todos, the sidecar is ~50× faster.

**Contrast.** `nutrition` and `thread_mentions` are pure sidecar tables — they have no JSON column on the parent. The constraint that distinguishes them: nutrition rows aren't ordered within an entry the way todos are (the dashboard never says "the third nutrition row of today"), so there's no list-as-unit reason to keep them in JSON. Thread mentions are many-to-many across entries, todos, and threads, which JSON columns can't model cleanly. The split between JSON-as-list and table-as-set is the constraint that drives the choice.

### 2. The 1:1 todos_json ↔ todo_meta invariant

**Shape.** Three components hold the invariant. `entries.todos_json` carries the array of `TodoItem` (id, text, done, completedAt, createdAt, sourceLine). `todo_meta` carries the per-todo metadata row keyed by `todo_id`. `reconcileTodoMetaForEntry` in `src/services/todos/reconcileMeta.ts` runs after every entry commit and is responsible for inserting missing meta rows and deleting orphaned ones.

**Rule.** Every `TodoItem` in any `entries.todos_json` has exactly one row in `todo_meta`. The reconcile function is the only path that mutates this relationship; CRUD callers never insert into `todo_meta` directly. The invariant is asserted on every commit: missing meta → insert (with heuristic classify); orphaned meta (todo deleted from prose) → delete.

**Failure mode.** A path that adds to `todos_json` without firing reconcile produces a todo with no meta row — the `/todos` page's join would skip it silently, the type badge wouldn't render, the user would see a row with no badge and no expand affordance. A path that deletes from `todos_json` without firing reconcile leaves orphan meta rows that never get cleaned up; the `/todos` page would show ghost todos referencing entries that no longer have those lines. The reconcile pass exists specifically because both directions of drift have happened during development.

**Contrast.** The `entries.habits_json` column has *no* sidecar enforcement. A habit checked-in on a past day stays in the JSON column forever, even if the corresponding `habits` row is hard-deleted. The constraint that distinguishes them: a habit ID is an opaque pointer to a first-class object the user controls; a todo is part of the prose, and the prose is canonical. Past habits dangling is acceptable historical record; past todos dangling would mean the prose-canonical invariant broke.

### 3. The manual-touch deviation in thread_mentions

**Shape.** Three pieces define the deviation. `thread_mentions` schema permits `entry_id` and `todo_id` to be NULL. `toggleThreadTouchToday` in `src/services/threads/touch.ts` writes a row with both NULL and `tag_text = ''`, attached to a thread by `thread_id`. The dashboard's 14-cell strip on thread rows reads only manual-touch rows (filtering for both NULL).

**Rule.** Mentions are derived from prose (Principle 11), with one documented exception: the dashboard's "I worked on this thread today without writing about it" toggle. The deviation is allowed because (a) the schema permits both NULL, (b) the staleness math composes uniformly across mention shapes, (c) toggling off only deletes the manual row, and (d) the alternative — forcing the user to type prose to register a touch — defeats the dashboard's "tap to log" affordance.

**Failure mode.** Without the deviation, the dashboard tracker for threads has no usable interaction model. The user would have to navigate into a journal entry, type `#tagname`, and exit, just to mark a thread "done today." That's 5 taps and a typed token where one tap suffices. The cost would be silent: users would stop using the tracker, and the threads system would degrade to a passive read-only view.

**Contrast.** The same pattern doesn't apply to nutrition or todos because both have a natural prose form that's already fast to type. `[]` is two characters; `** food N kcal` is the explicit shape. There's no equivalent "tap a chip to log a nutrition row" affordance because typing is already the affordance. The constraint that distinguishes threads is that `#tag` requires a known thread *slug* the user has to recall, and the dashboard already shows the thread name — a tap is faster than typing.

---

## Interview questions

### [mid] Walk me through what's stored when a user types `[] call mom by tomorrow #family` into a journal entry.

**Model answer.**

After commit, three tables receive writes. `entries.text` stores the literal line as part of the day's prose; the prose is the canonical source. `scanTodosFromText` parses the `[]` line and merges into `entries.todos_json` — a `TodoItem` with a generated `id`, `text: 'call mom by tomorrow #family'`, `done: false`, `sourceLine: 0` (or whatever line index), `createdAt: now`. The same text — including the `#family` token — stays in the todo's `text` field for display.

`reconcileTodoMetaForEntry` runs fire-and-forget. It detects the new todo and inserts a `todo_meta` row keyed by the todo's id with `entry_id`, `entry_date`, `type='todo'` (set by the heuristic — "call" is in the imperative-verb list), `classifier_confidence='heuristic'`, `stage='todo'` (default, surfaces as "Open"), `position=NULL`, `user_overridden_type=0`. The heuristic also matches `by tomorrow` against the deadline pattern, which would have set type to 'todo' too if the verb didn't.

`scanThreadsForEntry` runs after `scanTodos` because it needs the new todo's id for `[]`-line tag attribution. It parses `#family`, resolves the slug to a `thread_id` (auto-creating the `threads` row if `family` doesn't exist), and inserts a `thread_mentions` row with `thread_id`, `entry_id` (so the prose-on-the-entry case is covered), `todo_id` (so the tag-inside-the-todo case is also covered), `source_line: 0`, `tag_text: 'family'`, `created_at: now`.

`schedulePush()` debounces 5 seconds, then `pushAll()` ships all four tables (`entries`, `todo_meta`, `threads` if newly created, `thread_mentions`) to Supabase as one batch. Total writes: 1 prose update + 1 meta insert + possibly 1 thread insert + 1 or 2 mention inserts (depending on whether the tag is in entry prose alone or also inside the todo line).

### [senior] Why do you store `tag_text` literal-as-typed alongside `thread_id` in `thread_mentions`?

**Model answer.**

Two reasons. The first is line-shift fallback in the two-pass reconcile. Pass 1 of `scanThreadMentionsForEntry` matches by `(thread_id, source_line)` — exact line. Pass 2 matches by `(thread_id, tag_text)` within ±3 lines. If a user inserts a paragraph above an existing line, Pass 1 misses (line index shifted) but Pass 2 catches it because the literal tag text is unchanged. Without storing the literal text, Pass 2 has nothing to match on.

The second is display-truthfulness. The user typed `#Buffr` (capitalized), but the slug is `buffr` (lowercased for case-insensitive uniqueness). When I render the thread detail page's mentions list, I want to show what the user actually typed — `#Buffr` — not the normalized slug. Storing `tag_text` keeps the original case for display. The thread's display name comes from the `threads.name` column (set on first auto-create from `tagText`), which is the same source.

There's a small risk: if the user types `#Buffr` and later changes the thread's name to "buffr", the mention row still shows `#Buffr`. That's fine — the mention is a historical record, not a current-state pointer. The thread row is the live identity; the mention row is the projection at the moment the prose was written. The same logic explains why renaming a thread *slug* invalidates existing mention reconciliation — the slug is the matching key, and changing it means the next scan loses the existing mentions. Spec §6.6 documents this as the slug-rejected-on-pull rule.

### [arch] If you split the database — keep prose local, move typed records to a server — what breaks?

**Model answer.**

The project's central architectural rule (DB is single source of truth, Principle 1; prose is canonical for drops, Principle 2) breaks immediately, and the failure modes cascade. The two-pass scanner pattern depends on reading existing typed rows synchronously when scanning new prose; if those rows live on a server, the scanner becomes a network call and `useEntries.editEntry` blocks on it. The journal's keystroke contract (DB-first autosave, Principle 3) requires that writes complete in milliseconds; a network round-trip to a server-side row store doesn't fit that budget.

The user-override lock breaks too. `user_overridden_type` is read on every reconcile pass. If meta lives on a server and prose lives on the device, the reconcile has to pre-fetch every meta row before scanning, and the prefetch has to happen at every commit. The classifier toast becomes "waiting for server before reclassifying," which destroys its quiet-background character. The fix would be a local cache of meta rows — but at that point you've reinvented local-first storage, just with worse semantics (cache invalidation, no transactional guarantees against the prose).

The thing that *would* work, and is what I'd actually do at a larger scale, is move only the LLM-derived columns (`expanded_md`, `caption`) server-side. Those have low write frequency (one expansion per todo, one caption per day), high cost-per-write (Sonnet 4.6 calls), and don't participate in the scanner reconciliation. The classifier output (`type`, `classifier_confidence`) stays local because it's read on every render and runs synchronously after commit. The split would be: server-side cache of the expensive generations, keyed by `(todo_id, prompt_version)`, accessible to the device on demand and synced down on first request. That's the Phase B path: server keeps an opinion about the few fields that the server is the right owner of, and the local DB stays authoritative for everything that has to keep up with the keystroke.

---

## The hard question

### "You have eleven tables and no foreign-key constraints in the JSON columns (todos_json, habits_json). How do you stop dangling references from corrupting the data?"

**Model answer (≥200 words).**

I don't, fully — and the answer differs by relationship. For `entries.habits_json` referencing `habits.id`, dangling references are deliberate: hard-deleting a habit doesn't rewrite past entries' `habits_json` because past days are historical record. The chip on the journal screen renders the habit label by joining `habits_json[i]` against the current `habits` table; when the join fails (the habit is gone), the chip just doesn't render, and the day's checkbox count is one lower than it was. That's an acceptable degradation — historical days don't need to be perfectly representable when the user has explicitly deleted the source habit.

For `entries.todos_json` referencing `todo_meta`, the invariant *is* enforced — by `reconcileTodoMetaForEntry`, not by the schema. The reconcile runs after every commit and inserts missing meta rows, deletes orphans. If a code path bypassed reconcile (a direct DB write to `todos_json` from an unfamiliar caller), the invariant could break silently between the commit and the next reconcile run. I don't have a CHECK constraint or trigger asserting it; I rely on the convention that all writes go through `updateEntry`, which fires the scanner suite, which fires reconcile. That's discipline, not enforcement.

The compromise I've made is: use foreign keys in the relational tables (`thread_mentions.thread_id`, `nutrition.entry_id` are FK-like by intent even when not declared), and accept that JSON columns are projections of prose where the prose is the actual source. If the worst happens — a row in `todos_json` with no meta — the next entry edit fixes it (`reconcileTodoMetaForEntry` is idempotent and re-asserts the invariant on every run). That's the same self-healing logic that makes backfill migrations safe to re-run.

What I'd build at a higher scale: a periodic integrity check job. Walk every `entries.todos_json[i].id`, assert a matching `todo_meta` row exists, log mismatches. Run it daily (or on every cold boot). This is on the deferred backlog but not in v1 because zero data-loss bugs of this shape have surfaced in production use, and the reconcile-on-commit pattern has been sufficient. At multi-tenant scale where the assumption "the user will commit again soon" doesn't hold for every dataset, the periodic check becomes mandatory.
