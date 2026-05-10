# Append-only Postgres migrations

**Industry name(s):** Append-only migrations, forward-only schema migration
**Type:** Industry standard · Language-agnostic

> Every Postgres schema change is a new file, never an edit of an existing one.

**See also:** → [02-authentication-boundary](./02-authentication-boundary.md) · → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md)

---

## Why care

You've edited a migration that already ran on production, deployed the change, and watched the next environment go up cleanly while the previous one stayed silently broken — because the migration runner thought the work was done and never re-ran the patched file. The pain isn't the bug; it's that there's no way to detect it without diffing schemas across environments. The root cause is treating a migration as code you can revise, instead of as a transaction log entry that's already been committed.

Forward-only schema migrations are an append-only ledger: once a migration has been applied anywhere, it is frozen, and any correction ships as a new migration that fixes the previous one. It belongs to the family of "immutable history" patterns, the same shape as event sourcing, Git commits, blockchain blocks, and write-ahead logs. You've seen this in every serious migration tool — Rails, Flyway, Liquibase, Alembic — and in the way append-only logs are how distributed systems agree on what happened. The diagram below shows the shape it takes here.

---

## Append-only migrations — diagram

```
  supabase/migrations/
    0001_initial_schema.sql            ── 10 mirror tables, composite (user_id, id) PKs
    0002_rls_policies.sql              ── RLS policies (currently DISABLED in Phase A)
    0003_server_time_rpc.sql           ── RPC the pull path uses
    0004_relax_fks.sql                 ── adjust FKs to allow soft-delete edge cases
    0005_todo_meta_pinned.sql          ── ADD COLUMN pinned
    0006_todo_meta_type_study.sql      ── widen type CHECK to include 'study' (2026-05-09)
    0007_todo_meta_type_reflect.sql    ── widen type CHECK to include 'reflect' (2026-05-10)
    0008_todo_meta_type_reduce.sql     ── DROP {bug, question, decision, content};
                                          remap existing rows to 'todo';
                                          clear user_overridden_type (2026-05-10)

  Apply path:
    node scripts/db-migrate.mjs --all-pending
                       │
                       ▼
    pg client connects, walks files in order, executes any not yet applied
```

---

## How it works

Each migration is a numbered SQL file. The runner connects to Postgres using `pg` + `dotenv`, queries a `_migrations` ledger table for what's already applied, and runs every newer file in order. After a successful run, the ledger is updated.

Append-only means: never edit `0001` even if you find a typo two days later. Either ship a `0006_fix_typo.sql` that does an `ALTER`, or accept the drift. The discipline keeps every environment converging on the same schema by the same path.

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

- **Append-only** — gives: replay determinism. Costs: log length grows; readers must walk the history to understand current state.
- **`pg`-based runner** — gives: dev and CI both run the same script. Costs: needs `DATABASE_URL` in env; not Supabase Studio's preferred path.
- **No `prisma migrate`-style snapshots** — gives: zero ORM coupling. Costs: schema drift is harder to detect; a tool like `pg_dump` becomes the reference.

---

## Quick summary

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

[senior] Q: Why use `node scripts/db-migrate.mjs` with raw `pg` instead of Supabase's CLI or a Prisma-style runner?

A: Two reasons. First, the project doesn't use an ORM — `database.ts` writes raw SQL to SQLite, and the cloud schema is hand-authored DDL. Adding Prisma just for migrations would mean carrying its schema-generation toolchain for one task. Second, the runner is twenty lines of code that I can read and reason about: connect with `pg`, query a `_migrations` ledger, run pending files in order, update the ledger. No magic. The cost is no auto-generated migrations from schema diffs (which Prisma offers); the win is no Prisma. For a five-migration project, the win pays back.

[arch] Q: What happens when this migration log gets to fifty files and you need to bootstrap a new environment?

A: Replay-from-zero takes longer — every fresh DB runs all fifty files in order. At fifty migrations on a few thousand rows, that's seconds. At five hundred migrations or large data backfills, it becomes minutes and then hours. The standard answer is squashing: once a quarter, take the current schema state, write a new "consolidated" migration `00XX_squash.sql`, and archive the older files. The runner has to know which environments have run which subset, so squashing usually pairs with a "minimum compatible version" check. I haven't needed to squash because there are five files; the day there are fifty, the squash plan ships.

### The question candidates always dodge
Q: You said "never edit `0001` even for a typo." Have you ever broken that rule, and if so why?

A: Once, locally, before any environment but my dev box had run the migration. I edited `0001` to fix a constraint name during initial schema design, before cloud was even configured. I don't count that as breaking the rule because no environment had committed to the original — it was still being authored. The rule applies the moment a migration runs against any environment that I don't control or that I won't reset. The discipline I actually hold is: if I'm uncertain whether the migration has shipped, treat it as if it has and add a new file. The cost is sometimes a redundant migration; the alternative is a silent schema drift that costs me hours to debug. Cheap insurance.

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
