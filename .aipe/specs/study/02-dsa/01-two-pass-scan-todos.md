# Two-pass scan: matching prose lines to existing todos

> Map + Set in two passes — exact text first, then line-index fallback. Preserves todo identity across edits without requiring the user to declare it.

**See also:** → [02-reconcile-todo-meta](./02-reconcile-todo-meta.md) · → [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md) · → [01-system-design/04-two-pass-matching](../01-system-design/04-two-pass-matching.md)

---

## Quick summary
- **What:** `scanTodosFromText` matches `[]` lines to existing TodoItems, preserving id/createdAt/classifier output across edits.
- **Why here:** identity must survive prose edits. Pass 1 catches reorderings; Pass 2 catches "same line, different words."
- **Tradeoff:** can't tell apart "I edited line 7" from "I deleted line 7 and added a new todo on line 7" — both look the same to the algorithm.

**Real operation:** `scanTodosFromText` in `src/services/todos/scanTodos.ts`. Runs at every commit (focus blur, screen leave) on `entries.text`.

---

## The data

```
  text (entry.text):
    "Morning notes
     [] call mom
     [] write spec
     [x] book dentist
     idea: refactor scanner"

  existing TodoItem[]:
    [
      { id: "t-A", text: "call mom",      done: false, sourceLine: 1, createdAt: "...", completedAt: null },
      { id: "t-B", text: "draft spec",    done: false, sourceLine: 2, createdAt: "...", completedAt: null },
      { id: "t-C", text: "book dentist",  done: false, sourceLine: 3, createdAt: "...", completedAt: null },
    ]
```

**The problem:** produce a new `TodoItem[]` where existing rows survive across edits. "call mom" is unchanged → keep `t-A`. "draft spec" was edited to "write spec" on the same line → keep `t-B` via line-index fallback. "book dentist" is now `[x]` → keep `t-C`, set `done=true`, stamp `completedAt`.

---

## Brute force

```
  for each line in text:
    for each existing todo:
      if line.text equals existing.text (case-insensitive):
        match!
      else if line.lineIndex equals existing.sourceLine:
        match!
  // O(n × m) with backtracking on duplicates
```

**Execution trace** (lines = 4 [], existing = 3):

```
  step  line                  scan over existing                  claim
  ────  ────────────────────  ──────────────────────────────────  ──────
  1     line 1 "call mom"     t-A.text == ✓                        t-A
  2     line 2 "write spec"   t-A used; t-B.text != ; t-C.text !=  none yet
                              re-scan w/ line-index: t-B.line==2 ✓ t-B
  3     line 3 "book dentist" t-A used; t-B used; t-C.text == ✓    t-C
  4     line 4 "idea: ..."    NOT a [] line, skipped                —
```

**Complexity:** O(n × m) time · O(n) space — where n = `[]` lines, m = existing todos.

**What goes wrong at scale:** a single entry rarely has more than 20-30 todos in this app, so even at O(n × m) the absolute count is tiny (600 ops max). Scale isn't the issue here. The issue is *correctness* on duplicates: a naive loop matches the same existing todo to two different lines.

---

## Optimal

**The insight:** track which existing ids are already claimed (`Set`), and iterate matches in two distinct passes — exact text first (so reorderings always win), line-index second (so single-line edits keep their identity).

```
  matches = collectMatches(text)             // de-duped [] lines
  claimed = empty Map<int, TodoItem>
  used    = empty Set<string>

  // Pass 1 — exact text match
  for i in 0..matches.length:
    key = matches[i].content.toLowerCase()
    prior = first existing where prior.text.lower == key AND prior.id NOT in used
    if prior:
      claimed[i] = prior
      used.add(prior.id)

  // Pass 2 — line-index fallback
  for i in 0..matches.length:
    if claimed has i: continue
    li = matches[i].lineIndex
    prior = first existing where prior.sourceLine == li AND prior.id NOT in used
    if prior:
      claimed[i] = prior
      used.add(prior.id)

  // Build output
  out = []
  for i in 0..matches.length:
    m = matches[i]
    prior = claimed[i]
    if prior:
      out.push({
        ...prior,
        text: m.content,
        done: m.isDone,
        completedAt: prior.done != m.isDone
                     ? (m.isDone ? now : null)
                     : prior.completedAt,
        sourceLine: m.lineIndex,
      })
    else:
      out.push(newTodo(m))

  // Carry over the unmatched
  carryover = existing where id NOT in used, with sourceLine cleared
  return [...carryover, ...out]
```

**Execution trace** (same input):

```
  Pass 1 (exact text):
    i=0  match "call mom"      → t-A unused, text== ✓     claimed[0]=t-A used={t-A}
    i=1  match "write spec"    → no exact match           claimed[1]=∅  used={t-A}
    i=2  match "book dentist"  → t-C unused, text== ✓     claimed[2]=t-C used={t-A,t-C}

  Pass 2 (line-index):
    i=0  claimed                                        skip
    i=1  claimed[1]=∅, line=2 → t-B sourceLine==2 ✓     claimed[1]=t-B used={t-A,t-B,t-C}
    i=2  claimed                                        skip

  Build out:
    i=0 prior=t-A → out += { id:t-A, text:"call mom",     done:false, completedAt:null }
    i=1 prior=t-B → out += { id:t-B, text:"write spec",   done:false, completedAt:null }
    i=2 prior=t-C → out += { id:t-C, text:"book dentist", done:true,  completedAt:now } ← flipped
    used = {t-A,t-B,t-C}

  Carryover: existing.filter(id ∉ used) → [] (none)

  Result: [t-A, t-B, t-C] — same ids, t-B's text updated, t-C's done flipped.
```

**Complexity:** O(n + m) time after the Map/Set conversion (linear scans, O(1) Set lookups) · O(n + m) space.

**Why it's faster:** the brute-force version does O(m) work *inside* the line loop (re-scanning existing each time) and re-checks already-claimed rows. With a `Set<string>` of used ids and a guarded `Map<int, TodoItem>` of claims, each existing row is touched at most twice (once per pass).

---

## Comparison

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n × m)       │ O(n + m) amort.  │
  │ Space           │ O(n)           │ O(n + m)         │
  │ At 30 todos     │ 900 ops        │ 60 ops           │
  │ At 300 todos    │ 90,000 ops     │ 600 ops          │
  │ Correctness     │ duplicates ✗   │ Set-guarded ✓    │
  └─────────────────┴────────────────┴──────────────────┘
```

**When brute force is fine:** never. The Set guard isn't an optimization — it's correctness. Two `[]` lines with the same text would both claim the same todo and one would be reused twice.

---

## In this codebase

- `src/services/todos/scanTodos.ts` → `scanTodosFromText()` and `collectMatches()`.
- Called by every prose-edit commit path that touches a journal entry.

---

## Elaborate

### Where this pattern comes from
The two-pass match is a simplification of Myers diff: take the cheap exact-match pass first, then run a tighter pass over what's left. Source-control diff tools have used variants of this for decades.

### The deeper principle
**Pass priority encodes evidence quality.** Exact-text match is stronger evidence of "same thing" than line-index match. Running them in priority order means the strongest signal wins; the weaker one only fills in the gaps.

### Where this breaks down
- Bulk edit + bulk reorder in the same commit. Both passes can miss.
- Two identical lines on the same day — depends on `Set`-guarded order to avoid double-claim.

### What to explore next
- [02-reconcile-todo-meta](./02-reconcile-todo-meta.md) → what runs after this scan.
- [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md) → same pattern, looser Pass 2.
- Myers diff → for the deeper algorithm.

---

## Tradeoffs

- **Map + Set** — gives: O(n+m) time + correctness. Costs: extra structures (memory, allocation).
- **Two passes** — gives: identity survives common edits. Costs: can't disambiguate edit-in-place from delete-and-add.
- **Carryover preserved** — gives: rows aren't lost if their line goes away briefly. Costs: orphan-like rows accumulate until reconcile cleans them.
