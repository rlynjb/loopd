# Trees, tries, and balanced indexes — on-disk only in buffr
## Industry name(s): binary tree, B-tree, trie · Type: Foundational

> Buffr's only tree usage is the on-disk B-tree behind the composite PK index (Postgres + SQLite). No in-memory tree. No trie. Worth studying because trees appear constantly in interview questions; in product code they're rare.

## Zoom out, then zoom in

```
  TREES IN BUFFR

  on-disk:
   ─ B-tree per index (PK on every synced table)
  
  in-memory:
   ─ none
```

Zoom in: the B-tree is doing all the heavy lifting at the index layer (`study-database-systems/03`). Buffr's code never sees the tree structure — it sees the index by name and the query planner picks it.

## Structure pass

```
  layers   ─ data structure ─ access pattern
  axes     ─ in-memory vs on-disk
             ─ balanced vs degenerate
```

## How it works

### Move 1 — binary tree basics

```
  each node has up to 2 children. binary search tree: ordered.
  balanced (AVL, RB): O(log N) ops; unbalanced: O(N) worst case.
```

### Move 2 — B-tree is a fat tree for disk

```
  high fan-out (hundreds of children per node).
  designed for disk page reads (one page per node).
  Postgres + SQLite use B-trees for indexes.
```

### Move 3 — tries for prefix queries

```
  one node per character; children indexed by next character.
  good for autocomplete, prefix search.
  not used in buffr; no autocomplete today.
```

## Implementation in codebase

```sql
-- the B-tree behind every PK
PRIMARY KEY (user_id, id)
```

That's it. No app-level tree.

## Elaborate

Worth deliberate practice: BST insert/delete, in-order traversal, level-order traversal. Common interview material. None of it in buffr.

## Interview defense

**Q [mid]:** What's a B-tree?

**A:** A balanced search tree with high fan-out. Each node corresponds to a disk page. Postgres and SQLite use it for indexes.

**Q [senior]:** When is a trie better than a hashmap?

**A:** Prefix queries: "give me all keys starting with 'rec'". Hashmap can't do that; trie can.

## Validate

### Level 1 — define BST.

### Level 2 — explain why B-trees over BSTs for disk.

### Level 3 — apply: autocomplete on thread names. Trie or just sorted-list-prefix-search.

### Level 4 — defend: "Replace SQLite indexes with hashmaps." Hashmaps can't do range scans.

## See also

- `../study-database-systems/03-btree-hash-and-secondary-indexes.md`
- `02-arrays-strings-and-hash-maps.md`
- `05-graphs-and-traversals.md`
