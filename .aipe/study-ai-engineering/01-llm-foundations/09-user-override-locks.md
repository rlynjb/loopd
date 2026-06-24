# User-override locks

**Industry name(s):** User-override locks, user-correction protection, source-of-truth flag
**Type:** Industry standard · Project-shaped

> Any field the LLM writes that the user can also edit needs an override flag. Without it, the next re-run silently erases the user's correction. The flag tracks "who set this last"; the LLM checks before writing.

**See also:** → [04-structured-outputs](./04-structured-outputs.md) · → [07-heuristic-before-llm](./07-heuristic-before-llm.md) · → [`ai-features-in-this-codebase`](../ai-features-in-this-codebase.md)

---

## Why care

### Move 1 — The grounded scenario

User types `[] revisit the caption-variants decision`. Buffr classifies it as `study`. User opens the todo detail, taps the type chip, manually changes it to `reflect` ("I'm not learning something new — I'm reconsidering a call I already made"). Closes the screen. Next day, user edits the prose. The classifier runs again on the (slightly changed) text. It re-classifies as `study`. User's manual correction is gone. From the user's perspective, the AI is fighting them.

### Move 2 — Name the question the pattern answers

That who-set-this question is what user-override locks answer. Not "how do I prevent classifier drift" (different problem); just *what's the canonical pattern for any field the LLM writes that the user can override, so the user's correction sticks*. The answer: a per-field `_user_overridden` flag that, when true, blocks the LLM from writing.

### Move 3 — Why answering that question matters

**What breaks without override locks:** every chain that runs more than once silently erases user corrections. User trust breaks because "the AI changed it back." In buffr today, `todo_meta.user_overridden_type` is the override flag for the classifier's `type` field — when true, `classify` short-circuits and returns the existing value instead of running the LLM. The pattern is documented in principle #9 of the spec.

### Move 4 — Concrete before/after

Without override lock:
- User overrides `type` from `study` to `reflect`
- Next classify run rewrites to `study`
- User has to manually re-fix; eventually gives up
- AI gets a "broken" reputation in the user's head

With override lock:
- User overrides → `user_overridden_type = true` set in `todo_meta`
- Next classify run sees `user_overridden_type` and returns existing value
- Correction sticks indefinitely
- User trust intact

### Move 5 — The one-line summary

Any field with both AI and user write access needs an override flag; the LLM checks before writing. The user's correction is the canonical answer once they've made it.

---

## How it works

### Move 1 — The mental model

```
   Field with override tracking:
   ┌──────────────────────────────────────────────┐
   │ {                                            │
   │   type: 'reflect',                           │
   │   type_source: 'user',     ← who set this    │
   │   user_overridden_type: true                 │
   │ }                                            │
   └──────────────────────────────────────────────┘

   When the classifier runs:

   if (user_overridden_type === true) {
     return existing.type;   // don't overwrite
   } else {
     type = classifyWithLLM(text);
     user_overridden_type = false;
   }
```

### Move 2 — The layered walkthrough

**Layer 1 — what the flag means.** A boolean per overridable field: `true` if the user has explicitly set this field, `false` if the LLM did. Set to `true` when the user edits the field via UI. Set to `false` only when the row is created or when the user explicitly resets ("reclassify with AI"). The LLM check is `if (flag === true) return existing; else write`.

```
   Lifecycle of user_overridden_type
   ─────────────────────────────────
   row created       →  false  (LLM will classify)
   user edits chip   →  true   (LLM blocked)
   reset to default  →  false  (LLM resumes)
   prose changes     →  unchanged  (override persists)
```

**Layer 2 — where the check lives.** In `src/services/todos/classify.ts`, the function checks `todo_meta.user_overridden_type` before calling the LLM. If true, returns the existing type without making the API call. This saves the LLM cost on overridden todos and — more importantly — guarantees correctness.

```
   classify(todoId) dispatch
   ─────────────────────────
     fetch todo_meta(todoId)
           │
           ▼
     ┌──────────────────────────┐
     │ user_overridden_type?    │
     └────────┬─────────────────┘
              │
        ┌─────┴─────┐
        │           │
        ▼ true      ▼ false
     return        run heuristic → LLM if needed
     existing.type
```

**Layer 3 — which fields need this pattern.** Every field where (a) the LLM writes a value and (b) the user can edit it. In buffr today, that's exactly one field: `todo_meta.type`. Other LLM-written fields (`ai_summaries.summary_json`, `caption variants`, `expanded_md`) are not user-editable — they're regenerated wholesale, not patched. The `B1.9` curriculum item is an audit to confirm no other field has slipped into "user can edit AI's value" territory without a lock.

```
   buffr's overridable-AI fields audit (today)
   ───────────────────────────────────────────
   todo_meta.type             →  has override lock  ✓
   ai_summaries.summary_json  →  not user-editable  N/A
   caption variants           →  not user-editable  N/A
   todo_meta.expanded_md      →  not user-editable  N/A
```

### Move 3 — The principle

User-override locks are non-negotiable for any AI-and-user co-edited field. Two ways to fail: forget to add the lock (data loss bug), add the lock but forget to check it (data loss bug, slower). Test both write paths: (a) LLM doesn't overwrite when locked, (b) user can still edit freely.

The full picture is below.

---

## User-override locks — diagram

```
┌─ todo_meta schema (with lock fields) ──────────────────────────────────┐
│                                                                        │
│   id                       integer    primary key                      │
│   todo_id                  text                                        │
│   type                     text       ('todo'|'idea'|'knowledge'|…)    │
│   user_overridden_type     boolean    DEFAULT false                    │
│   expanded_md              text       nullable                         │
│   classifier_confidence    real       nullable                         │
│   ...                                                                  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─ Write paths and the override check ───────────────────────────────────┐
│                                                                        │
│   User edits chip (UI)  ────→  setTodoType(id, type) ─────────────────┐│
│                                  │                                   │ │
│                                  ▼                                   │ │
│                              UPDATE todo_meta                        │ │
│                              SET type = ?,                            │ │
│                                  user_overridden_type = true          │ │
│                              WHERE todo_id = ?                        │ │
│                                                                       │ │
│   Prose changes  ──→ reconcileMeta(todos) ─→ classify(id)  ←──────────┘│
│                                                  │                     │
│                                                  ▼                     │
│                                          fetch user_overridden_type    │
│                                                  │                     │
│                                          ┌───────┴────────┐            │
│                                          │                │            │
│                                          ▼ true           ▼ false      │
│                                       return         run classifier    │
│                                       existing       write new type    │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A — buffr implements the override lock on `todo_meta.type`.**

**Files:**
- `supabase/migrations/0001_schema.sql` and the SQLite mirror — `todo_meta.user_overridden_type BOOLEAN NOT NULL DEFAULT 0`.
- `src/services/todos/classify.ts` (~L25–L40) — checks `user_overridden_type` before any heuristic or LLM dispatch.
- `src/services/database.ts` — `setTodoType(id, type)` UPDATEs both `type` and `user_overridden_type = true` in one transaction.
- `app/todos/[id].tsx` — the type-chip edit UI calls `setTodoType` on user tap.
- `docs/spec.md` §10 principle #9 — documented as a non-negotiable.

The lock is verified by an integration test (manual at present — automated via `B1.9`): override a todo's type, edit the prose, re-run the reconciler, assert the type is unchanged.

---

## Elaborate

### Where this pattern comes from

The pattern is a special case of "source of truth" tracking — common in distributed systems where multiple writers update the same field. The LLM-and-user case became prominent post-2022 as classifiers and structured-extraction features shipped to end-users.

### The deeper principle

When multiple writers can update the same field, the system needs to know which write is canonical. A flag-per-field is the simplest pattern; an audit-log-per-field is the more general pattern.

### Where this breaks down

For fields with frequent user edits, the override semantics become questionable — was the user's edit "permanent" or "context-specific"? Some patterns reset the lock after N days; some never. Buffr's current shape (lock is permanent until user resets) matches the user-perceived behaviour but means the LLM can never re-classify a corrected todo even years later when the model has improved.

### What to explore next

- [04-structured-outputs](./04-structured-outputs.md) — the structured output is what fills the field; the override decides whether to write at all
- [`05-evals-and-observability/04-llm-observability`](../05-evals-and-observability/04-llm-observability.md) — overridden-todo rate is a quality signal for the classifier
- [01-what-is-an-llm](./01-what-is-an-llm.md) — the LLM has no awareness of past corrections; the override flag is your code carrying that state

---

## Tradeoffs

```
┌──────────────────┬──────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Override lock            │ No lock                      │
├──────────────────┼──────────────────────────┼──────────────────────────────┤
│ User trust       │ Corrections persist      │ Corrections silently erased   │
│ Schema overhead  │ One boolean per field    │ Zero                         │
│ LLM cost         │ Saved on overridden rows │ Wasted on overridden rows    │
│ Re-classification│ Blocked until reset       │ Always runs                  │
│ when model       │                          │                              │
│ improves         │                          │                              │
└──────────────────┴──────────────────────────┴──────────────────────────────┘
```

### The breakpoint

Add the lock the moment a field is both LLM-written and user-editable. There is no "small enough not to bother" — even one user correction is enough to teach them the AI is unreliable.

---

## Tech reference (industry pairing)

### SQLite boolean column

- **Codebase uses:** `BOOLEAN NOT NULL DEFAULT 0` (SQLite has no real boolean; stored as 0/1 integer).
- **Why it's here:** simple, indexable, mirrors cleanly to Postgres `BOOLEAN`.

### Database transaction for atomic update

- **Codebase uses:** `database.ts`'s `setTodoType` wraps the type update and the lock-set in one transaction so the two can never diverge.
- **Why it's here:** atomicity guarantees no race window where lock is set but type isn't, or vice versa.

---

## Project exercises

### B1.9 — Audit every AI-written field for override-lock coverage

- **Exercise ID:** `B1.9`
- **What to build:** walk every field written by any chain (`summarize`, `caption`, `expand`, `classify`, `interpret`) and verify either (a) the field is not user-editable, or (b) there's an override lock and a check. Document the audit in `docs/spec.md` as a table mapping field → lock-status → write-paths.
- **Why it earns its place:** the moment a new feature lets the user edit an AI-written field without a lock, this bug class returns. The audit catches it before shipping.
- **Files to touch:** `docs/spec.md`; possibly migrations if a missing lock is found.
- **Done when:** the table is in spec.md; every field is either marked "not user-editable" or has a verified lock + check.
- **Estimated effort:** 2 hours.

---

## Summary

### Part 1 — concept recap

Any field that's both LLM-written and user-editable needs a `_user_overridden` flag. The LLM checks before writing. Buffr's `todo_meta.user_overridden_type` is the canonical example — when true, the classifier returns the existing value instead of running. The pattern is documented in principle #9 of the spec; the audit (`B1.9`) verifies no field has slipped into "both writers, no lock" territory.

### Part 2 — key points to remember

- Override lock = `boolean` per field, set to `true` on user edit.
- LLM checks before writing: `if (lock === true) return existing; else write`.
- Update lock and field atomically in the same transaction.
- Default value is `false` (LLM may write); user edit flips it.
- Buffr's only locked field today is `todo_meta.type`.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks about user-AI co-editing, they're checking whether you've shipped past the demo. Engineers who haven't shipped don't think about override locks; engineers who have shipped have a story about the bug they fixed by adding one.

### Likely questions

**Q [mid]:** What's the override lock pattern and why does it matter?

**A:** A boolean per LLM-written, user-editable field — true when the user has explicitly set the value, false otherwise. The LLM checks the flag before writing: if true, return the existing value; if false, write the new value. Without it, every re-run silently overwrites user corrections. In buffr, `todo_meta.user_overridden_type` is the canonical case — the classifier short-circuits when this is true. Without the lock, users would see their type corrections vanish on every prose edit.

**Q [senior]:** What's tricky about the override lock pattern at scale?

**A:** Permanence semantics. A user's correction last year — is it still authoritative this year? Buffr's current shape says "yes, forever, unless the user resets." That's user-friendly (their correction sticks) but means the LLM can never re-classify a corrected row even when the model has improved by leaps. The alternative — reset locks after N days, or on a major model upgrade — risks "the AI changed my correction" complaints. Most production systems pick the permanence shape and live with the staleness; some add a manual "reclassify" button so users can opt in.

### One-line anchors

- Override lock = boolean per overridable AI field.
- LLM checks before writing.
- Atomic update with the field value.
- Default false; user edit flips to true.
- Buffr has one lock today (`todo_meta.user_overridden_type`).

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the override-lock check in the classify flow: fetch lock → branch on true/false → return-or-classify.

### Level 2 — Explain it out loud

Explain in under 60 seconds why an AI-written field that the user can edit needs an override flag.

### Level 3 — Apply it to a new scenario

A new requirement: buffr should AI-suggest a `priority` (1-5) per todo, user-editable. Sketch the schema additions and where the override check goes.

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should reset `user_overridden_type` automatically when the classifier confidence on the latest prose exceeds 0.9 — the model now knows better."

### Quick check — code reference test

Without opening files:
- What field carries buffr's only override lock today?
- Where does the classify dispatch check the lock?
- What's the symptom of a missing lock?

---
