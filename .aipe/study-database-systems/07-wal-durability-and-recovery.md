# WAL, durability, and recovery — what survives a crash
## Industry name(s): write-ahead log, fsync, crash recovery, PITR · Type: Foundational mechanism

> Both engines use a WAL. Postgres's is non-negotiable and managed by Supabase (with backups). SQLite's mode is whatever the platform default is — buffr never sets it explicitly. Recovery is "open the DB; the engine replays the WAL."

## Zoom out, then zoom in

```
  THE WAL CONTRACT

  1. write the change to the WAL
  2. fsync the WAL
  3. respond OK to the caller
  4. (later) apply the WAL to the main data files
  5. (later) checkpoint and recycle the WAL

  on crash: replay from the last checkpoint.
```

Zoom in: when the buffr UI writes "saved," what's actually durable is step 3 — the WAL has the change. Subsequent steps can happen at any point; the change survives a crash either way. The durability boundary is the fsync after step 2.

## Structure pass

```
  layers   ─ in-memory write ─ WAL append ─ fsync ─ main file
  axes     ─ durability (which step "saved" maps to)
             ─ recovery time (WAL replay length)
  seams    ─ write() ←→ WAL append
             ─ fsync() ←→ OS guarantee
             ─ checkpoint ←→ main file flush
```

## How it works

### Move 1 — Postgres always fsyncs the WAL

```
  Postgres synchronous_commit = on (default)
   → every commit waits for WAL fsync
   → trades latency for durability
   → buffr's writes are infrequent enough that this is invisible

  Supabase backs up the WAL → Point-In-Time Recovery available.
```

### Move 2 — SQLite has tunable durability

```
  PRAGMA synchronous = OFF       no fsync ever; lose recent writes on crash
                    = NORMAL     fsync at journal commit (WAL mode); default
                    = FULL       fsync more aggressively; small perf cost
                    = EXTRA      fsync directory entries too; usually overkill

  buffr never sets this. expo-sqlite-next default is NORMAL (verify).
  NORMAL in WAL mode is the standard "safe enough" choice.
```

### Move 3 — recovery is automatic on open

```
  open(buffr.db) → engine sees uncheckpointed WAL → replays it
  open(postgres) → server starts → replays WAL from last checkpoint

  recovery time is bounded by WAL size since last checkpoint.
  buffr's WAL is tiny; recovery is <100ms.
```

## Primary diagram

```
   the durability boundary

   user types "saved"
        │
        ▼
   ┌─────────────────────────────────┐
   │ app: db.exec('UPDATE ...')      │
   │       ─ writes to WAL            │
   │       ─ fsync(WAL)        ◄── DURABLE here
   │       ─ returns "ok"             │
   └─────────────────────────────────┘
        │
        ▼  "saved" returned to user
        │
   ┌────────────────────────┐
   │ later: checkpoint        │
   │   ─ apply WAL to main DB │
   │   ─ recycle WAL          │
   └────────────────────────┘
```

## Implementation in codebase

```ts
// src/services/db/sqlite.ts  (pattern)
const db = SQLite.openDatabaseSync('buffr.db');
// no PRAGMA journal_mode or synchronous calls.
// expo-sqlite-next defaults rule.
```

**The improvement.** Setting WAL + NORMAL explicitly removes ambiguity:

```ts
db.execSync('PRAGMA journal_mode = WAL');
db.execSync('PRAGMA synchronous = NORMAL');
```

Worth doing? Yes for clarity. Not yet exercised.

**Postgres side:** durability is Supabase-managed. Buffr does nothing here. PITR is available through Supabase's dashboard for restoration.

## Elaborate

The "durability is invisible until you lose data" property of WAL means buffr will never see this work… until a phone crashes mid-write and the app comes back and the user's last paragraph is gone. The probability is small with NORMAL; FULL makes it smaller; OFF makes it certain.

The recovery story for buffr is good — local replays automatically, cloud restores from Supabase backup if needed. The hole is the absence of a tested restore drill: nobody has confirmed that "restore from Supabase backup → wipe device → re-sync" produces identical state. Worth doing once a year.

## Interview defense

**Q [mid]:** What's a WAL and why do we have one?

**A:** Write-ahead log. Every change goes to the log first, fsynced, then later applied to the main data files. The fsync after the log write is the durability boundary. On crash, replay from the last checkpoint. The point is: one fsync per commit instead of one fsync per touched page.

**Q [senior]:** What's `synchronous = NORMAL` in SQLite WAL mode and why isn't it FULL?

**A:** NORMAL fsyncs at WAL frame boundaries; FULL fsyncs more aggressively (including the WAL header on every commit). NORMAL is the standard recommendation in WAL mode — the WAL itself is the durable record, and FULL's extra fsync rarely buys anything in practice for journaling-style workloads.

**Q [arch]:** What's your recovery story?

**A:** Local: automatic on open via WAL replay. Cloud: Supabase PITR (managed). Untested end-to-end. The hole is the absence of a periodic restore drill — when did we last confirm a clean restore works? We haven't.

## Validate

### Level 1 — sketch the WAL → fsync → main file path.

### Level 2 — explain why fsync is the durability boundary, not write().

### Level 3 — apply: a feature wants "guaranteed durability before returning to the user." On SQLite that's `synchronous = FULL`. On Postgres it's the default already.

### Level 4 — defend: "Disable fsync to make tests fast." Fine for tests (data isn't real). Never in production. Buffr's tests don't exist yet, but if they did, in-memory SQLite (`:memory:`) is cleaner than fsync-off.

## See also

- `05-transactions-isolation-and-anomalies.md` — what "committed" means in relation to the WAL.
- `08-replication-and-read-consistency.md` — the WAL ships to replicas.
- `../study-debugging-observability/audit.md` — what monitoring would warn on backup failures.
