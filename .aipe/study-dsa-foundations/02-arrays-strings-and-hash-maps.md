# Arrays, strings, and hash maps — buffr's actual in-memory work
## Industry name(s): array, string, hash map, hash set · Type: Foundational

> The reconcileMeta diff is a hash-map keyed by stable line key. The chain cache is a hash-by-content. Both are textbook hash-map use. Almost everything else is plain JS arrays.

## Zoom out, then zoom in

```
  THE STRUCTURES BUFFR EXERCISES

  Array<T>        UI lists; reconcile input
  Map<K, T>       reconcile existing-by-key
  Set<K>          reconcile "seen" tracking
  hash string     ai_summaries cache key
  JSON string     entries.text; serialized meta
```

Zoom in: the reconcile diff is the most algorithmically interesting code in buffr. It's a textbook three-step diff over Maps + Set.

## Structure pass

```
  layers   ─ raw bytes ─ JS array/string ─ Map/Set
  axes     ─ ordered (array) vs unordered (set/map)
             ─ identity (=== vs hash)
```

## How it works

### Move 1 — Map for "existing rows keyed by stable id"

```
  const existing = new Map<string, TodoMeta>();
  for (const row of existingRows) existing.set(row.lineKey, row);
  
  O(N) build, O(1) lookup. classic.
```

### Move 2 — Set for "what's been seen"

```
  const seen = new Set<string>();
  for (const todo of newTodos) {
    seen.add(todo.lineKey);
    // ...
  }
  // soft-delete the ones not seen
  for (const existing of existingRows) {
    if (!seen.has(existing.lineKey)) softDelete(existing);
  }
```

### Move 3 — hash by content for the cache

```
  const key = sha256(chain + canonicalize(input));
  
  content-addressable: same input → same key → same cached row.
  this is THE algorithm that gives the chain composition pattern
  its cost-control teeth.
```

## Implementation in codebase

```ts
// pattern; src/services/prose/reconcileTodos.ts
async function reconcileTodos(tx, entry, todos, userId) {
  const existing = new Map<string, TodoMeta>(
    (await tx.queryAll<TodoMeta>(`SELECT * FROM todo_meta WHERE entry_id = ?`, [entry.id]))
      .map(t => [t.lineKey, t])
  );
  const seen = new Set<string>();
  for (const todo of todos) {
    seen.add(todo.lineKey);
    if (existing.has(todo.lineKey)) updateRow(...);
    else insertRow(...);
  }
  for (const [key, row] of existing) {
    if (!seen.has(key)) softDelete(row);
  }
}
```

```ts
// pattern; src/services/ai/cache.ts
const key = sha256(chain + JSON.stringify(canonicalInput));
```

## Elaborate

The "Map + Set diff" pattern generalizes to most "given old set and new set, reconcile" problems. The cost is O(N) in the size of the larger set. Hash collisions in practice are zero at this scale.

## Interview defense

**Q [mid]:** Walk me through reconcileMeta.

**A:** Build a Map of existing rows keyed by lineKey. Iterate new items, marking each "seen" — update if exists, insert if not. Then soft-delete anything in existing that wasn't seen. Three passes; O(N).

**Q [senior]:** Why a content hash for the cache key?

**A:** Content-addressable means the same input always maps to the same key. If the user re-enters the same prose, the cache hits. No explicit invalidation.

## Validate

### Level 1 — define hash map vs hash set.

### Level 2 — explain the three-step diff.

### Level 3 — apply: diff two lists of files by path.

### Level 4 — defend: "Use Array.indexOf instead of a Set." O(N²) instead of O(N).

## See also

- `01-complexity-and-cost-models.md`
- `../study-system-design/04-prompt-driven-prose-commit.md`
- `../study-system-design/03-chain-composition-with-cache-shortcircuit.md`
