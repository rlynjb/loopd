# Daily-schedule grid cell state — pure decision tree, O(1) per cell

**Industry name(s):** Decision tree, finite state classification
**Type:** Industry standard · Language-agnostic

> Map (habit, date, today, checkedDates) → one of 5 states (`done | off-day | pending | upcoming | missed`). Pure, no DB.

**See also:** → [06-thread-cards-aggregate](./06-thread-cards-aggregate.md)

---

## Why care

You've watched a calendar grid flicker on every render because each cell did its own database lookup to figure out what colour it should be. The right shape is the inverse: gather the data your view needs once, hand the gathered structure down to the cell renderer, and let each cell compute its own state in pure code with zero I/O. The decision becomes a function of its inputs and nothing else — no awaits, no `useState`, no race conditions. The cell can re-render a thousand times per second and the cost stays flat.

This is a pure decision function — sometimes called a finite-state classifier or a lookup table when the input space is small enough to enumerate. It's the same pattern as CSS rule resolution (compute the matched class from element state, do not query anything), the same pattern as React's `useMemo` selectors, the same pattern as Redux derived state. The family is "split the expensive side (gathering) from the cheap side (deciding) so the cheap side can run hot without dragging the expensive side along." The handoff is that the parent owns the gather, the child owns the decide, and the contract between them is a plain data structure. Here's how this codebase applies that pattern.

---

## How it works

A traffic light. Green if it's allowed to go, red if it's not, yellow if it's about to change. The light doesn't query the road network on every cycle — it just looks at its internal counter and decides. The cell state is the same shape: given (habit cadence, this date, today, the set of dates the habit was checked), pick one of five labels. No DB call, no `await`, no state hook — the decision is a closed-form function of its arguments, evaluated thousands of times per render with zero I/O cost. If you're coming from frontend, this is exactly the pattern you reach for when a `useMemo` selector starts feeling expensive — gather the inputs once at the top, decide per-item in pure code, never let the leaf component own data fetching.

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

── Brute force ──────────────────────────────────

Pseudocode (compute every branch with no early-out):

```
  function cellStateForBrute(habit, dateStr, todayStr, checkedDates):
    // Evaluate every predicate up-front, no short-circuit
    isChecked   = checkedDates has dateStr
    date        = parse(dateStr + 'T12:00:00')
    isDue       = isDueOn(habit, date)
    isToday     = dateStr == todayStr
    isFuture    = dateStr  > todayStr
    isPast      = dateStr  < todayStr

    // Then walk a flat list to pick the matching state
    if isChecked:                       return 'done'
    if not isDue:                       return 'off-day'
    if isToday:                         return 'pending'
    if isFuture:                        return 'upcoming'
    if isPast and isDue and !isChecked: return 'missed'
    return 'pending'  // unreachable
```

Execution trace (specific_days = M/W/F → days [1,3,5]; today Thu day=4; checkedDates = {05-05, 05-06}):

```
  Tue 05-05  isChecked=true   isDue=false  isToday=false  isFuture=false
             walk: isChecked  → 'done'   (4 predicates evaluated; one branch wins)
  Thu 05-07  isChecked=false  isDue=false  isToday=true   isFuture=false
             walk: not checked, not due → 'off-day'  (4 predicates still evaluated)
  Mon 05-04  isChecked=false  isDue=true   isToday=false  isFuture=false  isPast=true
             walk: not checked, due, not today, not future, past+due+uncheck'd → 'missed'
```

Complexity: O(1) per cell (still constant, but every predicate runs every time) · O(1) space.

What goes wrong at scale: O(1) doesn't get worse, but the constant grows — every predicate runs, including the `parse(dateStr)` Date allocation and `isDueOn` switch. At 7 days × 100 habits = 700 cells per render, brute does ~3,500 predicate evaluations vs optimal's ~700 short-circuited. On a 60Hz UI, the render-budget-per-frame difference is measurable on low-end Android. The bigger trap: an impure brute-force version (DB read per cell) would turn O(1) into O(network), and that's the actual mistake to avoid.

── Optimal ──────────────────────────────────────

The insight: order the branches by frequency-and-evidence-priority so the cheapest dominant case (`done` check via O(1) Set) short-circuits before parsing the date.

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

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(1) (5 preds) │ O(1) (1-5 preds) │
  │ Space           │ O(1)           │ O(1)             │
  │ At 1,000 cells  │ ~5,000 preds   │ ~1,500 preds     │
  │ At 10,000 cells │ ~50,000 preds  │ ~15,000 preds    │
  │ Readable?       │ yes            │ yes (priority)   │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: never matters for correctness — both return the same state. The optimal version's win is purely constant-factor + readability: the branch order encodes "check-in beats cadence beats time-of-week," which is a business rule worth making visible.

This is what people mean by "split gather from decide." The expensive side (build a `Set<string>` of checked dates once, hand a habit's cadence config down) runs once per render at the top; the cheap side (one decision per cell, O(1)) runs thousands of times in the inner loop. The pattern is everywhere — CSS rule resolution, React `useMemo`, Redux derived state, OS file system attribute caches. The boundary the architecture maintains is that leaf cells never own data fetching; they own decisions, and decisions are pure.

---

## Why pure matters here

The grid re-renders on every habit toggle, week change, and live-now tick. If `cellStateFor` were impure (DB read, async), the grid would flash and the user would see in-flight states. Keeping the function pure means React's reconciler only re-renders cells whose state actually changed.

The `checkedDatesByHabit: Map<string, Set<string>>` is built once per render at the parent and passed down. N habits with O(1) map lookup each means the entire grid renders in O(7N) — N habits times 7 days.

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

We traded data-prep responsibility at the parent for an O(1) pure per-cell decision the React reconciler can skip cheaply.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (pure + parent prep)│ Alternative (per-cell I/O)     │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Time complexity  │ O(1) per cell · O(7N) grid     │ O(N) per cell · O(7N²) grid    │
│                  │ after parent O(N) Map build    │ if each cell scans an array    │
│ Latency at 30    │ <1ms total grid (210 cells)    │ <1ms but with re-render flash  │
│ habits (real N)  │                                │ on every input touch           │
│ Latency at 10×N  │ ~3ms at 300 habits (2,100      │ ~30ms at 300 habits + DB stall │
│                  │ cells); 60fps fine             │ on each cell if impure         │
│ Code complexity  │ ~70 LOC for cellStateFor +     │ ~40 LOC for cell, but parent   │
│                  │ ~20 LOC for parent Map build   │ becomes the source of races    │
│ Cognitive load   │ reader must trace why parent   │ reader sees one place — and   │
│                  │ prep is what makes O(1) true   │ misses why the grid flashes    │
│ Failure mode     │ stale Map at parent → cells    │ async per-cell read → flash,   │
│                  │ render last-tick state for ~1m │ in-flight states visible       │
│ Extensibility    │ adding 6th state touches every │ adding 6th state touches one  │
│                  │ consumer of the union type     │ function, but introduces I/O   │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The parent (`DailyScheduleGrid.tsx`) carries the data-prep cost: it materialises `checkedDatesByHabit: Map<string, Set<string>>` once per render before any cell renders. That's ~20 LOC of setup the parent owns, and a contributor who modifies the parent has to know that breaking the Map shape silently degrades every cell from O(1) to O(N).

The decision tree is closed — adding a 6th state (`paused`, `snoozed`, anything) means changing the union type, every consumer that switches on it, and the order of branches in `cellStateFor` to keep evidence priority intact. We picked exhaustive over open and pay the migration cost every time the product asks for a new state.

Order-sensitivity is load-bearing — the branches encode "check-in beats cadence beats time-of-week" as code. A reader who reorders them to look prettier breaks the contract that an off-day check-in still renders as `done`. The comment density around the function exists to preserve that fact.

### What the alternative would have cost

If each cell called `getCheckIns(habit, date)` directly, the function shape would be ~40 LOC instead of ~70 — but it would either be an SQLite call (async, impure, bad in render) or a JS scan over a flat array (O(N) per cell, grid becomes O(7N²)). At 30 habits that's a 6,300-op cost vs the current 210; at 300 habits it's 630,000 vs 2,100. The 300× gap shows up as visible UI lag during scrubbing.

The hidden cost is React. An impure cell renders mid-await, then re-renders when the await resolves — every cell flashes its placeholder state before the real one. The user sees the grid bloom into existence twice per render cycle, and the reconciler can't bail out of the second render because the inputs technically changed.

### The breakpoint

Fine until habit count exceeds ~500 in a single user's account, at which point the parent's Map build (O(N)) starts to dominate the render and the grid stutters on the first paint. The fix isn't the algorithm — it's pagination at the parent (only render the visible week's habits), which the data shape already supports.

---

## Tech reference (industry pairing)

### React function component + props (pure render)

- **Codebase uses:** `src/components/home/DailyScheduleGrid.tsx` builds `checkedDatesByHabit: Map<string, Set<string>>` once via a `useMemo` and passes it down; the cell calls `cellStateFor(habit, dateStr, todayStr, checkedDates)` in pure code.
- **Why it's here:** the cell renders thousands of times per session; making the decision pure means React can short-circuit re-renders via referential-equal props.
- **Leading today:** React functional components + `useMemo` selectors — `adoption-leading` for derived-state rendering, 2026.
- **Why it leads:** pairs naturally with React's reconciler — pure props + memoised selectors skip unnecessary re-renders without manual `shouldComponentUpdate` discipline.
- **Runner-up:** Reselect / TanStack Query select — `innovation-leading` when selectors get composable across modules; here the decision is small enough that an inline pure function is clearer.

### TypeScript `Set<string>` for membership testing

- **Codebase uses:** `Set<string>` per habit containing checked-date strings, built once at the parent. O(1) `.has(dateStr)` check inside `cellStateFor`.
- **Why it's here:** the cell calls `checkedDates.has(dateStr)` 7×N times per render; making the lookup O(1) is what keeps the grid render flat.
- **Leading today:** native `Set` — `adoption-leading` for membership tests at this scale, 2026.
- **Why it leads:** runtime-builtin, O(1) average, zero dependency cost; reading `checkedDates.has(dateStr)` names the invariant.
- **Runner-up:** `Map<string, true>` — equivalent at this scale; functionally interchangeable.

---

## Summary

A pure decision function is the family of "split the expensive side (gathering) from the cheap side (deciding) so the cheap side can run hot without dragging the expensive side along" — the same shape as CSS rule resolution, React `useMemo` selectors, and Redux derived state. In this codebase `cellStateFor` and `cellStateForThread` in `src/components/home/cellState.ts` map `(habit, date, today, checkedDates)` to one of five states (`done | off-day | pending | upcoming | missed`) using a short-circuiting decision tree: check-in beats cadence beats time-of-week. The constraint is that the grid re-renders on every habit toggle, week change, and live-now tick — if the function were impure (DB read, async), the grid would flash and React's reconciler couldn't skip unchanged cells. The cost is that the parent (`DailyScheduleGrid.tsx`) has to materialise `checkedDatesByHabit: Map<string, Set<string>>` once per render and pass it down; that's the data prep that turns the per-cell call into O(1). Without the Map the algorithm collapses — each cell would scan an array per call and the grid would become O(7 × N²).

Key points to remember:
- O(1) per cell short-circuiting decision tree, called 7 × N times per render.
- The decision order encodes priority of evidence: `done` (check-in) wins over `off-day` (cadence) wins over time-of-week.
- The `Map<string, Set<string>>` built once at the parent is what makes the per-cell call O(1) — without it the complexity argument falls apart.
- Pure + O(1) means React's reconciler only repaints cells whose inputs actually changed.
- Adding a 6th state would mean changing every consumer; the tree is deterministic and exhaustive, but not open for extension cheaply.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand that "O(1) per cell" is a property of the render contract, not just the algorithm. `cellStateFor` could be O(1) and still wreck performance if it triggered a re-render storm. The win is that pure + O(1) means React's diffing only repaints cells whose inputs actually changed. The interviewer wants to hear that the data prep at the parent (`checkedDatesByHabit`) is what makes the per-cell call O(1) — without the Set, `cellStateFor` would have to scan an array per call and the complexity argument falls apart.

### Likely questions

[mid] Q: Why does the `done` check come before the `isDueOn` check in `cellStateFor`?
      A: Because the user can check in on a day the habit isn't normally due — say they're on a M/W/F cadence and they did the run on a Tuesday. The check-in is real data; the cadence is just the schedule. If `isDueOn` ran first, an off-day check-in would render as `off-day` and the user's done-state would be invisible. Order encodes priority of evidence: the user's recorded action always wins over the schedule's prediction.

```
[branch order in cellStateFor]

  cell (habit M/W/F, Tue, checkedDates={Tue})
        │
        ▼  branch 1
  checkedDates has "Tue"? YES → 'done'   ◀── stops here
        │
        ▼  branch 2 (skipped)
  isDueOn(habit, Tue)? would be false → 'off-day' (would hide the check-in)
        │
        ▼
  evidence priority preserved
```

[senior] Q: Why pass `checkedDatesByHabit` down as a Map instead of letting each cell call `getCheckIns(habit, date)`?
         A: Because `getCheckIns` would be either an SQLite call (impure, async, bad in render) or a JS scan over a flat array (O(N) per cell, so the grid becomes O(7×N²)). The Map is a one-time O(N) build at the parent that turns every cell lookup into O(1). The grid renders in O(7N) total. It's the classic decorate-once-query-many-times pattern; the Map is the index, the render is the query.

```
                  Path taken (parent Map)              Alternative (per-cell getCheckIns)
                  ────────────────────────             ──────────────────────────────────
build cost        1× O(N) Map build at parent          0 — but cells pay per call
per-cell lookup   O(1) Set.has                         O(N) array scan OR async DB read
grid total        O(7N) at 30 habits = 210 ops         O(7N²) at 30 habits = 6,300 ops
render purity     pure — reconciler can skip cells     impure — every cell may re-render
                                                       when async resolves
flash on touch    none                                 yes — placeholder, then real state
LOC               +20 at parent, -O(N) in each cell    -20 at parent, +scan/await in cell
```

[arch] Q: What if I had 1,000 habits — does the grid still render in 16ms?
       A: 7 × 1,000 = 7,000 cell renders. The state computation is O(1) so that's fine, but React's reconciliation overhead per cell is non-trivial — at 1,000 rows you'd want virtualization (`FlashList` or `RecyclerListView` in RN) to only render the visible window. The algorithm itself doesn't change; what changes is how much of the grid you render at once. The state function is decoupled from the rendering strategy, which is exactly why the purity matters.

```
[scale curve — what breaks first at 10× and 100× habit count]

  habits   cells   cellStateFor cost   React commit budget   breaks?
  ──────   ─────   ─────────────────   ───────────────────   ──────────────────
  30        210    <1ms                 16ms fine             no
  300     2,100    ~3ms                 16ms fine             no
  1,000   7,000    ~10ms                ◀ 16ms budget         reconciler stalls
                                                              first   ◀── BREAKS FIRST
  5,000  35,000    ~50ms                ◀◀ way over           need virtualization;
                                                              data model still fine
```

### The question candidates always dodge
Q: Your function depends on `todayStr` as a string from the parent. What happens at midnight when the date rolls over and the parent hasn't ticked yet?

A: The parent ticks on a 1-minute interval, so there's a window of up to 60 seconds where `todayStr` is yesterday. During that window, today's pending cells render as `missed` if they haven't been checked in, and tomorrow's upcoming cells render as `upcoming` until the tick fires. That's wrong on the technicality — yesterday's checked cells stay `done`, that's correct, but a pending habit on the new day might briefly flash as `missed` once midnight passes. The honest fix is to anchor the tick to a time-zone-aware "next midnight" timer instead of a fixed interval, so the grid recomputes exactly at the boundary. Right now the user sees a 1-minute lag at the day boundary, which has never been observable in practice because nobody is staring at the grid at 12:00:00. It's wrong and it's fine — the kind of bug I'd fix the moment it surfaced and not before.

```
                  Path taken (1-minute fixed tick)    Suggested (timezone "next midnight")
                  ──────────────────────────────────  ──────────────────────────────────
tick boundary     up to 60s lag at 00:00              ms-accurate at the day boundary
worst-case state  pending → flashes as missed for     no flash — boundary recompute is
                  ≤60s after midnight                 exact
observable        nobody is staring at 12:00:00       same — fix is unobservable in use
implementation    setInterval(60_000)                 setTimeout to next-midnight diff,
                                                       chained
DST / TZ change   silently wrong on the changeover    explicit re-compute on each
                  day                                  midnight, robust to DST
verdict           wrong-and-fine; fix when noticed    principled fix waiting for a user
                                                       report
```

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
Updated: 2026-05-10 — added v1.14.0 subtitle block + brute-force section + comparison table.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 + v1.23.0 pass: inserted `## Tech reference (industry pairing)` section between Tradeoffs and Summary with `###` per tech + five labelled bullets each.

---
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (traffic-light metaphor + frontend bridge to useMemo selectors) and Move 3 principle after the Comparison block.
