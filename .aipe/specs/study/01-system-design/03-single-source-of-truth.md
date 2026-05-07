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
