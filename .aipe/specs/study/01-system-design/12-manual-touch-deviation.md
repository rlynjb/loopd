# Manual-touch deviation (Principle 11)

**Industry name(s):** — (project-specific exception to derived-from-prose invariant)
**Type:** Project-specific

> The only place the app writes a `thread_mentions` row whose `entry_id` and `todo_id` are both NULL. Marks "I touched this thread today" without any prose attribution.

**See also:** → [03-single-source-of-truth](./03-single-source-of-truth.md)

---

## Why care

Every clean architectural rule has exactly one or two cases that don't fit, and pretending otherwise is how codebases become liars. The honest move is to keep the rule, name the exception, and write it down in the same place the rule lives — so the next reader sees both and doesn't think they've found a bug. The alternative is to weaken the rule until it accommodates everything, which is the same as having no rule.

A documented exception is an explicit, narrow carve-out from an architectural invariant, recorded alongside the invariant itself. It belongs to the family of "principle plus enumerated escapes" patterns, the same shape as a strict type system that allows a tightly-scoped escape hatch, or a security policy that lists its exact bypass conditions. You've seen this in coding standards that say "use immutable data, except in these three named places," in API contracts that allow one deprecated field for backward compatibility, and in linter configs with file-scoped disables. Here's how the shape lands in this codebase.

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

**The deviation:**     `src/services/threads/touch.ts` → `toggleThreadTouchToday()` (the entire 54-line file is the documented exception — writes a `thread_mentions` row with `entry_id = NULL AND todo_id = NULL`)
**14-day strip:**      `src/services/threads/getThreadCards.ts` L17–L131 — reads `WHERE entry_id IS NULL AND todo_id IS NULL` to build `activeDates` per thread
**UI surface:**        `src/components/home/DailyScheduleGrid.tsx` — the dashboard grid that taps into `toggleThreadTouchToday`
**Staleness math:**    `src/services/threads/staleness.ts` → `computeStaleness()` — consumes any non-deleted mention row regardless of shape (this is what makes the deviation compose)

---

## Elaborate

### Where this pattern comes from
Documented exceptions are common in codebases that hold otherwise-strict invariants. The pattern is to put the exception in code where it's most visible (a service file with a name that calls out the deviation) and to describe it in the spec under the principle it breaks.

### The deeper principle
**A documented exception beats an undocumented one — and beats a poorly-fit invariant.** The 12-principle list says "mentions are derived from prose," but the dashboard's daily-schedule grid genuinely needs a mention-shaped row that isn't from prose. Rather than weaken the principle ("mentions are mostly from prose"), loopd kept the principle strict and called out the one deviation by name.

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

## Quick summary

A documented exception is an explicit, narrow carve-out from an architectural invariant, recorded alongside the invariant itself rather than absorbed into a weaker rule. In this codebase the daily-schedule grid in `src/components/home/DailyScheduleGrid.tsx` taps into `toggleThreadTouchToday()` in `src/services/threads/touch.ts`, which writes a `thread_mentions` row with `(entry_id=NULL, todo_id=NULL, source_line=0, tag_text='')` — the only place in the app that produces that shape. The constraint was that the dashboard needs a "I touched this thread today" signal with no prose attribution, and the cleanest way to compose with the existing staleness math (`computeStaleness`, `getThreadCards`) was to keep `thread_mentions` as the uniform feed and carve out one exception. The cost is that every reader of `thread_mentions` must know the exception exists — Principle 11's "mentions are derived from prose" is no longer literally true, and a careless `WHERE entry_id IS NOT NULL` query would silently exclude these rows. The alternative (inserting a synthetic `[]` line into the user's prose) was rejected because the journal is the user's writing and the app does not write into it.

Key points to remember:
- One row shape, one writer: `touch.ts:toggleThreadTouchToday` is the only code path that produces `(entry_id=NULL, todo_id=NULL)` in `thread_mentions`.
- The 14-day activity strip in `getThreadCards.ts` queries `WHERE entry_id IS NULL AND todo_id IS NULL` to read these rows specifically; the staleness math consumes them uniformly because it doesn't care about shape.
- Lives in step 1 (Data model) of the system-design checklist.
- One documented exception is the explicit budget — a second deviation would mean Principle 11 is wrong and needs rewriting, not patching.
- Manual-touch rows persist when an entry is deleted because they have no `entry_id` to cascade from; that's intentional but a future bulk-cleanup feature would need a `WHERE entry_date = ?` path.

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

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the manual-touch deviation to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/threads/touch.ts:toggleThreadTouchToday`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A new feature ships: "delete all mentions for an entry when the entry is soft-deleted." Today, `reconcileMentions` re-runs against an absent entry and produces no matches → mentions auto-soft-delete. Now: what happens to the manual-touch rows for that day? Should they be deleted or preserved, and where in the codebase would the answer be enforced? Why does the current schema permit either interpretation, and which one would you ship?

Write your answer. 3–5 sentences minimum. Then open `src/services/threads/touch.ts` and `src/services/threads/getThreadCards.ts` to check current consumer assumptions.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/threads/touch.ts` (the deviation) to support what exists
→ Point to where a synthetic-prose-line alternative would land (`src/services/threads/scanThreads.ts` rewriting the `entries.text` body) if you chose the alternative

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet + corrected "11-principle list" → "12-principle list".

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
