# Two-pass scan: matching nutrition prose to existing rows

**Industry name(s):** — (project-specific composition of exact-match + line-index fallback for nutrition prose)
**Type:** Project-specific

> Map + Set in two passes — exact `(name, kcal)` first, then line-index fallback. Same shape as the todo two-pass, applied to the `** food N kcal` prose-marker pattern.

**See also:** → [01-two-pass-scan-todos](./01-two-pass-scan-todos.md) · → [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md)

---

## Why care

Imagine running `rsync` from a source folder to a destination folder. The matching phase is the same in both modes: figure out which files in the destination correspond to which files in the source. The behaviour diverges at the end: with `--delete`, files in the destination that aren't in the source get removed; without it, they stick around as orphans. The matcher is shared. The cleanup rule is the domain choice.

That is the question this operation answers when one type of prose-derived row needs to be a strict 1:1 mirror of the source lines (delete unmatched), while a sibling type wants soft preservation (carryover unmatched): how do you reuse the matching pass but vary the apply step? Not "rewrite the whole algorithm per domain," not "fold the cleanup decision into the comparator" — just *share the two-pass match, parameterise the apply tail, let the domain rule live where it belongs*.

**What depends on getting this right:** the `nutrition` table's invariant that every row corresponds to a live `** food N kcal` line in `entries.text`. In this codebase `scanNutritionForEntry` runs after every entry text change (called from `useEntries.ts:20`). Pass 1 matches scanned lines to existing rows by exact `(name, kcal)`, Pass 2 by `lineIndex` for the in-place-edit case, then the apply step inserts new lines and updates changed ones, and the *delete sweep* removes every existing row whose id isn't in `usedIds`. The delete is what makes nutrition diverge from its todo-scanner sibling: a todo can carry over because deleted-then-restored todos retain meaning, but a nutrition row has no identity outside its prose line. Lose that delete and `nutrition` grows monotonically with edits, cross-day aggregates start counting phantom calories, and sync bandwidth carries rows that no longer match any prose anywhere.

Without the delete sweep (carryover semantics):
- User logs `** banana 95 kcal` → row `n-B` inserted
- User deletes the line entirely from `entries.text`
- Carryover policy keeps `n-B` in the DB with `sourceLine` cleared
- The dashboard's "daily kcal" sum still includes 95 kcal that no prose claims
- The user can't reconcile "what's on screen" with "what's in storage" — invariant broken

With the delete-on-unmatch shape:
- Same edits up to deletion of the banana line
- `scanNutritionForEntry` runs; Pass 1 and Pass 2 leave `n-B` unclaimed in `usedIds`
- The delete sweep at the tail runs `deleteNutrition(n-B)`
- `schedulePush()` sends a soft-delete to Supabase
- Every reader of `nutrition` sees exactly the rows the current prose still claims

Share the matcher, vary the apply tail; prose is canonical.

---

## How it works

`git status` compares two snapshots of the same set of files — the index and the working tree — and emits the diff. The matching algorithm is shared with every other git operation, but the cleanup options diverge: `git restore` keeps unmatched files, `git clean -fd` removes them. Same matcher, opposite policy. `rsync` lives on the same fork — `--delete` mirrors the source exactly, while no-flag preserves destination-only files. For todos here, "gone from prose" means "kept as carryover" because the user might restore the line tomorrow. For nutrition, "gone from prose" means "hard-deleted" because every food log corresponds to exactly one prose line. Same matching algorithm, opposite cleanup rules. If you're coming from frontend, this is the same shape as the `git status` / `git clean` split or rsync's `--delete` flag — the matcher is shared; the apply step is where the domain rule lives.

**Real operation:** `scanNutritionForEntry` in `src/services/nutrition/scanNutrition.ts`. Runs after every entry text change via `useEntries.ts:20`.

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

This is what people mean by "share the matcher, vary the apply step." The same two-pass-match algorithm survives for todos, threads, and nutrition because the matching question (which prior row is this line?) is identity-shaped — it doesn't care about the domain. The differences live in the apply step: todos preserve unmatched rows as carryovers because the user might restore them; nutrition deletes unmatched rows because their meaning was the prose line that no longer exists. The discipline is recognising which cleanup rule the domain actually needs, and not letting one feature's policy bleed into another's. The diagram below shows the whole flow end-to-end.

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

We traded carryover for a stricter "prose is canonical" contract — delete the line, delete the row, no escape hatch.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (two-pass + delete  │ Alternative (two-pass + carry  │
│                  │ unmatched)                     │ over, like todos)              │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Time complexity  │ O(n + m) — two linear passes   │ O(n + m) — same matching pass  │
│                  │ + O(m) delete sweep            │ + O(m) carryover append        │
│ Latency at 5     │ <1ms                            │ <1ms — both invisible at        │
│ foods/entry      │                                 │ this scale                     │
│ Latency at 10×N  │ <1ms at 50 foods                │ <1ms at 50 foods                │
│ Cleanup policy   │ unmatched row → DELETE         │ unmatched row → carryover       │
│                  │                                 │ with cleared sourceLine        │
│ User error       │ accidental line delete → row   │ accidental line delete → row    │
│  recovery        │ is gone (re-type to re-create) │ persists, looks "orphaned"     │
│ Code complexity  │ ~95 LOC scanner + delete sweep │ ~120 LOC + carryover bookkeep   │
│                  │                                 │ + UI affordance to clean up    │
│ Cognitive load   │ reader sees "delete unmatched" │ reader sees carryover, has to   │
│                  │ once, understands rule         │ understand why some rows have   │
│                  │                                 │ no sourceLine                  │
│ Schema           │ no soft-delete needed —        │ soft-delete column required to  │
│                  │ derived state                   │ track carried-over rows        │
│ Failure mode     │ user typo → loses row id       │ user typo → row sticks around   │
│                  │ permanently                    │ as orphan in DB                │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The delete-unmatched semantics mean a user who deletes a nutrition line by accident permanently loses the row id and `createdAt`. The mitigation is grim — re-type the line as a fresh insert with a new id, same kcal. Nothing user-visible is lost, but the loss is irreversible by design. We accepted this because "prose is canonical" is the larger contract; every derived table follows the same shape.

The Set guard (`usedIds`) is correctness, not optimization. At 5 food lines per entry the brute O(n × m) version is essentially free; we still ship the guard because two identical `** apple 95 kcal` lines would otherwise both claim the same existing row. A contributor reading the loop has to be told (or comment-marked) that the Set is correctness work, not perf — adding the explanation is a per-feature onboarding cost.

The apply loop runs `await` per row instead of wrapping the inserts/updates/deletes in a single transaction. Each statement is a separate SQLite commit and a separate `schedulePush()` trigger. At ~5 rows per scan this is fine; at 50 rows per scan it's measurable. The fix would be a batched-write API in `database.ts`, which we haven't built because the typical case never exceeds 10 rows.

### What the alternative would have cost

If we matched the todo scanner's carryover semantics, an accidentally-deleted nutrition line would survive in the DB with its `sourceLine` cleared. The user would see the row in their nutrition history without a corresponding journal line — which is exactly the friction the prose-canonical rule exists to prevent. To make that shape work, we'd also need a UI affordance for "this row has no source line, mark it dead?" which is a feature in its own right.

The hidden cost is sync: with carryover, the row stays in `nutrition` indefinitely, taking sync bandwidth and showing up in cross-day aggregates. The delete-unmatched shape keeps the table size bounded to what the prose currently expresses — every reader downstream gets the simpler invariant "every row corresponds to a live prose line."

A bulk-transaction apply path would have shaved a few ms at 50-row scans but added ~50 LOC for the transaction boundary plus retry logic. We picked the per-row simplicity because nutrition scans rarely exceed 10 rows.

### The breakpoint

Fine until a user genuinely needs an "undo last delete" affordance for nutrition lines — at which point soft-delete with a 5-minute reversal window is the principled fix. That's a single new column (`deleted_at`) plus a cleanup job, ~30 LOC. We haven't shipped it because nobody has hit the foot-gun yet.

### What wasn't actually a tradeoff

Choosing two passes over one pass with a combined predicate isn't really a tradeoff — the precedence "exact (name, kcal) beats line-index" needs ordered evaluation. A combined predicate with a tiebreak would handle reorderings worse: a line that just moved would race against another line whose value happens to match the moved row's old position. The two-pass shape encodes evidence quality correctly; one pass is the wrong primitive.

---

## Tech reference (industry pairing)

### TypeScript Map + Set + linear scan (no diff library)

- **Codebase uses:** native `Map<id, NutritionRow>` and `Set<id>` (used-row guard) inside `src/services/nutrition/scanNutrition.ts → scanNutritionForEntry()`. Raw SQL inserts/updates/deletes through `database.ts`.
- **Why it's here:** the algorithm has to run after every entry text edit; the Set guard is the cheapest enforcement of "claim each existing row at most once" and the Map is the cheapest "find by id" lookup.
- **Leading today:** native collections — `adoption-leading` for in-memory matching + hard-delete cleanup at this scale, 2026.
- **Why it leads:** runtime-builtin, O(1) average, zero dependency cost; the algorithm fits in ~120 LOC of typed scanner+reconciler code.
- **Runner-up:** `jsdiff` / `fast-diff` — `adoption-leading` for richer line-level diff with hunk semantics; the right move if the scanner ever needs to surface diff metadata or support undo.

### expo-sqlite — hard-delete for prose-bound rows

- **Codebase uses:** `expo-sqlite` against `loopd.db`. The cleanup phase runs `DELETE FROM nutrition WHERE id NOT IN (...usedIds)` — not a soft-delete. The row truly disappears.
- **Why it's here:** unlike `todo_meta` (which carryover-preserves to maintain identity across prose edits), `nutrition` rows are 1:1 with their prose line — if the line is gone, the row is meaningless. Hard delete is the right call.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** native SQLite `DELETE` is the canonical disposal; no library needed; the cloud-sync layer above handles soft-delete semantics for the cross-device case.
- **Runner-up:** soft-delete via `deleted_at` — `adoption-leading` discipline for cloud-synced tables. The codebase uses soft-delete everywhere *except* here, because nutrition's prose-line binding makes hard-delete more correct than convention.

---

## Summary

Two-phase matching with a configurable "delete unmatched" tail is the family of "diff-then-apply where the matching is shared but the handling of right-only items is the domain rule" — same shape as file-sync tools in mirror vs additive mode, same shape as DB replication that either propagates or filters deletes. In this codebase `scanNutritionForEntry` in `src/services/nutrition/scanNutrition.ts` runs after every entry text edit (called from `useEntries.ts:20`): Pass 1 matches scanned `** food N kcal` lines against existing rows by exact `(name, kcal)`, Pass 2 falls back to line-index for the unmatched residue, then the apply step inserts new lines and updates changed ones — and the delete sweep removes every existing row whose id is not in the `usedIds` Set. The constraint that makes nutrition diverge from its todo-scanner sibling is "prose is canonical": a nutrition row has no identity outside its source line, so if the line is gone the row is gone. The cost is no carryover — an accidental line deletion permanently loses the row id, mitigated only by re-typing the line as a fresh insert. At a handful of food lines per entry both brute O(n × m) and optimal O(n + m) run sub-millisecond; the Set guard is correctness, not optimization, because two identical `** apple 95 kcal` lines would otherwise double-claim the same row.

Key points to remember:
- Pass 1 key is `(name, kcal)` composite; Pass 2 key is `lineIndex` — exact-value beats line-position as evidence quality.
- `usedIds` Set prevents two scanned lines from double-claiming the same existing row — the guard is correctness, not perf.
- Delete-on-unmatch is the policy difference vs todos: nutrition rows are derived state, todos have carryover.
- O(n + m) time and space after Set conversion; correctness holds even when two identical lines appear on the same entry.
- Identity should survive the user's edit but not the user's deletion — that contract is the whole shape of the algorithm.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I see this as a copy of the todo scanner or a deliberate sibling. The answer is sibling: the contract for nutrition is *strictly* coupled to prose lines (delete-when-line-gone), whereas todos have carryover. Same two-pass shape, different tail behavior. The interviewer wants to hear that I can articulate why the two algorithms look identical and aren't.

### Likely questions

[mid] Q: Why is `(name, kcal)` the Pass-1 key instead of just `name`?
      A: Because users edit kcal in place. If `oatmeal` matched by name only, a kcal-only edit would still claim the existing row — fine. But two `oatmeal` lines with different kcal values would race to claim the same row. The `(name, kcal)` composite key lets two oatmeal entries coexist if they're genuinely different foods (e.g., "oatmeal 320 kcal" and "oatmeal with berries 380 kcal" if the masker only saw "oatmeal" both times).

```
[Pass 1 composite key flow]

  scanned: [{oatmeal, 320}, {oatmeal, 180}]
  existing: [{oatmeal, 320}, {oatmeal, 180}]
        │
        ▼  Pass 1 with key=name only
  both scanned items match first existing → double-claim   ◀── bug
        │
        ▼  Pass 1 with key=(name, kcal) composite
  scanned[0] (oatmeal,320) → existing[0] (oatmeal,320)
  scanned[1] (oatmeal,180) → existing[1] (oatmeal,180)
        │
        ▼
  no collision — composite key disambiguates
```

[senior] Q: Unlike `scanTodosFromText`, this function deletes unmatched existing rows instead of carrying them over. Why?
         A: Because nutrition has no identity outside its prose line. A todo can be "carried over" because it might come back next commit; a nutrition row is a parse result over the current text. If the line is gone, the row is gone. The carryover semantics in scanTodos exist because deleted-then-re-added todos retain meaning across commits (the user's intent persists); nutrition rows are derived state and don't.

```
                  Path taken (delete unmatched)        Alternative (carryover like todos)
                  ────────────────────────────────────  ──────────────────────────────────
identity source   the prose line is the row's only id  user intent persists across commits
deleted line      row gone — re-type to recreate       row stuck around with cleared
                                                       sourceLine
schema cost       no soft-delete needed                soft-delete column required
table size        bounded to current prose             grows monotonically with edits
cross-day reads   every row maps to a live line       readers must filter "rows with no
                                                       sourceLine"
sync bandwidth    only live rows on wire               carried-over rows take bandwidth
                                                       indefinitely
verdict           strict shape matches "prose is        carryover doesn't fit nutrition's
                  canonical" rule                       data model
```

[arch] Q: Could you merge this with `scanTodosFromText` into one parameterised function?
       A: Yes, and the temptation is real — the two-pass shape is identical. But the contract diverges in the tail: todos have carryover, nutrition deletes. Merging would mean a flag parameter (`carryover: boolean`) that branches the post-pass behavior, and at that point the two functions are clearer as siblings than as one polymorphic function with a flag. I picked duplication over premature abstraction; if I add a third scanner with a third tail, I'd merge.

```
[scale curve — what breaks first at 10× and 100× food count]

  foods/entry   scan ops       apply latency     breaks?
  ───────────   ─────────      ──────────────    ──────────────────
  5 (real)      ~25 ops         <1ms              no
  50 (10×)      ~250 ops        ~5ms              no — per-row awaits visible but fine
  500 (100×)    ~2,500 ops      ~50ms+            per-row await loop becomes
                                                  visible UI delay     ◀── BREAKS FIRST
  5,000+        ~25k ops        seconds           data model is wrong — nutrition is
                                                  a daily journaling feature, not
                                                  a bulk-import target
```

### The question candidates always dodge
Q: Your `delete unmatched` semantics mean a user who removes a line by accident loses the row permanently. Is that the right default?

A: It's the right default *given* loopd's larger contract that prose is canonical. Every other table (todos, threads, mentions) follows the same shape — if the prose says it's gone, it's gone. The mitigation is the journaling app's undo-via-edit: the user re-types `** banana 95 kcal` and a new row gets inserted with a new id, same value. The lost row is just the id and createdAt; nothing user-visible. The principled fix would be a soft-delete with a 5-minute reversal window — that's a real product feature and I haven't built it because nobody has hit the foot-gun yet. The day someone does, soft-delete is one column away.

```
                  Path taken (hard delete on unmatch)  Suggested (soft-delete + 5-min undo)
                  ────────────────────────────────────  ──────────────────────────────────
deleted line      row gone immediately                 row gets deleted_at stamp;
                                                       background cleanup after 5m
recover by re-type  yes — fresh id, same kcal            yes — undo within 5m restores
                                                       original id + createdAt
schema cost       no new column                         +1 column (deleted_at)
cleanup job       n/a                                   background sweep over deleted_at
                                                       column once per day
user trust        "I deleted, it's gone"               "I can undo for a few minutes"
foot-gun rate     observed: zero                        n/a
LOC               unchanged                             +30 (column + sweep job)
verdict           strict default fits "prose is        the right shape the day someone
                  canonical"; one column away if        complains
                  demand arises
```

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
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 + v1.23.0 pass: inserted `## Tech reference (industry pairing)` section between Tradeoffs and Summary with `###` per tech + five labelled bullets each.

---
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (fridge-snapshot metaphor + frontend bridge to rsync --delete) and Move 3 principle after the Comparison block.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (rsync-mirror-vs-additive-mode scenario → naming the share-matcher-vary-apply-tail pattern → bolded "what depends on getting this right" pivot with `nutrition` 1:1-with-prose invariant stakes → before/after bullets walking a deleted `** banana 95 kcal` line through carryover vs delete-sweep → one-line summary "share the matcher, vary the apply tail; prose is canonical").

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of How it works to anchor on real software (replaced fridge-snapshots analogy with `git status` vs `git clean -fd` and rsync's `--delete` flag — same matcher, opposite cleanup policy). Why care Move 1 already used `rsync` and was left untouched.
