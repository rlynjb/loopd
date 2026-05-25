# Append-only Postgres migrations

**Industry name(s):** Append-only migrations, forward-only schema migration
**Type:** Industry standard · Language-agnostic

> Every Postgres schema change is a new file, never an edit of an existing one.

**See also:** → [02-authentication-boundary](./02-authentication-boundary.md) · → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md)

---

## Why care

Open `git log` on any repo with more than two contributors. Yesterday's commit has a typo in the message — `fxi` instead of `fix`. The engineer doesn't `git commit --amend` because the commit has already been pushed and pulled by three teammates; amending would create divergent history and force everyone to recover. Instead they push a follow-up commit that explains or fixes the typo. Anyone reading the log from the beginning sees the same sequence of events, in the same order, and arrives at the same final state. Postgres's WAL (write-ahead log) ships this discipline at the database layer; event sourcing ships it at the application layer; every "the build works on my machine" bug that traces back to schema drift is the consequence of breaking it.

The question git answers is one any system whose state is "the result of applying a sequence of changes" has to answer: when a past change turns out to be wrong, do you edit it (and risk divergence between anyone who already applied it and anyone who didn't) or do you write a correction forward? Not "edit in place" — that breaks every copy that's already past the bad entry. The answer is *append-only history*: once a change is committed and applied anywhere, it is frozen; corrections ship as new entries that reference the old ones.

**What depends on getting this right:** whether a fresh Supabase clone (production, staging, a new contributor's local instance) converges on the same schema as production, or whether environments silently diverge by the size of a typo. In this codebase every schema change is `supabase/migrations/NNNN_<description>.sql`, where `NNNN` is a zero-padded sequence number. The runner is `scripts/db-migrate.mjs`: it reads a `_migrations` ledger table for the list of already-applied filenames and runs every file in `supabase/migrations/` that isn't in the ledger, in numeric order, then records the filename. A fresh project replays `0001` through whatever's latest; an existing one runs only what's new. The rule: once `0001` is in any environment's `_migrations` table, you don't edit it — you ship `0006_fix_the_typo.sql` with an `ALTER TABLE`.

Without append-only (edit-in-place is allowed):
- Developer notices `0001` declared `entries.text TEXT` but should have been `TEXT NOT NULL`
- They edit `0001` directly, commit, push, and re-run the migration runner locally
- Their local sees `0001` already in `_migrations` and skips it — but the file on disk now says `NOT NULL`
- Production was already past `0001`, so its `entries.text` stays nullable
- A new contributor's fresh clone applies the *new* `0001` with `NOT NULL`
- Two environments now have schemas that differ by a NULL/NOT NULL constraint that no one can see in the file tree

With append-only (corrections ship as new files):
- Same typo discovery; developer writes `0006_entries_text_not_null.sql` with `ALTER TABLE entries ALTER COLUMN text SET NOT NULL`
- Fresh clones run `0001` (nullable) → `0006` (not nullable); existing projects run only `0006`
- Both converge on the same final schema
- The ledger entries match the file tree on every environment; "works on my machine" doesn't happen

The migration history *is* the schema — never edit history, append corrections.

---

## How it works

Git's published commit history is the canonical pattern. Every commit is dated, hashed, and immutable once pushed. If yesterday's commit has a bad change, you don't `git rebase -i` and rewrite history (that would break every teammate's clone) — you push a follow-up commit that explicitly reverts or corrects. Anyone who reads the repo from commit 0 forward sees the same sequence, in the same order, and arrives at the same final tree. Supabase migrations enforce the same shape at the schema layer: every migration file is numbered, dated, immutable; corrections come as new files, not edits to old ones.

The append-only ledger shape in one picture:

```
   supabase/migrations/              _migrations (in Postgres)
   ──────────────────────            ─────────────────────────
   0001_initial.sql                  ┌────────────────────────┐
   0002_rls.sql                      │ filename               │
   0003_server_time.sql              ├────────────────────────┤
   0004_relax_fks.sql                │ 0001_initial.sql       │ ◄── ledger of
   0005_todo_meta_pinned.sql         │ 0002_rls.sql           │     applied files
   0006_fix_typo.sql      ◄── never  │ 0003_server_time.sql   │
                              edit   │ ...                    │
                              0001;  └────────────────────────┘
                              ship
                              0006              │
                              forward           │
        │                                       │
        ▼                                       ▼
   every environment replays in numeric order  →  same schema
   git's append-only commit history shape, applied to SQL.
```

The migration history IS the schema. The four sub-sections below trace the numbered convention, the runner that walks the ledger, the never-edit rule, and the convergence property that makes the discipline worth keeping.

### The numbered file convention — `NNNN_description.sql`

Every schema change lives in `supabase/migrations/NNNN_<description>.sql`, where `NNNN` is a zero-padded sequence number. The codebase currently has `0001_initial_schema.sql` through `0005_todo_meta_pinned.sql`. The numbers are the canonical order; the filenames are documentation; the SQL inside is what actually runs. If you're coming from frontend, this is the same shape as a typed event-sourcing log or a Redux action history — events appended in order, the current state derived by replaying from the start. Concrete consequence: a fresh Supabase project runs `0001` through `0005` in order; an existing project that's already at `0004` runs only `0005`. The "current schema" is whatever the sum of all migrations produces — there's no separate `schema.sql` file claiming to be the truth. Boundary: this works because no two migrations carry the same number (the developer convention enforces uniqueness; the runner would error on collision).

The numbered-file convention in the file tree:

```
   supabase/migrations/
   ────────────────────────────────────────────────────
     0001_initial_schema.sql       ◄── canonical order
     0002_rls_policies.sql              is the number
     0003_server_time_rpc.sql           (not the date,
     0004_relax_fks.sql                  not git history)
     0005_todo_meta_pinned.sql
     ...
     (current head: NNNN)

   replay rules:
     fresh project:        apply 0001 → 0002 → ... → NNNN
     existing-at-N:        apply N+1 → ... → NNNN
     already-up-to-date:   no-op

   the "current schema" = the sum of all migrations replayed
   there's no separate schema.sql claiming to be the truth
```

The number is the load-bearing part — filenames are documentation, SQL inside is what runs.

### The runner — `db-migrate.mjs` and the `_migrations` ledger

`scripts/db-migrate.mjs` is the harness. It connects to Postgres using the `pg` library and `dotenv` for credentials, queries a `_migrations` table for the list of already-applied filenames, and runs every file in `supabase/migrations/` that's not in the ledger, in numeric order. After each successful file, it inserts a row into `_migrations` with the filename. If you've worked with `prisma migrate` or `knex migrate:latest`, the shape is the same — a ledger table records what's applied, the diff against the filesystem says what's pending, the runner walks the diff. Concrete consequence: run `node scripts/db-migrate.mjs --all-pending` on a fresh database. The runner sees `_migrations` is empty, reads the migrations directory, applies `0001` → inserts `('0001_initial_schema.sql', now)` → applies `0002` → inserts → and so on. On a database already at `0004`, the runner sees `0001`-`0004` in the ledger, skips them, applies only `0005`. Boundary: if a migration fails halfway through, the ledger doesn't record it; the next run retries the same file. This assumes Postgres transactionality around the migration body — if a migration is non-transactional (e.g. CREATE INDEX CONCURRENTLY), the recovery story gets more involved.

The runner's logic in one flow:

```
   node scripts/db-migrate.mjs --all-pending
                       │
                       ▼
   ┌──────────────────────────────────────────────────┐
   │ 1. SELECT filename FROM _migrations               │  ◄── what's applied
   │                                                    │
   │ 2. ls supabase/migrations/*.sql                    │  ◄── what's on disk
   │                                                    │
   │ 3. pending = (on disk) − (in ledger)               │  ◄── what to run
   │                                                    │
   │ 4. for each pending file in NNNN order:            │
   │      BEGIN;                                        │
   │        run the file's SQL                          │
   │        INSERT INTO _migrations (filename)          │
   │      COMMIT;                                       │
   └──────────────────────────────────────────────────┘
                       │
                       ▼  on failure mid-file
   transaction rolls back; ledger not updated
   next run retries the same file
   (assumes the migration body is transactional)
```

Same ledger pattern as Prisma, Knex, Flyway — the runner is small precisely because the discipline does the work.

### Append-only means never edit `0001` — the discipline

The rule: once a migration is committed and applied anywhere, it is permanent. If you discover a typo in `0001` two days later, you do NOT edit `0001`. You ship `0006_fix_the_typo.sql` that does the correction with `ALTER TABLE` or `ALTER COLUMN`. The reason: if `0001` is already in some environment's `_migrations` ledger, editing it doesn't re-run it — the ledger says "applied," so the runner skips it. The two environments are now diverging by exactly the size of the typo. If you're coming from frontend, this is the same shape as Git's rule against rewriting public history (`git push --force` to a shared branch): once others have a copy of the commit, you can only add on top. Concrete consequence: developer notices `0001` declared `entries.text TEXT` but it should have been `TEXT NOT NULL`. They write `0006_entries_text_not_null.sql` with `ALTER TABLE entries ALTER COLUMN text SET NOT NULL`. The fresh-project path now runs `0001` (text nullable) → `0006` (text not nullable). The already-running-project path runs only `0006`. Both converge on the same final schema. Boundary: this assumes the correction is expressible as an ALTER — schema changes that would require data backfill (e.g., the typo created data that's now misaligned) need their own DML migration in the same ledger.

The two paths after discovering a typo:

```
                     WRONG: edit 0001 in place
   ┌─────────────────────────────────────────────────────────┐
   │ env A (already past 0001):                                │
   │   _migrations has it; runner skips                         │
   │   schema stays nullable                                    │
   │ env B (fresh clone):                                      │
   │   runner applies the new 0001 with NOT NULL                │
   │ env A and env B now have different schemas for one         │
   │ column — invisible in the file tree                        │
   │   "works on my machine" bug                                │
   └─────────────────────────────────────────────────────────┘

                     RIGHT: ship 0006 forward
   ┌─────────────────────────────────────────────────────────┐
   │ add 0006_entries_text_not_null.sql:                       │
   │   ALTER TABLE entries ALTER COLUMN text SET NOT NULL;     │
   │ env A: applies 0006 → text now NOT NULL                   │
   │ env B: applies 0001 (nullable) → 0006 (NOT NULL)          │
   │ both converge on the same final schema                    │
   └─────────────────────────────────────────────────────────┘
```

Editing `0001` is the same mistake as `git push --force` to a shared branch — silent divergence everywhere a copy already exists.

### Why the discipline matters — every environment converges on the same path

The point of append-only isn't aesthetic. It's that *every environment runs the same sequence of files in the same order*. Production, staging, your local Supabase, a new contributor's Supabase clone — they all replay `0001` through `0005`. If the runner runs the same files in the same order on every environment, the schemas converge. The moment someone edits `0001`, environments that already applied the old `0001` carry one schema, and environments that haven't yet applied any migration apply the new `0001` and carry a different schema. Think of it like the determinism contract a build tool relies on (`make` rebuilds only what's changed; the build graph is the truth). Concrete consequence: a new contributor clones the repo, points at a fresh Supabase project, runs the migration runner. They get exactly the same schema production has. There's no "remember to also manually do X" step — the ledger is the only handoff. Boundary: a developer who edits `0001` on their machine and pushes the change breaks this contract. Code review catches it; the runner doesn't.

Three environments, the same ledger sequence, the same end-state schema:

```
        Production              Staging              New contributor
   ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
   │ _migrations:     │    │ _migrations:     │    │ _migrations:     │
   │   0001 ✓         │    │   0001 ✓         │    │   0001 ✓         │
   │   0002 ✓         │    │   0002 ✓         │    │   0002 ✓         │
   │   0003 ✓         │    │   0003 ✓         │    │   0003 ✓         │
   │   0004 ✓         │    │   0004 ✓         │    │   0004 ✓         │
   │   0005 ✓         │    │   0005 ✓         │    │   0005 ✓         │
   └──────────────────┘    └──────────────────┘    └──────────────────┘
              │                       │                       │
              └─────────────┬─────────┴───────────────────────┘
                            │
                            ▼
              same sequence → same schema → same final state
              (the ledger IS the handoff; no "remember to also manually do X")
```

Same files, same order, same outcome — that's the entire reason the discipline exists.

This is what people mean by "schemas as event-sourced logs." The pattern is everywhere — Postgres migration tools (Flyway, Liquibase, Alembic), Rails migrations, Knex, Prisma, Sequelize — they all enforce the same discipline because the alternative is environments drifting into uniqueness, which is the source of "works on my machine" bugs that nobody can debug. Once you internalise that the migration history IS the schema, never editing the history becomes a one-line rule rather than a wishful aspiration. The full picture is below.

---

## Append-only migrations — diagram

```
┌─ Source tree (append-only ledger) ──────────────────────────────────────┐
│  supabase/migrations/                                                   │
│    0001_initial_schema.sql            ── 10 mirror tables, (user_id,id) │
│    0002_rls_policies.sql              ── RLS (DISABLED in Phase A)      │
│    0003_server_time_rpc.sql           ── RPC the pull path uses         │
│    0004_relax_fks.sql                 ── FK adjust for soft-delete edges│
│    0005_todo_meta_pinned.sql          ── ADD COLUMN pinned              │
│    0006_todo_meta_type_study.sql      ── widen type CHECK +'study'      │
│    0007_todo_meta_type_reflect.sql    ── widen type CHECK +'reflect'    │
│    0008_todo_meta_type_reduce.sql     ── DROP {bug,question,decision,   │
│                                          content}; remap rows to 'todo' │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌─ CLI / runner ──────────────────────────────────────────────────────────┐
│  node scripts/db-migrate.mjs --all-pending                              │
│      ↓                                                                  │
│  pg client connects, queries _migrations ledger,                        │
│  walks files in order, executes any not yet applied                     │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌─ Storage layer (Supabase Postgres) ─────────────────────────────────────┐
│  schema updated; _migrations ledger appended                            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Migrations dir:** `supabase/migrations/` — currently 8 files (was 5 pre-2026-05-09). Append-only; never edit a committed file. The 0006/0007/0008 trio narrowed the thinking-mode taxonomy from 7 modes to 5 in the most disruptive way the rule allows: 0006 added `study`, 0007 added `reflect`, 0008 dropped `bug/question/decision/content` and remapped affected rows to `todo`. Three migrations instead of one because each shipped on a separate day; no edit of the prior files even though the end state is "narrowed taxonomy".
**Runner:**         `scripts/db-migrate.mjs` (153 lines) — uses `pg` + `dotenv`. Connects via `DATABASE_URL`, queries a `_migrations` ledger table, runs pending files in order. Run with `node scripts/db-migrate.mjs --all-pending`.
**Local SQLite:**   `src/services/database.ts` — handles the same `CHECK` constraint dance via a recreate-table block (SQLite can't `ALTER TABLE … DROP CONSTRAINT` like Postgres can; it has to copy the table). The 0006/0007 migration block was repurposed to also cover 0008's reduce.

---

## Elaborate

### Where this pattern comes from
Append-only migrations are the canonical Rails pattern, copied by Django, Sequelize, Prisma, Knex, and basically every ORM-adjacent tool since 2008. The shared insight: a migration that ran on prod yesterday cannot retroactively change. Editing it would mean the dev DB and prod DB end up in different states.

### The deeper principle
**Schema is event-sourced; the latest state is a sum of every applied migration, not a snapshot.** This is what makes "spin up a fresh DB and replay" tractable — every fresh environment converges on the same schema by running the same sequence.

### Where this breaks down
- Massive schema changes that the migration log has no neat way to express (e.g., "split this column into three new tables" with data backfill). Pragma is to write a script alongside the migration and document it.
- Time-bounded fixes where the ledger lies (someone manually applied a hotfix and didn't record it). Discipline is the only mitigation.

### What to explore next
- [Authentication boundary](./02-authentication-boundary.md) → migration `0002` is the staged-but-disabled RLS scaffold.
- Squashing migrations (the once-a-quarter compaction practice) → for managing log length over time.

---

## Tradeoffs

We traded a clean-looking schema for replay determinism: every fresh environment runs the same files in the same order, and the cost is a growing ledger of migrations that readers must walk to understand current state.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (append-only)     │ Alternative (edit-in-place)  │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Environment      │ guaranteed — same files,     │ silent drift between dev,    │
│ convergence      │ same order, same schema      │ CI, prod once a file is      │
│                  │                              │ edited post-deploy           │
│ Bug detection    │ extra file is visible in diff│ schema drift undetectable    │
│                  │ — readable audit trail       │ without pg_dump comparisons  │
│ Code surface     │ ~150 LOC runner, 8 SQL files│ same runner; fewer files but │
│                  │ today (was 5 pre-2026-05-09) │ "edit existing" undocumented │
│ Schema readability  must replay or read ledger  │ open one file, see schema    │
│                  │ to understand current state  │ snapshot                     │
│ Replay cost      │ N migrations × ~50 ms each = │ trivial — single file        │
│                  │ ~400 ms today; minutes at    │                              │
│                  │ 500+ migrations              │                              │
│ Squash difficulty handled at ~50 files via      │ already squashed; loses      │
│                  │ consolidation migration       │ audit trail                  │
│ Audit trail      │ git blame the migration —    │ git blame the file edit —    │
│                  │ "when did pinned ship?"      │ doesn't say "when did this  │
│                  │ → answer is "0005's mtime"    │ run on prod?"                │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

The schema is no longer a snapshot you can read in one file. Understanding "what columns does `todo_meta` have today?" means walking 0001 → 0005 (pinned column) → 0006 (type widen) → 0007 (type widen) → 0008 (type reduce). Eight files today; the cost grows linearly with feature work. Anyone joining the project has to either replay against a fresh DB or read the files in order — there's no consolidated `schema.sql` to grep.

The 0006/0007/0008 sequence shows the discipline cost plainly. Three migrations narrowed the thinking-mode taxonomy from 7 modes to 5: 0006 added `study`, 0007 added `reflect`, 0008 dropped four. Each shipped on a separate day. None of them edits the prior files even though the net effect could have been one file with the final state. Three files, three audit entries, three replays per fresh DB. The cost is the file count; the win is that any dev who ran 0006 alone and stopped has a defined intermediate state.

The runner is hand-written (`scripts/db-migrate.mjs`, 153 LOC, `pg` + `dotenv`). It does what Supabase CLI or Prisma migrate would do, minus the auto-diff features. We pay in onboarding (a new contributor doesn't recognize "`node scripts/db-migrate.mjs --all-pending`" as a standard command) and in lack of tooling (no auto-generated migrations from schema diffs).

### What the alternative would have cost

Edit-in-place migrations save the file-count cost but trade it for silent schema drift between environments. The day someone edits `0003_server_time_rpc.sql` to fix a bug, all environments that already ran the original have the buggy version; new environments replay the fix. Detecting the divergence requires `pg_dump` comparisons across environments or schema-introspection tooling — neither of which exists in this project. The bug surfaces as "works in CI, broken in prod" weeks later, and the root cause is the cleanest-looking decision in the project.

Prisma or Supabase Studio with managed migrations would have added a toolchain and an ORM-shaped expectation. The codebase deliberately writes raw SQL on both ends (SQLite via `database.ts`, Postgres via append-only files); adding Prisma for migrations alone means carrying its schema-generation toolchain for one task. Net code surface goes up, not down.

### The breakpoint

Fine until ~50 migrations or until the replay cost crosses a minute. At 50 files the migration log becomes a navigational burden; readers can't hold the sequence in their head, fresh-environment setup slows down, and "squash" becomes a real operation: take current schema state, write `00XX_consolidated.sql`, archive the older files behind a minimum-compatible-version check. We have 8 files today; the squash plan ships the day we cross ~50.

### What wasn't actually a tradeoff

Manual hotfixes outside the migration ledger weren't a real option. The ledger is the only source of truth for "what has this environment run." A SQL change applied via Supabase Studio's UI that doesn't go through `scripts/db-migrate.mjs` produces exactly the drift the append-only discipline is meant to prevent. The runner's ledger query is the audit gate; bypassing it defeats the design.

---

## Tech reference (industry pairing)

### pg + db-migrate.mjs

- **Codebase uses:** `scripts/db-migrate.mjs` — 153 LOC, `pg` + `dotenv`.
- **Why it's here:** hand-written runner applies append-only SQL files to Supabase Postgres via `_migrations` ledger; chosen over ORMs to avoid toolchain.
- **Leading today:** Prisma Migrate — `adoption-leading`, 2026.
- **Why it leads:** schema-first DSL + auto-generated typed client; widely adopted across JS backends.
- **Runner-up:** Drizzle Kit — `innovation-leading` typed SQL with compile-time migration generation.

---

## Summary

Forward-only schema migrations are an append-only ledger: once a migration has been applied anywhere it is frozen, and any correction ships as a new migration that fixes the previous one. In this codebase `supabase/migrations/000N_*.sql` files are immutable once committed, and `scripts/db-migrate.mjs` (153 lines of `pg` + `dotenv`) walks the directory, queries a `_migrations` ledger table, and runs any pending file in order. The constraint was that editing `0001` after it ran on cloud would silently drift the schema between dev and prod — there's no way to detect that without diffing schemas across environments. The cost is that the migration log gets long and readers must walk the history to understand current state, which is why the 0006/0007/0008 trio narrowed the thinking-mode taxonomy across three separate files instead of one even though the net effect was a single taxonomy change. Squashing is the answer once the log gets to fifty files; today there are eight and squashing hasn't been needed.

Key points to remember:
- Schema is event-sourced; the current state is the sum of every applied migration in order, not a snapshot.
- Every fresh environment converges on the same schema by running the same files in the same sequence — that's the whole point of the discipline.
- Lives in step 1 (Data model) of the system-design checklist.
- Editing a shipped migration silently diverges environments; adding `000N_fix_typo.sql` is always the cheaper insurance.
- The 0006/0007/0008 sequence held the append-only line even when the end state was a taxonomy narrowing — three migrations on three days, no edits to prior files.

---

## Interview defense

### What an interviewer is really asking
Append-only migrations is a discipline question, not a technical one. The interviewer wants to know whether you understand *why* you can't edit `0001` after it ships, and whether you've actually held the line under pressure (typo in `0003`? add `0004`, don't fix `0003`).

### Likely questions

[mid] Q: I notice migration `0001_initial_schema.sql` has a typo in a column name. The migration is already deployed. What do you do?

A: I add `0006_fix_typo.sql` that runs an `ALTER TABLE ... RENAME COLUMN`. I do NOT edit `0001` even though it's tempting and would be cleaner-looking on disk. The reason: every environment that ran `0001` did so with the typo'd name; if I edited the file, fresh environments would replay with the fixed name and existing environments would still have the typo'd name. The two would silently diverge until someone notices. The audit trail is the file ordering, not the cleanliness of any individual file.

```
[typo-fix flow with append-only]

  0001_initial_schema.sql      ← shipped, frozen, typo'd
        │
        │ environments already ran with typo
        ▼
  new file: 0006_fix_typo.sql
    ALTER TABLE x RENAME COLUMN bad_name TO good_name;
        │
        ▼  node scripts/db-migrate.mjs --all-pending
  every environment runs 0006 → all converge on good_name
        │
        ▼  fresh env from scratch:
  runs 0001 (typo'd) → 0006 (rename) → same final state
```

[senior] Q: Why use `node scripts/db-migrate.mjs` with raw `pg` instead of Supabase's CLI or a Prisma-style runner?

A: Two reasons. First, the project doesn't use an ORM — `database.ts` writes raw SQL to SQLite, and the cloud schema is hand-authored DDL. Adding Prisma just for migrations would mean carrying its schema-generation toolchain for one task. Second, the runner is twenty lines of code that I can read and reason about: connect with `pg`, query a `_migrations` ledger, run pending files in order, update the ledger. No magic. The cost is no auto-generated migrations from schema diffs (which Prisma offers); the win is no Prisma. For a five-migration project, the win pays back.

```
                  Path taken (raw pg runner)            Alternative (Prisma migrate)
                  ──────────────────────────────        ──────────────────────────────
ORM dependency    none                                  Prisma's schema-generation + client
code surface      153 LOC db-migrate.mjs +              +Prisma toolchain (~30 MB),
                  pg, dotenv                            prisma/schema.prisma + generated
                                                        client code
schema source     hand-authored SQL files               schema.prisma + auto-generated SQL
auto-gen from     no (manual)                           yes — schema-diff produces migrations
 model diff
runs against      Postgres directly via DATABASE_URL    Prisma's connection layer
ledger format     _migrations table (one row per file)  prisma_migrations table (richer)
shadow DB needed  no                                    yes for migrate dev (extra setup)
when pays back    8 files, one developer                large team + frequent schema work,
                                                        50+ migrations
```

[arch] Q: What happens when this migration log gets to fifty files and you need to bootstrap a new environment?

A: Replay-from-zero takes longer — every fresh DB runs all fifty files in order. At fifty migrations on a few thousand rows, that's seconds. At five hundred migrations or large data backfills, it becomes minutes and then hours. The standard answer is squashing: once a quarter, take the current schema state, write a new "consolidated" migration `00XX_squash.sql`, and archive the older files. The runner has to know which environments have run which subset, so squashing usually pairs with a "minimum compatible version" check. I haven't needed to squash because there are five files; the day there are fifty, the squash plan ships.

```
At 50+ migrations / large data backfills:

  ┌─ Source tree ────────────────────────────────┐
  │ supabase/migrations/                         │
  │   0001..0050+ files                          │
  └─────────────────────────────────────────────┘
              │
  ┌─ Runner (db-migrate.mjs) ───────────────────┐
  │ replay-from-zero: 50 files × ~50ms each =   │  ◀── BREAKS FIRST
  │ ~2.5s + larger if data backfills            │     (fresh-env setup slows;
  │ at 500 files + GB-scale backfills: minutes  │      mental model loses sequence)
  └─────────────────────────────────────────────┘
              │
  ┌─ Squash operation (the fix) ────────────────┐
  │ + 00XX_squashed.sql with current schema     │
  │ + minimum-compatible-version check in       │
  │   runner ("must have run 00YY before")      │
  │ + archive 0001..00YY files                  │
  └─────────────────────────────────────────────┘
              │
  ┌─ Audit trail loss ──────────────────────────┐
  │ archive is in git history, not in repo HEAD │
  │ "when did pinned ship?" requires git log    │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You said "never edit `0001` even for a typo." Have you ever broken that rule, and if so why?

A: Once, locally, before any environment but my dev box had run the migration. I edited `0001` to fix a constraint name during initial schema design, before cloud was even configured. I don't count that as breaking the rule because no environment had committed to the original — it was still being authored. The rule applies the moment a migration runs against any environment that I don't control or that I won't reset. The discipline I actually hold is: if I'm uncertain whether the migration has shipped, treat it as if it has and add a new file. The cost is sometimes a redundant migration; the alternative is a silent schema drift that costs me hours to debug. Cheap insurance.

```
                  Path taken (treat-as-shipped if      Suggested ("just edit if it hasn't
                  uncertain)                            shipped yet")
                  ──────────────────────────────        ──────────────────────────────
default action    add new file when in doubt           edit existing file when "sure"
                                                          it hasn't deployed
audit signal      git history shows extra file —       silent edit; no signal that the
                  obvious that a fix was applied       schema once differed
cost when wrong   1 redundant migration (~50 ms        silent drift between environments
 (false alarm)    replay cost forever)                 → debugging hours/days later
detection speed   immediate at PR review               weeks later via "works in CI,
                                                          broken in prod"
mental load       "did this ship?" → "doesn't matter,  "did this ship?" → must verify
                  add a new file"                       against every env state
honest practice   discipline holds under pressure       discipline erodes the moment
                                                          someone "knows" it hasn't shipped
real risk profile bounded — extra file is cheap        unbounded — silent drift compounds
```

### One-line anchors
- "Append-only is event-sourcing for schema — current state is the sum of every applied migration, not a snapshot."
- "Every fresh environment converges on the same schema by running the same files in the same order; that's the point."
- "Editing a shipped migration silently diverges environments; the cost of an extra file is always lower."
- "The runner is twenty lines of `pg` + `dotenv` because there's no ORM to defer to — the simplicity is deliberate."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain append-only migrations to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `supabase/migrations/` + `scripts/db-migrate.mjs`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

You realise migration `0003_server_time_rpc.sql` has a bug — the RPC returns `timestamptz` but the client expects `text`. The migration is already deployed to your dev Supabase project. The right fix involves dropping and recreating the function. Walk what you'd do: do you edit `0003`? Add `0006`? What's in the `0006` SQL? What's the order of the deploy?

Write your answer. 3–5 sentences minimum. Then open `supabase/migrations/0003_server_time_rpc.sql` and `scripts/db-migrate.mjs` to verify the runner's behaviour.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `scripts/db-migrate.mjs` (the 153-line raw `pg` runner) to support what exists
→ Point to where Prisma or Supabase CLI hooks would land (likely a `prisma/` directory + a `supabase/` CLI config) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — migration count grew from 5 to 8. Added 0006 (study), 0007 (reflect), 0008 (drop bug/question/decision/content + remap to 'todo'). Three migrations instead of one because they shipped on separate days — append-only discipline held even when the net effect was a taxonomy narrowing.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram; added architectural-layer labels to the primary diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for pg + db-migrate.mjs.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (accounting-ledger metaphor opening / 4 layered sub-sections — numbered file convention, the runner + _migrations ledger, append-only discipline, why every environment converges — each with frontend bridges and concrete consequences / principle paragraph on schemas as event-sourced logs).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (bound-ledger correction-on-today's-page scenario → append-only history named as the answer → bolded "what depends on getting this right" with NNNN-file/_migrations-ledger stakes → before/after walking a typo-edit-vs-new-migration on `0001` → one-line "the migration history *is* the schema — never edit history, append corrections").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced accounting-ledger + branch-office-photocopies analogies with git log push-and-amend discipline + Postgres WAL + event sourcing). Both Move 1s were missed by the original triage agent.

---
Updated: 2026-05-14 — v1.32.0 pass: R1 no-op (anchors already at level-4 — git, Postgres WAL, event sourcing). Added Move 1 mnemonic diagram (migrations directory + ledger + git-like history shape) + 4 Move 2 sub-section diagrams: numbered-file replay rules, runner ledger-diff flow, wrong-vs-right path on a typo, three-env same-schema convergence. Total: 5 new diagrams.
