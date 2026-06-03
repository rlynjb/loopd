# Database systems in buffr — the engines beneath the schema

buffr runs on **two database engines** at once: SQLite on the device (canonical) and Postgres in Supabase (mirror). They have different storage layouts, different transaction semantics, different concurrency models, different durability boundaries. The application code assumes both, and the sync engine bridges them.

## The engine map

```
  ┌────────────────────────────────────────────────────────────────┐
  │  app process (React Native, JS)                                 │
  │     │                                                            │
  │     ├─ expo-sqlite-next  →  SQLite (file: buffr.db)              │
  │     │     storage:  pages (4 KiB), one file, single writer       │
  │     │     index:    B-tree (rowid + secondary)                   │
  │     │     txn:      WAL + journal; single-writer serialization   │
  │     │     dur:      synchronous=NORMAL (default-ish)             │
  │     │                                                            │
  │     └─ supabase-js  →  PostgREST → Postgres 15.x                 │
  │            storage:  pages (8 KiB), heap + visibility map        │
  │            index:    B-tree + Hash + GiST (only B-tree in use)   │
  │            txn:      MVCC, default isolation = Read Committed    │
  │            dur:      WAL + replication (managed by Supabase)     │
  └────────────────────────────────────────────────────────────────┘
```

## Findings (ranked)

| Rank | Finding | Concept | Evidence | Severity |
|---|---|---|---|---|
| 1 | App assumes Read-Committed on Postgres but never names it | 05-transactions-isolation | implicit; no `BEGIN ISOLATION LEVEL` anywhere | MED |
| 2 | Composite PK `(user_id, id)` makes RLS-deny cost cheap but ZERO index hits the `(user_id, updated_at)` shape the sync pull uses | 03-btree-hash-and-secondary-indexes | `supabase/migrations/0007_composite_pks.sql` + `pullTable` filter | MED |
| 3 | Local SQLite WAL mode never explicitly set; the engine defaults rule | 07-wal-durability-and-recovery | `src/services/db/sqlite.ts` (no `PRAGMA journal_mode=WAL`) | MED |
| 4 | Pull cursor uses `updated_at` for ordering; no MVCC awareness — replica lag could replay rows | 08-replication-and-read-consistency | `pullTable` cursor advance | LOW (single-replica Supabase) |
| 5 | No EXPLAIN ANALYZE ever run on the sync queries | 04-query-planning-and-execution | absence of `EXPLAIN` in migrations or docs | LOW |
| 6 | Supabase managed backups; no project-side recovery drill | 07-wal-durability-and-recovery | inferred | LOW |
| 7 | `synced_at` stamp uses server time RPC — durable ordering relies on Postgres's clock, not the device's | 05-transactions-isolation | `getServerTime()` RPC + `synced_at` set | PRAISE — the right design |
| 8 | Soft delete columns make replication semantics simple (no tombstones to chase) | 08-replication-and-read-consistency | every synced table has `deleted` column | PRAISE |
| 9 | All migrations are idempotent and ordered; recovery from migration squash is trivial | 07-wal-durability-and-recovery | `supabase/migrations/*` sequence | PRAISE |

## Reading order

Top-down for first read: `01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09`. The map (01) frames the engines; storage (02) and indexes (03) are the substrate; planning/execution (04) shows how queries actually run; transactions/isolation (05) and locks/MVCC (06) are the consistency floor; WAL/durability (07) is what survives a crash; replication (08) is what arrives at the second machine; the red-flags audit (09) is the consolidated ranked checklist.

## Cross-guide seams

- **`study-data-modeling`** — the *shape* of the data (composite PKs, soft delete, the `users` table absence). Buffr's data-modeling decisions drive the index choices analyzed here.
- **`study-system-design`** — *which* engines were chosen and why (SQLite + Supabase, local-first mirror). The system-design audit owns the architectural decision; this guide owns the mechanism.
- **`study-software-design`** — module decomposition of the sync engine. The orchestrator pattern critique lives there.
- **`study-distributed-systems`** — replication, LWW conflict resolution, eventually-consistent reads. The CAP-side framing.
- **`study-debugging-observability/01-success-only-log-guard.md`** — why most DB-tier failures (RLS deny, schema-missing) are returned as data and silently dropped.

## What this guide does NOT cover

- Vector search / pgvector / embedding indexes — buffr's principle #11 says "no RAG until provably needed"; pgvector is not installed.
- Time-series specific storage (TimescaleDB) — buffr has time-shaped data but uses standard tables; no time-series extension.
- Column stores / OLAP / analytics warehouses — no Snowflake/BigQuery/DuckDB; analytics-grade reads are not part of buffr today.
- Sharding / multi-master — single Postgres instance, single SQLite file per user.
