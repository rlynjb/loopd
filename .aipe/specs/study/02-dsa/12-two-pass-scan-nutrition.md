# Two-pass scan: matching nutrition prose to existing rows

**Industry name(s):** — (project-specific composition of exact-match + line-index fallback for nutrition prose)
**Type:** Project-specific

> Map + Set in two passes — exact `(name, kcal)` first, then line-index fallback. Same shape as the todo two-pass, applied to the `** food N kcal` prose-marker pattern.

**See also:** → [01-two-pass-scan-todos](./01-two-pass-scan-todos.md) · → [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md)

---

## Why care

The same matching shape that survives prose edits for one kind of line should work for any other kind — once you have the pattern, you re-use it. The risk is in the *cleanup rule*, not the matching. If unmatched existing rows should hang around (because they might be coming back), you keep them. If unmatched existing rows are dead by definition (because every row corresponds to exactly one line in the source, and the line is gone), you delete them. Same matching pass, different end-of-loop policy, completely different lifecycle.

This is two-phase matching followed by an explicit "carryover or delete" decision — the same shape as a diff applied as a sync (compute the diff, then choose whether removals propagate). You've seen this in file-sync tools where "mirror" mode deletes destination files missing from the source and "additive" mode does not. You've seen it in database replication where deletes can either replicate or be filtered out. The family is "diff-then-apply with a configurable handling of right-only items." The matching is shared; the apply step is where the domain rules live. Here's how this codebase applies that pattern.

---

## Quick summary
- **What:** `scanNutritionForEntry` matches `** food N kcal` lines in `entries.text` to existing `nutrition` rows, preserving row identity across edits.
- **Why here:** the user can edit either the name or the kcal value on a line in-place. Both `(name, kcal)` exact match (Pass 1) and line-index fallback (Pass 2) are needed.
- **Tradeoff:** unlike todos, *unmatched existing rows are deleted* — every row corresponds to a specific prose line, so if the line is gone, the row is gone.

**Real operation:** `scanNutritionForEntry` in `src/services/nutrition/scanNutrition.ts`. Runs after every entry text change via `useEntries.ts:20`.

---

## Primary diagram

```
                        entry.text
                            │
                            ▼
                    collectMatches()
              ┌─────────────┴─────────────┐
              ▼                           ▼
    ScannedMatch[]                  existing nutrition rows
    { lineIndex, name, kcal }        (getNutritionByEntry)
              │                           │
              └──────────────┬────────────┘
                             ▼
                  Pass 1 — exact (name, kcal)
                  → claim by id (Set guard)
                             │
                             ▼
                  Pass 2 — line-index fallback
                  → claim remaining (Set guard)
                             │
                             ▼
              ┌──────────────┴──────────────┐
              ▼                             ▼
        claimed match                   unmatched
        → updateNutrition               (scanned)  → insertNutrition
        if anything changed             (existing) → deleteNutrition
```

---

## The data

```
  entry.text:
    "Breakfast log
     ** oatmeal 320 kcal
     ** banana 100 kcal
     ** large coffee 5 kcal"

  existing nutrition rows (entry-scoped):
    [
      { id: "n-A", name: "oatmeal",      kcal: 320, sourceLine: 1 },
      { id: "n-B", name: "banana",       kcal: 95,  sourceLine: 2 },   ← edited value
      { id: "n-X", name: "stale entry",  kcal: 50,  sourceLine: 9 },   ← line removed
    ]
```

**The problem:** preserve `n-A` (unchanged), preserve `n-B` via line-index fallback (kcal edited 95→100), insert nothing for `large coffee` if no match — actually it has no prior, so insert. Delete `n-X` because line 9 no longer exists.

---

## How it works

── Brute force ──────────────────────────────────

Pseudocode (re-scan whole text per existing row):

```
  for each scanned-match in collectMatches(text):
    for each existing-row in existing:
      if scanned.name == existing.name AND scanned.kcal == existing.kcal:
        match!
      else if scanned.lineIndex == existing.sourceLine:
        match!
  // also nested scan for deletions
```

Execution trace (3 scanned × 3 existing):

```
  scanned[0] (line 1, oatmeal, 320):
    scan existing:
      n-A: name+kcal match ✓                    claim n-A
  scanned[1] (line 2, banana, 100):
    scan existing:
      n-A: claimed; skip
      n-B: name match, kcal != (95 vs 100)      no exact
      n-X: name mismatch
      re-scan w/ line-index: n-B.sourceLine==2 ✓ claim n-B (without used-Set guard,
                                                  another row could double-claim)
  scanned[2] (line 3, large coffee, 5):
    scan existing:
      n-A claimed; n-B claimed; n-X line 9 != 3 → no match  insert new
```

Complexity: O(n × m) time · O(n) space.

What goes wrong at scale: at typical scale (a few foods per entry, ~5 × 5 = 25 ops), brute force is essentially free. With 1,000 foods × 1,000 existing it's 1M ops; with 10,000 × 10,000 it's 100M ops. The real failure mode is correctness without a `used` Set: two `oatmeal 320 kcal` lines on the same entry would both claim `n-A` and one would be reused.

── Optimal ──────────────────────────────────────

The insight: same two-pass shape as `scanTodosFromText` — `Set<id>` of claimed rows guards against double-claim; pass priority encodes evidence quality (exact value beats line position).

```
  matches = collectMatches(text)
  claimed = empty Map<int, NutritionRow>
  usedIds = empty Set<string>

  // Pass 1 — exact (name, kcal)
  for i in 0..matches.length:
    m = matches[i]
    key = m.name.lower
    prior = first existing where prior.id ∉ usedIds
                              AND prior.name.lower == key
                              AND prior.kcal == m.kcal
    if prior: claimed[i] = prior; usedIds.add(prior.id)

  // Pass 2 — line-index fallback
  for i in 0..matches.length:
    if claimed has i: continue
    li = matches[i].lineIndex
    prior = first existing where prior.id ∉ usedIds
                              AND prior.sourceLine == li
    if prior: claimed[i] = prior; usedIds.add(prior.id)

  // Apply diffs
  for i in 0..matches.length:
    m = matches[i]
    prior = claimed[i]
    if prior:
      if changed(prior, m): updateNutrition(prior.id, { name, kcal, sourceLine })
    else:
      insertNutrition({ ... })

  // Delete unmatched existing rows
  for row in existing:
    if row.id ∉ usedIds: deleteNutrition(row.id)
```

Execution trace (same input):

```
  Pass 1 (exact name+kcal):
    i=0 m=(oatmeal,320)   → n-A name+kcal match     claimed[0]=n-A used={n-A}
    i=1 m=(banana,100)    → n-B name match, 95≠100  claimed[1]=∅   used={n-A}
                            n-X name mismatch
    i=2 m=(large coffee,5)→ no exact                claimed[2]=∅   used={n-A}

  Pass 2 (line-index):
    i=0 claimed; skip
    i=1 line 2 → n-B sourceLine==2 ✓               claimed[1]=n-B used={n-A,n-B}
    i=2 line 3 → no existing.sourceLine==3         claimed[2]=∅

  Apply:
    i=0 prior=n-A, no change → no-op
    i=1 prior=n-B, kcal 95→100 + sourceLine same → updateNutrition(n-B, { kcal:100 })
    i=2 prior=∅                                   → insertNutrition(new "large coffee 5 kcal")

  Delete sweep:
    n-A in used; n-B in used; n-X NOT in used     → deleteNutrition(n-X)

  Result: n-A unchanged, n-B kcal patched, new row inserted, n-X removed.
```

Complexity: O(n + m) time after the Set conversion · O(n + m) space.

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n × m)       │ O(n + m)         │
  │ Space           │ O(n)           │ O(n + m)         │
  │ At 1,000 items  │ 1,000,000 ops  │ 2,000 ops        │
  │ At 10,000 items │ 100,000,000 ops│ 20,000 ops       │
  │ Readable?       │ yes            │ yes (Set guard)  │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: at the typical scale of a handful of food lines per entry, both versions are sub-millisecond. The Set guard isn't an optimization — it's correctness. Two identical `** apple 95 kcal` lines on the same entry would double-claim the same row without it.

---

## In this codebase

**File:** `src/services/nutrition/scanNutrition.ts`
**Function / class:** `scanNutritionForEntry()` (with helpers `collectMatches()` and `parseLine()`)
**Line range:** L54–L130 (helper `collectMatches` at L31–L40, `parseLine` at L21–L29)

Called from `src/hooks/useEntries.ts:20` on every entry text change. The `NUTRITION_RE` at L13 (`/^\s*\*\*\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s*kcal\b/i`) defines the marker syntax. `parseNutritionLine` (L134–L136) is exposed for the autocomplete UI to parse single lines without touching the DB.

---

## Elaborate

### Where this pattern comes from
Same lineage as `scanTodosFromText` — a project-specific two-phase matching pass distilled from Myers-diff thinking. The "delete unmatched existing rows" tail makes it stricter than the todo version: there's no carryover, because nutrition rows have no identity outside their prose line.

### The deeper principle
**Identity should survive the user's edit, not the user's typo.** If the user changes `banana 95 kcal` to `banana 100 kcal`, the same row gets updated. If they delete the line, the row is gone. The two-pass shape encodes this contract.

### Where this breaks down
- Two identical `** apple 95 kcal` lines on the same entry — both Pass-1 candidates compete for the same row. The Set guard prevents double-claim; the second one becomes a new row.
- Massive multi-line edits where every line changed name AND kcal AND position — Pass 2's line-index fallback only saves rows that kept their line number, so a "rewrite everything" commit deletes all rows and re-inserts.

### What to explore next
- [01-two-pass-scan-todos](./01-two-pass-scan-todos.md) → same shape on `[]` todo prose.
- [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md) → same shape with looser Pass 2.

---

## Tradeoffs

- **Map + Set guard** — gives: O(n+m) and correctness against double-claim. Costs: extra structures vs the brute version.
- **Delete unmatched** — gives: prose line removal cleans up the DB row. Costs: a temporary "save and undo" round-trip loses the row id.
- **Per-line `await`s in the apply loop** — gives: simple async-await flow. Costs: serial DB writes vs a single bulk transaction. Acceptable at a handful of rows per entry.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I see this as a copy of the todo scanner or a deliberate sibling. The answer is sibling: the contract for nutrition is *strictly* coupled to prose lines (delete-when-line-gone), whereas todos have carryover. Same two-pass shape, different tail behavior. The interviewer wants to hear that I can articulate why the two algorithms look identical and aren't.

### Likely questions

[mid] Q: Why is `(name, kcal)` the Pass-1 key instead of just `name`?
      A: Because users edit kcal in place. If `oatmeal` matched by name only, a kcal-only edit would still claim the existing row — fine. But two `oatmeal` lines with different kcal values would race to claim the same row. The `(name, kcal)` composite key lets two oatmeal entries coexist if they're genuinely different foods (e.g., "oatmeal 320 kcal" and "oatmeal with berries 380 kcal" if the masker only saw "oatmeal" both times).

[senior] Q: Unlike `scanTodosFromText`, this function deletes unmatched existing rows instead of carrying them over. Why?
         A: Because nutrition has no identity outside its prose line. A todo can be "carried over" because it might come back next commit; a nutrition row is a parse result over the current text. If the line is gone, the row is gone. The carryover semantics in scanTodos exist because deleted-then-re-added todos retain meaning across commits (the user's intent persists); nutrition rows are derived state and don't.

[arch] Q: Could you merge this with `scanTodosFromText` into one parameterised function?
       A: Yes, and the temptation is real — the two-pass shape is identical. But the contract diverges in the tail: todos have carryover, nutrition deletes. Merging would mean a flag parameter (`carryover: boolean`) that branches the post-pass behavior, and at that point the two functions are clearer as siblings than as one polymorphic function with a flag. I picked duplication over premature abstraction; if I add a third scanner with a third tail, I'd merge.

### The question candidates always dodge
Q: Your `delete unmatched` semantics mean a user who removes a line by accident loses the row permanently. Is that the right default?

A: It's the right default *given* loopd's larger contract that prose is canonical. Every other table (todos, threads, mentions) follows the same shape — if the prose says it's gone, it's gone. The mitigation is the journaling app's undo-via-edit: the user re-types `** banana 95 kcal` and a new row gets inserted with a new id, same value. The lost row is just the id and createdAt; nothing user-visible. The principled fix would be a soft-delete with a 5-minute reversal window — that's a real product feature and I haven't built it because nobody has hit the foot-gun yet. The day someone does, soft-delete is one column away.

### One-line anchors
- "Same two-pass shape as todos; different tail because nutrition has no carryover."
- "Set guard prevents two identical food lines from double-claiming the same row."
- "Pass 1 = `(name, kcal)` composite; Pass 2 = line-index fallback for in-place edits."
- "Delete-on-unmatch is the right default when prose is canonical."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain two-pass nutrition scan to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/nutrition/scanNutrition.ts:scanNutritionForEntry`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

Existing rows: `n-A = (oatmeal, 320, line 1)`, `n-B = (banana, 95, line 2)`. The user changes line 2 to `** banana 100 kcal` and adds a new line 3 `** apple 95 kcal`. Walk Pass 1, Pass 2, the apply step, and the delete sweep — what gets inserted, what gets updated, what gets deleted?

Write your answer. 3–5 sentences minimum. Then open `src/services/nutrition/scanNutrition.ts` L54–L130 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/nutrition/scanNutrition.ts` to support what exists
→ Point to `src/services/todos/scanTodos.ts` (the sibling that has carryover instead of delete) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
