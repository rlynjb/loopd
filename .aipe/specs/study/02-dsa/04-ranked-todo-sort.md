# Ranked todo flatten + sort (legacy `rankTodos`)

> Array flatten across entries, then 3-key compare (done last, source priority, createdAt asc). **The `rankTodos` function is currently in the repo but no app code calls it** — kept here as it's a real algorithm worth understanding.

**See also:** → [11-pinned-first-sort](./11-pinned-first-sort.md) · → [01-system-design/16-pin-replaces-reorder](../01-system-design/16-pin-replaces-reorder.md)

---

## Quick summary
- **What:** flatten todos across all entries, drop completed-too-long-ago, sort by (done, source priority, createdAt).
- **Why studied:** the file is still in the repo (`src/services/todos/rank.ts`), and the concept of "compose-into-one-comparator" is broadly applicable.
- **Status:** **legacy.** The dashboard and `/todos` no longer call `rankTodos`. They use a simpler pinned-first sort (see [11-pinned-first-sort](./11-pinned-first-sort.md)). Only `formatRelativeTime` from this file is currently imported.

**Real (legacy) operation:** `rankTodos` in `src/services/todos/rank.ts`.

---

## The data

```
  entries: [
    { id: "e-yest", date: "2026-05-06", createdAt: "...", todos: [
        { id: "t-1", text: "call mom",   done: false, completedAt: null, createdAt: "2026-05-06T08:00" },
        { id: "t-2", text: "ship feat",  done: true,  completedAt: "2026-05-07T09:00", createdAt: "..." },
    ]},
    { id: "e-tdy",  date: "2026-05-07", createdAt: "...", todos: [
        { id: "t-3", text: "review PR",  done: false, completedAt: null, createdAt: "2026-05-07T10:00" },
        { id: "t-4", text: "fix bug",    done: false, completedAt: null, createdAt: "2026-05-07T10:05" },
    ]},
  ]
  today = "2026-05-07"
  keepDoneMs = 2000
  now = "2026-05-07T10:30:00"
```

**The problem:** flatten across entries, drop completed-too-long todos, then bubble: carried-from-yesterday → ai-generated → today's → all sorted oldest first within each group, with done at the bottom.

---

## Pseudocode

```
  flat = []
  for each entry in entries:
    for each todo in entry.todos:
      if todo.done AND todo.completedAt AND (now - completedAt > keepDoneMs): continue
      source = (not done AND entry.date < today) ? 'carried' : 'journal'
      flat.push({ ...todo, entryId, entryDate, entryCreatedAt, source })

  priority = { carried: 0, ai: 1, journal: 2 }

  flat.sort((a, b):
    if a.done != b.done: return a.done ? +1 : -1     // done at bottom
    if priority[a.source] != priority[b.source]: return priority[a]-priority[b]
    return parseISO(a.createdAt) - parseISO(b.createdAt) )   // oldest first

  return flat
```

**Execution trace:**

```
  Flatten + filter:
    t-1 "call mom"   not done, e.date 05-06 < today 05-07 → source='carried'
    t-2 "ship feat"  done, completedAt 09:00, now 10:30, diff = 5400000ms > 2000ms → DROP
    t-3 "review PR"  not done, e.date == today           → source='journal'
    t-4 "fix bug"    not done, e.date == today           → source='journal'

  flat = [t-1 carried, t-3 journal, t-4 journal]

  Sort:
    a=t-1, b=t-3
      done equal (both false)
      priority: carried 0, journal 2 → t-1 first
    a=t-3, b=t-4
      done equal
      priority equal (journal/journal)
      createdAt: 10:00 < 10:05 → t-3 first

  Final order: [ t-1 (carried), t-3 (journal), t-4 (journal) ]
```

**Complexity:** O(n log n) time (sort dominates) · O(n) space.

**Why this would be optimal:** the alternative (group → sort within groups → concat) is also O(n log n) but allocates more arrays. Compose-into-one-comparator is the cleanest.

---

## When brute force is fine

`rankTodos` IS the only-version-here. The brute alternative (multi-pass: group, sort each, concatenate) is also O(n log n) but more allocation-heavy. At todo-list scale (a few hundred max), both are sub-millisecond.

---

## In this codebase

- `src/services/todos/rank.ts` → `rankTodos()` defined and exported, **not currently called by any app code**.
- `src/services/todos/rank.ts` → `formatRelativeTime()` is imported by `app/todos.tsx` and `src/components/home/SmartTodoList.tsx`. That's the live consumption of the file.
- The actual sort used by the dashboard and `/todos` is in [11-pinned-first-sort](./11-pinned-first-sort.md).

---

## Elaborate

### Where this pattern comes from
"Compose multiple sort keys into one comparator" is the canonical pattern for stable lexicographic sort — used everywhere from SQL `ORDER BY a, b, c` to spreadsheet multi-column sort. The trick is the comparator returns the first non-zero comparison; the key list defines the priority.

### The deeper principle
**Sort priority is just a sequence of fall-through comparisons.** Each key gets one chance to decide the ordering; if equal, fall through. This composes elegantly and is easy to extend or reorder.

### Where this breaks down
- Sorts where you want some keys ascending and others descending — the comparator gets verbose. Loopd handles it inline (`a.done ? +1 : -1`).
- Sorts where the key derivation is expensive. The comparator runs O(n log n) times so each derivation runs many times. A `decorate-sort-undecorate` pattern (Schwartzian transform) helps.

### What to explore next
- [11-pinned-first-sort](./11-pinned-first-sort.md) → the live algorithm that replaced this one.
- [01-system-design/16-pin-replaces-reorder](../01-system-design/16-pin-replaces-reorder.md) → why the swap happened.

---

## Tradeoffs (in its prime, vs alternatives)

- **Compose comparator** — gives: one stable sort, easy to reorder. Costs: comparator can get long.
- **3 source tiers (`carried` > `ai` > `journal`)** — gives: meaningful surface order. Costs: AI-source todos require classifier/expand metadata; the field has to be derivable.
- **`keepDoneMs` filter inside flatten** — gives: a single pass. Costs: the filter parameter has to be threaded through; not configurable per-screen without plumbing.

---
Updated: 2026-05-07 — reframed as legacy. The function is no longer called by app code; the dashboard and /todos use the pinned-first sort. Only `formatRelativeTime` from rank.ts is consumed live. See `11-pinned-first-sort.md` for the active algorithm.
