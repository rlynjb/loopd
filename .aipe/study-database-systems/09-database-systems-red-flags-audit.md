# Database-systems red flags — the ranked checklist
## Industry name(s): DB review checklist · Type: Audit summary

> The consolidated database-engine checklist for buffr. Most flags are LOW today because the scale is small; the structural ones (no explicit isolation level, no explicit WAL/synchronous PRAGMA, no index on `updated_at`) are pre-emptive — name them now so they're known at the moment they start to bite.

## Zoom out, then zoom in

```
  the top three moves (ranked)
  ─────────────────────────────────────────────────────────
  1. PRAGMA journal_mode=WAL + synchronous=NORMAL explicit
     ✓ stops depending on platform default; documents intent
     ✓ ~5 LOC; no runtime cost
  2. CREATE INDEX (user_id, updated_at) on every synced table
     ✓ buys clean range scans for pull cursor
     ✓ pays for itself the moment any table grows past ~10k rows
  3. EXPLAIN ANALYZE on the sync queries; checkpoint the plan
     ✓ documents the current plan; catches regressions early
     ✓ one-shot; commit results to docs/
```

## Structure pass

```
  axis = "what's the cost of this flag firing if we don't fix it?"

  HIGH   structural; data loss or silent failure surface
  MED    perf degrades at next scale step
  LOW    style; fix in review
  PRAISE the design currently prevents the flag from firing
```

## How it works

### Move 1 — the checklist (one row per flag)

```
  row: flag, fires?, severity, fix
```

### Move 2 — buffr's DB red-flag scorecard

**Storage / layout**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| `WITHOUT ROWID` not used despite composite PK on SQLite | ✓ MIGHT | LOW | switch when row count makes locality matter |
| Postgres heap not clustered by PK | ✓ TRUE | LOW | `CLUSTER` once; not maintained automatically |
| Wide JSON columns in `entries.meta` (potential bloat) | ✓ POSSIBLE | LOW | consider extracting hot fields when ≥10k rows |

**Indexes**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| No index on `updated_at` despite sync pull ordering by it | ✓ TRUE | MED | `CREATE INDEX (user_id, updated_at)` per table |
| No index on `synced_at` for local dirty filter | ✓ TRUE | MED (scale-dependent) | local index; only matters when SQLite tables grow |
| Indexes audited for the queries that actually run | ✗ AUDIT | — | run `EXPLAIN` on each sync query; document |

**Query / planning**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| No `EXPLAIN ANALYZE` ever run on production queries | ✓ TRUE | LOW | one focused afternoon; commit findings to docs |
| N+1 patterns in reconcileMeta | ✗ NOT YET | — | scan once on each prose commit; OK |

**Transactions / isolation**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Default isolation (RC) assumed but never named | ✓ TRUE | LOW | no fix needed; document the assumption |
| Multi-statement atomicity required and not available | ✗ NOT YET | — | when needed, write a Postgres function |
| Local SQLite reconcile uses real txn (transaction across todos+thread+nutrition) | ✗ PRAISE | — | the right design |

**Concurrency**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Two-device write conflict resolution = LWW | ✗ INTENTIONAL | — | acceptable for single-user model |
| Deterministic tiebreaker on equal `updated_at` | ✗ PRAISE | — | local wins; no flapping |

**Durability / recovery**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| SQLite `PRAGMA synchronous` / `journal_mode` never set | ✓ TRUE | MED | explicit `WAL + NORMAL`; ~5 LOC |
| No tested restore drill | ✓ TRUE | MED | annual: restore from Supabase, wipe device, re-sync |
| Supabase managed backups in place | ✗ PRAISE | — | leave as-is |

**Replication**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Cursor uses `updated_at`; replication lag could replay | ✗ N/A | — | buffr reads from primary; not a problem today |
| Sync cursor advance is correct | ✗ PRAISE | — | max(updated_at) in page; resumes cleanly |
| Server-time RPC for `synced_at` (not device clock) | ✗ PRAISE | — | the right design |

### Move 3 — the principle

```
  most DB red flags don't fire until scale forces them.
  buffr's scale is tiny; most flags are "documented and waiting."
  the discipline is naming them now so the moment one fires,
  the diagnosis is 1 minute, not 1 afternoon.
```

## Primary diagram

```
   buffr DB scorecard

   HIGH SEVERITY
    ─ (none today; all structural risks are MED or lower)

   MED SEVERITY
    ─ no PRAGMA WAL/synchronous explicit on SQLite
    ─ no index on (user_id, updated_at) per synced table
    ─ no tested restore drill

   LOW SEVERITY
    ─ no EXPLAIN ANALYZE on sync queries
    ─ Postgres heap not clustered by PK
    ─ default isolation assumed implicitly

   PRAISE
    ─ server-time RPC for synced_at
    ─ soft-delete columns simplify replication
    ─ Supabase managed backups + PITR
    ─ deterministic LWW tiebreaker (local wins)
    ─ idempotent ordered migrations
```

## Implementation in codebase

The three concrete actions, in order:

```ts
// 1. src/services/db/sqlite.ts — set the PRAGMAs explicitly
const db = SQLite.openDatabaseSync('buffr.db');
db.execSync('PRAGMA journal_mode = WAL');
db.execSync('PRAGMA synchronous = NORMAL');
```

```sql
-- 2. supabase/migrations/0013_add_updated_at_indexes.sql
CREATE INDEX IF NOT EXISTS entries_user_updated_idx
  ON buffr.entries (user_id, updated_at);
-- ... repeat for the other synced tables.
```

```bash
# 3. document the EXPLAIN ANALYZE output for the sync pull
psql -c "EXPLAIN (ANALYZE, BUFFERS)
         SELECT * FROM buffr.entries
         WHERE user_id = '...' AND updated_at > '...'
         ORDER BY updated_at LIMIT 100;" > docs/db-plans/sync-pull.txt
```

## Elaborate

The "small scale" caveat is real but the discipline of naming the risks now compounds. When buffr crosses 10k entries (still small in absolute terms but the threshold where in-memory sorts and full scans become measurable), each named risk turns into a 1-line fix. Without this audit, each one would be a 30-minute diagnosis.

The DB-side audit has no HIGH-severity findings because the engines are doing most of the work — Supabase's managed Postgres handles WAL, replication, backups, and isolation by default. SQLite's defaults are also reasonable. The flags are about *explicitness* and *future-proofing*, not about brokenness.

## Interview defense

**Q [mid]:** What's the top DB red flag?

**A:** SQLite's WAL mode and synchronous level are never explicitly set in code. The engine defaults rule. That's fine if the defaults stay sensible; it's a footgun the moment expo-sqlite-next changes them, or a teammate switches to a different platform with different defaults. ~5 LOC to fix; permanent clarity.

**Q [senior]:** What's the highest-impact index to add?

**A:** `(user_id, updated_at)` on each synced table. The sync pull cursor structurally needs it. Today the planner sorts in memory; at the first scale tier where this spills, the index is the difference between sub-second sync and 5-second sync.

**Q [arch]:** What's the DB-tier biggest risk for the next 12 months?

**A:** Not running a restore drill. Backups exist; restore has never been tested end-to-end. The moment a real loss event happens, "we have backups" is not the same as "we can restore." One annual drill closes this.

## Validate

### Level 1 — sketch the severity ladder.

### Level 2 — explain why no flag is HIGH severity.

### Level 3 — apply: a new contributor proposes "use PostgreSQL on the device too." Walk the cost (much heavier; no longer offline; no longer free).

### Level 4 — defend: "Just add every possible index." Each index is a write tax + storage cost. Only add indexes that match real query shapes. The proposed `(user_id, updated_at)` matches the sync pull exactly.

## See also

- `00-overview.md` — the engine map.
- All concept files 01–08 for the source of each finding.
- `../study-debugging-observability/audit.md` — for the silent-error guard finding (the cross-cutting finding).
- `../study-testing/05-edge-cases-and-error-paths.md` — for the RLS-deny-as-data test.
