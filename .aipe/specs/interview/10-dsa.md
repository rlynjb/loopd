# 10 — Data structures and algorithms

> **Three coding problems derived from real loopd operations.** Each problem cites the file:line where the pattern lives, gives both brute-force and optimal solutions in TypeScript, and shows step-by-step ASCII traces of the algorithms running.

The pattern across all three problems is the same insight: when you see a nested loop searching a list for a key, reach for a hashmap. Every interesting algorithm in this codebase is some variation of "build the lookup once, then iterate the second collection in linear time."

If you're studying this chapter for a coding round, internalize the *insight* of each problem, not the code. Code is recoverable from the insight. The insight is the part you have to memorize because it's what tells you *which primitive to reach for* under pressure.

## Problem 1 — Sparse-position reorder

### Where this lives in loopd

[`src/services/todos/reorder.ts`](../../../src/services/todos/reorder.ts) — when the user reorders a todo via the up/down arrows in `/todos`, the page rebuilds visible-sort positions and persists them. The actual production code does an adjacent swap; this problem generalizes the primitive to "apply a target order received from a drag-drop gesture."

### Problem statement

You're given two arrays:

- `items: { id: string; position: number | null; createdAt: string }[]`
- `targetOrder: string[]` — a permutation of the visible IDs in their *new* desired order.

Update each item's `position` to a dense integer matching its index in `targetOrder`. Items not in `targetOrder` keep their current `position`. Return the updated `items` array.

### Brute force

For each id in `targetOrder`, scan `items` linearly for a match. `O(n × m)` time where `m = items.length`, `n = targetOrder.length`.

```ts
type Item = { id: string; position: number | null; createdAt: string };

function reorderBrute(items: Item[], targetOrder: string[]): Item[] {
  for (let i = 0; i < targetOrder.length; i++) {
    const id = targetOrder[i];
    for (const item of items) {        // O(m) per outer iter
      if (item.id === id) { item.position = i; break; }
    }
  }
  return items;
}
// Time:  O(n × m)
// Space: O(1)
```

### ASCII trace — brute force

```
items = [{a,0}, {b,1}, {c,2}]
targetOrder = ["c", "a", "b"]

iter 0  id="c"
  scan items[0]:{a,0}     no match
  scan items[1]:{b,1}     no match
  scan items[2]:{c,2}     MATCH → items[2].pos = 0
                                  ▲ 3 comparisons

iter 1  id="a"
  scan items[0]:{a,0}     MATCH → items[0].pos = 1
                                  ▲ 1 comparison

iter 2  id="b"
  scan items[0]:{a,1}     no match
  scan items[1]:{b,1}     MATCH → items[1].pos = 2
                                  ▲ 2 comparisons

Total comparisons: 3 + 1 + 2 = 6  (worst case n × m = 9)
```

### Optimal

Build a `Map<id, item>` once (`O(m)`), then iterate `targetOrder` with `O(1)` lookups. Total `O(n + m)` time, `O(m)` space.

```ts
function reorderOptimal(items: Item[], targetOrder: string[]): Item[] {
  const byId = new Map(items.map(it => [it.id, it]));   // O(m)
  for (let i = 0; i < targetOrder.length; i++) {
    const item = byId.get(targetOrder[i]);
    if (item) item.position = i;
  }
  return items;
}
// Time:  O(n + m)
// Space: O(m)
```

### ASCII trace — optimal

```
items = [{a,0}, {b,1}, {c,2}]
targetOrder = ["c", "a", "b"]

Step 1 — build byId Map (one pass through items, O(m)):
  byId = { "a" → ref(items[0]),
           "b" → ref(items[1]),
           "c" → ref(items[2]) }

Step 2 — iterate targetOrder (one pass, O(n) with O(1) lookup each):
  i=0  id="c"  byId.get("c") → items[2]  → items[2].pos = 0
  i=1  id="a"  byId.get("a") → items[0]  → items[0].pos = 1
  i=2  id="b"  byId.get("b") → items[1]  → items[1].pos = 2

Total operations: m (build) + n (iterate) = 6 for this input
                  vs brute's worst-case n × m = 9

Output:
  [{a,1}, {b,2}, {c,0}]

Re-sorted by position ASC:
  [{c,0}, {a,1}, {b,2}]  ← matches targetOrder
```

### Why optimal wins

The hashmap turns the `O(m)` inner scan into `O(1)`. This is the most-used array-with-lookups optimization in interview problems and shows up everywhere in this codebase: every two-pass matcher uses it, the entry-meta join uses it, the autocomplete dedupe uses it. **Memorize this primitive: when you see nested loops with key-based search, build the map.**

### Follow-up an interviewer asks

> "What if `targetOrder` contains an ID that doesn't exist in `items`?"

In production code I'd ignore unknown IDs (the `if (item)` guard handles it) because the gesture library could send a stale ID after a delete. But in a stricter contract — say a server-side endpoint expecting client-side consistency — I'd surface unknowns explicitly: collect them into a `missing[]` array and return `{ updated, missing }`. The choice is about *who's responsible for the contract* — defensive UI vs. strict API.

---

## Problem 2 — Tree-flatten with hash-join

### Where this lives in loopd

[`app/todos.tsx`](../../../app/todos.tsx) — building the row list for the screen. `Entry[]` is loaded; each entry has nested `todos: TodoItem[]`. Separately, `TodoMeta[]` is loaded from `todo_meta`. The render layer needs a flat array of rows where each todo carries its parent's `entryDate` plus its meta. This is a tree-flatten plus hash-join in one pass.

### Problem statement

Given:

- `entries: { id; date; todos: { id; text; done }[] }[]`
- `metas: { todoId; type; stage }[]` — 1:1 with each TodoItem

Return `Row[]` where each row is `{ ...todo, entryId, entryDate, meta }`. If a todo has no matching meta, fill in a default `{ type: 'todo', stage: 'todo' }`.

### Brute force

For each todo, scan `metas` linearly. `O(N × M)` where `N` = total todos, `M` = total metas.

```ts
function joinBrute(entries: Entry[], metas: Meta[]): Row[] {
  const out: Row[] = [];
  for (const entry of entries) {
    for (const todo of entry.todos) {
      let meta = metas.find(m => m.todoId === todo.id);  // O(M)
      if (!meta) meta = { todoId: todo.id, type: 'todo', stage: 'todo' };
      out.push({ ...todo, entryId: entry.id, entryDate: entry.date, meta });
    }
  }
  return out;
}
// Time:  O(N × M)
// Space: O(N)
```

### Optimal

Build `Map<todoId, Meta>` once. Walk the tree linearly, doing `O(1)` lookups. Total `O(N + M)`.

```ts
function joinOptimal(entries: Entry[], metas: Meta[]): Row[] {
  const byId = new Map(metas.map(m => [m.todoId, m]));   // O(M)
  const out: Row[] = [];
  for (const entry of entries) {
    for (const todo of entry.todos) {
      const meta = byId.get(todo.id) ?? defaultMeta(todo);
      out.push({ ...todo, entryId: entry.id, entryDate: entry.date, meta });
    }
  }
  return out;
}
// Time:  O(N + M)
// Space: O(M) for map + O(N) for output
```

### ASCII trace — optimal

```
entries = [
  { id: "e1", date: "04-25", todos: [
      { id: "t1", text: "call mom" },
      { id: "t2", text: "buy milk" },
  ]},
  { id: "e2", date: "04-26", todos: [
      { id: "t3", text: "review PR" },
  ]},
]
metas = [
  { todoId: "t1", type: "todo",  stage: "todo" },
  { todoId: "t3", type: "idea",  stage: "in_progress" },
]

Step 1 — build byId (O(M)):
  byId = { "t1" → metas[0], "t3" → metas[1] }

Step 2 — flatten + join (O(N), each lookup O(1)):
  e1.t1  byId.get("t1") → metas[0]    → row{...t1, entryDate:"04-25", meta:metas[0]}
  e1.t2  byId.get("t2") → undefined   → row{...t2, entryDate:"04-25", meta:default}
  e2.t3  byId.get("t3") → metas[1]    → row{...t3, entryDate:"04-26", meta:metas[1]}

output: [
  {id:"t1", entryDate:"04-25", meta:{type:"todo"}},
  {id:"t2", entryDate:"04-25", meta:{type:"todo"}},   ← default
  {id:"t3", entryDate:"04-26", meta:{type:"idea"}},
]
```

### Why optimal wins

Same hashmap-join trick as Problem 1, applied during a tree flatten. The flatten itself doesn't add asymptotic cost — it's just nested iteration over a fixed dataset. The win is the inner lookup. **Pre-build the lookup; keep the inner loop O(1).** In databases this pattern has a name: *hash join*. It's literally what the SQL planner does when joining two tables on an indexed key.

### Follow-up an interviewer asks

> "How would this scale to 100k todos and 1k entries?"

At that volume the JS-side flatten becomes a render-time cliff. Three steps. (1) Move the join to SQL — a single `SELECT entries.id, entries.date, todos_json, todo_meta.* FROM entries LEFT JOIN todo_meta ON ...` returns the joined rows already, no JS hash needed. (2) Page the result — render only what's visible via virtualized lists like FlashList. (3) Index `todo_meta(todo_id)` so the SQL join is `O(N log M)` rather than full scan. The principle: at small scale, JS-side hash joins are fine; at large scale, push the join to the layer with the index.

---

## Problem 3 — Two-pass identity-preserving record matching

### Where this lives in loopd

[`src/services/todos/scanTodos.ts:63-88`](../../../src/services/todos/scanTodos.ts#L63-L88) — when a user types `[] foo` then edits it to `[] bar`, the scanner must recognize that the same todo got renamed (preserve `id`, `done`, `createdAt`) rather than treating it as delete + insert. Same pattern applies to nutrition lines.

### Problem statement

A user's prose contains lines like `[] foo` (todo) or `[x] bar` (done todo). Each line, in order, has a *line index* in the prose. You have a list of *existing* todos (from a previous parse) and the *new* parsed result. For each line, decide whether it matches an existing todo or creates a new one. Match rules in priority order:

1. **Pass 1**: line content (case-insensitive, trimmed) matches an existing todo's `text` exactly.
2. **Pass 2**: line index matches an existing todo's `sourceLine`.
3. Otherwise, this is a new todo.

After both passes, any existing todos that weren't claimed are "orphans" (their content was deleted from the prose). Return `{ matched: [{ existingId, lineIndex }], orphans: existingId[] }`.

### Brute force

For each new line, scan all existing todos for content match. Then for each unmatched line, scan all existing for sourceLine match. Time: `O(n × m)`. Space: `O(1)`.

```ts
type Existing = { id: string; text: string; sourceLine: number };
type NewLine = { content: string; lineIndex: number };

function matchBrute(existing: Existing[], newLines: NewLine[]) {
  const matched: { lineIdx: number; existingId: string }[] = [];
  const claimed = new Set<string>();

  // Pass 1
  for (const line of newLines) {
    for (const e of existing) {                         // O(m) per iter
      if (claimed.has(e.id)) continue;
      if (e.text.trim().toLowerCase() === line.content.trim().toLowerCase()) {
        matched.push({ lineIdx: line.lineIndex, existingId: e.id });
        claimed.add(e.id);
        break;
      }
    }
  }
  // Pass 2 (over still-unmatched lines, same O(m) inner scan)
  // ... similar nested loop
  const orphans = existing.filter(e => !claimed.has(e.id)).map(e => e.id);
  return { matched, orphans };
}
// Time:  O(n × m)
// Space: O(m) for claimed set
```

### Optimal

Two hash maps — one keyed by normalized content, one keyed by sourceLine. `O(n + m)` time, `O(n + m)` space.

```ts
function matchOptimal(existing: Existing[], newLines: NewLine[]) {
  const matched: { lineIdx: number; existingId: string }[] = [];
  const claimed = new Set<string>();
  const byText = new Map<string, Existing[]>();
  const byLine = new Map<number, Existing[]>();

  for (const e of existing) {
    const key = e.text.trim().toLowerCase();
    (byText.get(key) ?? byText.set(key, []).get(key)!).push(e);
    (byLine.get(e.sourceLine) ?? byLine.set(e.sourceLine, []).get(e.sourceLine)!).push(e);
  }

  // Pass 1: exact text match
  const unmatched: NewLine[] = [];
  for (const line of newLines) {
    const key = line.content.trim().toLowerCase();
    const candidates = byText.get(key);
    const pick = candidates?.find(c => !claimed.has(c.id));
    if (pick) {
      claimed.add(pick.id);
      matched.push({ lineIdx: line.lineIndex, existingId: pick.id });
    } else {
      unmatched.push(line);
    }
  }

  // Pass 2: sourceLine fallback
  for (const line of unmatched) {
    const candidates = byLine.get(line.lineIndex);
    const pick = candidates?.find(c => !claimed.has(c.id));
    if (pick) {
      claimed.add(pick.id);
      matched.push({ lineIdx: line.lineIndex, existingId: pick.id });
    }
  }

  const orphans = existing.filter(e => !claimed.has(e.id)).map(e => e.id);
  return { matched, orphans };
}
// Time:  O(n + m)
// Space: O(n + m)
```

### ASCII trace — optimal, edit-in-place case

```
The interesting test case: user changed line 0 from "foo" to "bar"
and line 2 stayed "baz". Identity should be preserved.

existing = [
  { id: "e1", text: "foo", sourceLine: 0 },
  { id: "e2", text: "bar", sourceLine: 1 },  ← unrelated row that
  { id: "e3", text: "baz", sourceLine: 2 },     happens to have
]                                                "bar" already
newLines = [
  { content: "bar", lineIndex: 0 },     ← user's edit of e1
  { content: "bar", lineIndex: 1 },     ← still e2
  { content: "baz", lineIndex: 2 },     ← still e3
]

Step 1 — build byText, byLine:
  byText = { "foo" → [e1],
             "bar" → [e2],
             "baz" → [e3] }
  byLine = { 0 → [e1], 1 → [e2], 2 → [e3] }
  claimed = {}

Pass 1 — exact text match:
  line[0] content="bar"  byText.get("bar") = [e2]  pick=e2 (not claimed)
                         match{lineIdx:0, e2}      claimed={e2}
  line[1] content="bar"  byText.get("bar") = [e2]  pick=undefined (claimed)
                         → unmatched
  line[2] content="baz"  byText.get("baz") = [e3]  pick=e3
                         match{lineIdx:2, e3}      claimed={e2, e3}

Pass 2 — sourceLine fallback for unmatched:
  line[1] lineIndex=1    byLine.get(1) = [e2]      pick=undefined (claimed)
                         → no match — this is a NEW row

Final:
  matched = [{0, e2}, {2, e3}]
  orphans = [e1]   ← e1's content "foo" is gone from the prose
                     (correctly identified — user replaced it)
  new lines (caller mints fresh): [{lineIndex:1, content:"bar"}]
```

The trace shows what makes two-pass non-trivial: `e2` and the renamed `e1` both have content `"bar"` after the edit, but Pass 1 deterministically picks the *unclaimed* one (which is `e2`), leaving `e1` to fall through to Pass 2 — where it doesn't find a sourceLine match (line 0 is now `"bar"`, owned by e2; line 1 is the new `"bar"` that fell through). So `e1` becomes an orphan and the user's edit at line 0 is correctly recognized as creating a brand-new row, not preserving the old `e1`'s identity.

The pathological case in the trace also reveals a real limitation: when the user duplicates a string in their prose, identity preservation is best-effort. In the loopd app this happens almost never; in a real tradeoff conversation I'd say so plainly.

### Why optimal wins

Three pieces.

1. **Two passes are non-negotiable.** A single-pass algorithm can't preserve identity through edits. A content-only matcher would link wrong todos when content shifts. A line-index-only matcher would lose track when content is reordered. Two-pass with claim tracking is the minimum correct algorithm.

2. **Hash maps turn the inner loop into `O(1)` lookup.** Without them you're at `O(n × m)`. With them, `O(n + m)` with a small constant.

3. **Claimed-set is the trick.** When two new lines have the same content, you don't want both to claim the same existing todo. The `Set` ensures one-to-one mapping; the second occurrence falls through to Pass 2.

This is the connection to classical algorithms: it's a degenerate case of bipartite matching, where the two passes are a heuristic instead of running Hungarian. For loopd's scale, the heuristic is correct often enough that we never need the full algorithm.

### Follow-up an interviewer asks

> "What if you had three matching dimensions instead of two — say, text, line-index, and a timestamp tiebreaker?"

Add a third pass with a third hashmap. The pattern generalizes cleanly: each dimension gets its own pre-built map; iterate the unmatched-from-previous-pass through the next pass; track claimed IDs in the same `Set`. The complexity stays `O(n + m × k)` where `k` is the number of dimensions, which is constant for any real problem.

The harder question is *priority order*. Two-pass with text-first then line-index-fallback works because text identity is "stronger" than positional identity — if the content matches, that's almost certainly the same record regardless of where it lives. If you swapped the order, you'd preserve identity through reorder but lose it through rename, which is the wrong tradeoff for prose editing. Picking the priority order is the design call; the algorithm is mechanical.

→ [11 — Defending AI-assisted work](./11-defending-ai-work.md)
