# Two-pass matching

**Industry name(s):** — (project-specific composition of exact-match-by-id + line-index fallback)
**Type:** Project-specific

> Every prose-derived feature (todos, threads, mentions) matches existing rows in two passes — exact text first, line-index second — so identity survives both reorderings and same-line edits.

**See also:** → [03-single-source-of-truth](./03-single-source-of-truth.md) · → [06-one-to-one-invariant](./06-one-to-one-invariant.md) · → [02-dsa/01-two-pass-scan-todos](../02-dsa/01-two-pass-scan-todos.md)

---

## Why care

Open React DevTools and drag-reorder an item in any keyed list. The reconciler doesn't tear down every `<li>` and rebuild — it walks the new render and matches each entry against the previous one by `key` prop first, then falls back to position for whatever didn't match. That's why React warns when you forget `key` on a list: without the strong signal, only position is left, and any insert at the top reassigns every row below to the wrong piece of state. Git's rename detection runs the same shape: exact-hash match first, content-similarity threshold second, path-based heuristic third. Two ordered identity checks, strongest evidence first, with a hard rule that nothing claimed by pass 1 is eligible for pass 2.

The question those reconcilers solve is one any system without stable IDs has to solve: when the source format doesn't carry a primary key, what cheap proxies do you use to recognise "this is the same item as before"? Not a single check — a single check is fragile against either reordering or in-place edits. The answer is a *layered identity match*: try the strict cheap signal first, fall back to a fuzzier positional one for the leftovers only.

**What depends on getting this right:** whether every piece of metadata pinned to a todo — its AI-classified `type`, its 400-word `expanded_md`, its `pinned` flag, its `user_overridden_type` — survives when the user edits a typo or reorders lines, or vanishes the next time they touch the entry. In this codebase the source format is prose: `entries.text` carries `[]`-marked lines that the user reorders and edits like text, with no stable IDs in the prose itself. The matcher in `reconcileTodoMetaForEntry` runs two passes — pass 1 matches scanner output against existing `todo_meta.text` (exact, case-insensitive, whitespace-normalised), pass 2 takes the leftovers and matches by `sourceLine`. The two signals are independent on purpose: text identity survives reordering, position identity survives same-line edits.

Without two passes (text-only match):
- User has `[] call mom` at line 3 with `type='reflect'` and a 400-word AI expansion
- They fix a typo: `[] call Mom`
- Pass 1 fails (text changed); no fallback exists
- The matcher treats the line as new; inserts a fresh `todo_meta` row with `type='todo'` default
- The 400-word expansion and the `reflect` classification become orphaned, then soft-deleted on the next reconcile

With two passes (text first, line-index second):
- User has `[] call mom` at line 3 with `type='reflect'` and the expansion
- They fix the typo to `[] call Mom`
- Pass 1 fails; pass 2 finds the previous row at `sourceLine = 3`
- The row's id is preserved; the matcher updates `text` in place; `type`, `expanded_md`, `pinned` survive untouched

The matcher is React's keyed-list reconciler applied to backend rows: strong identifier (text) first, position (line-index) second.

---

## How it works

React's keyed-list reconciler is the canonical version. Pass 1 matches new entries to old by `key` prop (the strong identifier — most rows survive a reorder unchanged); Pass 2 falls back to position for whatever Pass 1 didn't claim (catching the case where the user edited a row's value but kept its slot in the list). Two ordered checks, strongest evidence first, with a hard rule that nothing matched in Pass 1 is eligible for Pass 2. Git's `--find-renames` flag runs the same shape on file paths: exact hash match first, content-similarity threshold second.

The cascade of identity checks in one picture:

```
   each new item from the scanner
              │
              ▼
   ┌────────────────────────────────────┐
   │ Pass 1: strong signal (exact text) │  ──▶  claim row, inherit metadata
   └────────────────────────────────────┘
              │  unmatched leftovers
              ▼
   ┌────────────────────────────────────┐
   │ Pass 2: fuzzy signal (line index)  │  ──▶  claim row, inherit metadata
   └────────────────────────────────────┘
              │  still unmatched
              ▼
              insert as a new row (mint a fresh id)
```

Each pass consumes only what the previous pass didn't claim — `claimed` and `used` sets enforce the "no double-claim" rule. The four sub-sections below trace each pass, why neither is sufficient alone, and the snapshot that pass 1 actually diffs against.

### Pass 1 — exact-text match

The matcher walks every item the scanner produced and tries to find an existing `todo_meta` row whose `text` matches the new line's text (case-insensitive, whitespace-normalised). If a match is found and that existing row hasn't already been claimed by a prior item in this pass, the row is claimed and the new item inherits its id. If you're coming from React, this is the same job `key` props do for list reconciliation — give every item a stable identifier and the framework can preserve component identity across re-renders even when the array reorders. Here the "key" is the text content itself, and the framework is the matcher. Concrete consequence: if a user has `[] call mom` on line 3 today and adds three new lines above tomorrow pushing it to line 6, pass 1 finds `"call mom"` in the existing rows, claims that row's id, and the `todo_meta` keeps every piece of attached metadata — `expanded_md`, `classifier_confidence`, `pinned`, `user_overridden_type`. Nothing was deleted; nothing was re-created. Boundary: pass 1 fails the moment the user edits the line in place (changes the text by even one character), at which point the row appears to be missing.

A reordering case where Pass 1 alone is enough:

```
   yesterday's todo_meta rows:           today's scanner output:
   ┌─────┬─────────────┐                 ┌─────┬─────────────┐
   │ id  │ text         │                │ ln  │ text         │
   ├─────┼─────────────┤                 ├─────┼─────────────┤
   │ t-A │ "call mom"   │                │ 6   │ "call mom"   │   ◄── moved
   │ t-B │ "ship feat"  │                │ 4   │ "ship feat"  │   ◄── moved
   │ t-C │ "fix bug"    │                │ 5   │ "fix bug"    │   ◄── moved
   └─────┴─────────────┘                 └─────┴─────────────┘
                              │
                              ▼  Pass 1: exact-text match
                              │  (case-insensitive, whitespace-normalised)
                       ┌─────────────────────────────┐
                       │ "call mom"  → claims t-A    │
                       │ "ship feat" → claims t-B    │
                       │ "fix bug"   → claims t-C    │
                       └─────────────────────────────┘
                              │
                              ▼
                       all metadata preserved
                       Pass 2 has nothing to do
```

Reorder all you want — every row's `expanded_md`, `type`, `pinned`, `user_overridden_type` survive because the text was the identifier.

### Pass 2 — line-index fallback

For every item that pass 1 *didn't* claim, the matcher takes a second walk and looks for an existing row whose previous `sourceLine` matches this item's new line index. Think of it like React's reconciliation when no `key` is provided — the framework falls back to positional matching, with the well-known caveat that reordering corrupts identity. Same trade here, intentionally accepted. Concrete consequence: if a user has `[] call mom` on line 3 and edits it in place to `[] call mom about flight`, pass 1 fails (the text changed) but pass 2 succeeds (this line is still index 3, and the previous scan tagged the row at line 3). The row keeps its id. Boundary: pass 2 fails when the user deletes line 3 *and* inserts a new line at position 3 in the same commit — pass 1 finds no match (new text), pass 2 finds the index but it now belongs to a different prose line. The match is wrong, the existing row gets a wrong text update, and the deleted item's row is now orphaned (and soft-deleted on the next reconcile).

A same-line edit case where Pass 2 saves the row:

```
   yesterday's todo_meta:                 today's scanner output:
   ┌─────┬──────────────────┬──────┐    ┌─────┬──────────────────────────┐
   │ id  │ text              │ line │    │ ln  │ text                      │
   ├─────┼──────────────────┼──────┤    ├─────┼──────────────────────────┤
   │ t-A │ "call mom"        │  3   │    │  3  │ "call mom about flight"   │  ◄── edited
   └─────┴──────────────────┴──────┘    └─────┴──────────────────────────┘
                              │
                              ▼  Pass 1: exact-text match
                       ┌─────────────────────────────┐
                       │ "call mom about flight"     │
                       │   ✗ no exact match          │
                       └─────────────────────────────┘
                              │
                              ▼  Pass 2: line-index fallback
                       ┌─────────────────────────────┐
                       │ line 3 was previously t-A   │  ──▶  claim t-A
                       │ (sourceLine match)          │      update text in place
                       └─────────────────────────────┘
                              │
                              ▼
                       row keeps its id
                       expanded_md, type, pinned preserved
```

The text field updates to the new prose, but every other column on the row rides along untouched.

### Why both passes — neither alone is enough

If you ran only pass 1 (text-only), the moment the user fixes a typo in place the row is treated as new — they lose its classifier result and `expanded_md`. If you ran only pass 2 (index-only), the moment the user reorders lines every row's metadata shifts to the wrong todo. The pattern works because the two signals are independent — text identity survives reordering, position identity survives same-line edits — and the matcher consumes them in the right order: cheap-and-strict first, fuzzy-and-positional as a safety net for the leftovers.

Walking the failure modes of each signal alone side by side:

```
   user action                Pass 1 only           Pass 2 only            Two passes
   ─────────────────────      ──────────────────    ──────────────────     ──────────────────
   fix typo on line 3         ✗ new text →          ✓ line still 3 →       ✓ Pass 2 catches it
                                 row treated new       row claimed
                                 metadata orphaned
   reorder lines (no edit)    ✓ text match holds    ✗ all indices         ✓ Pass 1 catches it
                                 metadata survives     shifted →
                                                       wrong row per slot
   reorder + edit same line   ✗ text changed         ✗ index shifted        ✓ Pass 1 catches
                                                                              unedited lines;
                                                                              Pass 2 catches
                                                                              the edited one
   delete + insert same slot  ✗ different text       ✗ wrong row at index   ✗ wrong match
                                                                              (one bad case
                                                                              accepted by design)
```

Two signals, independent failure modes — every realistic user action is caught by at least one pass except the delete-then-insert-at-same-index case, which we accept by design (it's rare in practice and the soft-delete invariant cleans up the orphan).

### The last-known scan record — what pass 1 reads against

Pass 1 doesn't compare against the new scan; it compares against what the previous scan stored as `text` on each `todo_meta` row. That's the "before" snapshot the matcher diffs into the "after." If you've worked with React's reconciler, this is the equivalent of the previous virtual DOM — the framework keeps it around so the next render has something to diff against. The codebase stores it directly on `todo_meta.text`; every successful reconcile updates it so the next pass's pass 1 reflects today's state.

What `todo_meta.text` looks like as a snapshot the matcher diffs against:

```
   todo_meta (the "previous virtual DOM")
   ┌─────────┬──────────────────┬──────┬──────────┬─────────────────────┐
   │ todoId  │ text              │ line │ type     │ expanded_md          │
   ├─────────┼──────────────────┼──────┼──────────┼─────────────────────┤
   │ t-A     │ "call mom"        │  3   │ personal │ "Mom's birthday..."  │
   │ t-B     │ "ship feat"       │  4   │ work     │ "v2 spec..."         │
   │ t-C     │ "fix bug"         │  5   │ work     │ "404 on /todos..."   │
   └─────────┴──────────────────┴──────┴──────────┴─────────────────────┘
        │           │            │
        │           │            └── Pass 2 reads sourceLine
        │           └─────────────── Pass 1 reads text
        └─────────────────────────── id is what survives the match
```

After every successful reconcile, the matcher writes today's `text` and `sourceLine` back to these columns — so tomorrow's Pass 1 reflects what the user typed today, not what they typed last week.

This is what people mean by "graceful identity preservation." When you can't stamp a primary key into your source format, you reach for two cheap proxies (content + position) and rank them by strictness. The same pattern shows up in `git`'s rename detection (content similarity threshold + path heuristic), in `react`'s reconciler (`key` first, position second), in `diff` algorithms (LCS first, fall back to position when ties tie). The full picture is below.

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
This is a simplified diff algorithm — Myers' diff and its descendants do exactly this kind of two-pass match (LCS first, fallback heuristics second) at character/line granularity. Buffr applies the idea to row identity: "what stayed the same? then what shifted?"

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

We traded a clean diff with explicit row IDs for a heuristic that works against prose the user actually types — identity survives in the common cases at the cost of one ambiguity the algorithm can't tell apart.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (two-pass match     │ Alternative (hidden UUID per   │
│                  │ on prose itself)               │ prose line, injected on write) │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Performance      │ O(n+m) with Map+Set in         │ O(n) lookup by UUID            │
│                  │ scanTodosFromText (n = matches │                                │
│                  │ in prose, m = existing rows);  │                                │
│                  │ typically 1–20 each, sub-ms    │                                │
│ Paste / dictate  │ works — pasted prose flows     │ breaks — pasted text has no    │
│  workflows       │ through Pass 1 (text match) or │ UUIDs, falls into "all new"    │
│                  │ Pass 2 (line index)            │ branch every time              │
│ Edge case        │ "edit in place" vs "delete +   │ unambiguous — every line has   │
│  ambiguity       │ retype on same line" produce   │ an explicit identifier         │
│                  │ identical inputs to matcher    │                                │
│ Complexity       │ ~90 LOC in scanTodos +         │ ~30 LOC matcher + every write  │
│                  │ ~60 LOC in reconcileMentions   │ path has to inject/strip UUID  │
│                  │ (Pass 2 ±3-line window)        │ tokens from prose (hard)       │
│ User-visible     │ none — prose looks normal       │ tokens leak on copy-paste out  │
│  artifact        │                                │ of the app                     │
│ Failure at 2     │ silent — LWW picks one writer  │ silent — same problem at the   │
│  writers         │                                │ prose layer                    │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The algorithm cannot distinguish "I edited line 7 in place" from "I deleted line 7 and typed a new todo on the same line." Both produce the same inputs to Pass 1 (no exact text match) and Pass 2 (line index match wins). The row's identity flows to the new content either way. In practice this is the right answer for journaling — users rarely delete-and-retype on the same line — but in an interview defense it has to be acknowledged.

Bulk reorder combined with bulk text edit degrades the algorithm to "everything looks new." Both passes miss: Pass 1 misses because text changed, Pass 2 misses because lines shifted. Every existing row falls into carryover (its `sourceLine` cleared, the row preserved with `deleted_at` left intact) and every new line becomes a new todo. The user's classifier output, expansion, and pin state survive on the carryover rows but no longer line up with what's on screen. This is rare for a single-user journal; it would be catastrophic for a tool that ingests other people's text.

Carryover rows accumulate. A todo whose prose line was deleted stays in `todo_meta` with `sourceLine` cleared until the soft-delete path or reconciler eventually removes it. We accepted this — the soft-delete window is forgiving, and `reconcileTodoMetaForEntry` (`src/services/todos/reconcileMeta.ts` L48–L92) keeps the 1:1 invariant — but a contributor reading the matcher in isolation can wonder why we keep ghost rows around.

### What the alternative would have cost

If we had injected hidden UUID tokens into the prose (e.g., a `^uuid` suffix per `[]` line), every paste workflow would lose identity. The user pastes a todo list from a note app, the tokens aren't there, the matcher treats them as all new. Dictation has the same problem. We'd need a "rehydrate token" mode that ran heuristic matching anyway — exactly two-pass match — so we'd carry both systems.

We'd also have to strip tokens from every export, every share, every clipboard copy. That's at least 4 surfaces (`docs/spec.md` lists journal export, vlog caption, AI summary, clipboard) and 4 places to forget. The token-leak bug is shipping inevitable.

### The breakpoint

Fine until the app needs to round-trip prose between writers — collaborative editing, bulk import from a third-party source, OCR pipelines that produce todo-like lines. At that point "the user's prose IS the identifier" stops holding because identity has to survive crossing trust boundaries. The fix is either CRDT-prose (which carries identity at the character level, see [08-conflict-last-write-wins](./08-conflict-last-write-wins.md)) or a versioned snapshot system where the matcher runs against the prior snapshot, not the current row state.

---

## Tech reference (industry pairing)

### Hand-written matchers (no parser library)

- **Codebase uses:** TypeScript matcher functions in `src/services/todos/scanTodos.ts` (Pass 1 + Pass 2 over `[]` lines) and `src/services/threads/reconcileMentions.ts` (Pass 1 + Pass 2 with ±3 line shift window for `#tag`).
- **Why it's here:** the algorithm has to run on every focus blur and screen leave — bringing in a parser dependency would add weight for what is fundamentally two ordered scans over typed arrays.
- **Leading today:** hand-written matchers — `adoption-leading` for sparse-marker prose reconciliation, 2026.
- **Why it leads:** the matching grammar is tiny (one comparator per pass); a library would add startup cost, types to maintain, and error-recovery code the use case doesn't need.
- **Runner-up:** `chevrotain` / `nearley` — `innovation-leading` parser combinators with typed grammars; the right move once the marker grammar grows recovery requirements or supports more than ~5 marker classes.

### expo-sqlite (WAL)

- **Codebase uses:** `expo-sqlite` against `buffr.db` — `todo_meta.text` and `todo_meta.sourceLine` are the columns the matcher reads as the "before" snapshot for Pass 1 and Pass 2 respectively.
- **Why it's here:** the matcher needs synchronous read access to the previous scan's output; SQLite's WAL gives readers a stable snapshot while writers commit, so the matcher sees a consistent "before" state.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** ships with the Expo SDK; WAL mode is battle-tested; mirrors the SQLite C API directly with zero bridge cost.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding with no bridge cost; the perf tier for bare React Native projects.

---

## Summary

Exact-then-fallback matching is a layered reconciliation strategy: try the strict cheap identifier first, then fall back to a fuzzier positional one for the leftovers, so identity survives both reorderings and same-line edits. In this codebase `scanTodosFromText` runs Pass 1 (exact case-insensitive text match, which catches reorderings) and Pass 2 (line-index match against the existing row's `sourceLine`, which catches "I edited the words on this line"); the same shape lives in `reconcileMentions` for `#tag` threads, with Pass 2 widened to a ±3 line shift window. The constraint was using the prose itself as the identifier — a hidden UUID would break paste, dictate, and natural-edit workflows the user actually relies on. The cost is that "I edited line 7" looks the same as "I deleted line 7 and added a new todo" to the algorithm, and bulk reorders combined with bulk text edits degrade because neither pass fires. The two-pass algorithm assumes single-writer; two devices editing the same prose breaks it silently, not loudly.

Key points to remember:
- Pass 1 (exact text) runs before Pass 2 (line index) so reorderings always win over positional matches.
- The `used` set blocks double-claims — duplicate `[]` lines with identical text fall through cleanly.
- Lives in step 1 (Data model) and step 4 (State ownership) of the system-design checklist.
- A row's id is the user's investment over time (classifier output, AI expansion, pin state); content edits shouldn't destroy identity.
- Unmatched existing rows survive as carryover with `sourceLine` cleared, paying for it with orphan-like rows that the soft-delete + reconciler combo eventually cleans up.

---

## Interview defense

### What an interviewer is really asking
"How do you know which `[]` line is which" sounds trivial. The interviewer is probing for whether you understand that user-facing identity (a todo with its classifier output, expansion, and pin) survives content edits — and whether you can name the algorithm that preserves it cheaply. They're looking for diff-algorithm vocabulary without the candidate reaching for "I'd just give every line a UUID."

### Likely questions

[mid] Q: Why does Pass 1 run before Pass 2? What goes wrong if you flip the order?

A: Pass 1 is exact-text match; Pass 2 is line-index fallback. If Pass 2 ran first, "I moved my todos around" would match by line position — the wrong todo gets matched to the wrong line, and identity gets shuffled. By running text-match first, a reorder always wins: "call mom" finds its prior row regardless of where the user moved it. Pass 2 only fills in what Pass 1 couldn't — the case where the user edited the words on a line that didn't move.

```
[order matters]

  Pass 1: exact text     ─── strongest evidence ───
        │                                          │
        ▼  reorders win                            │
  Pass 2: line index     ─── weaker, fills gaps ───┘
        │
        ▼
  leftovers → new todos
  unclaimed existing → carryover
```

[senior] Q: Why two passes and not just give every prose line a hidden UUID?

A: A hidden UUID means the user can't paste prose between days, can't copy-paste a list of todos from a note app, can't dictate prose to the OS keyboard — every "import" path would either lose identity or have to invent ids. Two-pass matching uses the prose itself as the identifier, which is what the user types and edits naturally. The cost is that the algorithm gets confused by simultaneous bulk edit + bulk reorder, but that's a workflow that doesn't actually exist for solo journaling. I picked the constraint that fits the user, not the constraint that fits the algorithm.

```
                  Path taken (two-pass on prose)       Alternative (hidden UUID per line)
                  ──────────────────────────────       ──────────────────────────────────
identifier        the prose itself                     ^uuid token suffix on every []
paste-in works    yes — matcher rehydrates ids         no — pasted lines have no token,
                                                       all new rows
dictation works   yes — same path                      no — same problem
token leak risk   none — no tokens to leak             every export / share / clipboard
                                                       must strip
ambiguous case    "edit in place" ≡ "delete+retype"    none
contributor       "two passes? why?"                   "where does the uuid come from?"
                  → one paragraph                      → tooling for inject + strip
algorithm cost    O(n+m) with Map+Set                  O(n) lookup
```

[arch] Q: What happens to this design if the prose can be edited by two devices at the same time?

A: It would break in the worst way — silently. Two devices both running `scanTodosFromText` against different versions of the prose would produce different `todos_json` arrays, both legitimate-looking, and the LWW conflict resolver in `chooseWinner` would pick one and discard the other's identity preservation work. The fix isn't on the matcher; it's on the prose itself. Either prose becomes a CRDT (Y.js / Automerge), or the app goes single-writer-at-a-time with explicit handoff. The two-pass match is a single-writer algorithm.

```
At 2 writers (multi-device) editing the same day's prose:

  ┌─ UI / editor layer ─────────────────────────┐
  │ unchanged — each device shows its own text  │
  └─────────────────────────────────────────────┘
              │
  ┌─ Scanner (scanTodosFromText) ───────────────┐
  │ unchanged shape — single-writer algorithm   │  ◀── BREAKS FIRST
  │ Device A & B each produce legit todos_json  │     (both legitimate,
  │ from their own prose                        │     one silently dropped)
  └─────────────────────────────────────────────┘
              │
  ┌─ Conflict resolver (chooseWinner / LWW) ────┐
  │ picks one writer, discards other's identity │
  │ preservation work                           │
  └─────────────────────────────────────────────┘
              │
  ┌─ Canonical prose layer ─────────────────────┐
  │ needs CRDT (Y.js / Automerge) to converge   │  ◀── needs replacement
  │ deterministically before scanner runs       │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: What does your algorithm do when a user has two `[]` lines with the exact same text on the same day?

A: Pass 1 sees the second match's text in the existing list, but the existing row has already been claimed by the earlier match — the `used` set blocks the double-claim. The second match falls through to Pass 2. Pass 2 looks for an existing row with the same line index and an unclaimed id; if the second occurrence is on a fresh line, it gets a new todo. If both occurrences are at the same line (impossible in normal prose, but defensively considered) the algorithm produces one match and one new row. The honest answer is that this case is rare in journaling — duplicate `[]` lines with identical text are usually a copy-paste accident, and the user notices and edits one of them. If duplicates were common, I'd add a `(text, lineIndex)` composite key to the matcher; with the actual data shape, the `used` set is enough.

```
                  Path taken (used-set blocks         Suggested ((text, lineIndex)
                  double-claim, second falls          composite key from day 1)
                  through to Pass 2)
                  ──────────────────────────────      ──────────────────────────────────
duplicate-prose   rare — copy-paste accident,         common — would be the right call
 frequency        user notices and edits
algorithm cost    O(n+m), small constants             O(n+m), larger map keys
correctness       correct in the common case;         correct universally
                  defensive in the rare case
data hint         actual data shape says duplicates   would be the right call if data
                  are accidents, not workflow         shape changes
contributor       "why no composite key?" →           "why composite key for a rare
 confusion        "duplicates are rare; used-set is   case?" → same paragraph but
                  enough"                             flipped
when worth        if duplicates show up in            now
 flipping         analytics
```

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

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).

---
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram. Skipped layer labels — the diagram is a single-function algorithm trace (Pass 1 / Pass 2 decision logic), not a cross-layer composition.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 + v1.23.0 pass: inserted `## Tech reference (industry pairing)` section between Tradeoffs and Summary with `###` per tech + five labelled bullets each.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (mental-model opening / layered walkthrough with frontend bridges / principle paragraph); each move-2 sub-section now carries its technical term, frontend bridge, concrete consequence, and boundary condition.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (librarian rebuilding a rearranged shelf scenario → layered identity match pattern named as the answer → bolded "what depends on getting this right" with metadata-preservation stakes → before/after walking a typo-fix on a classified todo → one-line "title first, shelf position second").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced librarian-rebuilding-shelf + librarian-re-cataloguing analogies with React keyed-list reconciler + git rename detection layered identity checks). Both Move 1s were missed by the original triage agent.

---
Updated: 2026-05-14 — v1.32.0 pass: R1 no-op (anchors already use level-1 primitives: React reconciler + `key` prop + git rename detection). Added Move 1 mnemonic diagram (cascade-of-checks shape) + 4 Move 2 sub-section diagrams: Pass 1 reordering trace, Pass 2 same-line-edit trace, signal-failure comparison table, last-known-scan snapshot. Total: 5 new diagrams.
