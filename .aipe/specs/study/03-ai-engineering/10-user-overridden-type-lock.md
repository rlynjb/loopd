# user_overridden_type — the manual lock

> A single boolean column on `todo_meta`. When the user manually picks a type from the picker, the column flips to `true`. From then on, every AI-driven path MUST read this flag and refuse to overwrite.

**See also:** → [09-async-classification](./09-async-classification.md) · → [11-failure-modes](./11-failure-modes.md)

---

## Quick summary
- **What:** `todo_meta.user_overridden_type` is a permanent lock. Any AI-driven update to `type` must check it and skip.
- **Why here:** the LLM is sometimes wrong. Users notice and correct. Without the lock, the next batch run silently undoes the correction.
- **Tradeoff:** the user can't "let the AI try again" via the same field — they have to clear the lock manually (or via a dev affordance).

---

## user_overridden_type — diagram

```
  Without lock:                            With lock:
  ─────────────                            ──────────

  classify  → type='idea'                  classify         → type='idea'
  user opens picker, picks 'todo'          user picks 'todo' → user_overridden_type=true
        │                                        │
  next reconcile fires...                  next reconcile / catch-up fires...
  fresh classify → type='idea' AGAIN ✗     classify still returns 'idea'
                                           BUT: write path checks user_overridden_type
                                                → SKIPS the update ✓
```

---

## How it works

The flag lives on `todo_meta` as a single boolean. It defaults to `false` on insert.

When the user picks a type from the manual picker (in `/todos` or the todo detail screen), the update sets both `type` AND `user_overridden_type=true` in the same write.

Every AI-driven update path consults the flag:
- `scheduleClassify`'s success handler reads the current meta before writing — if `user_overridden_type=true`, it skips.
- The catch-up classifier (the migration that fills `null` types on existing rows) reads the flag and skips locked rows.
- Any future "retroactive re-classify" feature must do the same.

---

## Where to apply this pattern

Any AI-assigned attribute that the user can override. The same shape would work for AI-suggested clip order, AI-detected mood, AI-picked filter — none of which are currently overridable, but the column is the canonical pattern when they become so.

---

## In this codebase

- `src/types/todoMeta.ts` → `user_overridden_type: boolean`.
- `src/services/database.ts` → `updateTodoMeta` accepts the flag.
- `src/components/todos/TypeChangePicker.tsx` → sets the flag when the user changes type.
- `src/services/todos/classify.ts` → catch-up paths check the flag.

---

## Elaborate

### Where this pattern comes from
"User intent supersedes machine intent" is one of the oldest UX rules. Source control merge tools have it (manually-resolved conflicts stay resolved); spam filters have it (user-marked-not-spam stays not-spam); recommender systems have it (do-not-recommend lists).

### The deeper principle
**Make user override permanent until the user reverses it.** A user override that AI later silently reverts is worse than no override at all — it makes the user lose trust in the system.

### Where this breaks down
- Cases where the user actually wants to "let AI try again" — there's no UI affordance for that today. The only escape is to manually pick the type they want, which still flips the flag.
- Bulk operations that should reset all locks (e.g., "I've changed my classification taxonomy, re-classify everything"). Today this would require a SQL update.

### What to explore next
- [09-async-classification](./09-async-classification.md) → the classifier path that reads the flag.
- [11-failure-modes](./11-failure-modes.md) → other ways the AI surface protects user data.

---

## Tradeoffs

- **One boolean per attribute** — gives: simple, explicit, queryable. Costs: a new attribute means a new flag.
- **Default off** — gives: AI runs freely on new rows. Costs: must be explicitly set on user picks.
- **Permanent unless reset** — gives: trust. Costs: no "try again" affordance today.

---

## Interview defense

### What an interviewer is really asking
The user-override question tests whether I understand that AI annotation is *advisory*, not authoritative. The trap is the candidate who designs an AI feature where the model overwrites the user's correction on the next batch run. The interviewer wants to hear that I built a permanent lock and that every AI write path consults it — and that I picked "permanent" deliberately, not "until next run".

### Likely questions

[mid] Q: Trace what happens when a user opens `TypeChangePicker` and changes a todo from 'idea' to 'todo'.
      A: The picker calls `updateTodoMeta` with both `type='todo'` and `user_overridden_type=true` in the same write — same transaction, atomic. From that point, every AI-driven write path consults the flag: `scheduleClassify`'s success handler reads the current meta before writing and skips if the lock is set; the catch-up classifier (the migration that fills `null` types on existing rows) reads the flag and skips locked rows. The LLM may still return 'idea' on some future call — the lock means the *write* is suppressed, not the *call*. The user's correction stands until they reverse it.

[senior] Q: Why a boolean lock instead of, say, a per-field "last-edited-by" column?
         A: A "last-edited-by" column would let me reason about provenance ('user' vs 'classifier-v2' vs 'classifier-v3'), which sounds more flexible. I picked the boolean because the only decision the write paths need to make is "skip or write", and the boolean answers that in one column with one default. Adding provenance would be premature — none of today's features need it, and the day they do, I can migrate from boolean to enum without changing the core "skip if locked" logic. Simple now, extensible later.

[arch] Q: How would this pattern scale to other AI-assigned attributes — clip order, mood, filter preset?
       A: The shape generalises: one boolean per attribute the user can override. So `user_overridden_clip_order`, `user_overridden_mood`, etc. The cost is N booleans for N overridable attributes. An alternative at scale is a single JSON column `overrides` storing `{ type: true, mood: true }` — fewer migrations, one column, slightly worse query semantics. I'd pick the JSON variant the day a fourth overridable attribute lands; below four, separate booleans are explicit and queryable. The doc already names this generalisation.

### The question candidates always dodge
Q: A user who's curious "let me see what AI thinks now" has no way to test that without permanently flipping the lock back. You've made the user a permanent gatekeeper of their own classification. Is that user-friendly?

A: Honestly, no — there's no "try again" affordance and that's a real UX gap. If a user picks 'todo' manually, then six months later wonders if the classifier got better, the only escape today is to manually pick a different type (which still flips the lock to true under the new value) or to clear the flag via SQL in dev mode. Neither is a real user flow. The reason I shipped it this way is that the alternative — a "let AI re-classify" button — adds a state I have to design (does it re-fire just this row? all rows? what about the lock for the next run?) and a UI affordance I don't have a place for. The principle "user override permanent until user reverses it" wins on trust at the cost of flexibility. The day someone asks for "let AI try again", I'd add a `clearOverride(todoId)` action, surfaced as a long-press option on the type badge, and then `scheduleClassify` would treat the cleared flag as a normal classify candidate. Today, no one's asked.

### One-line anchors
- "User intent supersedes machine intent — permanently, until the user reverses it."
- "One boolean per attribute. Simple now, extensible later."
- "The lock means the *write* is suppressed, not the *call*."
- "No 'try again' affordance today. That's a real UX gap I haven't filled."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
