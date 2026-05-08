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

---

## Interview defense

### What an interviewer is really asking
The interviewer is checking whether you can name your own architectural exceptions out loud. "Mentions are derived from prose" is a clean rule with one documented violation. They want to hear you describe why this specific deviation was the right call — and why one is the budget you allowed yourself.

### Likely questions

[mid] Q: What does the row inserted by `toggleThreadTouchToday` actually look like?

A: A `thread_mentions` row with `thread_id` set, `entry_id = NULL`, `todo_id = NULL`, `source_line = 0`, `tag_text = ''`, and `entry_date = today`. Standard `created_at`, `updated_at`, `deleted_at`. The shape is a normal mention row except for the two NULLs that no other code path can produce. The 14-day activity strip detects this shape with `WHERE entry_id IS NULL AND todo_id IS NULL`; the staleness math doesn't care about the shape and consumes it as just another mention.

[senior] Q: Why didn't you make the touch gesture insert a synthetic `[]` line in the user's prose? That would keep "mentions are derived from prose" intact.

A: I considered it for about an afternoon and rejected it. Inserting a synthetic prose line means the user opens their journal and sees a `[]` line they didn't type — that's a UX violation that's worse than an architectural violation. The journal is the user's writing; the app doesn't write into it. The deviation is the cleaner choice: the schema permits the entry-less mention shape, the staleness math is uniform, and the rule "the journal is the user's" stays absolute. The cost is that any new consumer of `thread_mentions` has to know the deviation exists, which I documented in the spec under Principle 11.

[arch] Q: What happens to manual-touch rows when an entry is deleted, and is that consistent with your other cascades?

A: Manual-touch rows are unaffected by entry deletion because they have no `entry_id` to cascade from. Standard mentions with `entry_id = e123` get soft-deleted when the entry is deleted (because `reconcileMentions` re-runs against an absent entry and finds no matching mentions). Manual-touch rows persist until the user explicitly untouches them via the same dashboard tap. That's the right behavior — the user's "I touched this thread today" intent isn't tied to a journal entry, so it shouldn't disappear when one does. The risk is that a future "delete all entries from a date" sweep would expect to clean up manual-touch rows for that date and miss them; I'd add a `WHERE entry_date = ?` cleanup path if that feature ever ships.

### The question candidates always dodge
Q: You allow one documented exception. What stops the codebase from accumulating five more "small" exceptions over time?

A: Discipline, mostly — and a docs surface that calls out the exception by name. The spec lists 12 principles and explicitly enumerates the deviations. When I considered shipping a second deviation (a "promote a todo to a thread" gesture that would also need a from-the-air mention), I rejected it precisely because adding a second exception erodes the strictness of the rule. The discipline I hold myself to is: if a feature needs a second deviation, the principle is wrong and needs rewriting, not patching with another exception. So far the only deviation is manual-touch, and the principle hasn't required a rewrite. The honest answer is the budget could erode if I stopped paying attention; the docs are the tripwire that makes erosion visible. The day a code review proposes deviation #2, I either fix it or I refactor the principle.

### One-line anchors
- "One documented exception beats two undocumented ones, and beats a poorly-fit invariant."
- "The journal is the user's writing — the app does not write `[]` lines into prose to satisfy an architectural rule."
- "The staleness math composes uniformly because the deviation respects the *shape* of a mention row, only the source differs."
- "If a second deviation became necessary, the principle would be wrong — not the schema."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
