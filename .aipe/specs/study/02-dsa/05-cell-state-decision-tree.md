# Daily-schedule grid cell state — pure decision tree, O(1) per cell

> Map (habit, date, today, checkedDates) → one of 5 states (`done | off-day | pending | upcoming | missed`). Pure, no DB.

**See also:** → [06-thread-cards-aggregate](./06-thread-cards-aggregate.md)

---

## Quick summary
- **What:** `cellStateFor` (habits) and `cellStateForThread` (threads) compute one of 5 cell states for the weekly grid.
- **Why here:** the grid re-renders on every habit toggle, week change, and live-now tick. If `cellStateFor` were impure (DB read, async), the grid would flash.
- **Tradeoff:** the parent has to materialise `checkedDatesByHabit: Map<string, Set<string>>` once per render and pass it down. Worth it for O(1) lookups.

**Real operation:** `cellStateFor` and `cellStateForThread` in `src/components/home/cellState.ts`.

---

## The data

```
  habit: { id, cadenceType: 'specific_days', cadenceDays: [1,3,5], ... }
  dateStr = "2026-05-07"   (Thu, day=4)
  todayStr = "2026-05-07"
  checkedDates = Set<string> { "2026-05-05", "2026-05-06" }
```

**The problem:** map (habit, date, today, checkedDates) → one of 5 states. Must be cheap (called 7 × N times per render) and pure (no DB).

---

## Pseudocode

```
  function cellStateFor(habit, dateStr, todayStr, checkedDates):
    if checkedDates has dateStr:        return 'done'         // 1. check-in always wins
    date = parse(dateStr + 'T12:00:00')
    if not isDueOn(habit, date):        return 'off-day'      // 2. cadence excludes
    if dateStr == todayStr:             return 'pending'      // 3. today
    if dateStr  > todayStr:             return 'upcoming'     // 4. future
    return 'missed'                                           // 5. past + due + uncheck'd
```

**Execution trace** (specific_days = M/W/F → days 1, 3, 5; today is Thu day=4):

```
  Tue 05-05  date < today, day=2:
    checkedDates has "05-05"? YES        → 'done' ✓
  Wed 05-06  date < today, day=3:
    checkedDates has "05-06"? YES        → 'done' ✓
  Thu 05-07  today, day=4:
    checkedDates has "05-07"? NO
    isDueOn(habit, day=4)?                day=4 ∉ [1,3,5] → false → 'off-day'
  Fri 05-08  date > today, day=5:
    checkedDates has "05-08"? NO
    isDueOn(habit, day=5)?                day=5 ∈ [1,3,5] → true
    dateStr > todayStr                    → 'upcoming'
  Mon 05-04  date < today, day=1:
    checkedDates has "05-04"? NO
    isDueOn(habit, day=1)?                day=1 ∈ [1,3,5] → true
    dateStr < todayStr                    → 'missed'
```

**Complexity:** O(1) per cell · O(1) space (the `Set.has` is constant; `isDueOn` is a switch).

---

## Why pure matters here

The grid re-renders on every habit toggle, week change, and live-now tick. If `cellStateFor` were impure (DB read, async), the grid would flash and the user would see in-flight states. Keeping the function pure means React's reconciler only re-renders cells whose state actually changed.

The `checkedDatesByHabit: Map<string, Set<string>>` is built once per render at the parent and passed down. N habits with O(1) map lookup each means the entire grid renders in O(7N) — N habits times 7 days.

---

## When brute force is fine

There's no brute version here — the function is already O(1). The "alternative" would be making it impure (e.g., querying SQLite per cell), which would be both slower and incorrect (renders racing the DB).

---

## In this codebase

- `src/components/home/cellState.ts` → `cellStateFor()` and `cellStateForThread()`.
- `src/services/habits/cadence.ts` → `isDueOn()`, the cadence engine.
- `src/components/home/DailyScheduleGrid.tsx` → consumer; builds `checkedDatesByHabit` once.

---

## Elaborate

### Where this pattern comes from
Pure render functions are fundamental to React (and to spreadsheet recalc engines, and to functional reactive programming generally). The "compute derived state inside the render path, not in effects" pattern is one of React's core advantages over imperative UI frameworks.

### The deeper principle
**Pure functions in the render path turn rendering into recalculation.** A cell that depends on `(habit, date, today, checkedDates)` will only re-render when one of those inputs changes. Impure functions break this contract.

### Where this breaks down
- States that genuinely require I/O. Loopd's solution is to materialise the I/O result at the parent (the `checkedDatesByHabit` map) and pass it down as data.
- States that depend on time. The grid passes `todayStr` from a parent that ticks on a 1-minute interval — explicit, controllable.

### What to explore next
- React's reconciler keying → why cells re-render only on input change.
- [06-thread-cards-aggregate](./06-thread-cards-aggregate.md) → the parent's data prep before render.

---

## Tradeoffs

- **Pure function** — gives: O(1) per cell, no flash, easy to test. Costs: parent must prep all inputs.
- **Decision tree (5 states)** — gives: deterministic, exhaustive. Costs: adding a 6th state means changing every consumer.
- **Order-sensitive checks** — gives: `done` always wins; `off-day` beats `missed`. Costs: the order encodes business rules; readers must follow it.
