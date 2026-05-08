# Single-source-of-truth principle

> The journal text in `entries.text` is the only writable surface for drops; everything else (`todos_json`, `todo_meta`, `nutrition`, `thread_mentions`) is derived state, rebuilt from prose at commit time.

**See also:** → [04-two-pass-matching](./04-two-pass-matching.md) · → [06-one-to-one-invariant](./06-one-to-one-invariant.md) · → [12-manual-touch-deviation](./12-manual-touch-deviation.md)

---

## Quick summary
- **What:** prose is canonical. Markers like `[]`, `** food N kcal`, and `#tag` in `entries.text` are the source. All derived rows are rebuilt by scanners at commit time.
- **Why here:** keeps a single editable place. Two surfaces would mean drift; this way "delete the line in your journal, the todo is gone" works without divergent code paths.
- **Tradeoff:** you can't have a todo that doesn't exist as a `[]` line — except the dashboard's quick-add path, which adds a `[]` line implicitly.

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

- `src/services/todos/scanTodos.ts` → `scanTodosFromText()` — extracts `[]` lines.
- `src/services/threads/scanThreads.ts` → `parseTags()` + `reconcileMentions()` — extracts `#tag` mentions.
- `src/services/nutrition/scan.ts` — extracts `** food N kcal` lines.
- `src/services/todos/reconcileMeta.ts` → `reconcileTodoMetaForEntry()` — keeps `todo_meta` 1:1 with `todos_json`.

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
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
