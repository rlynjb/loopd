# Soft delete and the deleted_at column

> Every synced table has a `deleted_at TEXT` column. Deletes write a timestamp, not a `DELETE FROM` row. Reads filter it out.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [01-local-first-request-flow](./01-local-first-request-flow.md)

---

## Quick summary
- **What:** soft-delete via `deleted_at` timestamp. Every read filters `WHERE deleted_at IS NULL`. Every write that "deletes" stamps the column and bumps `updated_at`.
- **Why here:** the cloud sync layer must learn about deletions; a hard `DELETE FROM` would just make the row vanish locally and cloud would re-pull it as if still alive.
- **Tradeoff:** the database grows monotonically. A 30-day vacuum is in the spec but deferred — volume is small enough that it doesn't matter yet.

---

## Soft delete — diagram

```
  Read path:                      Write path:
  ───────────                     ────────────
  SELECT *                        UPDATE entries
  FROM entries                       SET deleted_at = now,
  WHERE deleted_at IS NULL  ←        updated_at  = now
                                  WHERE id = ?
  └── always! every read site     │
      filters this column         └── trips schedulePush()
                                    so cloud learns about
                                    the delete
```

---

## How it works

Soft-delete is a tombstone pattern. A row marked `deleted_at = now` is invisible to every read in the app (every query carries `WHERE deleted_at IS NULL`). The row stays in the DB so the sync layer can propagate the deletion to the cloud — push will see `updated_at > synced_at` and upsert the tombstone, pull will see the cloud tombstone and apply it locally.

Hard delete is reserved for the future "30-day vacuum" — a job that hard-deletes rows whose `deleted_at` is more than 30 days old, on both sides. That job is deferred until the volume warrants it.

The combination "every CRUD delete stamps `deleted_at` + bumps `updated_at`" + "every read filters the column" + "every write triggers `schedulePush()`" makes deletes behave like any other edit from the sync layer's perspective. There is no special "delete protocol."

---

## In this codebase

- `src/services/database.ts` — every delete-style mutator (`deleteEntry`, `deleteHabit`, etc.) sets `deleted_at = now`, bumps `updated_at`, calls `schedulePush()`.
- `supabase/migrations/0003_soft_delete.sql` (or similar) — adds `deleted_at` to every synced table.
- Every read site in services and screens filters `WHERE deleted_at IS NULL`.

---

## Elaborate

### Where this pattern comes from
Soft-delete is one of the oldest tombstone patterns in distributed systems. It shows up in CRDTs, in DynamoDB-style sync engines, in CouchDB. Anywhere two nodes need to converge on "this row is gone," a tombstone is what carries the message.

### The deeper principle
**Deletion is a state, not an event.** If "the row is gone" is just an event, replicas can't disagree about whether the event happened — they either both saw it or one didn't. If "deleted" is a state, both sides can converge on it the same way they converge on any other state.

### Where this breaks down
- Compliance use cases where data must be physically erased on request (GDPR right to erasure). Tombstones must be paired with a hard-delete sweep for those.
- Tables that grow fast — millions of rows where each tombstone costs storage. Periodic vacuum becomes mandatory.

### What to explore next
- [Cloud sync as a mirror](./07-cloud-sync-mirror.md) → how tombstones flow through push and pull.
- [Conflict resolution: last-write-wins](./08-conflict-last-write-wins.md) → what happens when one side sees the delete and the other has a newer edit.

---

## Tradeoffs

- **Soft-delete** — gives: sync convergence on deletes for free. Costs: rows accumulate; reads must filter every time.
- **Filter at read site** — gives: each query is explicit; no surprise behaviour. Costs: every `SELECT` needs the predicate; one missed query = bug.
- **Vacuum deferred** — gives: simpler today. Costs: at scale the table will need it; build the job before the data demands it.

---

## Interview defense

### What an interviewer is really asking
Soft-delete is a tell. Engineers who have built sync engines know why it's required; engineers who haven't reach for `DELETE FROM` and re-discover the problem at 2am. The interviewer wants to hear you name the convergence problem out loud — that two replicas can't agree on "this row no longer exists" via absence alone. They want a tombstone explanation, not a "we soft-delete because it's safer" platitude.

### Likely questions

[mid] Q: If the user deletes an entry, what actually changes in the local DB and what gets pushed to the cloud?

A: `deleteEntry` in `database.ts` runs `UPDATE entries SET deleted_at = now, updated_at = now WHERE id = ?` — no `DELETE FROM`. That bumps `updated_at` so the next `pushAll()` cycle picks it up via `WHERE updated_at > synced_at`, then the upsert sends the row with its `deleted_at` populated to Supabase. Every read in the app filters `WHERE deleted_at IS NULL`, so the user sees the entry disappear immediately — but the row is still there, ready to be pushed.

[senior] Q: Why soft-delete every synced table, but leave the option of hard-delete for sync_meta and sync_deletions?

A: Because `sync_meta` and `sync_deletions` are local-only — they don't sync, so there's no second replica to convince that the row is gone. Soft-delete is a tombstone pattern; tombstones only matter when there's a peer that needs to learn the row was deleted. For the synced ten tables, push and pull both need to see the deletion as state. For local-only tables, `DELETE FROM` is correct and cheaper. The rule is "soft-delete because it crosses a sync boundary," not "soft-delete because it's safer." Conflating those two leads people to soft-delete everywhere and pay the storage cost for no reason.

[arch] Q: At a million entries, this design has problems. Walk me through them.

A: Two problems. First, every read filters `deleted_at IS NULL` — without a partial index on `(deleted_at) WHERE deleted_at IS NULL`, that filter can scan millions of tombstones. Second, the database grows monotonically. Mitigation is the deferred 30-day vacuum: a job that hard-deletes rows whose `deleted_at` is more than 30 days old on both sides. The vacuum order matters — it has to delete cloud first, then local, otherwise pull will resurrect the local tombstone. Until the vacuum exists, the table size assumption is "single user journaling for years" — at 5 entries/day for 5 years that's ~9k rows, which is nothing. The right time to build the vacuum is when the actual table tops 100k.

### The question candidates always dodge
Q: GDPR right-to-erasure says you must physically delete user data on request. Soft-delete leaves the row in the DB. How do you reconcile that?

A: I can't, today. The 30-day vacuum is the path that closes this hole, but it's deferred. If someone served a deletion request right now, the answer would be a manual SQL hard-delete on both Supabase and the user's local DB — no automation. That's not good enough for a production multi-user app and I won't pretend it is. The interim fix is a `vacuum_now(user_id)` admin path that bypasses the 30-day window, which is maybe a half-day of work; the permanent fix is the scheduled vacuum job, which is more like two days because it has to coordinate cloud-first-then-local with re-resurrection guards. Phase A is single-user-me, so the obligation is real but the practical exposure is zero. The day there's a second user, the vacuum ships before that user logs in.

### One-line anchors
- "Soft-delete is a tombstone pattern, and tombstones only matter when there's a replica that has to learn the row is gone."
- "`deleted_at` lets sync converge on deletes the same way it converges on edits — uniformly."
- "Every read filters `deleted_at IS NULL` — one missed query is a bug, which is why it's in every CRUD function in `database.ts`."
- "The database grows forever until the 30-day vacuum exists; for solo journaling, that's years away."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
