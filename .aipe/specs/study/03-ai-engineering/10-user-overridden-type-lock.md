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
