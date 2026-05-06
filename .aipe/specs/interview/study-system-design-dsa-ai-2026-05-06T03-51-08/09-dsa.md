# Chapter 9 — Data structures and algorithms

This chapter walks through the actual algorithms in loopd. Each problem is one I solved while building the app — not LeetCode, not theoretical. Each one has a brute-force version (often what shipped first), an optimal version (what's there now or what I'd change at scale), and an ASCII trace of execution.

The DSA shape of loopd is dominated by **flat-array transformation**: take an array of records, filter, sort, deduplicate, group. There are no trees, no graphs, no DP. The interesting algorithmic territory is in the scanners (line-by-line text parsing with two-pass matching) and the cell-state derivation (cadence math against a date set). I'll cover one problem from each category.

## Problem 1 — Two-pass scanner: matching todo identities across edits

**Where it lives.** `src/services/todos/scanTodos.ts:scanTodosFromText(text, existing): TodoItem[]`

**Problem statement.** Given the entry's full prose text and the existing `TodoItem[]` from the previous scan, produce the new `TodoItem[]` such that:
- Every line in prose matching `[]` / `[ ]` / `[x]` syntax produces exactly one TodoItem.
- An existing todo whose text didn't change keeps its `id`, `createdAt`, `done`, `completedAt` — even if its line moved.
- An existing todo whose text changed (but stayed on the same line) keeps its `id` — but updates `text` and `done` to the new line's values.
- Lines that don't match an existing todo become fresh todos with new IDs.
- Existing todos that no longer match any line become carryover (returned but with `sourceLine` cleared).

The constraint that makes this nontrivial: identity. If the user edits "[] call mom" to "[] call dad" on the same line, that should be the *same todo* (preserves AI classification, completion timestamp, etc.) — not a new one + an orphan. Conversely, if the user *moves* "[] call mom" from line 4 to line 2, that should also be the same todo.

### Brute-force solution: text match only

```typescript
function scanV1(text: string, existing: TodoItem[]): TodoItem[] {
  const lines = collectMatches(text); // [{ lineIndex, content, isDone }]
  const out: TodoItem[] = [];
  const usedIds = new Set<string>();

  for (const m of lines) {
    const prior = existing.find(t =>
      !usedIds.has(t.id) && t.text.trim().toLowerCase() === m.content.toLowerCase()
    );
    if (prior) {
      usedIds.add(prior.id);
      out.push({ ...prior, done: m.isDone, sourceLine: m.lineIndex });
    } else {
      out.push({ id: generateId('todo'), text: m.content, done: m.isDone, ... });
    }
  }
  return out;
}
```

**Complexity.** O(L × E) where L = lines, E = existing todos (linear scan on each match). Space O(L + E).

**Bug.** Editing the text of a line creates a new todo. Original todo's text doesn't match anything — becomes orphan carryover. The user sees a duplicate.

### Brute-force trace

```
existing: [
  { id: 'a', text: 'call mom', sourceLine: 0 },
  { id: 'b', text: 'pay rent', sourceLine: 1 },
]

text:
  Line 0: [] call dad        ← user edited "mom" → "dad"
  Line 1: [] pay rent

scanV1 walks lines:
  Line 0: 'call dad' — find existing.text == 'call dad' → none
                       → fresh todo { id: 'NEW1', text: 'call dad', sourceLine: 0 }
  Line 1: 'pay rent' — find existing.text == 'pay rent' → 'b' ✓
                       → reuse 'b', { id: 'b', sourceLine: 1 }

out: [
  { id: 'NEW1', text: 'call dad', sourceLine: 0 },     ← brand new
  { id: 'b',   text: 'pay rent', sourceLine: 1 },      ← reused
]

carryover: ['a' was unused, returns as { id: 'a', text: 'call mom', sourceLine: undef }]

Result: TWO todos for one line in prose. User sees duplicate. Bug.
```

### Optimal solution: two-pass matching

```typescript
export function scanTodosFromText(
  text: string | null | undefined,
  existing: TodoItem[],
): TodoItem[] {
  if (!text) return existing;

  const matches = collectMatches(text);
  const claimed = new Map<number, TodoItem>();
  const usedIds = new Set<string>();

  // Pass 1: exact text match (case-insensitive, trimmed)
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i].content.toLowerCase();
    const prior = existing.find(
      t => !usedIds.has(t.id) && t.text.trim().toLowerCase() === key,
    );
    if (prior) { claimed.set(i, prior); usedIds.add(prior.id); }
  }

  // Pass 2: line-index fallback for unclaimed matches
  for (let i = 0; i < matches.length; i++) {
    if (claimed.has(i)) continue;
    const lineIndex = matches[i].lineIndex;
    const prior = existing.find(
      t => !usedIds.has(t.id)
        && typeof t.sourceLine === 'number'
        && t.sourceLine === lineIndex,
    );
    if (prior) { claimed.set(i, prior); usedIds.add(prior.id); }
  }

  // Build output
  const out: TodoItem[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const prior = claimed.get(i);
    out.push(prior
      ? { ...prior, text: m.content, done: m.isDone, sourceLine: m.lineIndex }
      : { id: generateId('todo'), text: m.content, done: m.isDone, sourceLine: m.lineIndex, ... });
  }

  // Carryover: existing todos unmatched in both passes
  const carryover = existing
    .filter(t => !usedIds.has(t.id))
    .map(t => ({ ...t, sourceLine: undefined }));

  return [...carryover, ...out];
}
```

**Complexity.** O(L × E) per pass = O(2 × L × E) ≈ O(L × E), same big-O as brute-force. Space O(L + E). The optimization is *correctness*, not speed.

### Optimal trace, same input

```
existing: [
  { id: 'a', text: 'call mom', sourceLine: 0 },
  { id: 'b', text: 'pay rent', sourceLine: 1 },
]

text:
  Line 0: [] call dad
  Line 1: [] pay rent

PASS 1 (exact text match):
  Line 0 'call dad': existing.text == 'call dad' → none, unclaimed
  Line 1 'pay rent': existing.text == 'pay rent' → 'b' ✓
                     claimed[1] = b, usedIds = {b}

PASS 2 (line-index fallback) on unclaimed:
  Line 0 (lineIndex=0): existing where !used && sourceLine==0 → 'a' ✓
                         claimed[0] = a, usedIds = {b, a}

Build output:
  Line 0: prior=a → { id: 'a', text: 'call dad', done: ..., sourceLine: 0 }
  Line 1: prior=b → { id: 'b', text: 'pay rent', done: ..., sourceLine: 1 }

carryover: usedIds is {a, b}; existing all used → []

Result: TWO todos for two lines. 'a' kept its identity through a text edit
on the same line. 'b' kept its identity through pass 1.
```

**Why optimal wins.** Identity is preserved across edits (pass 1 catches reorders, pass 2 catches text edits at a fixed line). The user can rename "call mom" → "call dad" on line 0 without losing the todo's classifier_confidence, completed_at, or pinned state.

### Interviewer follow-up

*"What happens if the user moves 'call mom' from line 4 to line 2 AND edits the text in the same commit?"*

That's the case neither pass catches cleanly. Pass 1 fails (text changed), pass 2 fails (lineIndex changed). The result: the original todo carries over with `sourceLine: undefined`, and a fresh todo is created at line 2 with new id. The user effectively sees a duplicate.

This is a real limitation of the two-pass approach — it handles "edit at same position" and "move with same text," but not "edit AND move." Solving it would require a fuzzy match (Levenshtein distance over line content) which adds complexity and risk: a high-edit-distance match might claim a *different* user-intended todo. I picked the bounded two-pass over fuzzy matching because the failure mode of the two-pass is "user occasionally sees a duplicate after a heavy edit" (recoverable: delete the orphan), while the failure mode of fuzzy matching is "user occasionally sees their wrong todo's classification carried over" (silent, harder to notice).

## Problem 2 — Cell-state derivation: cadence-aware grid rendering

**Where it lives.** `src/components/home/cellState.ts:cellStateFor(habit, date, today, checkedDates): CellState`

**Problem statement.** Given a habit (with `cadence_type`, `cadence_days`, `cadence_count`, `time_of_day`), a target date, today's date, and the set of dates the habit was checked, return one of the cell states: `done | pending | upcoming | missed | off-day`.

The complexity: cadence interacts with time. A "weekly Mon/Wed/Fri" habit that was checked Wednesday: today (Friday) the cell is `pending` if not yet checked, but Saturday's cell is `upcoming` (no further obligation till next Monday). The off-day rule: a habit configured for Mon/Wed/Fri renders Sat/Sun as `off-day`, never `missed`.

### Optimal solution

```typescript
export function cellStateFor(
  habit: Habit,
  date: string,
  today: string,
  checkedDates: ReadonlySet<string>,
): CellState {
  if (checkedDates.has(date)) return 'done';

  const isOffDay = !isOnSchedule(habit, date);
  if (isOffDay) return 'off-day';

  if (date === today) return 'pending';
  if (date < today) return 'missed';
  return 'upcoming';
}

function isOnSchedule(habit: Habit, date: string): boolean {
  if (habit.cadenceType === 'daily') return true;
  if (habit.cadenceType === 'weekly') {
    const dow = new Date(date + 'T12:00:00').getDay(); // 0=Sun..6=Sat
    return habit.cadenceDays?.includes(dow) ?? false;
  }
  if (habit.cadenceType === 'count_per_week') {
    // Off-day model: don't visually mark off-days for count-based.
    // Every day is "scheduled"; the user picks N of 7.
    return true;
  }
  return true;
}
```

**Complexity.** O(1) per cell. The grid renders 7 cells × N rows ≈ 50 cells per render, all O(1). Total O(rows × 7) = O(rows).

### Trace

```
habit: { id: 'h1', cadenceType: 'weekly', cadenceDays: [1, 3, 5] } // Mon/Wed/Fri
today: '2026-05-05' (Tuesday)
checkedDates: { '2026-05-04' /* Mon */, '2026-04-29' /* Wed */ }

Render week (Mon..Sun) starting '2026-05-04':

  date          dow  isOnSchedule  checked  date<today  state
  2026-05-04    1    true (Mon)    YES                   done
  2026-05-05    2    false         NO                    off-day
  2026-05-06    3    true (Wed)    NO       NO (today)   pending  ← but wait, today=05-05, not 05-06
                                                                       so 06 is upcoming...
```

Let me re-trace cleaner:

```
today: '2026-05-05' (Tuesday)
habit: weekly Mon/Wed/Fri (dow [1,3,5])
checkedDates: { '2026-05-04' /* Mon — checked */ }

Week: '2026-05-04' (Mon) through '2026-05-10' (Sun)

  date         dow  isOnSchedule  checked  cmp today      state
  2026-05-04   1    true          YES      <today         done
  2026-05-05   2    false         NO       =today         off-day  (off-day check)
  2026-05-06   3    true          NO       >today         upcoming
  2026-05-07   4    false         NO       >today         off-day
  2026-05-08   5    true          NO       >today         upcoming
  2026-05-09   6    false         NO       >today         off-day
  2026-05-10   0    false         NO       >today         off-day

Visual row:
  [✓] [·] [☐] [·] [☐] [·] [·]
  done off  up  off  up  off off
                ↑                    ↑                    ↑
                upcoming Wed         upcoming Fri         off Sun
```

**Why this is the right shape.** The cell is *fully derived* from the inputs — pure function. No memoization needed at cell level (O(1) computation), no stored state, no DB write. The grid renders the user's reality and changes propagate the moment any input changes. If the user edits a habit's cadence from "weekly Mon/Wed/Fri" to "daily," every cell in every visible week recomputes correctly on the next render.

### Interviewer follow-up

*"What's the cost at 1 year of history with 20 habits?"*

The cell-state function is O(1), so a year of weekly grids (52 weeks × 7 days × 20 habits) = 7,280 cells, each O(1) — under 1ms. The dominant cost is the data fetch: `checkedDates` is a `Set<string>` per habit, populated from `getAllEntries` and flattening `habits_json`. With ~365 entries × 5 habits checked per day = 1,825 entries in each `checkedDates` set, but with a `Set` membership test that's still O(1) per lookup. Whole grid renders in <5ms total. Doesn't change architecturally at scale.

## Problem 3 — Dashboard todo ranking: pinned-first sort

**Where it lives.** `src/components/home/SmartTodoList.tsx` (and matching at `app/todos.tsx:189`).

**Problem statement.** Given a flat array of `(TodoItem, TodoMeta)` pairs from all entries, produce a sorted slice of the top 5 ranked-for-action todos. The rules:
1. Pinned todos before unpinned.
2. Within each group, sort by `createdAt` DESC (newest at top).
3. Drop done todos older than 2 seconds (KEEP_DONE_MS).

### Optimal solution

```typescript
const sorted = useMemo<DashboardTodo[]>(() => {
  const flat: DashboardTodo[] = [];
  for (const entry of entries) {
    for (const todo of entry.todos ?? []) {
      flat.push({ ...todo, entryId: entry.id, entryCreatedAt: entry.createdAt });
    }
  }
  // Drop long-completed
  const now = Date.now();
  const filtered = flat.filter(t => {
    if (!t.done) return true;
    if (!t.completedAt) return true;
    return now - new Date(t.completedAt).getTime() <= KEEP_DONE_MS;
  });
  // Pin-first, then createdAt DESC
  filtered.sort((a, b) => {
    const aPin = metas?.get(a.id)?.pinned ? 1 : 0;
    const bPin = metas?.get(b.id)?.pinned ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    const aTime = new Date(a.createdAt ?? a.entryCreatedAt).getTime();
    const bTime = new Date(b.createdAt ?? b.entryCreatedAt).getTime();
    return bTime - aTime;
  });
  return filtered;
}, [entries, metas]);
```

**Complexity.** Flatten O(N) where N = total todos. Filter O(N). Sort O(N log N). Slice O(1). Memoized on `[entries, metas]` so cost is paid only when those change, not on every render.

### Trace

```
entries: [
  { id: 'e1', createdAt: '2026-05-01', todos: [
      { id: 't1', text: 'pay rent',    done: false, createdAt: '2026-05-01T08:00' },
      { id: 't2', text: 'call mom',    done: true,  completedAt: '2026-05-05T14:00' },
  ]},
  { id: 'e2', createdAt: '2026-05-04', todos: [
      { id: 't3', text: 'read paper',  done: false, createdAt: '2026-05-04T10:00' },
      { id: 't4', text: 'write spec',  done: false, createdAt: '2026-05-04T16:00' },
  ]},
  { id: 'e3', createdAt: '2026-05-05', todos: [
      { id: 't5', text: 'fix bug',     done: false, createdAt: '2026-05-05T09:00' },
  ]},
]

metas: { t3: { pinned: true }, others: { pinned: false } }
now: 2026-05-05T14:01:00 (1 minute after t2 completed)

FLATTEN:
  [t1, t2, t3, t4, t5]

FILTER (drop done > 2s old):
  t2 done at 14:00:00, now 14:01:00 — 60s elapsed > 2s → DROP
  → [t1, t3, t4, t5]

SORT (pin DESC, then createdAt DESC):
  t3 pinned=true,  createdAt 2026-05-04T10:00
  t1 pinned=false, createdAt 2026-05-01T08:00
  t4 pinned=false, createdAt 2026-05-04T16:00
  t5 pinned=false, createdAt 2026-05-05T09:00

  Pinned first: [t3]
  Unpinned by createdAt DESC: [t5 (05-05), t4 (05-04T16), t1 (05-01T08)]

  Final: [t3, t5, t4, t1]

SLICE(0, 5):
  [t3, t5, t4, t1]    (only 4 items, all returned)

Visible on dashboard, top to bottom:
  ★ read paper       ← pinned
    fix bug          ← newest unpinned
    write spec
    pay rent
```

**Why this is the right shape.** O(N log N) is dominated by the sort. With N = 5,000 todos, sort is ~120K comparisons — under 10ms. Memoized on `[entries, metas]` means re-sort only happens when those refs change (i.e., after a write). Render is O(top-5) = O(1).

### Interviewer follow-up

*"What if the dashboard had 50K todos and re-sorting on every focus event was too slow?"*

Three options. (1) Database-side sort — push the `pinned DESC, createdAt DESC` into the SQL: `ORDER BY pinned DESC, created_at DESC LIMIT 5`. SQLite's index lookup makes this O(log N) on indexed columns. The cost: an index on `(pinned, created_at)`. Maybe 1MB extra at 50K rows. Cheap. (2) Materialized "dashboard top-N" cache, recomputed only on writes that affect the top — but staleness is hard to reason about (a pin toggle deep in the list could promote an item *into* the top-5). (3) Use `FlatList` with virtualization on the dashboard, so the cost-of-render is constant regardless of total count.

I'd ship (1) at 50K — it's the simplest correct answer. (2) is over-engineering. (3) is a frontend change for a sort-cost problem, which is the wrong direction.

## Complexity cheat sheet for all major operations

```
operation                      file                     time            space
─────────────────────────────────────────────────────────────────────────────
scanTodosFromText              services/todos/         O(L × E)        O(L + E)
                                 scanTodos.ts           ≈ O(L²) typical
rewriteTodoLine                services/todos/         O(L) over lines O(L)
                                 scanTodos.ts
reconcileTodoMetaForEntry      services/todos/         O(T)            O(T)
                                 reconcileMeta.ts       T = todos in entry
heuristicClassify              services/todos/         O(K)            O(1)
                                 heuristicClassify.ts   K = patterns
chooseWinner                   services/sync/          O(1)            O(1)
                                 conflict.ts
pushTable (per table)          services/sync/push.ts   O(D)            O(B)
                                                        D = dirty rows  B = batch (50)
pullTable (per table)          services/sync/pull.ts   O(P)            O(P)
                                                        P = pages × 200
cellStateFor                   components/home/        O(1)            O(1)
                                 cellState.ts
DailyScheduleGrid render       components/home/        O(R × 7)        O(R × 7)
                                 DailyScheduleGrid       R = rows
SmartTodoList sort             components/home/        O(N log N)      O(N)
                                 SmartTodoList.tsx       N = total todos
TodosScreen sort + filter      app/todos.tsx           O(N log N)      O(N)
computeStaleness               services/threads/       O(1)            O(1)
                                 staleness.ts
getThreadCards                 services/threads/       O(M)            O(T)
                                 getThreadCards.ts       M = mentions, T = threads
─────────────────────────────────────────────────────────────────────────────

10× scale considerations:

scanTodosFromText:    O(L²) becomes 10K × 10K = 100M ops at extreme scale.
                       Mitigation: chunk by entry; entries have ≤ ~50 todos.
SmartTodoList sort:   O(N log N) at N=50K = 800K comparisons = ~10ms; safe.
                       Mitigation: SQL ORDER BY + LIMIT 5 → O(log N).
pushTable / pullTable: bounded by network throughput, not algorithm.
                       Mitigation: parallelize across tables (today: serial).
classifier batch:     today serial per-todo; 1K ambiguous todos = 1K calls.
                       Mitigation: batched structured output (50 per call).
```
