# Ranked todo flatten + sort (legacy `rankTodos`)

**Industry name(s):** Multi-key comparator sort, ranked sort
**Type:** Industry standard · Language-agnostic

> Array flatten across entries, then 3-key compare (done last, source priority, createdAt asc). **The `rankTodos` function is currently in the repo but no app code calls it** — kept here as it's a real algorithm worth understanding.

**See also:** → [11-pinned-first-sort](./11-pinned-first-sort.md) · → [01-system-design/16-pin-replaces-reorder](../01-system-design/16-pin-replaces-reorder.md)

---

## Why care

Open a Postgres terminal and run `SELECT * FROM issues ORDER BY priority DESC, due_date ASC, created_at ASC`. Postgres doesn't sort three times — it runs a single pass where each pair of rows pays for at most one comparison per key. The first comparator that returns non-zero is the answer; the rest don't matter for that pair. Python's `sorted(items, key=lambda x: (a, b, c))` does the same with a tuple-key. Every spreadsheet's multi-column sort dialog does it too. One pass, multiple keys, lexicographic order.

That is the question this operation answers when an app has to display a flat list of items with a layered ranking rule: how do you express "sort by A, then B, then C" without writing three chained sorts? Not a triple-pass over the array, not a hand-rolled selection sort — just a *single multi-key comparator* with fall-through, the same shape as SQL `ORDER BY a, b, c` and Python's `sorted(items, key=lambda x: (a, b, c))`.

**What depends on getting this right:** the predictability of any flat ranked list the app surfaces. In this codebase `rankTodos` was the layered policy for `/todos` — `done` last, source tier (`carried` > `ai` > `journal`) second, `createdAt` ascending third. The comparator IS the policy: each clause encodes one product decision (don't let yesterday's unfinished todos drown under today's new ones), and the order of clauses encodes their priority. If the clauses are written as three separate `.sort()` calls instead of one fall-through comparator, every product change (add a new tier, flip an axis) becomes a multi-pass shuffle rather than a one-line edit, and stability across renders becomes a thing the developer has to keep in their head. Note that `rankTodos` is currently dormant — `app/todos.tsx` uses pinned-first sort now — but the live `formatRelativeTime` export from `src/services/todos/rank.ts` keeps the file in the bundle.

Without one comparator (chained `.sort()` calls):
- Pass 1: sort by `createdAt` ascending
- Pass 2: stable-sort by source tier
- Pass 3: stable-sort by `done`
- Adding a 4th tier (e.g. classifier confidence) means another sort pass and another stability worry
- Reading the file means following three separate sorts to understand the policy

With one comparator:
- `flat.sort((a, b) => doneCheck(a, b) || tierCheck(a, b) || createdAtCheck(a, b))`
- The comparator reads top-to-bottom as a policy list
- Adding a tier is one extra fall-through line
- TimSort is stable by ES2019 spec — equal items keep input order without effort

Compare on the most significant key, fall through to the next when it's a tie.

---

## How it works

A dictionary sorts words by their first letter; for words that share a first letter, by their second; and so on. The comparator's job is exactly that: walk the keys in priority order, and the moment two items disagree on a key, that's the answer — no need to look at the remaining keys. If you're coming from frontend, this is the same shape as a tuple-comparison in a `useMemo` selector, or what `Array.prototype.sort((a, b) => a.priority - b.priority || a.timestamp - b.timestamp)` does in two lines. Three keys, ordered by importance, evaluated lazily — fast because each row pays for at most one comparison per key, and clear because the rule reads top-to-bottom.

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

This is what people mean by "lexicographic ordering" — compare on the most significant key, only break the tie when it's actually a tie. The pattern shows up in SQL's `ORDER BY a, b, c`, in Python's `key=lambda x: (a, b, c)`, in every spreadsheet's "sort by primary then secondary" dialog. The reason it generalises is that any ranking that humans understand is multi-key by nature — most-important attribute first, fall-through for ties. The codebase's current sort isn't `rankTodos`; pin-replaces-reorder ([01-system-design/16](../01-system-design/16-pin-replaces-reorder.md)) reduced it to two keys. But the pattern stays callable for the day a richer order rule becomes load-bearing.

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

## Tradeoffs

We traded a long fall-through comparator and a parameter threaded through the flatten step for a single stable O(n log n) sort with an opinionated surface order that the user can't override.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (multi-key compare) │ Alternative (group-sort-concat)│
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Time complexity  │ O(n log n) — one TimSort pass  │ O(n log n) — bucket then sort  │
│                  │                                │ each group, then concat        │
│ Latency at N=50  │ <1ms — sub-millisecond         │ <1ms — same order of magnitude │
│ (real per-user)  │                                │                                │
│ Latency at 10×N  │ ~3ms at 500 todos              │ ~5ms — extra array allocations │
│ Code complexity  │ ~50 LOC: comparator + filter   │ ~75 LOC: bucket map + 3 sorts  │
│                  │ + flatten loop                 │ + concat                       │
│ Cognitive load   │ reader sees one comparator,    │ reader follows three groups    │
│                  │ three fall-through clauses     │ through three sort calls       │
│ Extensibility    │ adding a 4th key is one extra  │ adding a 4th key means a new   │
│                  │ if-then-return line            │ bucket dimension or pre-sort   │
│ Configurability  │ `keepDoneMs` baked into flatten │ filter is a separate pass that │
│                  │ — not per-screen tunable       │ can be parameterised per call  │
│ User control     │ opinionated order ; user has   │ same opinion ; same lack of    │
│                  │ no pin/unpin lever             │ override                       │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The comparator is ~12 lines of fall-through logic — `done` first, `priority[source]` second, `createdAt` last. Each clause is a separate `if (a.x !== b.x) return ...` line; the engineering price is a comparator that reads top-to-bottom as a policy list, but the LOC count grows with every new key. A fourth tiebreak (say, classifier confidence) would add another four-line clause.

`keepDoneMs` lives inside the flatten loop. Threading a per-screen variant through (e.g. `/todos` wants 24h, the dashboard widget wants 5 minutes) requires either a parameter on `rankTodos` or a separate call site that re-filters the output. We baked the filter into the flatten pass because the function had one consumer, and that decision is now a small cost the (dead) function pays.

The three source tiers (`carried` > `ai` > `journal`) require derivable metadata: `entry.date < today` for carried, `meta.source === 'ai'` for AI-generated, otherwise journal. The classifier flow has to populate `source` on the meta row at insert time, or the comparator falls through to `journal` and the tier collapses. That's coupling between the classifier and the sort that wasn't obvious until I tried to disable the classifier.

The function is currently dead code. Only `formatRelativeTime` from the same file is imported by `app/todos.tsx` and `SmartTodoList.tsx`. The cleanup-debt is real: extract the formatter into its own file, then delete `rank.ts` — three steps I keep deferring.

### What the alternative would have cost

Group-sort-concat would split the flat array into three buckets by source, sort each bucket by `(done, createdAt)`, then concatenate `[...carried, ...ai, ...journal]`. The asymptote is the same O(n log n). The visible costs are ~25 extra LOC, three extra array allocations per call, and an explicit bucketing step that loses the "comparator IS the policy" readability. Adding a fourth tier would mean a new bucket dimension or a pre-sort — not just a new fall-through line.

The Schwartzian transform (decorate-sort-undecorate) would help if any sort key required expensive derivation — for example, parsing `createdAt` strings to Date objects on every comparator call. We chose not to decorate because `parseISO` is cheap and the array stays small. At 10× N the comparator runs ~5,000 times and `parseISO` cost matters; we'd reach for decoration there, not now.

A separate sort-by-pin layer (the live `/todos` ordering) is what replaced this in production. The cost of the rewrite was ~80 LOC; the rationale was product, not perf — pinned-first is dumber and the user does more work, but it's predictable. `rankTodos` opinionates; pinned-first defers to the user.

### The breakpoint

Fine until the source-tier policy stops matching user intent. The actual breakpoint wasn't algorithmic — it was that users wanted explicit pin control, not algorithmic prioritisation. The function survives any reasonable N (sub-millisecond at 500 todos), but it was replaced when the product question changed from "what should you do next" to "what did you tell me matters." The algorithm is fine; the policy it encodes is wrong for the current product.

### What wasn't actually a tradeoff

Using `Array.prototype.sort` instead of writing a manual merge-sort wasn't a tradeoff — TimSort is in the runtime, handles partially-sorted input in near-linear time, and is stable by spec since ES2019. Writing a custom sort would have been work for negative value.

---

## Tech reference (industry pairing)

### JavaScript `Array.prototype.sort` (TimSort under the hood)

- **Codebase uses:** built-in `Array.prototype.sort()` with an inline 3-key comparator inside `src/services/todos/rank.ts → rankTodos()`. No external sort library.
- **Why it's here:** the comparator IS the policy; using the runtime sort with a typed comparator means the algorithm and the rule are next to each other and the implementation is one line.
- **Leading today:** native `Array.prototype.sort` — `adoption-leading` for in-memory sort in JS/TS, 2026.
- **Why it leads:** TimSort is the V8/JSC default — O(n log n) worst case, near-O(n) on partially-sorted input, stable by ES2019 spec. Zero dependency cost.
- **Runner-up:** `lodash.orderBy` — `adoption-leading` for multi-direction sorts when the comparator would otherwise need `(a, b) => a.x - b.x || b.y - a.y` mixing.

### Dormant code as architectural memory

- **Codebase uses:** `rankTodos` itself — kept in `src/services/todos/rank.ts` even though no UI call site reaches it as of 2026-05-05 (pin-replaces-reorder removed the only caller).
- **Why it's here:** the 3-key comparator is the recovery path if a user signals "I want manual order back." Wiring a `rankTodos`-backed setting is ~50 LOC; deleting the function would force re-deriving the rule from scratch.
- **Leading today:** "preserve dormant escape hatches" — `adoption-leading` discipline in small codebases that have made subtractive design moves, 2026.
- **Why it leads:** dormant code costs nothing at runtime (tree-shaken or never imported) and serves as an executable spec of the prior design. Deleting it would force re-discovery.
- **Runner-up:** "delete and recover from git" — `adoption-leading` purist alternative; the right move once the dormant code has rotted past the point where it would compile cleanly.

---

## Summary

Multi-key comparator sort is the canonical pattern for stable lexicographic ordering — the same shape as SQL `ORDER BY a, b, c`, the same shape as a Python tuple-key in `sorted(...)`, the same shape every spreadsheet uses for multi-column sort dialogs. In this codebase `rankTodos` in `src/services/todos/rank.ts` flattens todos across all entries, drops completed-too-long-ago rows, then runs a single `Array.prototype.sort` with a fall-through comparator over three keys: done flag (bottom), source priority (carried > AI > journal), and createdAt ascending. The constraint that made this the right call was an opinionated "what should I do next" surface order — carried-from-yesterday floats above AI-generated, which floats above today's freshly written. The cost is that the function is now legacy: pinned-first sort replaced it in the live UI on 2026-05-05 for product reasons (explicit user control beat automatic prioritization), and only `formatRelativeTime` from this file is still imported. Compose-into-one-comparator is broadly applicable beyond this codebase, which is why the concept is worth keeping even though the function is dormant.

Key points to remember:
- One stable sort over flattened-then-filtered todos, with a comparator that returns the first non-zero comparison across `(done, source priority, createdAt)`.
- Sort priority is a sequence of fall-through comparisons — each key gets one chance to decide, then falls through if equal.
- Status is legacy: dormant in the repo. `rankTodos` is exported but unreferenced; `formatRelativeTime` is the only live export from this file.
- O(n log n) time (TimSort) vs the brute-force selection-sort's O(n²) — at todo-list scale both are sub-millisecond, but the comparator stays explicit about the policy.
- Replaced for product reasons, not performance — pinned-first is dumber and the user does more work, but it's predictable.

---

## Interview defense

### What an interviewer is really asking
The probe here is dead-code honesty. `rankTodos` is exported, fully implemented, with three sort tiers and a `keepDoneMs` filter — and nothing in the app calls it. A weak answer is "I forgot to delete it." A strong answer says: I shipped the replacement before I deleted the original because I wasn't sure the replacement was right, and the cleanup is debt I haven't paid down. The interviewer is checking if I treat dead code as a code-smell I track or as ambient noise I ignore.

### Likely questions

[mid] Q: Walk me through what `priority = { carried: 0, ai: 1, journal: 2 }` is doing inside the comparator.
      A: It's a fall-through tiebreaker. After the `done` flag puts completed todos at the bottom, the next discriminator is "where did this todo come from?" — carried over from a previous day (highest urgency), AI-generated from an expand call, or written today directly. The lower number wins, so `carried` floats to the top of the open todos. If two todos share the same source tier, the comparator falls through to `createdAt` ascending, oldest first. Three keys, fall-through, single stable sort — the canonical multi-key pattern.

```
[comparator fall-through — one row through three checks]

  a vs b
    │
    ▼
  a.done != b.done ?
    │           ├─ yes → done one to the bottom    DONE
    │           │
    │           └─ no → fall through
    ▼
  priority[a.source] != priority[b.source] ?
    │           ├─ yes → lower number wins         DONE
    │           │        (carried < ai < journal)
    │           └─ no → fall through
    ▼
  parseISO(a.createdAt) - parseISO(b.createdAt)    DONE
   (oldest first)
```

[senior] Q: Why was this replaced by pinned-first if both are O(n log n)?
         A: Performance wasn't the reason. The product question changed. `rankTodos` baked in an opinionated ordering — carried > AI > journal — that made sense when I thought users wanted "what should I do next" surfaced automatically. After using the app for a few weeks I realized I wanted explicit control: pin what matters, recency for everything else. Pinned-first is dumber and the user does more work, but it's predictable. The comparator complexity is roughly the same; the design philosophy is opposite.

```
                  Path taken (rankTodos, dormant)      Replacement (pinned-first, live)
                  ─────────────────────────────────    ────────────────────────────────
priority axis     algorithm picks (carried/ai/journal) user picks (pinned ✓ or not)
who decides       the developer's opinion              the user's explicit action
predictability    surprising on reorder ; user sees    boring ; rows where user put them
                  algo reshuffle their list
sort cost         O(n log n)                           O(n log n) — same engine
LOC               ~50                                  ~30
config knobs      keepDoneMs baked in flatten          recency window from settings
maintenance       comparator extends per new tier      pinned flag toggles two states
chosen because    auto-surface "what's next"           explicit control beat automation
                                                       in real use
```

[arch] Q: If you brought back AI-prioritized todos, would you reuse `rankTodos` or write something new?
       A: I'd reuse the comparator skeleton — fall-through compare is the right shape — but I'd unify it with pinned-first instead of replacing it. The new comparator would be: pinned DESC, then `source` priority (carried > AI > journal), then createdAt DESC. That's a 3-tier compose, structurally identical to what `rankTodos` already does. I'd also lift `keepDoneMs` out of flatten into a query-layer filter so it's configurable per screen instead of hardcoded.

```
[scale curve — what breaks first at 10× / 100× input]

  N todos in flat array   sort cost      breaks?
  ──────────────────────  ─────────────  ──────────────────────────────
  50 (real)               <1ms           no
  500 (10×)               ~3ms           no
  5,000 (100×)            ~30ms          comparator runs ~60k times ;
                                         parseISO cost adds up — use
                                         Schwartzian transform
  50,000                  ~300ms         user-visible ; needs the
                                         tier policy lifted to SQL
                                         ORDER BY at the query layer
```

### The question candidates always dodge
Q: Why is this still in the repo if nothing calls it?

A: Because I shipped the pinned-first sort as the live ordering on 2026-05-05 and didn't delete `rankTodos` because I wasn't sure I wouldn't want it for an "unranked-by-default" view I had in mind. If I'm being honest, that's a rationalization — I haven't built the unranked view, I haven't even speced it, and the function has been dead since the day I wrote the replacement. It's debt. The right move is to delete it now and pull it back from git history if I ever want it. The reason I haven't is that the file also exports `formatRelativeTime`, which IS consumed by `app/todos.tsx` and `SmartTodoList.tsx`, so the cleanup is "extract the formatter, then delete the rest of the file" — three steps instead of one, and I keep deferring it. Good catch on a real interview question; I should fix this before the next time someone reads the codebase cold.

```
                  Path taken (keep dormant code)        Suggested (delete + extract)
                  ─────────────────────────────────     ─────────────────────────────
file              src/services/todos/rank.ts            two files: rankTodos in git
                  (rankTodos dead, formatRelativeTime    history, formatRelativeTime
                  live)                                  in src/utils/formatRelative.ts
bundle size       includes ~50 LOC dead code            ~50 LOC less ; bundle smaller
                                                        by ~1KB
onboarding cost   reader sees rankTodos, asks if it's   no rankTodos ; no question
                  live, can't tell without grep
recovery if       file is right there ; one find        git log --all -- rank.ts ;
 needed back      operation, no diff to read            cherry-pick the old commit
cleanup steps     0 — debt is paid forward              3 — extract, delete, update
                                                        imports in two files
verdict           comfortable but dishonest             slightly more work ; honest
                                                        code shape
```

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

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; normalised Tradeoffs heading from "(in its prime, vs alternatives)" to plain "Tradeoffs"; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 + v1.23.0 pass: inserted `## Tech reference (industry pairing)` section between Tradeoffs and Summary with `###` per tech + five labelled bullets each.

---
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (dictionary-comparator metaphor + frontend bridge to Array.sort tuple comparators) and Move 3 principle after the Comparison block.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (librarian-sorting-returns-cart scenario → naming the multi-key fall-through comparator → bolded "what depends on getting this right" pivot with `rankTodos` policy/dormant-status stakes → before/after bullets comparing chained sorts vs one comparator → one-line summary "compare on the most significant key, fall through to the next when it's a tie").

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care to anchor on real software (replaced librarian-sorting-cart analogy with Postgres `ORDER BY a, b, c`, Python's `sorted(key=lambda x: (a, b, c))`, and spreadsheet multi-column sort dialogs).
