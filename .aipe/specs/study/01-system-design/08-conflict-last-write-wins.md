# Conflict resolution: last-write-wins

**Industry name(s):** Last-write-wins (LWW), Lamport-style conflict resolution
**Type:** Industry standard · Language-agnostic

> Pure function in `sync/conflict.ts`. Compares `updated_at` timestamps; whichever side is newer wins. Same-second ties go to cloud.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [05-soft-delete](./05-soft-delete.md)

---

## Why care

Two devices have been offline for an hour and they both edit the same row. They reconnect at the same moment and start pushing their changes at the server. What's there afterwards? That's the question any replicated system has to answer before it ships, because "the latest write" is not actually well-defined when "latest" depends on whose clock you trust.

Last-write-wins is the simplest possible answer: attach a timestamp to every row, and on a conflict, keep the row with the bigger timestamp. It belongs to the family of "conflict resolution policies," sitting at the cheap end of a spectrum that runs through vector clocks all the way up to CRDTs and operational transforms. You've seen this in DynamoDB's default reconciliation, in Cassandra, in cookie-based session stores, and in any cache that uses TTL plus a "newer-wins" overwrite rule. It's the right call when concurrent edits are rare and "we kept the most recent one" is an acceptable answer. The shape it takes in this codebase is in Quick summary below.

---

## Quick summary
- **What:** `chooseWinner(local, cloud)` returns `'local' | 'cloud'`. The result drives whether a pulled row overwrites the local copy.
- **Why here:** solo Phase A. Two devices = the user. The honest cases (same person edits on phone, then on tablet) all resolve cleanly with this rule.
- **Checklist step:** 5 (Failure handling)
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

**File:** `src/services/sync/conflict.ts`
**Function / class:** `chooseWinner<T extends Tombstoned>(local, cloud)` — pure, no side effects
**Line range:** L20–L31 (the whole file is 31 lines; `Tombstoned` type at L13)

**Caller:** `src/services/sync/pull.ts` → `pullTable()` L34–L117 invokes `chooseWinner` per row to decide whether to upsert the cloud row over local.

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

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain last-write-wins conflict resolution to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/sync/conflict.ts:chooseWinner`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

The user has the app on phone and tablet. They edit entry e123 on the phone at 2026-05-07T09:00:00.500Z (so `local.updated_at = T+500ms`), then on the tablet they edit the same entry one millisecond later at 09:00:00.501Z. The phone's push fires first (gets to cloud), then the tablet pulls. What does `chooseWinner` return on the tablet for that row? What if both clocks were perfectly in sync but the times happened to be byte-identical?

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/conflict.ts` L20–L31 to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/sync/conflict.ts:chooseWinner` to support what exists
→ Point to where a `version_vector` column would have to thread through (`src/services/sync/tables/*`, the migration, every push/pull mapper) if you chose the alternative

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
