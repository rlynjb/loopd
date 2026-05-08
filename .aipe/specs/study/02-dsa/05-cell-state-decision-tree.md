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

**Algorithm:**       `src/components/home/cellState.ts` → `cellStateFor()` L30–L58 (habits) and `cellStateForThread()` L59–L67 (threads)
**Cadence engine:**  `src/services/habits/cadence.ts` → `isDueOn()` (consulted at L43-ish inside `cellStateFor` to short-circuit `off-day`)
**Consumer:**        `src/components/home/DailyScheduleGrid.tsx` — builds `checkedDatesByHabit: Map<string, Set<string>>` once per render and passes it down to each cell

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

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand that "O(1) per cell" is a property of the render contract, not just the algorithm. `cellStateFor` could be O(1) and still wreck performance if it triggered a re-render storm. The win is that pure + O(1) means React's diffing only repaints cells whose inputs actually changed. The interviewer wants to hear that the data prep at the parent (`checkedDatesByHabit`) is what makes the per-cell call O(1) — without the Set, `cellStateFor` would have to scan an array per call and the complexity argument falls apart.

### Likely questions

[mid] Q: Why does the `done` check come before the `isDueOn` check in `cellStateFor`?
      A: Because the user can check in on a day the habit isn't normally due — say they're on a M/W/F cadence and they did the run on a Tuesday. The check-in is real data; the cadence is just the schedule. If `isDueOn` ran first, an off-day check-in would render as `off-day` and the user's done-state would be invisible. Order encodes priority of evidence: the user's recorded action always wins over the schedule's prediction.

[senior] Q: Why pass `checkedDatesByHabit` down as a Map instead of letting each cell call `getCheckIns(habit, date)`?
         A: Because `getCheckIns` would be either an SQLite call (impure, async, bad in render) or a JS scan over a flat array (O(N) per cell, so the grid becomes O(7×N²)). The Map is a one-time O(N) build at the parent that turns every cell lookup into O(1). The grid renders in O(7N) total. It's the classic decorate-once-query-many-times pattern; the Map is the index, the render is the query.

[arch] Q: What if I had 1,000 habits — does the grid still render in 16ms?
       A: 7 × 1,000 = 7,000 cell renders. The state computation is O(1) so that's fine, but React's reconciliation overhead per cell is non-trivial — at 1,000 rows you'd want virtualization (`FlashList` or `RecyclerListView` in RN) to only render the visible window. The algorithm itself doesn't change; what changes is how much of the grid you render at once. The state function is decoupled from the rendering strategy, which is exactly why the purity matters.

### The question candidates always dodge
Q: Your function depends on `todayStr` as a string from the parent. What happens at midnight when the date rolls over and the parent hasn't ticked yet?

A: The parent ticks on a 1-minute interval, so there's a window of up to 60 seconds where `todayStr` is yesterday. During that window, today's pending cells render as `missed` if they haven't been checked in, and tomorrow's upcoming cells render as `upcoming` until the tick fires. That's wrong on the technicality — yesterday's checked cells stay `done`, that's correct, but a pending habit on the new day might briefly flash as `missed` once midnight passes. The honest fix is to anchor the tick to a time-zone-aware "next midnight" timer instead of a fixed interval, so the grid recomputes exactly at the boundary. Right now the user sees a 1-minute lag at the day boundary, which has never been observable in practice because nobody is staring at the grid at 12:00:00. It's wrong and it's fine — the kind of bug I'd fix the moment it surfaced and not before.

### One-line anchors
- "Pure + O(1) means React only repaints what changed."
- "The Map at the parent is what makes the per-cell call O(1) — without it the algorithm collapses."
- "Order in the decision tree encodes priority of evidence: check-in beats cadence."
- "Time-dependent purity needs an explicit tick; midnight is the edge case I'd fix when someone notices."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the cell state decision tree to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/components/home/cellState.ts:cellStateFor`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user has a habit with `cadenceType: 'specific_days'` and `cadenceDays: [1, 3, 5]` (Mon/Wed/Fri). Today is Thursday 2026-05-07. The user actually checked in on Thursday (so it's in `checkedDates`) but the habit doesn't have Thursday on its schedule. What state does `cellStateFor` return for the Thursday cell — `done`, `off-day`, or something else? And in what order do the checks fire to get there?

Write your answer. 3–5 sentences minimum. Then open `src/components/home/cellState.ts` L30–L58 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/components/home/cellState.ts` to support what exists
→ Point to `src/components/home/DailyScheduleGrid.tsx` (the parent that prepares `checkedDatesByHabit`) if you chose the alternative

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
