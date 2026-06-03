# Recursion, backtracking, and dynamic programming — not in product code
## Industry name(s): recursion, backtracking, memoization, tabulation · Type: Foundational

> Buffr's product code has no recursion, no backtracking, no DP. Worth deliberate study — these are foundational interview material — but they don't appear in the codebase.

## Zoom out, then zoom in

```
  WHAT'S COVERED HERE                  WHAT BUFFR USES IT FOR
  ─ recursion (function calls itself)   none in product
  ─ backtracking (explore + undo)        none in product
  ─ memoization (cache subproblem)       same idea as ai_summaries
                                          cache (content-key memoize)
  ─ tabulation (bottom-up DP)            none in product
```

Zoom in: the chain cache (`ai_summaries`) is structurally a memoization — same input always returns the same output, cache hits short-circuit recomputation. The pattern is the same; the algorithm domain is different (LLM call rather than recursive function).

## Structure pass

```
  layers   ─ subproblem ─ recurrence ─ cache
  axes     ─ top-down (memo) vs bottom-up (tabulate)
```

## How it works

### Move 1 — recursion

```
  function calls itself. base case + recursive case.
  watch: stack depth limit (~10k on Hermes by default).
```

### Move 2 — memoization is the recursion + cache pattern

```
  fib(n):
    if cache.has(n) return cache.get(n);
    if n <= 1 return n;
    const result = fib(n-1) + fib(n-2);
    cache.set(n, result);
    return result;
  
  same shape as buffr's chain cache. different domain.
```

### Move 3 — tabulation: bottom-up fill of a table

```
  fib_table[0] = 0; fib_table[1] = 1;
  for i in 2..n: fib_table[i] = fib_table[i-1] + fib_table[i-2];
  
  no recursion; O(N) space; O(N) time.
```

## Implementation in codebase

```ts
// the ai_summaries cache IS memoization
// just at a different scale (DB-side, content-keyed)
```

## Elaborate

The reader's study plan should prioritize: (a) DP on classic problems (knapsack, edit distance, longest common subsequence), (b) backtracking (N-queens, sudoku), (c) recursion with explicit memo. None directly applicable to buffr; all common in interviews.

## Interview defense

**Q [mid]:** What's memoization?

**A:** Caching results of function calls by argument. Saves recomputation in recursion with overlapping subproblems.

**Q [senior]:** When do you reach for DP?

**A:** Problems with overlapping subproblems and optimal substructure. Edit distance, knapsack, longest common subsequence.

## Validate

### Level 1 — define recursion, memoization, tabulation.

### Level 2 — explain how the chain cache is memoization.

### Level 3 — apply: edit distance for autocorrect. Standard DP.

### Level 4 — defend: "Use recursion for the reconcile algorithm." Why? It's a flat iteration; recursion adds nothing.

## See also

- `02-arrays-strings-and-hash-maps.md`
- `../study-system-design/03-chain-composition-with-cache-shortcircuit.md`
- `08-dsa-foundations-practice-map.md`
