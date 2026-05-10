# Pinned-first sort — the live /todos and dashboard ordering

**Industry name(s):** Stable sort with pinned partition
**Type:** Language-agnostic

> Two-key compare: `pinned` first (true before false), then `createdAt DESC` (newest first). Replaces the legacy `rankTodos` / position-based sort.

**See also:** → [04-ranked-todo-sort](./04-ranked-todo-sort.md) · → [01-system-design/16-pin-replaces-reorder](../01-system-design/16-pin-replaces-reorder.md)

---

## Why care

You've used an email inbox where starred messages sit on top and everything else stays in time order underneath. You've used a chat app where pinned conversations float above the rolling list of recent threads. The user model is the same in both: pinning is a sticky modifier, recency is the default order, and the two compose without fighting each other. A list that doesn't separate "what's important" from "what's recent" forces the user to do one of those jobs in their head every time they scan it.

This is sort with priority partition — a two-key lexicographic comparator where the first key is a boolean (pinned vs not), the second key is a timestamp. It's the same shape as a priority queue with timestamps as the tiebreak, the same shape SQL expresses as `ORDER BY pinned DESC, created_at DESC`, the same shape every "favourite folders first" file manager uses. The family is "stable lexicographic sort" — the comparator returns on the first key that differs, ties fall through to the next key, and equal-on-all-keys rows preserve their input order thanks to stability. The pinned flag is just a 0-or-1 column dressed up as a feature. Here's how this codebase applies that pattern.

---

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

── Brute force ──────────────────────────────────

Pseudocode (O(n²) selection sort with two passes — find pinned, then find non-pinned by comparator):

```
  result = []
  remaining = rows.slice()

  // Pass 1: drain pinned in createdAt DESC order via selection
  while remaining has any pinned:
    best = null
    for r in remaining:
      if !r.meta.pinned: continue
      if best == null OR r.createdAt > best.createdAt: best = r
    result.push(best); remaining.remove(best)

  // Pass 2: drain non-pinned in createdAt DESC order via selection
  while remaining is not empty:
    best = null
    for r in remaining:
      if best == null OR r.createdAt > best.createdAt: best = r
    result.push(best); remaining.remove(best)

  return result
```

Execution trace (input: t-1 unpinned 09:00, t-2 pinned 10:00, t-3 unpinned 05-06, t-4 pinned 11:00):

```
  Pass 1 (pinned only):
    iter 1: scan 4, candidates [t-2, t-4], best = t-4 (11:00) → result=[t-4]
            comparisons: 4
    iter 2: scan 3, candidates [t-2], best = t-2 → result=[t-4, t-2]
            comparisons: 3
    iter 3: scan 2, no pinned → exit Pass 1

  Pass 2 (rest):
    iter 1: scan 2, best = t-1 (newer) → result=[t-4, t-2, t-1]
            comparisons: 2
    iter 2: scan 1, t-3 → result=[t-4, t-2, t-1, t-3]
            comparisons: 1

  Total: 10 comparisons for n=4. At n=300, ~45,000.
```

Complexity: O(n²) time · O(n) extra space (the `remaining` copy).

What goes wrong at scale: at n = 300 (a heavy todo list), brute force runs ~45,000 comparisons vs TimSort's ~2,400. Both finish in <10ms in JS so the user never feels it. The cost is invisibility — two nested `while` loops obscure the n² behavior. With 10,000 items the gap is 50M ops vs 130k, ~0.5s vs <50ms. At journaling scale (a few hundred max), brute force is fine; at the design level, it's a warning sign the moment someone considers "import 10k todos."

── Optimal ──────────────────────────────────────

The insight: a two-key comparator handed to `Array.prototype.sort` lets TimSort do one O(n log n) pass with stable ordering, and the comparator stays explicit about policy ("pin first, then recency").

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

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n²)          │ O(n log n)       │
  │ Space           │ O(n) copy      │ O(1) in-place    │
  │ At 1,000 items  │ 500,000 ops    │ ~10,000 ops      │
  │ At 10,000 items │ 50,000,000 ops │ ~130,000 ops     │
  │ Readable?       │ yes (verbose)  │ yes (concise)    │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: at the journaling scale of a few hundred todos, both are sub-millisecond. The reason to prefer `Array.prototype.sort` is that TimSort is already in the runtime and handles partially-sorted lists in near-linear time — the comparator stays the only piece of code I own.

---

## In this codebase

**File (live):**         `app/todos.tsx`
**Function / class:**    inline `out.sort((a, b) => …)` in the `/todos` screen render path
**Line range:**          L187–L194 — pinned first, then `createdAt DESC`

**Toggle write path:**   `src/services/database.ts` → `updateTodoMeta(row.id, { pinned: !row.meta.pinned })` is the only call site

> ⚠ **Content drift flagged 2026-05-07**: `src/components/home/SmartTodoList.tsx` L41–L67 still uses the **legacy position-based sort** (`metas?.get(a.id)?.position`), NOT the pinned-first comparator described in this file. The dashboard component has not yet been migrated to match `/todos`. The in-file comment at L37-L40 of `SmartTodoList.tsx` describes the old NULL-position-then-position-ASC behaviour, and the sort body matches that comment — both are stale relative to `/todos`. Fix is a one-comparator swap. Tracking site: this concept file + `01-system-design/16-pin-replaces-reorder.md` + `00-overview.md`'s SmartTodoList description.

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

---

## Quick summary

Stable lexicographic sort with a priority partition is the family of "two-key comparator where the first key is a boolean importance flag and the second key is a timestamp" — the same shape SQL expresses as `ORDER BY pinned DESC, created_at DESC`, the same shape email inboxes use for starred-then-recent, the same shape chat apps use for pinned-then-recent threads. In this codebase the comparator is inlined in `out.sort((a, b) => …)` at `app/todos.tsx` L187–L194 on the `/todos` screen: it compares `pinned` first (true before false), then `createdAt DESC` so newer rows surface within each group. The constraint is that pinning is a sticky modifier on top of recency, not a replacement for it — capturing actual product intent in the cheapest comparator. The cost is no expression for "pin this specific old item to the very top of the pinned group" — within the pinned partition, a newer pinned item always wins, and there's no third tier. The dashboard component `src/components/home/SmartTodoList.tsx` L41–L67 still runs the legacy position-based sort — a known content drift waiting on a one-comparator swap.

Key points to remember:
- Two-key comparator: boolean pin first, `createdAt DESC` tiebreak — `Array.prototype.sort` runs TimSort, O(n log n), in-place.
- The policy is explicit and trivially evolvable: changing pin to a 3-tier priority is a one-line edit on `aPin = a.meta.priority`.
- TimSort is already in the runtime and handles partially-sorted input in near-linear time — the comparator is the only code I own.
- No way for a user to override the recency tiebreak inside the pinned group — the third tier doesn't exist yet, and the legacy `position` column is the path if demand shows up.
- `SmartTodoList.tsx` still uses the legacy position-based sort — content drift flagged but not migrated.

---

## Interview defense

### What an interviewer is really asking
Sorting is the textbook DSA topic that interviewers reach for when they're checking basics. The interviewer wants to confirm you understand that the sort isn't the interesting part — the comparator is — and that you can name what the two keys give up versus a richer ranking model.

### Likely questions

[mid] Q: Walk me through the comparator on `(t-1: pinned=false, 09:00)` vs `(t-2: pinned=true, 10:00)`.

A: `aPin = 0`, `bPin = 1`. The first check is `if (aPin !== bPin) return bPin - aPin`, which evaluates to `1 - 0 = 1`. A positive return from a comparator means "a should come after b" in JavaScript's sort, so `t-2` ends up before `t-1` — pinned wins regardless of recency. If both rows had `pinned: true`, we'd skip the first branch and fall to `bTime - aTime`, which puts the newer one first.

[senior] Q: Why a two-key comparator with a boolean and a timestamp instead of a single numeric rank?

A: A single rank (e.g., `pinned ? 1e15 - createdAt : -createdAt`) would work and be slightly faster, but it's harder to read and trivially easy to break with a sign flip. The two-key version is explicit about what the policy *is*: pin first, then recency. If product asked tomorrow "make pin a three-tier priority instead of a boolean," I change `aPin = a.meta.pinned ? 1 : 0` to `aPin = a.meta.priority` and the rest of the comparator is untouched. The single-rank version would need a coordinate redesign. Comparator clarity beats one fewer comparison at this scale (n in the hundreds).

[arch] Q: What changes if a user has 100,000 todos?

A: TimSort is still O(n log n), so the sort itself is fine — about 1.7M comparisons at 100k. The comparator is two cheap reads (a boolean and a millisecond conversion), so the per-call cost is constant. Where it actually breaks is the rendering: 100k rows in a `FlatList` requires virtualization to be set up correctly, and the `Swipeable` wrapper per row has overhead I haven't measured at that scale. The sort is the cheapest part of the page render at 100k. That said, no journaling user is going to hit 100k — at one todo per day it's 270 years.

### The question candidates always dodge
Q: Your design has no way to express "pinned and at the top of the pinned group." What's the workaround a user has if they pin something old and want it above newer pins?

A: There isn't one. The user can't override the `createdAt DESC` tiebreak within the pinned group. The workaround that exists is "unpin the newer pinned items so the old one is alone at the top," which is obviously bad UX. The honest answer is I haven't built a third tier because the use case hasn't shown up — for a journal where pinned items are usually a handful of recurring concerns, the recency tiebreak inside pinned is fine. The day a user complains, the path is to either re-introduce a `priority` integer within pinned (which is the legacy `position` column repurposed) or add a "stick this to the very top" toggle that's a third boolean. Both are about a day of work; neither is shipped because the demand doesn't exist.

### One-line anchors
- "The sort is two-key — pinned first, then `createdAt DESC` — because that captures the actual product intent in the cheapest comparator."
- "TimSort handles partially-sorted lists in near-linear time; the constants are tiny at journaling scale."
- "Two-key comparator beats single-rank because the policy is explicit and trivially evolvable."
- "No third tier within pinned — when the demand for it shows up, the legacy `position` column is the path."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain pinned-first sort to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `app/todos.tsx` L187–L194 (and that `SmartTodoList.tsx` is on the legacy comparator)
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

Three todos: `t-1 = {createdAt 2026-05-07T09:00, pinned: true}`, `t-2 = {createdAt 2026-05-07T11:00, pinned: false}`, `t-3 = {createdAt 2026-05-07T10:00, pinned: true}`. The user opens `/todos`. What's the final order, and why is `t-3` above or below `t-1` despite both being pinned? Then: open the dashboard (which uses `SmartTodoList`). What order does the dashboard render the same three rows, given the content-drift note above?

Write your answer. 3–5 sentences minimum. Then open `app/todos.tsx` L187–L194 and check whether your answer for `/todos` matches; then open `src/components/home/SmartTodoList.tsx` L41–L67 and verify the dashboard divergence.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `app/todos.tsx` to support what exists
→ Point to `src/components/home/SmartTodoList.tsx` (the unmigrated dashboard sort) if you chose the alternative — the cleanup is already overdue

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
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0). Flagged content drift: `SmartTodoList.tsx` still uses position-based sort, not pinned-first.
Updated: 2026-05-10 — added v1.14.0 subtitle block + brute-force section + comparison table.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
