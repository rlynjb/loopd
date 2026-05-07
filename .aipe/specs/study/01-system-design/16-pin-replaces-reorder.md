# Pin replaces manual reorder

> The /todos page swapped a user-managed integer `position` column for a single boolean `pinned`. The `position` column is kept on the schema (deprecated) but no UI reads it.

**See also:** → [02-dsa/04-ranked-todo-sort](../02-dsa/04-ranked-todo-sort.md) · → [02-dsa/11-pinned-first-sort](../02-dsa/11-pinned-first-sort.md) · → [13-append-only-migrations](./13-append-only-migrations.md)

---

## Quick summary
- **What:** as of 2026-05-05, `/todos` and the dashboard sort by `pinned` first (boolean), then `createdAt DESC`. The previous manual-reorder UI (drag handles, `position INT NOT NULL`) is gone.
- **Why here:** in practice users pinned a handful of items and ignored the rest of the order. A single bool captures the same intent without the UI complexity.
- **Tradeoff:** a user who actually wanted "thing A before thing B before thing C" can't express that anymore. Acceptable; nobody used it that way.

---

## Pin vs reorder — diagram

```
  Before (deprecated, ~through 2026-05-04):
  ─────────────────────────────────────────
  todo_meta:
    position INT NULL          ← user drag-reorders set it
    stage    TEXT 'todo'/'next'/'done'  ← surfaced in /todos filters

  Sort:
    NULL position rows by createdAt DESC, then positioned rows by position ASC

  UI:
    drag handles, manual reorder, three-stage filter

  After (2026-05-05+):
  ────────────────────
  todo_meta:
    position INT NULL          ← deprecated; kept for cloud-sync round-trip
    stage    TEXT 'todo'       ← still on schema, no UI surface
    pinned   BOOLEAN           ← NEW (migration 0005)

  Sort:
    pinned rows first, then everything by createdAt DESC

  UI:
    pin icon (toggle), no drag, no stage filter, swipe-to-delete added
```

---

## How it works

The `pinned` column landed via migration `0005_todo_meta_pinned.sql` and a corresponding local schema bump. The /todos page reads `meta.pinned` per row and sorts:

```
  pinned: true rows first
  same-pin: createdAt DESC (newest at top)
```

The dashboard's `SmartTodoList` matches this exactly. New captures land at the top because they're newest by `createdAt`. Pin acts as a sticky modifier on top of recency.

The `position` column stays on the schema because dropping it would require a destructive Postgres migration and the cloud round-trip still includes it (it's just always `null` on writes now). The `stage` column is in the same boat — kept on the schema with a single-value default, no UI surface.

The same commit that introduced `pinned` removed the drag-reorder gestures and the three-stage status filter, and added the `Swipeable` wrapper for swipe-to-delete on each todo row.

---

## In this codebase

- `supabase/migrations/0005_todo_meta_pinned.sql` — adds `pinned`.
- `src/types/todoMeta.ts` — declares `pinned: boolean`, `position: number | null` (marked deprecated 2026-05-05), `stage: TodoStage`.
- `app/todos.tsx` — sort: `pinned` first, then `createdAt DESC` (lines ~184-194). Swipe-to-delete via `react-native-gesture-handler`'s `Swipeable`.
- `src/components/home/SmartTodoList.tsx` — same sort.
- Pin toggle: `updateTodoMeta(row.id, { pinned: !row.meta.pinned })`.

---

## Elaborate

### Where this pattern comes from
The shift from "user manages an order" to "user marks priority" is older than software — the in-tray vs the "VIP" stamp is the same insight. Most modern todo apps default to recency-or-priority sorts because manual order is a maintenance burden the user almost always abandons.

### The deeper principle
**Match the data model to what users actually do, not what they say they want.** A drag-reorder UI feels powerful but the usage pattern was "a few sticky items." A boolean captures the actual intent in one bit instead of an integer per row. Removing affordance is often the right move.

### Where this breaks down
- Power users who genuinely curate a multi-item order. They lose expressiveness.
- Cases where pin-without-recency is needed (an old item you want at top forever, but newer pinned items keep displacing it). Today there's no priority-among-pinned tier.

### What to explore next
- [02-dsa/04-ranked-todo-sort](../02-dsa/04-ranked-todo-sort.md) → the legacy `rankTodos` function (still in the repo, currently unused).
- [02-dsa/11-pinned-first-sort](../02-dsa/11-pinned-first-sort.md) → the live sort algorithm.
- [13-append-only-migrations](./13-append-only-migrations.md) → why `position` and `stage` couldn't just be dropped.

---

## Tradeoffs

- **Boolean replaces int** — gives: trivial mental model, one less drag UI to maintain. Costs: can't express "A before B before C."
- **Deprecated columns kept** — gives: no destructive schema change. Costs: schema noise; future readers must know which columns are live.
- **Recency tiebreak** — gives: new captures bubble naturally. Costs: an old pinned item is below a newer pinned item — no way to override.
