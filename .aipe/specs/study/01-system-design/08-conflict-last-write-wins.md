# Conflict resolution: last-write-wins

> Pure function in `sync/conflict.ts`. Compares `updated_at` timestamps; whichever side is newer wins. Same-second ties go to cloud.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [05-soft-delete](./05-soft-delete.md)

---

## Quick summary
- **What:** `chooseWinner(local, cloud)` returns `'local' | 'cloud'`. The result drives whether a pulled row overwrites the local copy.
- **Why here:** solo Phase A. Two devices = the user. The honest cases (same person edits on phone, then on tablet) all resolve cleanly with this rule.
- **Tradeoff:** unrecoverable for true concurrent multi-user edits. Phase B may need vector clocks if two humans ever share a single workspace.

---

## Conflict — diagram

```
  local.updated_at vs cloud.updated_at:

  ┌────────────────────────────┬───────────────────┐
  │ Comparison                 │ Winner            │
  ├────────────────────────────┼───────────────────┤
  │ local > cloud              │ local (skip pull) │
  │ cloud > local              │ cloud (apply)     │
  │ local == cloud             │ tie → cloud       │
  │ malformed timestamp        │ cloud (defensive) │
  └────────────────────────────┴───────────────────┘
```

---

## How it works

`chooseWinner` is a pure function. No side-effects, no DB reads, no clock reads. It takes the two rows and returns a string. The caller (`pull.ts`) acts on the result.

The same-second tie rule biases toward cloud because the pull path is the one calling — if cloud has a same-second row, it's because that row arrived after the device last pulled. Letting cloud win prevents an infinite ping-pong.

The malformed-timestamp branch is defensive. If a row has a non-ISO string in `updated_at`, the comparison returns NaN; treating cloud as the winner means the locally-corrupt row gets overwritten with the well-formed cloud version, which is the desired healing direction.

---

## In this codebase

- `src/services/sync/conflict.ts` → `chooseWinner()`.
- `src/services/sync/pull.ts` → `pullTable()` calls it per row.

---

## Elaborate

### Where this pattern comes from
LWW is the simplest conflict resolution rule in distributed systems. It's what Cassandra defaults to, what Riak ships out of the box, what DynamoDB uses for last-modified-by-time semantics. Its appeal is operational simplicity: no tombstones, no vectors, no metadata bloat.

### The deeper principle
**Pick the simplest rule that solves your real conflict surface, not the imagined one.** Loopd's only conflict surface is the same person on two devices. Vector clocks and CRDTs would add complexity for a problem the app doesn't have.

### Where this breaks down
- Two humans editing the same row at once. LWW silently drops one user's work.
- Distributed clock skew larger than the typical edit gap. The "newer" timestamp may not be the chronologically newer write.
- Operations that aren't last-write-style — e.g., counters, sets, where merge semantics matter. LWW would lose one increment in two.

### What to explore next
- CRDTs (LWW-Set, OR-Set, RGA) → for the case where merging matters.
- Vector clocks → for ordering events without trusting wall-clock time.

---

## Tradeoffs

- **LWW** — gives: simple, fast, debuggable. Costs: silent loss in true concurrent multi-writer cases.
- **Tie → cloud** — gives: pull path doesn't bounce. Costs: a same-second cloud row beats a same-second local row (rare; usually unimportant).
- **Pure function** — gives: trivially testable, no flaky state. Costs: can't use richer signals (e.g., field-level merge); the whole row is the unit.
