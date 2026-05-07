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
