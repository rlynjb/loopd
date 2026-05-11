# Append-only Postgres migrations

**Industry name(s):** Append-only migrations, forward-only schema migration
**Type:** Industry standard · Language-agnostic

> Every Postgres schema change is a new file, never an edit of an existing one.

**See also:** → [02-authentication-boundary](./02-authentication-boundary.md) · → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md)

---

## Why care

You've edited a migration that already ran on production, deployed the change, and watched the next environment go up cleanly while the previous one stayed silently broken — because the migration runner thought the work was done and never re-ran the patched file. The pain isn't the bug; it's that there's no way to detect it without diffing schemas across environments. The root cause is treating a migration as code you can revise, instead of as a transaction log entry that's already been committed.

Forward-only schema migrations are an append-only ledger: once a migration has been applied anywhere, it is frozen, and any correction ships as a new migration that fixes the previous one. It belongs to the family of "immutable history" patterns, the same shape as event sourcing, Git commits, blockchain blocks, and write-ahead logs. You've seen this in every serious migration tool — Rails, Flyway, Liquibase, Alembic — and in the way append-only logs are how distributed systems agree on what happened. Here's how that actually works in this codebase.

---

## How it works

Each migration is a numbered SQL file. The runner connects to Postgres using `pg` + `dotenv`, queries a `_migrations` ledger table for what's already applied, and runs every newer file in order. After a successful run, the ledger is updated.

Append-only means: never edit `0001` even if you find a typo two days later. Either ship a `0006_fix_typo.sql` that does an `ALTER`, or accept the drift. The discipline keeps every environment converging on the same schema by the same path. The diagram below shows it end-to-end.

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

### Tech reference (industry pairing)

┌─ pg + db-migrate.mjs ───────────────────────────────────────────┐
│ Codebase uses:    scripts/db-migrate.mjs — 153 LOC, pg + dotenv │
│ Why it's here:    hand-written runner applies append-only SQL    │
│                   files to Supabase Postgres via _migrations    │
│                   ledger; chosen over ORMs to avoid toolchain   │
│                                                                 │
│ Leading today:    Prisma Migrate — adoption-leading, 2026       │
│ Why it leads:     schema-first DSL + auto-generated typed       │
│                   client; widely adopted across JS backends     │
│                                                                 │
│ Runner-up:        Drizzle Kit — innovation-leading typed SQL    │
│                   with compile-time migration generation        │
└─────────────────────────────────────────────────────────────────┘

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
