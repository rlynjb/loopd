# Ranked todo flatten + sort (legacy `rankTodos`)

**Industry name(s):** Multi-key comparator sort, ranked sort
**Type:** Industry standard · Language-agnostic

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

── Brute force ──────────────────────────────────

Pseudocode (selection-sort / repeated min-finding):

```
  flat = []
  for each entry in entries:
    for each todo in entry.todos:
      if todo.done AND (now - completedAt > keepDoneMs): continue
      flat.push({ ...todo, source })

  // Repeated min-finding (selection sort):
  result = []
  while flat is not empty:
    bestIdx = 0
    for i in 1..flat.length:
      if comparator(flat[i], flat[bestIdx]) < 0:
        bestIdx = i
    result.push(flat.splice(bestIdx, 1)[0])
  return result
```

Execution trace (4 input todos, after flatten + filter → `[t-1 carried, t-3 journal, t-4 journal]`):

```
  Iter 1: scan 3 candidates, find best (carried beats journal) → t-1
          result = [t-1]; remaining = [t-3, t-4]
          comparisons: 2
  Iter 2: scan 2 candidates, compare priority equal, createdAt 10:00 < 10:05 → t-3
          result = [t-1, t-3]; remaining = [t-4]
          comparisons: 1
  Iter 3: 1 candidate → t-4
          result = [t-1, t-3, t-4]
          comparisons: 0
  Total comparator calls: 3 (for n=3)
  At n=300: ~45,000 comparator calls
```

Complexity: O(n²) time · O(n) space.

What goes wrong at scale: at n = 300 (a heavy multi-day todo list), brute force runs ~45,000 comparator calls vs optimal's ~2,400. Both finish in <10ms in JS so the user never notices. The real cost is invisibility — selection-sort hides the n² behavior inside a `while` loop without making it obvious. With 10,000 items the gap widens to 50M vs 130k ops, ~0.5s vs <50ms.

── Optimal ──────────────────────────────────────

The insight: a single `flat.sort(comparator)` lets the engine's TimSort do n log n work, and a fall-through comparator composes the three sort keys without nested passes.

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

**Why this is optimal:** the alternative (group → sort within groups → concat) is also O(n log n) but allocates more arrays. Compose-into-one-comparator is the cleanest.

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n²)          │ O(n log n)       │
  │ Space           │ O(n)           │ O(n)             │
  │ At 1,000 items  │ 500,000 ops    │ ~10,000 ops      │
  │ At 10,000 items │ 50,000,000 ops │ ~130,000 ops     │
  │ Readable?       │ yes (verbose)  │ yes (concise)    │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: at todo-list scale (a few hundred max), even O(n²) is sub-millisecond. The reason to prefer `Array.prototype.sort` isn't speed — it's that TimSort is already in the runtime, handles partially-sorted lists in near-linear time, and the comparator stays explicit about the policy.

---

## In this codebase

**File (legacy):** `src/services/todos/rank.ts`
**Function / class:** `rankTodos()` (with helper `effectiveCreatedAt()`)
**Line range:** L24–L73 (helper `effectiveCreatedAt` at L17–L23)

**Status:** dormant — defined and exported, but no app code currently calls it. Verify with `grep -r "rankTodos" src/ app/`.

**Live consumption from the same file:** `formatRelativeTime()` L74–L86 — imported by `app/todos.tsx` and `src/components/home/SmartTodoList.tsx`. That import is the only reason `rank.ts` is still in the bundle.

The actual sort used by `/todos` and the dashboard is documented in [11-pinned-first-sort](./11-pinned-first-sort.md).

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

## Interview defense

### What an interviewer is really asking
The probe here is dead-code honesty. `rankTodos` is exported, fully implemented, with three sort tiers and a `keepDoneMs` filter — and nothing in the app calls it. A weak answer is "I forgot to delete it." A strong answer says: I shipped the replacement before I deleted the original because I wasn't sure the replacement was right, and the cleanup is debt I haven't paid down. The interviewer is checking if I treat dead code as a code-smell I track or as ambient noise I ignore.

### Likely questions

[mid] Q: Walk me through what `priority = { carried: 0, ai: 1, journal: 2 }` is doing inside the comparator.
      A: It's a fall-through tiebreaker. After the `done` flag puts completed todos at the bottom, the next discriminator is "where did this todo come from?" — carried over from a previous day (highest urgency), AI-generated from an expand call, or written today directly. The lower number wins, so `carried` floats to the top of the open todos. If two todos share the same source tier, the comparator falls through to `createdAt` ascending, oldest first. Three keys, fall-through, single stable sort — the canonical multi-key pattern.

[senior] Q: Why was this replaced by pinned-first if both are O(n log n)?
         A: Performance wasn't the reason. The product question changed. `rankTodos` baked in an opinionated ordering — carried > AI > journal — that made sense when I thought users wanted "what should I do next" surfaced automatically. After using the app for a few weeks I realized I wanted explicit control: pin what matters, recency for everything else. Pinned-first is dumber and the user does more work, but it's predictable. The comparator complexity is roughly the same; the design philosophy is opposite.

[arch] Q: If you brought back AI-prioritized todos, would you reuse `rankTodos` or write something new?
       A: I'd reuse the comparator skeleton — fall-through compare is the right shape — but I'd unify it with pinned-first instead of replacing it. The new comparator would be: pinned DESC, then `source` priority (carried > AI > journal), then createdAt DESC. That's a 3-tier compose, structurally identical to what `rankTodos` already does. I'd also lift `keepDoneMs` out of flatten into a query-layer filter so it's configurable per screen instead of hardcoded.

### The question candidates always dodge
Q: Why is this still in the repo if nothing calls it?

A: Because I shipped the pinned-first sort as the live ordering on 2026-05-05 and didn't delete `rankTodos` because I wasn't sure I wouldn't want it for an "unranked-by-default" view I had in mind. If I'm being honest, that's a rationalization — I haven't built the unranked view, I haven't even speced it, and the function has been dead since the day I wrote the replacement. It's debt. The right move is to delete it now and pull it back from git history if I ever want it. The reason I haven't is that the file also exports `formatRelativeTime`, which IS consumed by `app/todos.tsx` and `SmartTodoList.tsx`, so the cleanup is "extract the formatter, then delete the rest of the file" — three steps instead of one, and I keep deferring it. Good catch on a real interview question; I should fix this before the next time someone reads the codebase cold.

### One-line anchors
- "Three keys, fall-through compare — canonical multi-key sort."
- "Replaced for product reasons, not performance."
- "It's dead code. The cleanup is `formatRelativeTime` extraction plus a delete."
- "If AI-priority comes back, I'd compose with pinned-first, not revive `rankTodos`."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain ranked-todo-sort (legacy) to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/rank.ts:rankTodos` (and that it's currently dormant)
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

Imagine you re-enable `rankTodos` and ship it tomorrow as the live sort on `/todos` (replacing pinned-first). What's the first user-visible regression you'd see, given that users have been pinning items for two weeks under the current model? Reference the three sort tiers (`carried`, `ai`, `journal`) and explain what would happen to a freshly pinned todo from yesterday.

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/rank.ts` L24–L73 and check whether your answer matches what the comparator actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/rank.ts` to support what exists
→ Point to `src/services/todos/rank.ts:formatRelativeTime` (the only live export — the cleanup is "extract this helper, then delete the rest of the file") if you chose the alternative

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
