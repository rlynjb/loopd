# Manual-touch deviation (Principle 11)

> The only place the app writes a `thread_mentions` row whose `entry_id` and `todo_id` are both NULL. Marks "I touched this thread today" without any prose attribution.

**See also:** → [03-single-source-of-truth](./03-single-source-of-truth.md)

---

## Quick summary
- **What:** dashboard tap on a thread cell in the daily-schedule grid writes a special `thread_mentions` row with `(entry_id=NULL, todo_id=NULL)`.
- **Why here:** the daily-schedule grid lets the user mark a thread "done today" with no prose. The staleness math (`computeStaleness`, `getThreadCards`) consumes `thread_mentions` uniformly — so writing an entry-less mention row is the cleanest signal.
- **Tradeoff:** breaks Principle 11's "mentions are derived from prose" — explicitly documented as one of two allowed deviations.

---

## Manual-touch deviation — diagram

```
  Standard mention shape:                    Manual touch shape:
  ─────────────────────────                  ─────────────────────
  thread_mentions row:                       thread_mentions row:
    thread_id     = ...                        thread_id     = ...
    entry_id      = e123      ← from prose     entry_id      = NULL  ← deviation
    todo_id       = NULL                       todo_id       = NULL
    source_line   = 7                          source_line   = 0
    tag_text      = "loopd"                    tag_text      = ""
    entry_date    = 2026-05-07                 entry_date    = 2026-05-07
    deleted_at    = NULL                       deleted_at    = NULL
                                                          ▲
                                              dashboard tap on a thread
                                              row in the daily-schedule grid
```

---

## How it works

The daily-schedule grid renders one row per thread per visible week. Each cell is a date. Tapping the cell for "today" toggles a manual-touch — if there's already a manual-touch row for `(thread_id, today)`, soft-delete it; otherwise insert a new one with `entry_id=NULL`, `todo_id=NULL`, `source_line=0`, `tag_text=''`.

Downstream consumers (`computeStaleness`, `getThreadCards`, the 14-day activity strip) read `thread_mentions` uniformly. The 14-day activity strip specifically queries `WHERE entry_id IS NULL AND todo_id IS NULL` to build the `activeDates` set per thread; the staleness label uses any non-deleted mention regardless of shape.

---

## In this codebase

- `src/services/threads/touch.ts` → `toggleThreadTouchToday()`.
- `src/services/threads/getThreadCards.ts` → reads `WHERE entry_id IS NULL AND todo_id IS NULL` for `activeDates`.
- `src/components/home/DailyScheduleGrid.tsx` → the UI surface.
- `src/services/threads/staleness.ts` → consumes the rows uniformly.

---

## Elaborate

### Where this pattern comes from
Documented exceptions are common in codebases that hold otherwise-strict invariants. The pattern is to put the exception in code where it's most visible (a service file with a name that calls out the deviation) and to describe it in the spec under the principle it breaks.

### The deeper principle
**A documented exception beats an undocumented one — and beats a poorly-fit invariant.** The 11-principle list says "mentions are derived from prose," but the dashboard's daily-schedule grid genuinely needs a mention-shaped row that isn't from prose. Rather than weaken the principle ("mentions are mostly from prose"), loopd kept the principle strict and called out the one deviation by name.

### Where this breaks down
- Anyone adding a new consumer of `thread_mentions` must remember to handle the manual-touch shape. A consumer that assumes `entry_id IS NOT NULL` would silently exclude these rows.
- A future "delete the entry → cascade-delete its mentions" feature would orphan the manual-touch rows because they have no `entry_id`. (Today they're soft-deleted directly via `touch.ts`, so this isn't an issue yet.)

### What to explore next
- [Single-source-of-truth principle](./03-single-source-of-truth.md) → the principle this deviates from.
- `docs/spec.md` §11 → the canonical principle list and its noted exceptions.

---

## Tradeoffs

- **Allow entry-less mentions** — gives: a uniform consumer interface for staleness math. Costs: the schema permits a row that isn't tied to any prose, which a careless query can return unexpectedly.
- **One documented exception** — gives: the principle stays strict in 99% of cases. Costs: every reader of `thread_mentions` must know the exception exists.
- **Soft-delete the touch row to "untouch"** — gives: consistent with all other deletes. Costs: an undo-touch leaves a tombstone the database has to carry.
