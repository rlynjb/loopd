# Sorting, searching, and selection — what buffr lets the DB do
## Industry name(s): merge sort, quicksort, binary search, quickselect · Type: Foundational

> Buffr sorts via SQL (`ORDER BY`) and via JS `Array.sort` (V8/Hermes' implementation). No app-level binary search; SQLite/Postgres do it through the index. Worth studying because sorting and searching are foundational.

## Zoom out, then zoom in

```
  WHERE BUFFR SORTS

  SQL ORDER BY     sync pull (updated_at), list views
  Array.sort       UI rendering occasionally
  
  WHERE BUFFR SEARCHES
  SQL index        every WHERE clause that hits the PK
  no manual binary search anywhere
```

Zoom in: at buffr's scale, in-memory sort is free (small arrays). The interesting sort is the SQL one, which the planner handles.

## Structure pass

```
  layers   ─ data ─ algorithm ─ complexity
  axes     ─ stable vs unstable
             ─ comparison vs non-comparison
```

## How it works

### Move 1 — comparison sort lower bound is O(N log N)

```
  merge sort, heap sort, quicksort: all O(N log N) on average.
  quicksort is fastest in practice; merge sort is stable.
  V8/Hermes uses Timsort (stable, hybrid).
```

### Move 2 — binary search needs sorted data

```
  O(log N). only works on sorted arrays.
  buffr's DB indexes are sorted; the planner uses binary search
  on them implicitly.
```

### Move 3 — selection: find Kth without full sort

```
  quickselect: O(N) average. uses partition step from quicksort.
  in buffr: not used; no "top-K" queries today.
```

## Implementation in codebase

```ts
// JS-side sort
entries.sort((a, b) => b.updated_at - a.updated_at);
// for ~365 rows: free.
```

```sql
-- SQL sort; the planner picks merge or quick depending on indexes
SELECT * FROM entries WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30;
```

## Elaborate

The "let the DB sort" rule is the right move for any persisted data — the planner has stats, indexes, and can use disk if needed. In-memory sort on the device is only correct when the data is small AND already filtered.

## Interview defense

**Q [mid]:** What's V8/Hermes' sort algorithm?

**A:** Timsort. Stable, hybrid merge+insertion. O(N log N) worst case.

**Q [senior]:** When do you reach for quickselect?

**A:** Top-K without needing the full sorted order. O(N) average.

## Validate

### Level 1 — define stable sort.

### Level 2 — explain why DB sort beats app sort for large data.

### Level 3 — apply: top 10 most-recent entries. SQL ORDER BY ... LIMIT 10.

### Level 4 — defend: "Always sort on the client." Wrong for large data.

## See also

- `01-complexity-and-cost-models.md`
- `../study-database-systems/04-query-planning-and-execution.md`
- `03-stacks-queues-deques-and-heaps.md`
