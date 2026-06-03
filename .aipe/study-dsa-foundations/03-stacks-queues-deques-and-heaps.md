# Stacks, queues, deques, and heaps — not exercised in buffr
## Industry name(s): LIFO/FIFO/priority queue, heap · Type: Foundational

> Buffr's sync dirty-filter is the closest thing to a queue, and even that's a query, not a data structure. No stack, no priority queue, no heap. Worth studying because they show up everywhere else; just not in this codebase.

## Zoom out, then zoom in

```
  THE STRUCTURES

  Stack    LIFO. balanced parens; DFS; undo.
  Queue    FIFO. BFS; sync queue; event bus.
  Deque    both ends. sliding window; LRU.
  Heap     priority. top-k; Dijkstra; scheduling.

  in buffr: NONE explicitly used.
```

Zoom in: the SQL "queue" of dirty rows is a degenerate queue (the order is by `updated_at`, not insertion order; consumers don't pop). It's a query, not a queue.

## Structure pass

```
  layers   ─ underlying array ─ access discipline
  axes     ─ end of access (top vs front)
```

## How it works

### Move 1 — stack: LIFO

```
  push to top; pop from top.
  in JS: array.push() / array.pop() (O(1) amortized).
  uses: DFS, undo, balanced parens.
```

### Move 2 — queue: FIFO

```
  push to back; pop from front.
  in JS: array.push() / array.shift() (shift is O(N); use deque
   or two-stacks if perf matters).
  uses: BFS, event bus.
```

### Move 3 — heap: priority

```
  binary heap, log N insert and pop-min.
  uses: top-k, scheduling, Dijkstra.
  in JS: no built-in; use a small library or hand-roll.
```

## Implementation in codebase

Not used. The reader's study target.

## Elaborate

Worth practicing on LeetCode-style problems because heap-based "top K" and "merge K sorted lists" are common interview material. None of it is in product code.

## Interview defense

**Q [mid]:** What's a heap?

**A:** A complete binary tree with the heap property (min-heap: parent ≤ children). Insert/pop are log N.

**Q [senior]:** When do you reach for a heap?

**A:** Top-K queries on a stream; scheduling; Dijkstra. None of these in buffr today.

## Validate

### Level 1 — define stack, queue, heap.

### Level 2 — explain why JS array.shift() is O(N).

### Level 3 — apply: top-K most-mentioned threads in entries.

### Level 4 — defend: "Use a heap for sync queue." Not needed; SQLite handles ordering.

## See also

- `02-arrays-strings-and-hash-maps.md`
- `04-trees-tries-and-balanced-indexes.md`
- `06-sorting-searching-and-selection.md`
- `08-dsa-foundations-practice-map.md`
