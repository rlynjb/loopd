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
