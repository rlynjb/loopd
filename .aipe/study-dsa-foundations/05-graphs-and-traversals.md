# Graphs and traversals — not exercised in buffr
## Industry name(s): graph, BFS, DFS, topological sort, shortest paths · Type: Foundational

> Buffr has nothing graph-shaped today. Threads-and-entries could be modeled as a bipartite graph; it isn't. Worth deliberate study because graphs are a recurring interview topic; not in product.

## Zoom out, then zoom in

```
  WHAT MIGHT LOOK GRAPH-SHAPED IN BUFFR

  threads ↔ entries        bipartite; modeled as join table
  todos can reference each other   not implemented
  thread mentions across days    not graph-modeled
```

Zoom in: the bipartite-graph framing of "thread mentions" is the most realistic place a graph traversal would help. Today it's a SQL JOIN, not a graph algorithm.

## Structure pass

```
  layers   ─ vertices ─ edges ─ traversal ─ algorithm
  axes     ─ directed vs undirected
             ─ weighted vs unweighted
```

## How it works

### Move 1 — BFS

```
  queue-based level-by-level traversal.
  uses: shortest unweighted path; connected components.
```

### Move 2 — DFS

```
  stack-based (or recursive) deep-first traversal.
  uses: cycle detection; topological sort.
```

### Move 3 — shortest paths

```
  Dijkstra: weighted; non-negative; heap-backed.
  Bellman-Ford: weighted; allows negative.
```

## Implementation in codebase

Not used. Study target.

## Elaborate

The day buffr has features like "related threads," "show me what depends on this todo," "summarize this thread by traversing all entries that touch it," graph algorithms become real. Today the SQL JOIN is enough.

## Interview defense

**Q [mid]:** Explain BFS vs DFS.

**A:** BFS uses a queue; explores level by level; finds shortest unweighted path. DFS uses a stack (or recursion); explores deep first; useful for cycle detection.

**Q [senior]:** When would buffr need a graph?

**A:** Cross-thread references that form a DAG. Not implemented today.

## Validate

### Level 1 — define vertex, edge, BFS, DFS.

### Level 2 — explain when shortest-path matters.

### Level 3 — apply: detect cycles in thread references.

### Level 4 — defend: "Adopt graph DB." Wrong; buffr doesn't have graph-shaped queries.

## See also

- `03-stacks-queues-deques-and-heaps.md`
- `07-recursion-backtracking-and-dynamic-programming.md`
- `08-dsa-foundations-practice-map.md`
