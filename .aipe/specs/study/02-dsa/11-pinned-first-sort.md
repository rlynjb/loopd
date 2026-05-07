# Pinned-first sort — the live /todos and dashboard ordering

> Two-key compare: `pinned` first (true before false), then `createdAt DESC` (newest first). Replaces the legacy `rankTodos` / position-based sort.

**See also:** → [04-ranked-todo-sort](./04-ranked-todo-sort.md) · → [01-system-design/16-pin-replaces-reorder](../01-system-design/16-pin-replaces-reorder.md)

---

## Quick summary
- **What:** sort todos so pinned rows appear above unpinned, with newest-first ordering inside each group.
- **Why here:** the active sort on `/todos` and the dashboard. Pinned acts as a sticky modifier on top of recency.
- **Tradeoff:** within the pinned group, an old-but-still-pinned item is below a newer pinned item — no way to override.

**Real operation:** the inline `out.sort(...)` in `app/todos.tsx` (lines ~187-194) and `src/components/home/SmartTodoList.tsx`.

---

## The data

```
  rows: [
    { id: "t-1", createdAt: "2026-05-07T09:00", meta: { pinned: false } },
    { id: "t-2", createdAt: "2026-05-07T10:00", meta: { pinned: true  } },
    { id: "t-3", createdAt: "2026-05-06T15:00", meta: { pinned: false } },
    { id: "t-4", createdAt: "2026-05-07T11:00", meta: { pinned: true  } },
  ]
```

**The problem:** sort so `t-2` and `t-4` come first (pinned), with `t-4` above `t-2` inside the pinned group (newer); `t-1` then `t-3` in the unpinned group (newer first).

---

## Pseudocode

```
  rows.sort((a, b) => {
    const aPin = a.meta.pinned ? 1 : 0;
    const bPin = b.meta.pinned ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;        // pinned first
    const aTime = new Date(a.createdAt ?? a.meta.createdAt).getTime();
    const bTime = new Date(b.createdAt ?? b.meta.createdAt).getTime();
    return bTime - aTime;                         // newest first
  });
```

**Execution trace** (input above):

```
  comparator(t-1, t-2): aPin=0 bPin=1 → 1-0 = 1  → t-2 before t-1
  comparator(t-2, t-4): aPin=1 bPin=1 → 0       → fall to time
                        aTime=10:00 bTime=11:00  → 11:00-10:00 > 0 → t-4 before t-2
  comparator(t-1, t-3): aPin=0 bPin=0 → 0
                        aTime=05-07T09 bTime=05-06T15 → t-1 before t-3 (newer)

  Final order: [t-4 (pinned, 11:00), t-2 (pinned, 10:00), t-1 (un, 09:00), t-3 (un, 05-06)]
```

**Complexity:** O(n log n) time (Array.prototype.sort uses TimSort) · O(1) extra space (in-place).

---

## When brute force is fine

There's no slower version that's interesting. The constants are small (todos in the hundreds at most), TimSort handles partially-sorted lists in near-linear time, and the comparator is two cheap reads.

---

## In this codebase

- `app/todos.tsx` — the live `/todos` sort.
- `src/components/home/SmartTodoList.tsx` — the dashboard's identical sort. (Note: the in-source comment block in this component still references the old position-based logic — the actual sort body uses pinned + createdAt DESC like /todos.)
- `src/services/database.ts` — `updateTodoMeta(row.id, { pinned: !row.meta.pinned })` for the toggle.

---

## Elaborate

### Where this pattern comes from
"Sticky" or "starred" items above the chronological feed is the dominant pattern in messaging apps (pinned chats), email (starred messages), and to-do apps (Things, OmniFocus). The bool+recency two-tier captures the same UX without a third "priority" dimension.

### The deeper principle
**Two cheap dimensions beat one expensive one.** Asking "is this important AND when was it created?" is two O(1) reads. Asking "what is the rank of this item?" requires a global ordering, which is O(n) to maintain on insert.

### Where this breaks down
- Users who genuinely need a third tier ("most important pinned, then other pinned, then recency"). Today there's no expression for that.
- Cases where `createdAt` is unreliable (clock skew, imported data). The sort would jumble.

### What to explore next
- [04-ranked-todo-sort](./04-ranked-todo-sort.md) → the legacy `rankTodos` it replaced.
- [01-system-design/16-pin-replaces-reorder](../01-system-design/16-pin-replaces-reorder.md) → why the swap happened.

---

## Tradeoffs

- **Boolean pin** — gives: trivial mental model, instant toggle. Costs: no ordering within the pinned group beyond recency.
- **createdAt DESC tiebreak** — gives: new captures bubble up automatically. Costs: an old-pinned item gets pushed down by any newer pinned item.
- **Two-key comparator** — gives: O(n log n) one-pass sort. Costs: nothing meaningful.
