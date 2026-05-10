# Two-pass scan: matching prose lines to existing todos

**Industry name(s):** — (project-specific composition of exact-match-by-id + line-index fallback)
**Type:** Project-specific

> Map + Set in two passes — exact text first, then line-index fallback. Preserves todo identity across edits without requiring the user to declare it.

**See also:** → [02-reconcile-todo-meta](./02-reconcile-todo-meta.md) · → [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md) · → [01-system-design/04-two-pass-matching](../01-system-design/04-two-pass-matching.md)

---

## Why care

You've renamed a file in your editor and watched git track it as a rename instead of a delete-plus-add — the same words landed in a different place and the tool figured out it was the same file. That's the question this operation answers for a list of items inside prose: when the user retypes a line with one word changed, is that the same row with an edit, or a brand-new row that replaced the old one? The naive answer loses identity every time the text shifts; the right answer survives reorderings and in-place edits without asking the user to declare which is which.

This is the two-pass match — a stripped-down cousin of Myers diff, which is what git diff, every IDE's "rename detection," and React's keyed-list reconciliation all use under the hood. The family is "match items across two snapshots by strongest-evidence-first, fall back to weaker evidence for the remainder." You've seen the same shape in source-control merge tools (exact-line match before fuzzy hunk match), in spreadsheet diffs (cell value before cell position), and in any system that has to decide whether two records from different points in time refer to the same thing. Here's how this codebase applies that pattern.

---

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

── Brute force ──────────────────────────────────

Pseudocode:

```
  for each line in text:
    for each existing todo:
      if line.text equals existing.text (case-insensitive):
        match!
      else if line.lineIndex equals existing.sourceLine:
        match!
  // re-scan whole file from offset 0 for every TodoItem
```

Execution trace (lines = 4 `[]`, existing = 3):

```
  step  line                  scan over existing                  claim
  ────  ────────────────────  ──────────────────────────────────  ──────
  1     line 1 "call mom"     t-A.text == ✓                        t-A
  2     line 2 "write spec"   t-A used; t-B.text != ; t-C.text !=  none yet
                              re-scan w/ line-index: t-B.line==2 ✓ t-B
  3     line 3 "book dentist" t-A used; t-B used; t-C.text == ✓    t-C
  4     line 4 "idea: ..."    NOT a [] line, skipped                —
```

Complexity: O(n × m) time · O(n) space — where n = `[]` lines, m = existing todos.

What goes wrong at scale: a single entry rarely has more than 20-30 todos in this app, so even at O(n × m) the absolute count is tiny (600 ops max). Scale isn't the issue here. The bigger issue is *correctness* on duplicates: a naive loop matches the same existing todo to two different lines. With 10,000 lines × 10,000 existing todos the cost would be ~100M ops, but the codebase never reaches that — the correctness gap (Set-of-used guard) is the reason to rewrite, not speed.

── Optimal ──────────────────────────────────────

The insight: track which existing ids are already claimed (`Set`), and iterate matches in two distinct passes — exact text first (so reorderings always win), line-index second (so single-line edits keep their identity).

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

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n × m)       │ O(n + m) amort.  │
  │ Space           │ O(n)           │ O(n + m)         │
  │ At 1,000 items  │ 1,000,000 ops  │ 2,000 ops        │
  │ At 10,000 items │ 100,000,000 ops│ 20,000 ops       │
  │ Readable?       │ yes            │ yes              │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: never. The Set guard isn't an optimization — it's correctness. Two `[]` lines with the same text would both claim the same todo and one would be reused twice. At the project's actual scale (20-30 todos per entry) the speed delta is invisible, but the correctness gap is real even at n = 2.

---

## In this codebase

**File:** `src/services/todos/scanTodos.ts`
**Function / class:** `scanTodosFromText()` (with helper `collectMatches()`)
**Line range:** L53–L138 (helper `collectMatches` at L17–L52)

Called by every prose-edit commit path that touches a journal entry. The Set-of-used-ids guard inside the function is what makes Pass 2 safe against double-claim.

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

---

## Quick summary

Two-pass matching is the family of "match items across two snapshots by strongest-evidence-first, fall back to weaker evidence for the remainder" — a stripped-down cousin of Myers diff that powers git rename detection and React's keyed-list reconciliation. In this codebase `scanTodosFromText` runs at every commit (focus blur, screen leave) on `entries.text`: Pass 1 matches `[]` lines by exact text to preserve `id`, `createdAt`, and the AI classifier output across reorderings; Pass 2 falls back to line-index to catch "same line, different words" edits. The constraint is that row identity must survive prose edits — a brand-new id on every edit would invalidate `todo_meta` rows and break the 1:1 invariant the downstream reconciler depends on. The cost is that the algorithm cannot distinguish "I edited line 7" from "I deleted line 7 and added a new todo on line 7" — both look the same and inherit the old id, which can leave `meta.type` momentarily stale.

Key points to remember:
- Pass 1 is exact-text match; Pass 2 is line-index fallback for the unmatched residue.
- Identity (`id`, `createdAt`, classifier output) survives prose edits — that is the invariant the algorithm maintains.
- The `Set<string>` of used ids is doing correctness work, not performance work — without it two identical `[]` lines could double-claim the same existing todo.
- Linear time on each pass — O(n + m) after Map/Set conversion; never quadratic even at high entry count.
- The algorithm cannot tell apart "edited line 7" from "deleted-and-replaced line 7" — both inherit the prior id.

---

## Interview defense

### What an interviewer is really asking
The probe here is whether I understand that the `Set<string>` of used ids is doing correctness work, not performance work. A naive interviewer reads "two-pass" and hears "optimization"; a sharper one wants to know if I can articulate that two identical `[]` lines on the same day would double-claim the same existing todo without the guard. The brute-force version isn't slow at 30 todos — it's wrong.

### Likely questions

[mid] Q: Walk me through what happens in Pass 2 if a line that exactly matched in Pass 1 is also a line-index match for a different existing todo.
      A: It can't happen. The Pass 1 match writes the index into `claimed` and Pass 2's first check is `if claimed has i: continue`. The line is skipped entirely. Even if Pass 2 wanted to consider it, the corresponding `prior.id` was added to `used` in Pass 1, so the line-index lookup would also be filtered out. That's the whole point of the `used` Set — Pass 2 only sees rows Pass 1 didn't claim.

[senior] Q: Why two passes instead of running one pass with a combined predicate?
         A: Pass priority encodes evidence quality. Exact-text match is stronger evidence of "same todo" than line-index match — the user kept the words, they just moved the line. If I combined them into one pass with a tiebreak, a reorder where line 5 became line 2 would race against another line that happens to now be line 5 with different text, and the wrong row would win. Running exact-text first means reorderings always claim their rows before line-index gets to compete.

[arch] Q: What breaks if a single entry has 5,000 todos?
       A: `scanTodosFromText` stays O(n+m) and linear in real time, but the scan runs on every focus blur, so the cost shows up as input lag once the entry is huge. The bigger problem is `entries.text` itself — a single prose column with 5,000 `[]` lines is the wrong data model. The migration is one-entry-equals-one-day capped naturally; if someone wanted cross-day aggregation they'd compose at the query layer, not pile into one field.

### The question candidates always dodge
Q: Your algorithm can't tell apart "I edited line 7" from "I deleted line 7 and added a new todo on line 7." Why is that acceptable, and what do you lose?

A: It's acceptable because the user has no way to express the difference either — they just typed. If I forced a distinction I'd have to ship a "mark this as a new todo" affordance, which is exactly the kind of friction the app exists to avoid. What I lose is identity in the rare case where a user replaces "call mom" with "fix bug" on the same line on the same edit pass — that should logically be delete-and-add but my algorithm preserves `t-A`'s id, createdAt, and classifier metadata. The wrong consequence is that downstream `meta.type` might stay stale until the LLM reclassifies. The right consequence is that fixing a typo on a todo doesn't burn a fresh classifier call. I picked the cheap-and-mostly-right shape; the principled fix would be cosine-distance on the text with a threshold, but at 20-30 todos per entry that's overkill.

### One-line anchors
- "The Set isn't an optimization, it's a correctness gate."
- "Pass priority encodes evidence quality — exact text beats line index."
- "Identity survives prose edits because the algorithm trusts the line, not the user."
- "At 30 todos per entry, O(n×m) and O(n+m) are both sub-millisecond — the rewrite was for clarity."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain two-pass scan-todos to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/scanTodos.ts:scanTodosFromText`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

Existing has 3 todos with `sourceLine` 0, 1, 2 and texts "call mom", "draft spec", "book dentist". The user inserts a brand-new todo `[] write tests` at the very top (becomes line 0), deletes the dentist line entirely, and edits "draft spec" to "write spec" (now on line 2). After Pass 1 + Pass 2 + carryover, what 3 items does `out` contain, and which existing ids survive?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/scanTodos.ts` L53–L138 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/scanTodos.ts` to support what exists
→ Point to `src/services/todos/reconcileMeta.ts` (the downstream reconciler that depends on stable ids) if you chose the alternative

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
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — added v1.14.0 subtitle block + brute-force section + comparison table.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
