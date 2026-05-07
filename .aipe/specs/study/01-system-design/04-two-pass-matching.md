# Two-pass matching

> Every prose-derived feature (todos, threads, mentions) matches existing rows in two passes — exact text first, line-index second — so identity survives both reorderings and same-line edits.

**See also:** → [03-single-source-of-truth](./03-single-source-of-truth.md) · → [06-one-to-one-invariant](./06-one-to-one-invariant.md) · → [02-dsa/01-two-pass-scan-todos](../02-dsa/01-two-pass-scan-todos.md)

---

## Quick summary
- **What:** Pass 1 matches by exact text (catches reorderings). Pass 2 matches by line index (catches "I edited the words on this line").
- **Why here:** preserves the row's id, createdAt, classifier output, and expansion across edits without requiring the user to declare identity explicitly.
- **Tradeoff:** "I edited line 7" looks the same as "I deleted line 7 and added a new todo" to the algorithm. Acceptable; the classifier re-runs either way.

---

## Two-pass matching — diagram

```
  Existing todos:                    New scan of text:
  ┌─────────────────────┐            ┌─────────────────────┐
  │ id=t1 "call mom"    │            │ line 3: "call mom"  │
  │ id=t2 "ship feat"   │            │ line 5: "fix bug"   │
  │ id=t3 "fix bug"     │            │ line 7: "ship feature"│
  └─────────────────────┘            └─────────────────────┘
                                              │
                            ┌─────────────────┴─────────────────┐
                            │                                   │
                            ▼ Pass 1: exact text match          │
                      ┌─────────────────────┐                   │
                      │ "call mom"  → t1 ✓  │                   │
                      │ "fix bug"   → t3 ✓  │                   │
                      │ "ship feat" → ??    │ ← user edited it  │
                      └─────────────────────┘                   │
                                                                │
                            ▼ Pass 2: line-index fallback ◀─────┘
                      ┌─────────────────────────────┐
                      │ line 7 was previously t2    │  → t2 ✓
                      │ (sourceLine match)          │
                      └─────────────────────────────┘
```

---

## How it works

The scanner produces a list of "matches" (every `[]` line found in the prose). The matcher then walks the list twice.

Pass 1 looks for an existing todo whose text equals the match's text (case-insensitive). If found and the existing row hasn't been claimed by an earlier pass, claim it. This catches the common case: nothing changed except line position.

Pass 2 walks the still-unclaimed matches and looks for an existing todo whose `sourceLine` equals the match's current line index. This catches the case: the user edited the words but the line position is the same.

Anything left unmatched is a new todo. Anything unmatched on the existing side is a "carryover" (its line is gone from prose; the row is preserved with `sourceLine` cleared).

---

## In this codebase

- `src/services/todos/scanTodos.ts` → `scanTodosFromText()` implements both passes.
- `src/services/threads/scanThreads.ts` → `reconcileMentions()` does the same shape with a `±3 line shift` window in Pass 2.

```
Pseudocode (scanTodosFromText):
  matches = collectMatches(text)             // [] lines from prose
  claimed = empty map
  used    = empty set

  // Pass 1
  for i in 0..matches.length:
    prior = first existing where text matches AND id not used
    if prior:
      claimed[i] = prior; used.add(prior.id)

  // Pass 2
  for i in 0..matches.length:
    if claimed has i: continue
    prior = first existing where sourceLine == matches[i].lineIndex AND id not used
    if prior:
      claimed[i] = prior; used.add(prior.id)

  // Build output
  out = []
  for i in 0..matches.length:
    if claimed[i] exists: out.push({ ...claimed[i], text: matches[i].content, sourceLine: i })
    else:                 out.push(newTodo(matches[i]))

  // Carryover: existing todos that matched nothing stay (sourceLine cleared)
  carryover = existing where id not used
  return [...carryover, ...out]
```

---

## Elaborate

### Where this pattern comes from
This is a simplified diff algorithm — Myers' diff and its descendants do exactly this kind of two-pass match (LCS first, fallback heuristics second) at character/line granularity. Loopd applies the idea to row identity: "what stayed the same? then what shifted?"

### The deeper principle
**Identity ≠ content.** A row's id is the user's investment over time (classifier output, AI expansion, pin state). Edits to content shouldn't destroy identity. Two-pass matching is the cheapest way to preserve identity without making the user declare it.

### Where this breaks down
- Bulk reorders combined with bulk text edits — the algorithm degrades because Pass 1 misses (text changed) and Pass 2 misses (line shifted).
- Two identical lines on the same day — the order of claims matters; subtle bugs lurk if the matcher isn't strict about "no double-claim."

### What to explore next
- [The 1:1 invariant](./06-one-to-one-invariant.md) → what runs after the scanner to keep `todo_meta` aligned.
- [02-dsa/01-two-pass-scan-todos](../02-dsa/01-two-pass-scan-todos.md) → the exact algorithm with execution trace.
- Myers diff → if you want to understand the broader family.

---

## Tradeoffs

- **Two passes** — gives: identity survives the common edits. Costs: O(n×m) brute path; the actual codebase uses Map+Set for O(n+m).
- **Text-first, line-second** — gives: reorders always win. Costs: hard to tell apart "edit-in-place" from "delete-and-add-on-same-line."
- **Carryover preserved** — gives: a row with no current prose line stays in the DB until explicitly deleted. Costs: orphan-like rows accumulate; the soft-delete + reconciler combo cleans them up over time.
