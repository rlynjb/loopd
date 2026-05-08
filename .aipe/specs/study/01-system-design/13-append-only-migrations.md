# Append-only Postgres migrations

> Every Postgres schema change is a new file, never an edit of an existing one.

**See also:** → [02-authentication-boundary](./02-authentication-boundary.md) · → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md)

---

## Quick summary
- **What:** `supabase/migrations/000N_*.sql` files are immutable once committed. Schema changes ship as new files. The runner (`scripts/db-migrate.mjs`) applies any not-yet-applied file in order.
- **Why here:** an applied migration is permanent. Editing `0001` after it ran on cloud would drift the schema between dev and prod.
- **Tradeoff:** the migration log gets long. Worth it for the audit trail.

---

## Append-only migrations — diagram

```
  supabase/migrations/
    0001_initial_schema.sql       ── 10 mirror tables, composite (user_id, id) PKs
    0002_rls_policies.sql         ── RLS policies (currently DISABLED in Phase A)
    0003_server_time_rpc.sql      ── RPC the pull path uses
    0004_relax_fks.sql            ── adjust FKs to allow soft-delete edge cases
    0005_todo_meta_pinned.sql     ── ADD COLUMN pinned

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

- `supabase/migrations/0001_initial_schema.sql` through `0005_todo_meta_pinned.sql`.
- `scripts/db-migrate.mjs` — the runner. Uses `pg` + `dotenv`. Run with `node scripts/db-migrate.mjs --all-pending`.

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
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
