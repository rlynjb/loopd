# Single-source-of-truth principle

**Industry name(s):** Single source of truth (SSOT), canonical data store
**Type:** Industry standard · Language-agnostic

> The journal text in `entries.text` is the only writable surface for drops; everything else (`todos_json`, `todo_meta`, `nutrition`, `thread_mentions`) is derived state, rebuilt from prose at commit time.

**See also:** → [04-two-pass-matching](./04-two-pass-matching.md) · → [06-one-to-one-invariant](./06-one-to-one-invariant.md) · → [12-manual-touch-deviation](./12-manual-touch-deviation.md)

---

## Why care

Most data integrity bugs are not about a write going wrong — they're about the same fact being writable in two places, and the two places drifting. Edit a customer's email in the CRM, edit it again in the billing system, and within a week you've got two different emails and no honest answer to "which is real." The cheap fix is to pick one surface as canonical and treat every other copy as a cache you can throw away.

Single source of truth is the discipline of designating exactly one writable origin for each fact, with all other representations derived from it deterministically. It belongs to the family of "one-way data flow" patterns, alongside event sourcing and unidirectional state stores. You've seen this in Redux (the store is canonical, components render from it), in Git (the commit graph is canonical, the working tree is derived), and in compilers (the source file is canonical, every artifact is reproducible from it). Here's how that actually works in this codebase.

---

## Single-source-of-truth — diagram

```
              prose in entries.text                ←── canonical
                       │
                       │ scanners run at commit (focus blur, screen leave)
                       │
        ┌──────────────┼──────────────────┬─────────────────┐
        ▼              ▼                  ▼                 ▼
  scanTodos      scanThreads         scanNutrition       (no scanner —
        │              │                  │             habits are first-class)
        ▼              ▼                  ▼
  todos_json   thread_mentions       nutrition rows
        │
        ▼
  reconcileMeta
        │
        ▼
  todo_meta (1:1 with each TodoItem in todos_json)
```

---

## How it works

Every prose-derived feature has the same shape: a scanner reads `entries.text`, produces an array of structured rows, and a reconciler diffs those rows against what's already in the DB. Inserts what's new, deletes what's gone, leaves matching rows alone (preserving identity, classifier output, manual overrides).

The scanners run at commit boundaries — focus blur, screen leave, save events — not on every keystroke. The keystroke path autosaves the prose to SQLite; the scanners catch up at the next natural pause.

Habits are an exception: they're first-class user-managed entities, not derived from prose. There's no `scanHabits` because the user creates and edits habits directly in the more/habits screen.

---

## In this codebase

This principle is cross-cutting; the four scanner+reconciler pairs that enforce it are:

**Todos scan:**       `src/services/todos/scanTodos.ts` → `scanTodosFromText()` L53–L138 — extracts `[]` lines from prose
**Todos reconcile:**  `src/services/todos/reconcileMeta.ts` → `reconcileTodoMetaForEntry()` L48–L92 — keeps `todo_meta` 1:1 with `todos_json`
**Threads scan:**     `src/services/threads/scanThreads.ts` → `parseTags()` L37–L64 + `reconcileMentions()` L169–L230 — extracts `#tag` mentions
**Nutrition scan:**   `src/services/nutrition/scan.ts` — extracts `** food N kcal` lines

The principle's anchor is the call site that fires all of these on every prose commit (focus blur, screen leave). Habits are the deliberate non-derived first-class entity (no `scanHabits`).

---

## Elaborate

### Where this pattern comes from
The "single source of truth" idea is older than databases — it's a normalisation principle. The interesting move loopd makes is choosing *prose* as the source rather than a structured form. That's borrowed from tools like Roam, Logseq, and Obsidian, where you write naturally and the structure is parsed out behind you.

### The deeper principle
**Pick one surface as canonical, even if it costs you.** A second writable surface means you'll spend forever syncing them. Loopd would have been simpler in the short term with a "add todo" button writing directly to `todos_json`, but the long-term cost is that "delete the line, todo disappears" stops working — and the data drifts every time the two surfaces disagree.

### Where this breaks down
- Operations that have no natural prose representation (the manual-touch deviation is exactly this — see [12](./12-manual-touch-deviation.md)).
- Bulk imports where typing prose for hundreds of rows is impractical.
- Multi-author content where the prose is owned by one person and the metadata by another.

### What to explore next
- [Two-pass matching](./04-two-pass-matching.md) → how identity survives prose edits.
- [The 1:1 invariant](./06-one-to-one-invariant.md) → the reconciler that enforces this principle for `todo_meta`.
- [Manual-touch deviation](./12-manual-touch-deviation.md) → the documented exception.

---

## Tradeoffs

- **Prose canonical** — gives: edit-the-text deletes-the-row. Costs: every feature needs a scanner + reconciler.
- **Scanners at commit only** — gives: keystroke path stays cheap. Costs: a few hundred ms of "stale" derived state during typing.
- **No `scanHabits`** — gives: habits can have rich metadata (cadence, time-of-day) the user wouldn't write inline. Costs: habits are *not* declared in prose, so they don't show up in journal exports unless you mention them.

---

## Quick summary

Single source of truth is the discipline of designating exactly one writable origin for each fact, with every other representation derived from it deterministically — pick one surface as canonical, treat everything else as a cache you can throw away. In this codebase the prose in `entries.text` is canonical; markers like `[]`, `** food N kcal`, and `#tag` are the source, and `scanTodosFromText`, `parseTags` + `reconcileMentions`, and `src/services/nutrition/scan.ts` rebuild `todos_json`, `thread_mentions`, and nutrition rows at every commit boundary (focus blur, screen leave). The constraint was a single editable place — two writable surfaces would drift, and "delete the line, the row disappears" stops working the moment a button writes directly to `todos_json`. The cost is that every prose-derived feature needs its own scanner plus reconciler, and operations with no natural prose representation (the documented manual-touch deviation) become exceptions. Habits are first-class entities by design because cadence metadata won't fit inline; that's the principled exception, not a regression.

Key points to remember:
- Prose in `entries.text` is canonical; `todos_json`, `todo_meta`, `thread_mentions`, and nutrition rows are rebuilt from prose by scanners.
- Scanners run at commit boundaries (focus blur, screen leave), not on every keystroke — the keystroke path stays cheap.
- Lives in step 1 (Data model) of the system-design checklist.
- The dashboard's quick-add path preserves the invariant by appending a `[]` line to prose, not by writing directly to `todos_json`.
- Habits have no `scanHabits` because they're first-class user-managed entities; the manual-touch deviation is the documented one-off exception.

---

## Interview defense

### What an interviewer is really asking
The interviewer wants to know whether you understand the cost of declaring a single source of truth — most engineers say "single source of truth" as a slogan and then build two writable surfaces anyway. The probe is: did you actually live by it, and what did you give up to live by it?

### Likely questions

[mid] Q: A user types `[] call mom` then deletes the line. Walk me through what happens to the corresponding `todo_meta` row.

A: The keystroke autosaves prose to `entries.text` in SQLite. At the next commit boundary (focus blur, screen leave), `scanTodosFromText` runs — the deleted line produces no match, so the corresponding `TodoItem` is dropped from `todos_json`. Then `reconcileTodoMetaForEntry` diffs the new `todos_json` ids against the existing `todo_meta` rows and soft-deletes the orphan. There's no "delete todo" code path; the todo went away because the prose did.

[senior] Q: Why didn't you give the dashboard a "+ todo" button that writes directly to `todos_json`? It would be one less round-trip.

A: Because the moment two surfaces can write the same data, they drift. If I add a todo via a button, I either have to also add a `[]` line to the prose (so the canonical surface stays correct), or I accept that "delete the line, todo disappears" stops being a universal rule. The dashboard's quick-add path takes the first option — it appends a `[]` line to the day's entry text, then re-runs the scanner. It's a few more lines of code, but it preserves the invariant that the prose is the only writable surface for drops.

[arch] Q: How does this principle scale to a multi-author or collaborative version of the app?

A: Badly without changes. "Prose is canonical" assumes one writer. With two writers, you get the same problem as collaborative document editing — concurrent edits to the same prose line can both produce or both destroy a derived row, and neither writer is wrong. The fix would be to keep prose canonical but apply CRDT semantics on the prose itself (Y.js, Automerge), letting the scanners run after every converged state. The scanner pattern stays; the canonical layer changes from "raw text" to "CRDT-text".

### The question candidates always dodge
Q: The manual-touch deviation breaks your "prose is canonical" rule. Why is that one exception OK and not others?

A: It's not really OK — it's the smallest exception I could justify, and I documented it loudly in the spec (Principle 11). The dashboard's "tap a thread to mark it touched today" gesture writes a `thread_mentions` row with NULL `entry_id` AND NULL `todo_id` because there's no prose line to attach it to. I considered making the touch gesture insert a synthetic prose line, but that pollutes the journal with rows the user didn't type. The exception is permitted because the staleness math composes uniformly — the touch row counts the same as a prose-derived row when computing "did this thread happen today?". The rule the deviation respects is that the *derived shape* (a row in `thread_mentions`) is canonical-equivalent to a prose-derived row; only the source differs. If I needed a second exception, I'd revisit the architecture; one is the budget.

### One-line anchors
- "Prose is canonical — the cost is a scanner per feature, the win is that 'edit the line, the row updates' works without per-feature plumbing."
- "Two writable surfaces always drift; one writable surface plus derivers is the discipline."
- "The scanners run at commit boundaries, not on every keystroke — the keystroke path stays cheap."
- "Habits are first-class because cadence metadata won't fit inline; that's the principled exception, not a regression."
- "The manual-touch deviation is the documented one-off; one exception is the budget I gave myself."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "prose is canonical for drops" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/scanTodos.ts:scanTodosFromText` (and its sibling reconciler)
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user goes into the dashboard's quick-add and types "remember to call mom" — adds it as a todo via the button (not via prose). What does the system do to keep "prose is canonical" intact? Then: the same user opens the journal entry that the quick-add wrote into and deletes the line. What happens to the todo, the `todo_meta`, the `thread_mentions` (if any), the `expanded_md`?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/scanTodos.ts` and `src/services/todos/reconcileMeta.ts` to check.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/scanTodos.ts` (the scanner pattern) to support what exists
→ Point to `src/services/threads/touch.ts` (the documented manual-touch deviation) if you chose the alternative — show what a *second* deviation would actually cost

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

---
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
