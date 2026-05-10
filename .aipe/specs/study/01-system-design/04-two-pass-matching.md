# Two-pass matching

**Industry name(s):** — (project-specific composition of exact-match-by-id + line-index fallback)
**Type:** Project-specific

> Every prose-derived feature (todos, threads, mentions) matches existing rows in two passes — exact text first, line-index second — so identity survives both reorderings and same-line edits.

**See also:** → [03-single-source-of-truth](./03-single-source-of-truth.md) · → [06-one-to-one-invariant](./06-one-to-one-invariant.md) · → [02-dsa/01-two-pass-scan-todos](../02-dsa/01-two-pass-scan-todos.md)

---

## Quick summary
- **What:** Pass 1 matches by exact text (catches reorderings). Pass 2 matches by line index (catches "I edited the words on this line").
- **Why here:** preserves the row's id, createdAt, classifier output, and expansion across edits without requiring the user to declare identity explicitly.
- **Checklist step:** 1 (Data model) + 4 (State ownership)
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

**Todos:**     `src/services/todos/scanTodos.ts` → `scanTodosFromText()` L53–L138 — Pass 1 (exact text), Pass 2 (line index)
**Threads:**   `src/services/threads/scanThreads.ts` → `reconcileMentions()` L169–L230 — same shape, Pass 2 widens to `±3 line shift` window
**Sibling DSA:** [02-dsa/01-two-pass-scan-todos](../02-dsa/01-two-pass-scan-todos.md) and [02-dsa/03-two-pass-thread-mentions](../02-dsa/03-two-pass-thread-mentions.md) for execution traces

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

---

## Interview defense

### What an interviewer is really asking
"How do you know which `[]` line is which" sounds trivial. The interviewer is probing for whether you understand that user-facing identity (a todo with its classifier output, expansion, and pin) survives content edits — and whether you can name the algorithm that preserves it cheaply. They're looking for diff-algorithm vocabulary without the candidate reaching for "I'd just give every line a UUID."

### Likely questions

[mid] Q: Why does Pass 1 run before Pass 2? What goes wrong if you flip the order?

A: Pass 1 is exact-text match; Pass 2 is line-index fallback. If Pass 2 ran first, "I moved my todos around" would match by line position — the wrong todo gets matched to the wrong line, and identity gets shuffled. By running text-match first, a reorder always wins: "call mom" finds its prior row regardless of where the user moved it. Pass 2 only fills in what Pass 1 couldn't — the case where the user edited the words on a line that didn't move.

[senior] Q: Why two passes and not just give every prose line a hidden UUID?

A: A hidden UUID means the user can't paste prose between days, can't copy-paste a list of todos from a note app, can't dictate prose to the OS keyboard — every "import" path would either lose identity or have to invent ids. Two-pass matching uses the prose itself as the identifier, which is what the user types and edits naturally. The cost is that the algorithm gets confused by simultaneous bulk edit + bulk reorder, but that's a workflow that doesn't actually exist for solo journaling. I picked the constraint that fits the user, not the constraint that fits the algorithm.

[arch] Q: What happens to this design if the prose can be edited by two devices at the same time?

A: It would break in the worst way — silently. Two devices both running `scanTodosFromText` against different versions of the prose would produce different `todos_json` arrays, both legitimate-looking, and the LWW conflict resolver in `chooseWinner` would pick one and discard the other's identity preservation work. The fix isn't on the matcher; it's on the prose itself. Either prose becomes a CRDT (Y.js / Automerge), or the app goes single-writer-at-a-time with explicit handoff. The two-pass match is a single-writer algorithm.

### The question candidates always dodge
Q: What does your algorithm do when a user has two `[]` lines with the exact same text on the same day?

A: Pass 1 sees the second match's text in the existing list, but the existing row has already been claimed by the earlier match — the `used` set blocks the double-claim. The second match falls through to Pass 2. Pass 2 looks for an existing row with the same line index and an unclaimed id; if the second occurrence is on a fresh line, it gets a new todo. If both occurrences are at the same line (impossible in normal prose, but defensively considered) the algorithm produces one match and one new row. The honest answer is that this case is rare in journaling — duplicate `[]` lines with identical text are usually a copy-paste accident, and the user notices and edits one of them. If duplicates were common, I'd add a `(text, lineIndex)` composite key to the matcher; with the actual data shape, the `used` set is enough.

### One-line anchors
- "Two-pass match is Myers diff applied to row identity — strongest evidence first, weakest fills the gaps."
- "The user's investment is the row's id (classifier output, expansion, pin); content edits shouldn't destroy it."
- "Prose-as-identifier is what makes paste, dictate, and natural-edit workflows possible — UUIDs would block those."
- "The algorithm assumes single-writer; two devices editing the same prose breaks it silently, not loudly."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain two-pass matching to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/scanTodos.ts:scanTodosFromText`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

The user has 4 existing todos at lines 0–3: A=`call mom`, B=`ship feature`, C=`fix bug`, D=`book dentist`. They reorder so A is now line 2, B is line 0, C stays at line 2 → wait, that conflicts with A. Try again: B → 0, A → 1, C → 2, D → 3 (i.e., user just moved B to top). They also edit D's text from `book dentist` to `book the dentist`. After Pass 1 + Pass 2, do all four ids survive? Walk which pass claims each match.

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/scanTodos.ts` L53–L138 to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/scanTodos.ts` to support what exists
→ Point to `src/services/todos/scanTodos.ts:collectMatches` (where you'd inject hidden UUIDs into the prose-roundtrip) if you chose the alternative

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.
