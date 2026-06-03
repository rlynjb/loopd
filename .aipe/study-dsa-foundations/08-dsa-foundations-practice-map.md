# The DSA practice map — what to study, ranked
## Industry name(s): DSA learning plan, foundations curriculum · Type: Audit summary

> A ranked learning plan for someone studying DSA against buffr. Exercised material first (it's already in your codebase, defend it confidently); foundations second (interview-relevant, not in buffr).

## Zoom out, then zoom in

```
  TIER 1: ALREADY EXERCISED IN BUFFR — defend confidently
  ─────────────────────────────────────────────────────
  ─ Hash maps / hash sets (reconcileMeta)
  ─ Content hashing (ai_summaries cache)
  ─ Sorted scans by date/updated_at (UI lists, sync pull)
  ─ Cost models for I/O vs CPU
  ─ B-tree as a black box (PK index)

  TIER 2: NOT IN BUFFR, COMMON IN INTERVIEWS — practice
  ─────────────────────────────────────────────────────
  ─ Binary search (general; not via DB)
  ─ BFS / DFS / topological sort
  ─ Recursion + memoization
  ─ Heaps (top-K, scheduling)
  ─ Two pointers (sliding window)
  ─ DP (knapsack, edit distance, LCS)

  TIER 3: LESS LIKELY BUT FOUNDATIONAL — read
  ─────────────────────────────────────────────────────
  ─ Tries (prefix queries)
  ─ Backtracking (N-queens shape)
  ─ Shortest paths (Dijkstra)
  ─ Union-find (connected components)
```

Zoom in: ~70% of buffr's algorithmic surface is hash-map work. The remaining 30% is "the DB does it for us." That's why Tier 1 is short.

## Structure pass

```
  axis = "what's already defensible vs what needs practice?"
```

## How it works

### Move 1 — defend what's exercised

```
  reconcileMeta: Map + Set diff. classic shape.
  ai_summaries cache: content-keyed memoization.
  sync pull: sorted scan by updated_at.
```

### Move 2 — practice the gaps deliberately

```
  recommended:
   ─ pick LeetCode "medium" problems organized by topic
   ─ work through one Tier 2 topic per week
   ─ explain solutions out loud (interview practice)
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ a DSA-light codebase is honest. don't manufacture│
   │ algorithms to seem clever. defend the cost-model │
   │ decisions you made; study the gaps deliberately. │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   the practice plan

   week 1   arrays + hashing                    ◄── confirm Tier 1
   week 2   two pointers + sliding window
   week 3   binary search (general)
   week 4   stacks + queues
   week 5   trees + BFS / DFS
   week 6   recursion + memoization
   week 7   DP (1D, then 2D)
   week 8   heaps + top-K
   week 9   graphs (Dijkstra, union-find)
   week 10  string algorithms (KMP, Z, trie)
   ...
```

## Interview defense

**Q [mid]:** What DSA does buffr use?

**A:** Hash-map diff in reconcileMeta. Content-hashed cache. Sorted scans handled by the DB. Most algorithmic work is I/O-bound, not CPU-bound, which makes the DSA surface intentionally small.

**Q [senior]:** What's the most algorithmically interesting code?

**A:** reconcileMeta. Three-pass Map+Set diff. O(N) in the size of the larger todo set. Standard shape.

**Q [arch]:** How would you make buffr more DSA-heavy?

**A:** I wouldn't — the DSA surface is correctly small for the use case. Adding manual algorithms where the DB does the work is over-engineering.

## Validate

### Level 1 — list Tier 1 confidently.

### Level 2 — pick a Tier 2 topic and explain why it's foundational.

### Level 3 — apply: take a LeetCode problem and explain how its shape relates to buffr's reconcile.

### Level 4 — defend: "Don't bother with DSA practice; you have a job." Wrong; interview prep + transferable foundations.

## See also

- All concept files 01–07.
- `../study-system-design/audit.md`
- `../study-database-systems/03-btree-hash-and-secondary-indexes.md`
