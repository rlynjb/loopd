# Complexity and cost models — what to count, when
## Industry name(s): Big-O, amortized analysis, space complexity · Type: Foundational

> The thing to count is what dominates the operation. For buffr, that's almost always disk I/O on SQLite or network round-trips on sync. In-memory CPU rarely matters.

## Zoom out, then zoom in

```
  THE COST HIERARCHY (typical mobile)

  CPU op           ~1 ns
  memory hit       ~10 ns
  SQLite read      ~10 µs (warm) to 1 ms (cold)
  SQLite write     ~100 µs to 10 ms
  HTTP roundtrip   ~50-500 ms
  LLM call         ~500 ms to 30 s
```

Zoom in: optimizing buffr's CPU is rounding error. Optimizing buffr's number of LLM calls is product-defining. The cost model has to match the actual workload.

## Structure pass

```
  layers   ─ analysis ─ what's counted ─ what matters
  axes     ─ time vs space
             ─ worst vs amortized
  seams    ─ asymptotic vs constant-factor matters
```

## How it works

### Move 1 — pick the right cost

```
  for buffr:
   ─ reconcile complexity: count comparisons (O(n) on todo lines)
   ─ sync complexity:      count network roundtrips (O(tables))
   ─ chain complexity:     count LLM calls (O(uncached candidates))
```

### Move 2 — amortized matters more than worst-case

```
  upsert in PostgREST: amortized O(log n) for the index lookup.
  worst-case spike on a full-page write doesn't matter at buffr's scale.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ the cost model must match what dominates the     │
   │ operation. for buffr that's I/O and LLM calls;   │
   │ CPU complexity rarely matters. always state your │
   │ cost model BEFORE optimizing.                     │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   cost-of-an-operation pyramid

   LLM call          ~500ms-30s     ← optimize here first
   network HTTP      ~50-500ms
   SQLite write      ~100µs-10ms
   SQLite read       ~10µs-1ms
   memory op         ~10ns
   CPU op            ~1ns           ← rarely worth optimizing
```

## Implementation in codebase

```ts
// the most expensive thing buffr does
await callLLM(prompt);  // budget by hits saved via cache + heuristic
```

The compose pattern's cache short-circuit is the biggest single cost-model optimization in the codebase.

## Elaborate

The "wrong cost model" trap is the classic premature optimization. Engineers tune in-memory algorithms when the bottleneck is a network roundtrip. Buffr's heuristic-before-LLM pattern is a model example of the right cost model — saving LLM calls, not CPU.

## Interview defense

**Q [mid]:** What's the cost model for sync push?

**A:** Network roundtrips. The CPU cost of building the batch is rounding error.

**Q [senior]:** What's amortized analysis?

**A:** Average over a sequence of operations rather than worst-case any single one. For upsert: most are cheap; occasional full-page writes amortize down.

## Validate

### Level 1 — list the cost hierarchy.

### Level 2 — explain why CPU rarely matters here.

### Level 3 — apply: choose between a 100µs CPU optimization and a 1-call LLM cache improvement. The LLM cache wins.

### Level 4 — defend: "Always pick the best Big-O." Wrong when constants dominate.

## See also

- `06-sorting-searching-and-selection.md`
- `../study-system-design/05-heuristic-before-llm-classifier.md`
- `../study-database-systems/04-query-planning-and-execution.md`
