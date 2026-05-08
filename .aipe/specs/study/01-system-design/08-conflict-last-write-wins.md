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

---

## Interview defense

### What an interviewer is really asking
LWW is the boring answer to a much-too-interesting topic. The interviewer wants to know whether you understand that LWW *silently* loses data and whether your usage actually fits — because most engineers say "we use last-write-wins" and then describe an app that doesn't.

### Likely questions

[mid] Q: A row has `local.updated_at == cloud.updated_at` to the millisecond. What does `chooseWinner` return and why?

A: It returns `'cloud'`. The same-millisecond tie biases toward cloud because the caller is the pull path — if cloud has a row at the same timestamp as local, that row arrived from cloud after this device's last pull, and pulling resolves the bounce. Letting local win on a tie would mean the next pull comes back, sees the same tie, and ping-pongs forever. The rule is documented in `conflict.ts` and is the reason the function returns a string instead of a boolean — to make the tie path explicit.

[senior] Q: When does LWW silently destroy data, and have you accepted that?

A: When two writers edit the same row in the same window with different values. LWW picks the newer `updated_at` and the older write is just gone — there's no log, no merge, no warning. I've accepted that for Phase A because the only multi-writer scenario is "the user on phone, then the user on tablet" — same person, sequential intent, the loss is "the older edit was already obsolete to me anyway." The day there's a second human or true concurrent device usage, LWW becomes wrong; the migration is to per-field merge or operational transforms on the prose field specifically (where the loss would actually hurt). Until then, LWW is the right complexity for the problem.

[arch] Q: How would you migrate this to vector clocks or CRDTs without rewriting the whole sync layer?

A: I'd start by adding a `version_vector` JSON column on each synced table, populated alongside `updated_at` on every write. `chooseWinner` would learn a third path: if version vectors are concurrent (neither dominates), return `'merge'` and call a per-table merger; if one dominates, return that side. The push and pull cursors would still use `updated_at`; the conflict resolution would consult the vector. Per-table mergers handle the divergent fields. The migration risk is the backfill — every existing row needs a vector, and the bootstrap pull must re-key the cursor. It's two weeks of work to do right, which is why I haven't done it for a hypothetical use case.

### The question candidates always dodge
Q: Your same-second tie rule says cloud wins. Walk me through the edge case where the user types on the device, the row is pushed, and then a network blip causes pull to fire on the same second. Doesn't local lose its own write?

A: Almost. After the push succeeds, the local row has `updated_at = T` and `synced_at = T'` (where T' is server time, slightly later). The cloud row has `updated_at = T`. On the immediate pull, `chooseWinner` sees `local.updated_at == cloud.updated_at` and returns `'cloud'`. Then pull upserts the cloud row over local. The values are byte-identical (it's the same row I just pushed) so the user notices nothing — but the local `synced_at` stays correct because the upsert path stamps it again. The case where this would actually hurt is if my local row had a *newer* `updated_at` than what cloud received (because my push was racy and stamped after the cloud's accept timestamp), but my code path stamps `updated_at` before push specifically to avoid that. The risk is real but bounded; if I observed it in the wild I'd add a strict `>` instead of `>=` in `chooseWinner` and accept the rare miss.

### One-line anchors
- "LWW is the simplest rule that fits the actual conflict surface — single user, sequential devices."
- "The tie-goes-to-cloud rule prevents pull-path ping-pong; it's not a fairness rule, it's a termination rule."
- "Pure function = trivially testable; the cost is no field-level merging."
- "When the conflict surface changes (real concurrency, multi-user), LWW becomes wrong — and the migration target is vector clocks plus per-field merge."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
