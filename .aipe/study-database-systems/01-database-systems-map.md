# The database systems map — two engines, one app
## Industry name(s): polyglot persistence (constrained) · two-engine sync · Type: Architecture pattern

> Buffr runs on two engines: SQLite on the device (canonical), Postgres in Supabase (mirror). Each engine has its own storage layout, txn semantics, and durability boundary. The sync engine is the bridge; everything in this guide hangs off that fact.

## Zoom out, then zoom in

```
  LAYERS — the engine stack from the app down

  ┌─────────────────────────────────────────────────────────────┐
  │ buffr UI                                                     │
  │     reads ───────────────────────────► SQLite always         │
  │     writes ──────────────────────────► SQLite first          │
  ├─────────────────────────────────────────────────────────────┤
  │ sync engine (orchestrator + push/pull)                       │
  │     dirty filter ──► SQLite                                  │
  │     batch upsert ──► Supabase JS ──► PostgREST ──► Postgres  │
  │     batch pull   ──► PostgREST ──► Supabase JS ──► SQLite    │
  ├─────────────────────────────────────────────────────────────┤
  │ SQLite (expo-sqlite-next)        │  Postgres (Supabase)      │
  │  4 KiB pages, single file        │  8 KiB pages, heap+VM     │
  │  B-tree only                     │  B-tree (in use)          │
  │  one writer at a time            │  MVCC, many writers       │
  │  WAL mode (defaulted)            │  WAL + replication        │
  │  sync=NORMAL                     │  sync=on (managed)        │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the app never reads from Postgres directly. UI reads only ever touch SQLite. Writes always land in SQLite first, and only the sync engine ever talks to Postgres. This means the two engines are *not* peers — SQLite is canonical and Postgres is the mirror. Many database-systems concerns (isolation level on reads, replica lag) bind to one engine but not the other.

## Structure pass

```
  layers   ─ UI ─ sync engine ─ engine adapters ─ engine internals
  axes     ─ canonical-ness · txn semantics · durability boundary
  seams    ─ UI ←→ SQLite           : always synchronous; tiny
             ─ sync ←→ SQLite        : dirty filter + apply
             ─ sync ←→ Postgres      : batched upsert + cursor pull
             ─ SQLite ←→ filesystem  : WAL + journal
             ─ Postgres ←→ WAL       : managed by Supabase
```

The interesting boundary is "where does durability of a user's write actually live?" — answer: SQLite first (microseconds), Postgres second (5s debounced + network latency). Anything that depends on Postgres for durability is structurally seconds behind the user.

## How it works

### Move 1 — engine selection drives every later mechanism

```
  THE CHOICE        →   THE DOWNSTREAM EFFECTS
  ──────────────────────────────────────────────
  SQLite local      →   no concurrency primitives needed in-process;
                        one writer; B-tree only; small footprint
  Postgres mirror   →   MVCC available; secondary indexes available;
                        replication available; isolation levels available
```

Both engines are *capable* of more than buffr uses. SQLite supports FTS5, R-trees, vector tables (via extensions); none enabled. Postgres has pgvector, GiST, GIN, BRIN; only B-tree is in use. The choice to under-use both is deliberate (principle #11: no infrastructure before need).

### Move 2 — three durability boundaries to keep straight

```
  boundary 1   the OS write() returns
   ─ SQLite: this is what you usually mean by "saved"
   ─ Postgres: same, but plus the WAL fsync

  boundary 2   the WAL is fsynced
   ─ SQLite: configurable via PRAGMA synchronous
   ─ Postgres: always; non-negotiable

  boundary 3   the replica has the row
   ─ Supabase has at least one read replica; lag is usually < 1s
   ─ Buffr doesn't read from replicas explicitly
```

A "saved" entry in buffr passes boundaries 1 and 2 on SQLite within microseconds. It passes the same boundaries on Postgres seconds later (debounced sync + network + WAL fsync). This is the structural latency the user can't see.

### Move 3 — the principle: name your durability boundary

```
   ┌─────────────────────────────────────────────────┐
   │  every "saved" claim in code must implicitly    │
   │  name a durability boundary. buffr's UI claims  │
   │  "saved" at SQLite WAL boundary. that's correct │
   │  for the use case; it would NOT be correct for  │
   │  a banking app.                                 │
   └─────────────────────────────────────────────────┘
```

## Primary diagram

```
  the engine stack

   ┌── UI ──────────────────────────────────────────────────┐
   │  reads + writes  ───►  SQLite                          │
   └──────────────────────────────│─────────────────────────┘
                                  ▼
                          ┌────────────────┐
                          │   SQLite       │  canonical
                          │   (buffr.db)   │  durable @ µs
                          └────────────────┘
                                  │
                                  │ sync engine
                                  ▼
                          ┌────────────────┐
                          │   Postgres     │  mirror
                          │  (Supabase)    │  durable @ seconds
                          └────────────────┘
                                  │
                                  │ (managed replication)
                                  ▼
                            read replica
```

## Implementation in codebase

```ts
// src/services/db/sqlite.ts (pattern; verify path)
import * as SQLite from 'expo-sqlite-next';

const db = SQLite.openDatabaseSync('buffr.db');
// no PRAGMA journal_mode call here. SQLite's default is "delete";
// expo-sqlite-next defaults to WAL on iOS/Android — verify per platform.
```

```ts
// src/services/supabase/client.ts (pattern; verify path)
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: 'buffr' },  // namespaced schema (migration 0010)
});
// Postgres connection details are managed by Supabase. The app sees
// PostgREST over HTTPS, not raw Postgres protocol.
```

**Line-by-line read of the engine choices:**

- `expo-sqlite-next` over plain `expo-sqlite` — the next-gen variant supports the modern API (`openDatabaseSync`, prepared statements, transactions). Verify SQLite version at runtime if WAL behavior matters.
- `supabase-js` is the only way the app reaches Postgres. The PostgREST hop is *always* there — no raw SQL from the app. This gates which Postgres features the app can use (e.g., advisory locks: not exposed).
- The two engines never share a transaction. There is no two-phase commit; there is sync with last-write-wins.

## Elaborate

The "two engines, one app" pattern is the defining shape of every local-first app. It forces several structural decisions:

- **Schema must be expressible in both engines.** Buffr's migrations are SQL written for Postgres; the SQLite side is hand-maintained to match. A schema-divergence between the two would produce silent data loss (a column on Postgres that doesn't exist on SQLite gets dropped on push).
- **Type system has to bridge both.** Postgres `text` and SQLite `TEXT` are the same; `jsonb` and `TEXT` are reconciled (buffr stores JSON as text in SQLite).
- **Conflict resolution lives in one place.** Buffr uses LWW (last-write-wins by `updated_at`). The conflict point is the moment of upsert into Postgres.

The alternative — single-engine — would mean either cloud-only (loses offline) or device-only (loses multi-device + backup). Two-engine is the right call for buffr; the cost is the sync engine and everything in this study guide.

## Interview defense

**Q [mid]:** Why two databases? Why not just Postgres?

**A:** Local-first. Reads must work offline; writes must feel instant. Postgres-only means every read is a network hop, which collapses on a flaky connection. SQLite-local + Postgres-mirror is the standard pattern for daily-journaling apps; the cost is the sync engine.

**Q [senior]:** Where does "saved" actually mean saved?

**A:** SQLite WAL boundary, ~microseconds. The user sees their text rendered back from SQLite. Postgres durability is seconds behind (5s debounced sync + network + WAL fsync). For a journaling app this is correct; for a banking app it would be a bug.

**Q [arch]:** What happens if the schemas drift between the two engines?

**A:** Silent data loss on push — a column SQLite has but Postgres doesn't is dropped at the PostgREST boundary. The protection is that schema is maintained as migrations against Postgres, and the SQLite create-table strings are derived from the same source. Diverging the two would require a test that asserts row-trip equality — buffr doesn't have it yet (see `study-testing/05-edge-cases-and-error-paths.md`).

## Validate

### Level 1 — diagram

Sketch the two engines, the sync engine between them, and the three durability boundaries.

### Level 2 — explain

Under 90s: name the engine choice, the canonical/mirror direction, where "saved" actually means saved.

### Level 3 — apply

A teammate proposes "let's use IndexedDB on the web build instead of SQLite." Walk what changes: same canonical/mirror pattern works; IndexedDB has no transactions across object stores by default; FTS would need a JS-level index instead of SQLite FTS5.

### Level 4 — defend

Defend or oppose: "We should drop SQLite and read directly from Postgres for simplicity."

Drops offline. Drops sub-second feel. Adds network dependence on every screen. For buffr, the right answer is no.

## See also

- `02-records-pages-and-storage-layout.md` — page sizes and locality on each engine.
- `05-transactions-isolation-and-anomalies.md` — what isolation level buffr implicitly assumes.
- `07-wal-durability-and-recovery.md` — the WAL boundary on each engine.
- `../study-system-design/audit.md` — why these engines were chosen.
- `../study-data-modeling/00-overview.md` — the schema both engines carry.
