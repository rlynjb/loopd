# Shared state, races, and synchronization — what buffr doesn't need
## Industry name(s): mutex, atomic, channel, race condition · Type: Foundational

> Single-threaded JS means no thread-level races. The race conditions that DO exist in buffr are async-sequencing: two async tasks reading-then-writing the same row, observed at different points. Mitigated by SQLite's per-statement atomicity.

## Zoom out, then zoom in

```
  WHAT BUFFR DOESN'T HAVE                WHAT BUFFR HAS

  ─ mutexes                              ─ async tasks that touch shared state
  ─ atomics                              ─ SQLite per-statement atomicity
  ─ channels                             ─ awaited Promises sequencing
  ─ thread-level races                   ─ possible async races
```

Zoom in: a race in buffr looks like "task A reads row R, task B writes row R, task A writes back stale." The SQLite engine doesn't prevent this at the task level. Mitigation: idempotent writes (LWW by updated_at).

## Structure pass

```
  layers   ─ task ─ shared state ─ SQLite
  axes     ─ atomicity (per-statement)
             ─ visibility (snapshot in WAL mode)
```

## How it works

### Move 1 — JS single-thread saves you from low-level races

```
  two async tasks NEVER run their non-await code simultaneously.
  while task A's chunk runs, B is suspended. zero race conditions
  inside a single chunk.
```

### Move 2 — async races are between chunks

```
  task A:  const x = await db.read(row);
           // ...
           await db.write(row, modify(x));
  task B:  await db.write(row, newValue);
  
  if B runs between A's read and write, A overwrites B's change.
  classic async race.
```

### Move 3 — the principle: design for async sequencing

```
   ┌──────────────────────────────────────────────────┐
   │ buffr's mitigation is LWW + idempotency.         │
   │ both tasks write; whichever lands last wins.     │
   │ no flapping because tiebreak is deterministic.   │
   │ no corruption because writes are full-row.       │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

There are no mutexes anywhere in `src/`. The pattern is implicit in the single-writer-per-row property — buffr's UI rarely has two tasks writing the same row simultaneously.

```ts
// safe by serialization: only one prose-commit at a time
let proseCommitInFlight = false;
async function triggerProseCommit(entry) {
  if (proseCommitInFlight) return;
  proseCommitInFlight = true;
  try { await commitProseForEntry(entry); }
  finally { proseCommitInFlight = false; }
}
```

The `proseCommitInFlight` boolean is the closest thing to a lock — but it's a guard, not a sync primitive. It's safe because JS is single-threaded.

## Elaborate

The "no mutexes" property is real because of single-threadedness. The day buffr adds a worker thread (e.g., for image processing), the rules change — shared mutable state between threads would need actual synchronization. Today: zero work.

## Interview defense

**Q [mid]:** Why no mutexes?

**A:** JS is single-threaded. Two tasks can't execute non-await code simultaneously. Race conditions are between async chunks, not between threads, and the mitigation is idempotency + LWW rather than locks.

**Q [senior]:** When have you been bitten by an async race?

**A:** A UI button that fired twice on a slow render — the second fire's mutation ran before the first's. Mitigation: guard boolean (like `proseCommitInFlight`).

## Validate

### Level 1 — explain why JS doesn't need mutexes.

### Level 2 — name the async-race shape.

### Level 3 — apply: design a "save draft" feature with autosave + manual save. Two tasks touching the same row; LWW handles it.

### Level 4 — defend: "Use an actor model." Over-engineering for buffr's surface.

## See also

- `02-processes-threads-and-tasks.md`
- `03-event-loop-and-async-io.md`
- `../study-distributed-systems/03-idempotency-deduplication-and-delivery-semantics.md`
