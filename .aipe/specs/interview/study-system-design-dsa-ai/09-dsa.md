# Chapter 9 — Data Structures and Algorithms

## Opening — what you're looking at

Most candidates learn DSA from LeetCode and arrive at interviews able to solve the problem but unable to explain *why* a pattern matters. The reason is that LeetCode problems are abstract — they're decoupled from the systems where the patterns earn their weight. This chapter inverts that. Every problem here is drawn from a real file in `src/services/`. The pattern is named, the file is cited, and the brute-force-vs-optimal contrast is shown with execution traces against actual data shapes.

Five DSA patterns carry the bulk of the algorithmic work in loopd: HashMap-backed two-pass matching (the scanner reconcile pattern), multi-key sorting (the rank function), Set-based deduplication (the tag parser), dense integer rebase (the position-assigner), and threshold lookup (the staleness computation). Each one has a brute-force version that "works" and an optimal version that scales. The brute-force version usually shows up first when someone implements the feature without thinking about cardinality; the optimal version is the one that survives a refactor under load.

What this chapter is not: it is not a comprehensive textbook. It does not cover trees, graphs, dynamic programming, or string-matching beyond what the codebase actually uses. If a senior interviewer wants to drill down on DP or graph traversal, that's a different study guide (`docs/dsa-study-guide.md` covers the broader set). What this chapter *is*: a tight, honest read on the algorithms that make loopd work, written in the voice I'd use to explain them on a whiteboard.

---

## Problem 1 — Two-pass matching with line-index fallback

**Source file.** `src/services/todos/scanTodos.ts`, function `scanTodosFromText`.

**Problem statement.** Given an existing array of `TodoItem` (each with `id`, `text`, `sourceLine?`) and a new text blob containing some `[]`-marker lines, produce a new array of `TodoItem` such that:
- Lines whose text matches an existing todo (case-insensitive trim) keep that todo's `id` and `createdAt`.
- Lines whose text doesn't match but whose `sourceLine` matches an existing todo's `sourceLine` also keep that todo's id (the in-place edit case).
- Lines that match neither become new todos.
- Existing todos that match no line are dropped from the output.

This is the data-loss-prevention guarantee for the journal: the user can edit `[] call mom` to `[] call dad` without losing the meta row attached to the original.

### Brute force

```typescript
function brute(text: string, existing: TodoItem[]): TodoItem[] {
  const lines = parseLines(text);                          // [{lineIndex, content}]
  const out: TodoItem[] = [];
  const used = new Set<string>();

  for (const line of lines) {
    let claimed: TodoItem | null = null;
    // Pass 1: text match — O(N) scan over existing per line
    for (const t of existing) {
      if (used.has(t.id)) continue;
      if (t.text.trim().toLowerCase() === line.content.toLowerCase()) {
        claimed = t; break;
      }
    }
    // Pass 2: line-index fallback — another O(N) scan
    if (!claimed) {
      for (const t of existing) {
        if (used.has(t.id)) continue;
        if (t.sourceLine === line.lineIndex) { claimed = t; break; }
      }
    }
    if (claimed) {
      used.add(claimed.id);
      out.push({ ...claimed, text: line.content, sourceLine: line.lineIndex });
    } else {
      out.push({ id: gen(), text: line.content, done: false, sourceLine: line.lineIndex });
    }
  }
  return out;
}
```

**Time:** O(L × N) where L is line count, N is existing todo count. Both passes scan existing per line.
**Space:** O(N) for the `used` set.

### Brute force trace

Input:
- existing: `[{id:'a', text:'call mom', sourceLine:0}, {id:'b', text:'buy milk', sourceLine:1}]`
- new lines: `[{lineIndex:0, content:'call mom'}, {lineIndex:1, content:'buy bread'}]`

```
Iter line 0 ("call mom" at index 0):
  pass 1: scan existing
    t='a' (text='call mom') → match. claimed=a, used={a}
  push {id:'a', text:'call mom', sourceLine:0}

Iter line 1 ("buy bread" at index 1):
  pass 1: scan existing
    t='a' in used; skip
    t='b' (text='buy milk') → no match
  pass 2: scan existing
    t='a' in used; skip
    t='b' (sourceLine=1, line.lineIndex=1) → match. claimed=b, used={a,b}
  push {id:'b', text:'buy bread', sourceLine:1}

Output: [{id:'a',...}, {id:'b', text:'buy bread', sourceLine:1}]

Total: 4 inner-loop iterations. b's id and createdAt preserved despite text edit.
```

### Optimal

```typescript
function optimal(text: string, existing: TodoItem[]): TodoItem[] {
  const lines = parseLines(text);
  const out: TodoItem[] = [];
  const used = new Set<string>();

  // Build two HashMaps once: text → todo, sourceLine → todo
  const byText = new Map<string, TodoItem>();
  const byLine = new Map<number, TodoItem>();
  for (const t of existing) {
    byText.set(t.text.trim().toLowerCase(), t);
    if (typeof t.sourceLine === 'number') byLine.set(t.sourceLine, t);
  }

  for (const line of lines) {
    // Pass 1: O(1) text lookup
    let claimed = byText.get(line.content.toLowerCase());
    if (claimed && used.has(claimed.id)) claimed = undefined;

    // Pass 2: O(1) line-index lookup
    if (!claimed) {
      const candidate = byLine.get(line.lineIndex);
      if (candidate && !used.has(candidate.id)) claimed = candidate;
    }

    if (claimed) {
      used.add(claimed.id);
      out.push({ ...claimed, text: line.content, sourceLine: line.lineIndex });
    } else {
      out.push({ id: gen(), text: line.content, done: false, sourceLine: line.lineIndex });
    }
  }
  return out;
}
```

**Time:** O(L + N). Build the maps in O(N), then each line is O(1) lookup × L lines.
**Space:** O(N) for the two maps.

### Optimal trace

Same input as above.

```
Setup:
  byText  = { 'call mom' → a, 'buy milk' → b }
  byLine  = { 0 → a, 1 → b }
  used    = {}

Iter line 0 ("call mom" at index 0):
  byText.get('call mom') → a (not in used). claimed=a, used={a}
  push {id:'a', text:'call mom', sourceLine:0}

Iter line 1 ("buy bread" at index 1):
  byText.get('buy bread') → undefined
  byLine.get(1) → b (not in used). claimed=b, used={a,b}
  push {id:'b', text:'buy bread', sourceLine:1}

Output: same as brute force.
Total: 2 lookups + 2 lookups = 4 hashmap ops, all O(1).
```

**Why optimal wins.** At L=50 lines × N=200 existing todos, brute force is 10,000 inner operations per scan. Optimal is 250 hashmap operations. The scanner runs on every entry commit, so the savings compound.

### Follow-up

> *"What if multiple existing todos have the same text? The text-keyed HashMap collapses them."*

Right. At that point the HashMap value becomes a list of candidates and the lookup picks the first unused one. Or you can flip the contract: dedupe identical-text lines on the way in (the actual `scanTodos.ts` does this with `seen` in `collectMatches` so two `[] call mom` lines produce one todo). The codebase's choice is "dedupe on the way in"; the alternative is "store list of candidates per text key." Both correct; the dedupe approach is simpler and matches the user's likely intent (two identical `[]` lines are one task duplicated, not two independent tasks).

---

## Problem 2 — Multi-key sort across heterogeneous sources

**Source file.** `src/services/todos/rank.ts`, function `rankTodos`.

**Problem statement.** Flatten todos from N entries into one list. Each todo is tagged with a source: `'carried'` (todo from a previous date and not done), `'ai'` (AI-generated), or `'journal'` (default). Sort by:
1. Done todos go to the bottom of their group (with a 2-second grace window for the strikethrough).
2. Within each done/not-done group, sort by source priority: carried < ai < journal.
3. Within each source group, sort by `effectiveCreatedAt` ascending (oldest first).

The dashboard's `SmartTodoList` shows the top 5.

### Brute force

```typescript
function brute(entries: Entry[], today: string): RankedTodo[] {
  const flat: RankedTodo[] = [];
  for (const e of entries) {
    for (const t of e.todos ?? []) {
      const source = !t.done && e.date < today ? 'carried' : 'journal';
      flat.push({ ...t, entryDate: e.date, source });
    }
  }

  // Bubble sort with custom comparator
  for (let i = 0; i < flat.length; i++) {
    for (let j = 0; j < flat.length - i - 1; j++) {
      if (compare(flat[j], flat[j+1]) > 0) {
        [flat[j], flat[j+1]] = [flat[j+1], flat[j]];
      }
    }
  }
  return flat;
}
```

**Time:** O(N²) for the sort, where N is total todo count.
**Space:** O(N).

### Brute force trace

Input: 4 todos.

```
Initial: [
  {id:'a', done:false, source:'journal', createdAt:'2026-05-01'},
  {id:'b', done:false, source:'carried', createdAt:'2026-04-30'},
  {id:'c', done:true,  source:'journal', createdAt:'2026-05-01'},
  {id:'d', done:false, source:'ai',      createdAt:'2026-05-01'},
]

Pass 1: 6 comparisons, swaps move 'b' (carried, !done) to front:
  swap(j=0): a vs b → a.source > b.source → swap → [b,a,c,d]
  swap(j=1): a vs c → a.done < c.done → no swap → [b,a,c,d]
  swap(j=2): c vs d → c.done > d.done → swap → [b,a,d,c]
Pass 2: 4 more comparisons, 'd' (ai, !done) moves before 'a':
  swap(j=0): b vs a → no swap
  swap(j=1): a vs d → a.source > d.source → swap → [b,d,a,c]
Pass 3: stable, no swaps
Final: [b, d, a, c]
```

12 comparisons for N=4. At N=500, that's 250,000.

### Optimal

```typescript
function optimal(entries: Entry[], today: string): RankedTodo[] {
  const flat: RankedTodo[] = [];
  for (const e of entries) {
    for (const t of e.todos ?? []) {
      const source: TodoSource = !t.done && e.date < today ? 'carried' : 'journal';
      flat.push({ ...t, entryDate: e.date, source });
    }
  }
  const priority = { carried: 0, ai: 1, journal: 2 };
  flat.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (priority[a.source] !== priority[b.source]) {
      return priority[a.source] - priority[b.source];
    }
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  return flat;
}
```

**Time:** O(N log N) using the engine's `Array.prototype.sort` (TimSort in V8).
**Space:** O(log N) for the sort's call stack.

### Optimal trace (conceptual TimSort sketch)

Same input.

```
TimSort identifies natural runs and merges them.

Initial: [a(j,!d,'2026-05-01'), b(c,!d,'2026-04-30'),
          c(j,d), d(ai,!d,'2026-05-01')]

Step 1: split into runs. Comparator key (done, source-priority, createdAt):
  a → (0, 2, 1714521600000)
  b → (0, 0, 1714435200000)
  c → (1, 2, 1714521600000)
  d → (0, 1, 1714521600000)

Step 2: sort by tuple. Result: b(0,0,..), d(0,1,..), a(0,2,..), c(1,2,..)
  → [b, d, a, c]

Operations: ~4 × log2(4) = 8 comparisons (vs 12 in bubble sort).
At N=500, ~500 × log2(500) ≈ 4500 comparisons (vs 250,000 in bubble sort).
```

**Why optimal wins.** O(N log N) vs O(N²). At N=500 (a year of journaling at moderate volume), the brute version is ~55× slower. The dashboard sorts on every mount; on a slower Android device this is the difference between "instant" and "noticeable lag."

### Follow-up

> *"Could you avoid the sort entirely by pre-bucketing into 6 groups (done/not-done × 3 sources) and concatenating?"*

Yes — that's bucket sort with a constant number of buckets, O(N) time, and would beat O(N log N). Within each bucket you'd still have to sort by `createdAt`, but each bucket is much smaller. For the dashboard's top-5 use case, a partial sort would be even better: `nth_element`-style partitioning to find the top 5 in O(N), no full sort. The codebase doesn't do this because the full sort is cheap enough at current scale and the partial sort adds complexity that isn't justified yet. At 10,000 todos, the partial-sort path becomes the right answer.

---

## Problem 3 — Per-line per-slug Set deduplication

**Source file.** `src/services/threads/scanThreads.ts`, function `parseTags`.

**Problem statement.** Given a multiline text string, find all `#tag` mentions. Each mention is `(slug, tagText, lineIndex)`. If the same slug appears multiple times on the same line, collapse to one. Across different lines, both occurrences are kept.

Example: `#loopd shipped #loopd today\nbut not #git` → 2 mentions: `(loopd, line 0)`, `(git, line 1)`. The second `#loopd` on line 0 is dropped.

### Brute force

```typescript
function brute(text: string): ParsedTag[] {
  const lines = text.split('\n');
  const out: ParsedTag[] = [];
  for (let i = 0; i < lines.length; i++) {
    const matches = [...lines[i].matchAll(TAG_RE)];
    for (const m of matches) {
      const tagText = m[2];
      const slug = tagText.toLowerCase();
      // O(K) duplicate check against already-emitted tags on this line
      let isDupe = false;
      for (const existing of out) {
        if (existing.lineIndex === i && existing.slug === slug) {
          isDupe = true; break;
        }
      }
      if (!isDupe) out.push({ slug, tagText, lineIndex: i });
    }
  }
  return out;
}
```

**Time:** O(L × M × K) where L=line count, M=tags per line, K=output size. The duplicate check rescans `out` for every match.
**Space:** O(K).

### Brute force trace

Input: `"#loopd shipped #loopd today\nbut not #git"`

```
Line 0: "#loopd shipped #loopd today"
  matches: [#loopd, #loopd]
  match 0 (#loopd): out=[]. no dupe. push {slug:loopd, lineIndex:0}.
                    out=[{loopd,0}]
  match 1 (#loopd): scan out. existing={loopd,0}, same line+slug → dupe. skip.

Line 1: "but not #git"
  matches: [#git]
  match 0 (#git): scan out. {loopd,0} → diff slug. no dupe. push {git,1}.
                  out=[{loopd,0}, {git,1}]

Total iterations of dupe check: 1 + 1 = 2.
At 200 lines × 5 tags/line × 1000 final mentions = 1,000,000 inner ops worst case.
```

### Optimal

```typescript
function optimal(text: string): ParsedTag[] {
  const lines = text.split('\n');
  const out: ParsedTag[] = [];
  const seenPerLine = new Set<string>();      // key: `${lineIndex}::${slug}`
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].matchAll(TAG_RE);
    for (const m of matches) {
      const tagText = m[2];
      const slug = tagText.toLowerCase();
      const key = `${i}::${slug}`;
      if (seenPerLine.has(key)) continue;
      seenPerLine.add(key);
      out.push({ slug, tagText, lineIndex: i });
    }
  }
  return out;
}
```

**Time:** O(L × M) — Set operations are O(1) amortized.
**Space:** O(K) for `seenPerLine` and `out`.

### Optimal trace

Same input.

```
Line 0: "#loopd shipped #loopd today"
  match 0 (#loopd): key='0::loopd'. seenPerLine.has → false.
                    add. push {loopd,0}. seen={'0::loopd'}
  match 1 (#loopd): key='0::loopd'. seenPerLine.has → true. skip.

Line 1: "but not #git"
  match 0 (#git): key='1::git'. seenPerLine.has → false.
                  add. push {git,1}. seen={'0::loopd','1::git'}

Total: 4 Set operations, all O(1).
```

**Why optimal wins.** The brute version's dupe check is O(K) per match, where K grows over time. Optimal is O(1) per match. At a 200-line entry with 5 tags per line and high overlap, the brute version is ~50× slower.

### Follow-up

> *"What if I want global deduplication — same slug across all lines should only appear once?"*

Change the Set key from `${lineIndex}::${slug}` to just `slug`, drop the lineIndex segment. The output then becomes `(slug, tagText, lineIndex of first occurrence)`. The codebase chose per-line dedup because the use case is "where does this tag appear in the prose" — and the same slug appearing on two different lines is meaningful (two attribution moments). The constraint that distinguishes the two is what the deduplicated row represents: a single mention vs a single tag-presence.

---

## Problem 4 — Dense integer rebase for stable user reorder

**Source file.** `src/services/todos/reorder.ts`, function `ensureAllTodoPositions`.

**Problem statement.** Todos have a nullable `position` integer used for user-set ordering. When the user invokes "reorder" for the first time, every todo must be assigned a dense integer position based on the current visual order, so subsequent swaps don't have to handle nulls. The function is idempotent — if every row already has a position, return immediately.

### Brute force

```typescript
async function brute(visualOrder: Row[]): Promise<void> {
  const all = await getAllTodoMetas();
  // Re-sort the entire all list by current visual order, with hidden rows
  // placed at the end in createdAt-DESC order.
  const sorted: TodoMeta[] = [];
  for (const r of visualOrder) {
    const m = all.find(x => x.todoId === r.id);
    if (m) sorted.push(m);
  }
  for (const m of all) {
    if (!sorted.some(x => x.todoId === m.todoId)) sorted.push(m);
  }
  // Assign sequential positions, write each individually
  for (let i = 0; i < sorted.length; i++) {
    await updateTodoMeta(sorted[i].todoId, { position: i });
  }
}
```

**Time:** O(N²) — the dual `find` and `some` are linear scans inside a linear loop. Plus N DB writes (one per row, no batching).
**Space:** O(N).

### Brute force trace

Input: visualOrder = `[a, b]`, all metas = `[a, b, c]` (c is filtered out of view).

```
Build sorted:
  visualOrder iter:
    r='a': all.find(x.todoId='a') → m_a. sorted=[a]
    r='b': all.find(x.todoId='b') → m_b. sorted=[a,b]
  all iter (find unsorted):
    m='a': sorted.some(x='a') → true. skip
    m='b': sorted.some(x='b') → true. skip
    m='c': sorted.some(x='c') → false. push. sorted=[a,b,c]

Position assign:
  i=0: write a position=0
  i=1: write b position=1
  i=2: write c position=2

Total ops: 3 finds + 3 somes + 3 writes = 9 ops for N=3.
At N=500, ~250k inner ops + 500 sequential DB writes.
```

### Optimal

```typescript
async function optimal(visualOrder: Row[]): Promise<void> {
  const all = await getAllTodoMetas();
  const allHave = all.every(m => m.position != null);
  if (allHave) return;                                   // idempotent fast path

  const seenIds = new Set(visualOrder.map(r => r.id));
  const tail = all.filter(m => !seenIds.has(m.todoId))
                  .sort(stableHiddenSort);
  let i = 0;
  for (const r of visualOrder) {
    await updateTodoMeta(r.id, { position: i++ });
  }
  for (const m of tail) {
    await updateTodoMeta(m.todoId, { position: i++ });
  }
}
```

**Time:** O(N) for the Set build + O(N log N) for the tail sort + O(N) for writes. Dominated by the N writes.
**Space:** O(N) for the Set.

### Optimal trace

Same input.

```
Idempotency check: all.every(m.position != null) → false (rows are NULL). proceed.

seenIds = {'a','b'}
tail = all.filter(m → !seenIds.has(m.todoId)) = [c]
       sorted by stableHiddenSort (createdAt DESC, c is alone): [c]

Write loop 1:
  i=0: write a position=0
  i=1: write b position=1
Write loop 2:
  i=2: write c position=2

Total: 1 Set build + 1 filter + 3 writes = 5 ops for N=3.
At N=500: 1 Set + 1 filter (O(N)) + 500 writes.

Inner ops scaling: brute O(N²) → optimal O(N) (modulo writes).
```

**Why optimal wins.** Replacing the dual nested scan with a Set-based separation of seen/unseen rows turns the inner work from O(N²) to O(N). The DB write count is the same, but the writes can also be batched in a transaction (optimization left out of the function for clarity but worth doing under load). The idempotency fast path avoids re-running entirely when positions are already assigned, which is the common case after the first reorder.

### Follow-up

> *"Why dense integers? Why not floats so insertion between two rows is constant-time?"*

Floats avoid the rebase but introduce two problems. The first is precision: after enough insertions between adjacent rows, the floats round and two distinct rows can become equal. The second is sort cost: the SQLite query `ORDER BY position` is identical for floats vs integers, but integer sort is faster on hot paths. The codebase chose dense integers because rebases are rare (only on the first reorder action ever) and the `swapTodoPositions` function never needs to insert between — it only swaps adjacent rows in the visible list. The constraint that distinguishes the two: insertion between is rare in this UI; reorders are swaps, not arbitrary moves.

---

## Problem 5 — Threshold lookup for thread staleness

**Source file.** `src/services/threads/staleness.ts`, function `computeStaleness`.

**Problem statement.** Given a thread's `targetCadenceDays` (optional) and the days-since-last-mention (`Infinity` if never mentioned), return one of `'fresh' | 'aging' | 'stale' | 'cold'`. If `targetCadenceDays` is set, thresholds are 1×, 2×, 4× of cadence. Otherwise default thresholds: ≤1d fresh, ≤3d aging, ≤7d stale, >7d cold.

### Brute force

```typescript
function brute(daysSince: number, cadence: number | null): Staleness {
  if (cadence != null) {
    if (daysSince <= cadence) return 'fresh';
    if (daysSince <= cadence * 2) return 'aging';
    if (daysSince <= cadence * 4) return 'stale';
    return 'cold';
  }
  if (daysSince <= 1) return 'fresh';
  if (daysSince <= 3) return 'aging';
  if (daysSince <= 7) return 'stale';
  return 'cold';
}
```

**Time:** O(1) — three comparisons in the worst case.
**Space:** O(1).

This is already optimal. The interesting question is "what if you had 10× more states"?

### Optimal (when state count grows)

```typescript
const DEFAULT_THRESHOLDS: Array<[number, Staleness]> = [
  [1, 'fresh'], [3, 'aging'], [7, 'stale'], [Infinity, 'cold'],
];
function thresholdsForCadence(c: number): Array<[number, Staleness]> {
  return [[c, 'fresh'], [c*2, 'aging'], [c*4, 'stale'], [Infinity, 'cold']];
}
function optimal(daysSince: number, cadence: number | null): Staleness {
  const thresholds = cadence != null
    ? thresholdsForCadence(cadence)
    : DEFAULT_THRESHOLDS;
  for (const [t, label] of thresholds) {
    if (daysSince <= t) return label;
  }
  return 'cold';                                        // unreachable, fallback
}
```

**Time:** O(K) where K is threshold count (4 here, constant).
**Space:** O(K).

### Optimal trace

Input: daysSince=5, cadence=null.

```
thresholds = [[1,'fresh'], [3,'aging'], [7,'stale'], [Infinity,'cold']]
loop:
  t=1: 5 <= 1? false. continue
  t=3: 5 <= 3? false. continue
  t=7: 5 <= 7? true. return 'stale'

3 comparisons, returns 'stale'. Correct.

Input: daysSince=2, cadence=3.
thresholds = [[3,'fresh'], [6,'aging'], [12,'stale'], [Infinity,'cold']]
loop:
  t=3: 2 <= 3? true. return 'fresh'

1 comparison.
```

**Why this matters.** The brute version is fine at K=4 thresholds. At K=20 (e.g., a richer per-thread engagement model with more nuance), the linear scan stays O(K) but the array form makes the thresholds *data*, not control flow. You can serialize them, ship them from a config, or compute them dynamically. The branching version locks the thresholds at code-write time. The codebase uses the branching version because K=4 isn't worth the abstraction — but it's worth noticing the pattern, because at K=20 the array form is the natural shape.

### Follow-up

> *"What if `daysSince` is a float and the thresholds are sorted, can you do binary search?"*

Yes. `Array.prototype.findIndex` can be replaced with a binary search; complexity drops to O(log K). At K=4 it's slower in practice (higher constant factor); at K=20 it starts paying. The codebase doesn't do this because K stays at 4. This is the same pattern as picking insertion sort for small arrays in TimSort — choose the algorithm that wins on the actual size, not the asymptotically best one.

---

## Closing — pattern map

| Pattern | Where it lives | Why it matters here |
|---|---|---|
| HashMap two-pass match | `scanTodos.ts`, `scanNutrition.ts`, `scanThreads.ts` | identity-stable scanning across edits; the load-bearing pattern of the prose-derived layer |
| Multi-key sort | `rank.ts` | dashboard ranking; UI ordering for `/todos` |
| Set deduplication | `parseTags`, `collectMatches` | same-line tag dedup, same-text todo dedup |
| Dense integer rebase | `reorder.ts` | user reorder with stable swap operations |
| Threshold lookup | `staleness.ts` | per-thread freshness label |

For a deeper drill, `docs/dsa-study-guide.md` covers the broader DSA set with abstract problems alongside the codebase-grounded ones. This chapter is the project-anchored version: every pattern here is tied to a real file you can open and read.
