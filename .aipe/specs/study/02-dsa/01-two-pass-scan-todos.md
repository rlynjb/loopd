# Two-pass scan: matching prose lines to existing todos

**Industry name(s):** — (project-specific composition of exact-match-by-id + line-index fallback)
**Type:** Project-specific

> Map + Set in two passes — exact text first, then line-index fallback. Preserves todo identity across edits without requiring the user to declare it.

**See also:** → [02-reconcile-todo-meta](./02-reconcile-todo-meta.md) · → [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md) · → [01-system-design/04-two-pass-matching](../01-system-design/04-two-pass-matching.md)

---

## Why care

Open React DevTools and drag-reorder an item in any keyed list. The reconciler doesn't tear down every `<li>` and rebuild — it walks each new entry, matches against the previous render by `key` prop first, and only falls back to positional matching for whatever didn't match. That's why React warns you when you forget `key` on a list: without the strong signal, only position is left, and edits get misattributed to the neighbours on either side. The reconciler is running two passes — strong evidence first (the key), weaker evidence (position) for the residue.

That is the question this operation answers when the source is a paragraph of prose instead of a roster: given a new list of items typed into text and an old list with identities already assigned, which new items inherit which old identities? Not "diff the strings," not "rebuild from scratch" — just *match by strongest evidence, fall back to weaker evidence for the residue*. That two-pass match is the family Myers diff, git rename detection, and React's keyed-list reconciler all belong to.

**What depends on getting this right:** the stability of every downstream record keyed to a todo's `id`. In this codebase the `[]` lines in `entries.text` are the canonical source for `entries.todos_json`, and each todo's `id` is the foreign key that `todo_meta` rows hang off (one meta row per todo, holding `type`, `priority`, classifier output). If the scan produces a fresh `id` every time the user retypes a line with one word changed, the matching `todo_meta` row gets orphaned and `reconcileMeta()` has to throw away a classifier result that cost an Anthropic call. Identity must survive prose edits — that invariant is what makes `todo_meta` durable.

Without two-pass match (naive one-loop):
- User types `[] call mom` on Monday → todo `t-A` born, classified as `type=personal`
- Tuesday user retypes the same line, lowercase only: `[] call Mom`
- Naive matcher sees a "new string" → mints `t-X`, drops `t-A`
- `todo_meta` row for `t-A` is now orphaned; classifier re-runs on `t-X`
- Anthropic burns another call to learn `type=personal` again

With two-pass match:
- Pass 1 normalises case, exact-matches `"call mom"` → claims `t-A`
- `id`, `createdAt`, and `todo_meta` link all survive
- Pass 2 has nothing to do for that line; classifier call is saved
- `reconcileMeta()` sees a clean 1:1 invariant and noops

Strongest evidence first, weakest evidence cleans up the rest.

---

## How it works

React's keyed-list reconciler walks two snapshots of a list and matches each new entry to an old one by `key` first — the strong identifier — then falls back to position for anything unmatched. That's why the DevTools console warns when you omit `key`: without the strong signal, only position is left, and an insert at the top reassigns every row below to the wrong piece of state. The same two-signal shape powers this scanner: strong identifier (line text) first, weaker fallback (line index) for the leftovers. Two passes, two independent signals — text survives reordering, position survives in-place edits.

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

This is what people mean by "use the strongest evidence first." Two-pass match isn't a special algorithm — it's the discipline of layering identity checks by confidence and keeping the cheap ones in front. Git's rename detection does the same: exact hash match before content-similarity threshold before path-based heuristic. React's reconciler does the same: `key` before type before position. When you can't stamp a primary key into your source format, you reach for two cheap proxies and rank them.

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

We traded extra data structures and an extra pass for stable row identity across prose edits and correctness in the duplicate-line case.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (two-pass + Set)    │ Alternative (one-pass match)   │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Time complexity  │ O(n + m) — two linear passes   │ O(n × m) — re-scan per line    │
│                  │ over the matches array         │ with no claim guard            │
│ Latency at 30    │ <1ms — sub-millisecond on the  │ <1ms — also sub-ms; the speed  │
│ todos (real N)   │ device                         │ gap doesn't matter at this N   │
│ Latency at 10×N  │ ~5ms at 300 todos              │ ~50ms at 300 todos — single    │
│                  │                                │ keystroke commit feels laggy   │
│ Correctness      │ duplicate `[]` lines each      │ duplicate lines double-claim   │
│                  │ claim a distinct existing id   │ the same id — silent identity  │
│                  │                                │ loss on the second row         │
│ Code complexity  │ ~85 LOC for the helper + two   │ ~40 LOC, single loop, no Set   │
│                  │ passes + Set guard             │                                │
│ Cognitive load   │ reader must understand why     │ reader sees one loop, misses   │
│                  │ Set is correctness, not perf   │ that duplicates break it       │
│ Failure mode     │ edit-in-place looks like a     │ duplicate lines silently       │
│                  │ rename; old id survives — meta │ overwrite each other; classifier │
│                  │ may briefly be stale           │ metadata vanishes              │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The helper carries a `Map<int, TodoItem>` of claims and a `Set<string>` of used ids — extra allocations on every focus blur. In `src/services/todos/scanTodos.ts` L53–L138 the two structures cost ~85 LOC where a brute-force one-pass loop would be ~40. The memory delta is negligible (a few hundred bytes per scan) but the cognitive cost is real: a contributor reading the code has to be told that the `Set` is correctness, not speed, because the file scale (20-30 todos per entry) makes the speed argument look like premature optimization.

Two passes can't disambiguate edit-in-place from delete-and-add on the same line. If the user replaces "call mom" with "fix bug" on line 7 in one edit, Pass 2's line-index fallback inherits `t-A`'s id, `createdAt`, and classifier output — the downstream `meta.type` is now stale until the LLM reclassifies. We pay that cost on every same-line replacement.

Carryover (existing rows whose id wasn't claimed) gets concatenated to the output until the reconciler in `reconcileMeta.ts` soft-deletes the orphan. Between scan and reconcile, `todos_json` can contain a row whose `sourceLine` was cleared. UI surfaces that read `todos_json` during this window see an orphan-looking entry.

### What the alternative would have cost

A single-pass `for each line { for each existing }` would have dropped to ~40 LOC and no Set allocation. It would also be wrong at n=2: two `[]` lines with identical text would both match the same `prior`, and the second `out.push` would overwrite the first in `claimed[i]`'s frame. The user types two identical todos on the same day and one of them silently inherits the other's classifier output — a bug the user can't diagnose because the UI looks fine.

The latency picture is the inverse of the usual story. At 30 todos, the one-pass version is also sub-millisecond — the optimization isn't buying speed. It's buying the absence of a category of correctness bug that costs days to chase once it ships. The two-pass shape was rewritten from a brute-force version that had exactly this bug in early Phase A.

### The breakpoint

Fine until a single `entries.text` exceeds ~500 `[]` lines on a single day, at which point the focus-blur commit becomes user-visible (>16ms blocks a frame). The real breakpoint is the data model, not the algorithm: one prose column with 500+ todos is the wrong shape. The fix is to cap entries at one-day granularity (which the app already does) — cross-day aggregation belongs at the query layer, not in `entries.text`.

### What wasn't actually a tradeoff

Choosing case-insensitive exact match in Pass 1 (`text.toLowerCase()`) wasn't a tradeoff — it was a correctness fix. Users retype todos with inconsistent capitalisation; case-sensitive matching would treat "Call mom" and "call mom" as different rows and Pass 2 would have to clean up after Pass 1's misses.

---

## Tech reference (industry pairing)

### TypeScript Map + Set (no algorithm library)

- **Codebase uses:** standard-library `Map<int, TodoItem>` (claims by index) and `Set<string>` (used-id guard) inside `src/services/todos/scanTodos.ts → scanTodosFromText()`. No external diff/match library.
- **Why it's here:** the algorithm runs at every commit boundary; bringing in a diff library (jsdiff, deep-diff) would add weight for what is fundamentally two ordered scans plus an O(1) "already claimed" check.
- **Leading today:** native Map/Set — `adoption-leading` for in-memory matching at this scale, 2026.
- **Why it leads:** runtime-builtin, O(1) average insert/lookup, zero dependency cost; the algorithm at this size is more readable without a library wrapper.
- **Runner-up:** `jsdiff` — `adoption-leading` for line-level diff with hunk semantics; the right choice if the matching ever needs to track "moved blocks of 3+ lines" or surface diff metadata to the user.

### expo-sqlite (WAL)

- **Codebase uses:** `expo-sqlite` against `loopd.db` — the existing `TodoItem[]` and `sourceLine` values that Pass 1/2 read against live in the `entries.todos_json` JSON column and `todo_meta.text`/`todo_meta.sourceLine` rows.
- **Why it's here:** the "before" snapshot the algorithm matches against is whatever the previous commit wrote to SQLite. WAL mode guarantees readers see a consistent snapshot while the next commit is being prepared.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** ships with the Expo SDK; WAL mode gives readers stable snapshots; mirrors the SQLite C API directly.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding with no bridge cost; the perf tier for bare React Native projects.

---

## Summary

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

```
[Pass 1 / Pass 2 interaction]

  i=2 "book dentist" line 3
        │
        ▼  Pass 1 exact-text vs existing
  t-C.text == "book dentist" ✓
  claimed[2] = t-C ; used += t-C
        │
        ▼  Pass 2 line-index for i=2
  guard: claimed has 2 → CONTINUE   ◀── skipped entirely
        │
        ▼
  no double-claim possible
```

[senior] Q: Why two passes instead of running one pass with a combined predicate?
         A: Pass priority encodes evidence quality. Exact-text match is stronger evidence of "same todo" than line-index match — the user kept the words, they just moved the line. If I combined them into one pass with a tiebreak, a reorder where line 5 became line 2 would race against another line that happens to now be line 5 with different text, and the wrong row would win. Running exact-text first means reorderings always claim their rows before line-index gets to compete.

```
                  Path taken (two passes)              Alternative (one pass + tiebreak)
                  ────────────────────────             ──────────────────────────────────
evidence order    exact-text ALL → line-index ALL      both predicates per row, tiebreak
reorder behaviour exact text wins → row follows        line-index may grab a different
                  the words to the new line            line whose text changed; wrong id
duplicate guard   Set blocks Pass 2 from touching      one-pass version needs the same
                  Pass-1 claims (cheap)                Set anyway; no LOC saved
correctness       reorderings + edits both handled     reorderings lose identity when
                  deterministically                    a coincidental line-index matches
LOC               ~85                                  ~70 with equivalent guards
```

[arch] Q: What breaks if a single entry has 5,000 todos?
       A: `scanTodosFromText` stays O(n+m) and linear in real time, but the scan runs on every focus blur, so the cost shows up as input lag once the entry is huge. The bigger problem is `entries.text` itself — a single prose column with 5,000 `[]` lines is the wrong data model. The migration is one-entry-equals-one-day capped naturally; if someone wanted cross-day aggregation they'd compose at the query layer, not pile into one field.

```
[scale curve — what breaks first at 10× and 100× input]

  N todos in one entry   scan time    focus-blur frame    breaks?
  ────────────────────   ─────────   ─────────────────   ──────────────────
  30 (real)              <1ms         60fps fine          no
  300 (10×)              ~5ms         60fps fine          no
  3,000 (100×)           ~50ms        ◀ 16ms budget       UI stutter on blur
  5,000+                 ~80ms        ◀◀ over budget      data model is wrong
                                                          shape, not algo
```

### The question candidates always dodge
Q: Your algorithm can't tell apart "I edited line 7" from "I deleted line 7 and added a new todo on line 7." Why is that acceptable, and what do you lose?

A: It's acceptable because the user has no way to express the difference either — they just typed. If I forced a distinction I'd have to ship a "mark this as a new todo" affordance, which is exactly the kind of friction the app exists to avoid. What I lose is identity in the rare case where a user replaces "call mom" with "fix bug" on the same line on the same edit pass — that should logically be delete-and-add but my algorithm preserves `t-A`'s id, createdAt, and classifier metadata. The wrong consequence is that downstream `meta.type` might stay stale until the LLM reclassifies. The right consequence is that fixing a typo on a todo doesn't burn a fresh classifier call. I picked the cheap-and-mostly-right shape; the principled fix would be cosine-distance on the text with a threshold, but at 20-30 todos per entry that's overkill.

```
                  Path taken (line-index preserves id)  Suggested (cosine + threshold)
                  ────────────────────────────────────  ──────────────────────────────
user friction     zero — user just types                zero — user just types
typo on a todo    inherits id ; classifier reused       inherits id ; classifier reused
"call mom" →      inherits t-A ; meta.type stale        treated as delete-and-add ;
"fix bug" on L7   until next LLM call                   new classifier call burned
classifier cost   1 call only when meta is reclassified every same-line replacement
                  on schedule                           triggers a fresh classifier call
algo complexity   ~85 LOC, deterministic                ~150 LOC + embedding fetch +
                                                        threshold tuning + flake handling
N where it matters never at 20-30 todos/entry           never at 20-30 todos/entry
verdict           cheap and mostly-right, fits scale    principled but overkill at this N
```

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

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 + v1.23.0 pass: inserted `## Tech reference (industry pairing)` section between Tradeoffs and Summary with `###` per tech + five labelled bullets each.

---
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (teacher-attendance metaphor + frontend bridge to React keyed lists); added Move 3 principle paragraph after the Comparison block. Algorithm/trace structure preserved.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (teacher-with-seating-chart scenario → naming the pattern as strongest-evidence-first matching → bolded "what depends on getting this right" pivot with `todo_meta` 1:1 invariant stakes → before/after bullets walking a `[] call mom` re-edit → one-line summary "strongest evidence first, weakest evidence cleans up the rest").

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care + How it works to anchor on real software (replaced teacher/seating-chart analogy with React's keyed-list reconciler and DevTools-warning behaviour).
