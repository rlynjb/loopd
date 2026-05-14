# Two-pass thread mention reconcile — line-shift tolerant

**Industry name(s):** — (project-specific composition of exact-match + line-index fallback)
**Type:** Project-specific

> Same shape as the todo two-pass, but Pass 2 uses `±3 line shift` instead of exact line match.

**See also:** → [01-two-pass-scan-todos](./01-two-pass-scan-todos.md) · → [09-tag-parsing-code-fence](./09-tag-parsing-code-fence.md)

---

## Why care

Run `git blame` on a file you've been editing for months. The line that originally said `const PORT = 3000` still traces back to a commit from six months ago, even though you've added thirty lines above it and it now sits at row 47 instead of row 17. Blame doesn't lose identity because the file shifted — it follows the line through diffs, tolerating bounded movement before declaring the line "new." `git apply --3way` does the same for patches: try the original line number first, then sweep nearby for context lines that still match before giving up. Identity anchors on content; position is allowed to slip a bounded amount.

That is the question this operation answers when prose with embedded `#tag` markers is re-scanned after the user has typed paragraphs above existing tags: when the line numbers shift by one or two, do we keep the mention rows or burn their identity? Not strict line-number equality, not full text-similarity rebuild — just *fuzzy match with a bounded displacement window*, the same family as `git apply --3way`, git blame line tracking, and PDF annotations across reflowed pages.

**What depends on getting this right:** the durability of `thread_mentions` row ids across ordinary editing. In this codebase `thread_mentions` rows hang off `entries.text` by `(threadId, sourceLine, tagText)`, and any future per-row attribute (mention recency, user-applied weights, sync state in the `synced_at` ledger) is keyed to that id. If `reconcileMentions` deletes the old row and inserts a new one every time the user adds a paragraph above a `#health` tag, `schedulePush()` fires a delete-plus-insert pair to Supabase instead of nothing, the cloud sees churn, and any downstream aggregate built on mention age resets. The ±3 line tolerance is how the algorithm avoids burning identity on the most common edit shape (adding context above a tag).

Without the displacement window (strict line-index Pass 2):
- User has `#health` tag at line 8; `thread_mentions` row `m2` records `sourceLine=8`
- User adds 3 lines of prose at top of entry; the tag is now at line 11
- Pass 1 (exact line 11) misses; Pass 2 (exact line 8) misses
- `m2` gets deleted; a fresh row is inserted with new id and `sourceLine=11`
- `schedulePush()` sends a delete + insert to Supabase for what is logically the same mention
- Any downstream "first seen" timestamp on the mention resets

With the ±3 window:
- Pass 1 (exact line 11) misses
- Pass 2 sweeps `(threadId=health, tagText="health")` within ±3 lines of 11
- Finds `m2` at line 8; `|8 - 11| = 3 ≤ 3` ✓
- `updateMentionSourceLine(m2, 11)` — same row, new line number
- `schedulePush()` sends one update; cloud sees a single field change; first-seen survives

Anchor on identity, allow a bounded slip on position.

---

## How it works

`git blame --follow` tracks a line through commits by checking the original line number first, then sweeping nearby lines for matching content if the exact position no longer hits. The sweep window is bounded — too wide and the algorithm starts confusing unrelated code for the original line. If you're coming from frontend, this is the same shape as `react-window`'s scroll restoration when a virtualized list resizes: try the exact prior scroll position first, then expand a small window of nearby indices before giving up and snapping to the top. Two ordered checks, exact first, tolerance second, with a hard cap on how far identity can drift before being abandoned.

**Real operation:** `reconcileMentions` in `src/services/threads/scanThreads.ts`.

---

## The data

```
  parsed (from current text):
    [{ threadId: "th1", lineIndex: 5, tagText: "loopd" },
     { threadId: "th2", lineIndex: 7, tagText: "Health" }]

  existing (already in thread_mentions):
    [{ id: "m1", threadId: "th1", sourceLine: 5, tagText: "loopd"  },   ← exact match
     { id: "m2", threadId: "th2", sourceLine: 4, tagText: "health" }]   ← shifted +3
```

**The problem:** match parsed-tags-from-text to existing-mention-rows. The user moved a tag down 3 lines by adding lines above; the row id should survive that.

---

── Brute force ──────────────────────────────────

Pseudocode:

```
  for each parsed-tag in parsed:
    for each existing-mention in existing:
      if existing.threadId == p.threadId
         AND (existing.sourceLine == p.lineIndex
              OR (existing.tagText.lower == p.tagText.lower
                  AND |existing.sourceLine - p.lineIndex| <= 3)):
        match!
        break
  // re-scan whole `existing` array per parsed entry
```

Execution trace (`parsed = [{th1, line 5, "loopd"}, {th2, line 7, "Health"}]`, `existing = [m1{th1, line 5}, m2{th2, line 4, "health"}]`):

```
  parsed[0] (th1, line 5, "loopd"):
    scan existing:
      m1: threadId match, sourceLine == 5 ✓     match m1
    cost: 1 scan step before match

  parsed[1] (th2, line 7, "Health"):
    scan existing:
      m1: threadId mismatch (th1 != th2)        skip
      m2: threadId match, sourceLine 4 != 7;
          tagText match, |4 - 7| = 3 ≤ 3 ✓     match m2
    cost: 2 scan steps before match

  Total: 3 scan steps. No claim guard — naive matches risk double-claim if two parsed entries scan the same row first.
```

Complexity: O(n × m) time · O(n) space — where n = parsed tags, m = existing mentions.

What goes wrong at scale: at per-entry scale (typically <10 mentions, n × m < 100), brute force is essentially the same as the optimal version — the codebase deliberately keeps brute-force shape for Pass 2 because building a Map for 5-element lookup costs more than the scan it would replace. With 10,000 mentions × 10,000 parsed tags brute force would run ~100M ops; that's the threshold where indexing actually pays. Real bug at scale: no `used` Set means two same-text mentions on adjacent lines can both claim the same existing row.

── Optimal ──────────────────────────────────────

The insight: a `used` Set prevents double-claim; pass-priority encodes evidence quality (exact-line beats fuzzy-line). Per-pass loop is still O(n × m) but bounded by per-entry counts.

```
  claimed = empty Map<int, mention>
  used    = empty Set<string>

  // Pass 1: exact (threadId, sourceLine)
  for i in 0..parsed.length:
    p = parsed[i]
    prior = first existing where existing.threadId == p.threadId
                              AND existing.sourceLine == p.lineIndex
                              AND existing.id NOT in used
    if prior: claimed[i] = prior; used.add(prior.id)

  // Pass 2: (threadId, tagText) within ±3 lines
  for i in 0..parsed.length:
    if claimed has i: continue
    p = parsed[i]
    prior = first existing where existing.threadId == p.threadId
                              AND existing.tagText.lower == p.tagText.lower
                              AND |existing.sourceLine - p.lineIndex| <= 3
                              AND existing.id NOT in used
    if prior: claimed[i] = prior; used.add(prior.id)

  // Apply diffs
  for i in 0..parsed.length:
    p = parsed[i]
    prior = claimed[i]
    if prior:
      if prior.sourceLine != p.lineIndex: updateMentionSourceLine(prior.id, p.lineIndex)
      if prior.tagText    != p.tagText:   updateMentionTagText(prior.id, p.tagText)
    else:
      insertMention(makeNew(p))
  for row in existing:
    if row.id NOT in used: deleteMention(row.id)
```

**Execution trace:**

```
  Pass 1:
    i=0 (th1, line 5)  → m1 (th1, sourceLine 5) ✓     claimed[0]=m1, used={m1}
    i=1 (th2, line 7)  → m2 (th2, sourceLine 4) ✗     claimed[1]=∅,  used={m1}

  Pass 2:
    i=1 (th2, line 7, "Health")
        candidate m2: same threadId ✓
                      tagText.lower == "health" == "health" ✓
                      |4 - 7| = 3 ≤ 3 ✓
        claimed[1]=m2, used={m1, m2}

  Apply:
    i=0 prior=m1, no change       → no-op
    i=1 prior=m2, sourceLine 4→7  → updateMentionSourceLine(m2, 7)
                  tagText "health"→"Health" → updateMentionTagText(m2, "Health")

  Done: m1 + m2 both kept. No inserts, no deletes.
```

**Complexity:** O(n × m) per pass time · O(n) space. Within an entry, n + m is small (typically <10).

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n × m)       │ O(n × m) bounded │
  │ Space           │ O(n)           │ O(n)             │
  │ At 1,000 items  │ 1,000,000 ops  │ 1,000,000 ops    │
  │ At 10,000 items │ 100,000,000 ops│ 100,000,000 ops  │
  │ Readable?       │ yes            │ yes (Set guard)  │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: here. Pass 2 is the cheap path. The `find` is linear over a per-entry list — no Map needed because the predicate is "threadId AND text AND |line shift| ≤ 3", which doesn't index cleanly. At per-entry scale (handful of mentions), the constant overhead of building a Map exceeds the savings. The "optimal" version isn't asymptotically better — it just adds the `used` Set guard for correctness against double-claim.

This is what people mean by "anchor on identity, allow a bounded slip on position." The ±3 window is the cap that keeps the algorithm honest — small enough that wrong matches stay rare, large enough that ordinary edits don't burn identity. Git blame does it across commits, PDF annotation tools do it across reflowed pages, IDE breakpoints do it when a file changes outside the editor. The shape generalises to anything that needs to keep an anchor pinned to a moving target.

---

## In this codebase

**Algorithm:**     `src/services/threads/scanThreads.ts` → `reconcileMentions()` L169–L230 (private; called from `scanThreadMentionsForEntry` L109 and `scanThreadMentionsForTodo` L143)
**Parser input:**  `src/services/threads/scanThreads.ts` → `parseTags()` L37–L64 produces the `parsed` array
**Storage:**       `src/services/database.ts` → `insertMention`, `updateMentionSourceLine`, `updateMentionTagText`, `deleteMention` (the four side-effect calls inside `reconcileMentions`)

---

## Elaborate

### Where this pattern comes from
The ±3 fuzzy match is a tolerance window — same idea as patch-tolerance in `git apply --3way`, where context lines around a hunk allow the patch to land at slightly shifted positions.

### The deeper principle
**Match strictness should reflect data churn.** Todo lines rarely shift far (Pass 2 uses exact line index). Thread tags often shift by a few lines because users add prose above them. The Pass 2 tolerance reflects observed user behaviour, not an arbitrary number.

### Where this breaks down
- Adding more than 3 lines above a tag breaks Pass 2 → existing mention is deleted, new one inserted with new id. Acceptable for now — large-shift edits are rare.
- Two same-text tags on adjacent lines could swap claims; the `Set` guard prevents double-claim but the assignment may not be intuitive.

### What to explore next
- [09-tag-parsing-code-fence](./09-tag-parsing-code-fence.md) → how `parsed` is produced (with code fences masked).
- [01-two-pass-scan-todos](./01-two-pass-scan-todos.md) → the same shape with stricter Pass 2.

---

## Tradeoffs

We traded asymptotic optimality and a tunable threshold for a tiny constant on a per-entry data set where the linear-scan version is cheaper than any indexed alternative.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (linear, ±3 window) │ Alternative (Map + sorted idx) │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Time complexity  │ O(n × m) per pass — bounded    │ O(n + m × log m) — index build │
│                  │ by per-entry tag count         │ + binary search per Pass 2 hit │
│ Latency at N=5   │ <0.1ms — linear over 5         │ ~0.3ms — Map alloc + sort      │
│ (real per-entry) │ elements is faster than alloc  │ overhead exceeds the savings   │
│ Latency at 10×N  │ ~0.5ms at 50 tags              │ ~0.6ms at 50 tags              │
│ Latency at 100×  │ ~50ms at 500 tags              │ ~5ms at 500 tags — pays off    │
│ Code complexity  │ ~62 LOC two-pass + Set guard   │ ~110 LOC: index, sort, binary  │
│                  │                                │ search, range scan             │
│ Cognitive load   │ predicate reads inline: "same  │ reader must trace through the  │
│                  │ thread AND text AND |Δ|≤3"     │ sorted-index range lookup      │
│ Tolerance shape  │ ±3 lines — observed user shift │ same window required ; index   │
│                  │ when adding a paragraph above  │ must still scan the band       │
│ Failure mode     │ 4+ line shift → identity lost, │ same — index doesn't change    │
│                  │ new row inserted, old deleted  │ the tolerance semantics        │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The ±3 window is a hard threshold. A 4-line shift loses the row identity entirely — Pass 2 misses, the existing row is deleted, a new mention row is inserted with a fresh id. Any downstream attribute hanging off the mention id (none exist today, but staleness math does aggregate per row) gets reset. The number was picked from observed user behaviour, not measured optimisation; it could be wrong by ±1 and we'd never know without telemetry.

Pass 2 is O(n × m) — a linear scan over `existing` for every unmatched parsed tag. In `reconcileMentions` L169–L230, that's a naked `for ... existing.find(...)` with the ±3 predicate inline. At per-entry scale (typically <10 tags), this is ~50 ops worst case and finishes in <0.1ms. The cost is asymptotic uncleanliness: a reader sees `O(n × m)` and assumes a bug.

`updateMentionSourceLine` and `updateMentionTagText` are separate SQLite statements. When both change for the same row (the trace above does this for `m2`), we run two writes instead of one combined update. The cost is two more sync points and two `schedulePush()` triggers per affected row.

### What the alternative would have cost

A `Map<(threadId, tagText), sortedLines[]>` index would lift Pass 2 to O(n + m × log m). At N=5 per entry it's slower — the Map allocation, the sort, the binary-search call frames all cost more than the linear scan. The asymptote only pays at ~500 tags per entry, which the app never reaches. The added ~50 LOC of index plumbing would make the function harder to follow.

A single combined `updateMention(id, sourceLine, tagText)` would save one statement when both fields change. The cost is a wider SQL surface (one extra parameterised query, one extra mapper in `database.ts`) for a saving that fires only in the rare "user moved AND retyped" case. Not worth the schema-surface growth.

A wider tolerance window (say ±10) would catch more shifts but starts matching across unrelated paragraphs. The same `#health` tag in two different contexts within the entry can swap identities at ±10. The window has to be small enough that the match means something.

### The breakpoint

Fine until a single entry has more than ~200 tags or `reconcileMentions` is called across multiple entries in a single sweep. The first is a data-model failure (split the entry); the second would happen if a future feature ran a cross-day mention rebuild — at that point n × m grows to thousands and the Map+sorted-index version starts winning. The rewrite is local to `reconcileMentions` and would touch ~50 LOC.

### What wasn't actually a tradeoff

Case-insensitive `tagText` comparison in Pass 2 isn't a tradeoff — `#Health` and `#health` resolve to the same thread by design (the thread slug is case-insensitive). Matching case-sensitively here would create phantom mismatches that Pass 2's whole purpose is to tolerate.

---

## Tech reference (industry pairing)

### TypeScript Set + linear-scan find (no algorithm library)

- **Codebase uses:** native `Set<string>` (used-row guard) and `Array.prototype.find` (Pass 2 window scan) inside `src/services/threads/scanThreads.ts → reconcileMentions()`.
- **Why it's here:** Pass 2's predicate ("threadId AND text AND |line shift| ≤ 3") doesn't index cleanly into a single hash key; linear find over per-entry mentions is cheaper than building a multi-key index at this scale.
- **Leading today:** native Set + linear find — `adoption-leading` for sparse per-entry matching, 2026.
- **Why it leads:** zero dependency cost; the predicate fits in two lines; building a multi-key Map for ~5 mentions per entry would cost more than it saves.
- **Runner-up:** `lodash` `keyBy` + filter — `adoption-leading` for richer multi-key indexing once the predicate grows beyond two fields.

### expo-sqlite (WAL)

- **Codebase uses:** `expo-sqlite` against `loopd.db` — `thread_mentions` rows live here, and the "existing per-entry mentions" array Pass 1/2 reads against is fetched via the `database.ts` connection.
- **Why it's here:** the matcher needs a synchronous read of the previous scan's mentions; WAL mode gives a consistent snapshot while the next commit is being prepared.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** ships with Expo; WAL mode is battle-tested; zero bridge cost.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding for bare RN.

---

## Summary

Fuzzy match with a displacement window is the family of "anchor on identity, allow a bounded slip on position" — the same shape that `git apply --3way` uses for patch tolerance and that source-control "blame" uses to track lines across commits. In this codebase `reconcileMentions` matches parsed-tags-from-text against existing `thread_mentions` rows: Pass 1 demands an exact `(threadId, sourceLine)` match; Pass 2 falls back to `(threadId, tagText)` within ±3 lines for the unmatched residue. The constraint is that users often add a paragraph above a tag without moving the tag itself, so the row id should survive that small shift — a stricter algorithm would burn identity every time. The cost is that Pass 2 is O(n × m) instead of O(n + m), but per-entry n + m is bounded at a handful (typically <10), so the constant overhead of building a Map for hash lookup would exceed the savings of the linear scan it would replace. At the call site `parseTags` only returns tags within one entry, which is what makes the asymptote stop mattering.

Key points to remember:
- Same two-pass shape as the todo scanner, but Pass 2 uses a ±3 line tolerance window instead of exact line match.
- The `used` Set is correctness, not performance — it prevents two same-text mentions on adjacent lines from double-claiming the same existing row.
- Pass priority encodes evidence quality: exact `(threadId, sourceLine)` beats fuzzy `(threadId, tagText)` within ±3.
- O(n × m) per pass, but n + m is bounded at the call site (one entry's worth of tags), so the constant cost is what's actually paying.
- ±3 isn't arbitrary — it reflects observed user behaviour ("added a paragraph above the tag") rather than a chosen threshold.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I can defend O(n×m) on a hot path with a straight face. The honest answer is that "hot path" is a relative term — `reconcileMentions` runs on every entry commit, but per-entry tag count is bounded at a handful, so n×m is bounded at ~50. A Map allocation per call would cost more than the loop saves. The interviewer wants to see if I'm picking complexity classes by measurement, not by reflex.

### Likely questions

[mid] Q: Why does Pass 2 use `±3` instead of `±5` or `±10`?
      A: Three is the tolerance window for "the user added a paragraph above this tag and didn't move the tag itself." Empirically that's the most common shift — people add context, not displace tags. At ±10 I'd start matching across unrelated sections of the entry; the same `#health` tag in two different contexts could swap identities. ±3 keeps the match tight enough that confusion is rare and small enough that the linear scan stays cheap.

```
[tolerance window — what survives, what doesn't]

  user action                       shift   ±3?    outcome
  ───────────────────────────────   ─────   ────   ─────────────────────────
  retype tag in place               0       ✓      Pass 1 exact match
  add paragraph above (~3 lines)    +3      ✓      Pass 2 fuzzy match
  add a section above (~5 lines)    +5      ✗      identity lost ; reinsert
  move tag across whole page        +30     ✗      identity lost ; reinsert
```

[senior] Q: Why isn't Pass 2 indexed by `(threadId, tagText)` like Pass 1 could be?
         A: Because the third predicate is a *range*, not an equality. `|sourceLine - lineIndex| <= 3` doesn't fit a hash key — I'd need a sorted index per `(threadId, tagText)` group plus a binary search. At n+m around 10, building that structure costs more in allocation and indirection than the linear scan it would replace. I bounded the inputs at the call site — `parseTags` only returns tags within one entry — so the constant cost is what's actually paying.

```
                  Path taken (linear ±3 scan)          Alternative (Map + sorted index)
                  ────────────────────────────         ─────────────────────────────────
predicate         (threadId, text) equality +          equality fits hash ; range needs
                  |lineΔ| ≤ 3 range                    sorted-by-line band scan
ops at N=5        ~5 linear comparisons                Map.set ×5, sort, then binary
                                                       search — ~30 ops total
ops at N=500      ~250,000 (still <10ms in JS)         ~5,000 — pays off at this scale
allocation        zero — predicate inline              Map(m) + per-group sorted arrays
LOC               ~12 for Pass 2 body                  ~50 with index build + range scan
verdict at app N  linear wins                          would win only above N≈200
```

[arch] Q: What if a single entry grew to 10,000 lines with 500 tags? Does the algorithm survive?
       A: The algorithm scales as O(n × m) so 500 × 500 = 250k ops per pass, two passes — still under 10ms in JS. What breaks first is the assumption that `parseTags` runs on every commit. At 10k lines and 500 tags I'd want to debounce the scan, or only re-parse the dirty range of the text. The data shape itself stops fitting one entry at that point — the migration is to split entries, not to optimize the algorithm.

```
[scale curve — what breaks first at 10× / 100× input]

  N tags / entry      O(n×m) ops      commit cost      breaks?
  ──────────────────  ─────────────   ──────────────   ─────────────────────
  5 (real)            25              <0.1ms           no
  50 (10×)            2,500           ~0.5ms           no
  500 (100×)          250,000         ~10ms            commit visible to user
  5,000               25M             ~1s             ◀ scan, not data model
                                                       split entry before this
  fix                                  debounce parseTags ; re-parse dirty
                                       range only ; split entries per day
```

### The question candidates always dodge
Q: You have a sibling algorithm in `01-two-pass-scan-todos` that uses Map + Set for O(n+m). Why didn't you make this one O(n+m) too? Isn't that just inconsistency?

A: It's deliberate but it does look inconsistent on a quick read. The todo scan has up to 30 entries' worth of carryover floating around — when you reconcile a multi-day view, n and m can both grow to a few hundred — so the Map+Set actually pays. `reconcileMentions` runs strictly per-entry; n and m never get above a handful. Building a Map for a 5-element lookup is more allocation than the linear scan it replaces. I weighed it and the constant matters more than the asymptote at this scale. If `reconcileMentions` ever started running across multiple entries (a cross-entry rebuild), I'd rewrite it; I'd rather the rewrite happen at the moment the constraint changes than carry premature optimization.

```
                  Path taken (linear per-entry)        Suggested (Map+Set everywhere)
                  ──────────────────────────────       ──────────────────────────────
scan boundary     one entry's tags (n+m < 10)          same boundary, but indexed
asymptote         O(n × m) per pass                    O(n + m) per pass
real cost at N=5  ~5 comparisons ; zero allocation     Map alloc + Set alloc + 5 .has()
                                                       calls — allocation dominates
real cost at N=500 ~250k ops ; ~10ms                   ~1k ops ; ~0.2ms — wins here
LOC               ~62 (current shape)                  ~95 (todo-scan-style)
consistency       sibling-algo claims unity, but       sibling claims unity, costs more
 with sibling     measurements disagree                where the data set is tiny
when to switch    if reconcile starts running across   premature today ; constant cost
                  multiple entries in one sweep        dominates the asymptote
verdict           constant beats asymptote at this N   the asymptotic win is real but
                                                       only above N ≈ 200 per entry
```

### One-line anchors
- "±3 isn't arbitrary — it's the observed shift when users add context above a tag."
- "O(n×m) is correct when n×m is bounded; the constant cost of a Map allocation can dwarf the savings."
- "Same shape as the todo scan, looser Pass 2 — match strictness reflects data churn."
- "I bounded the inputs at the call site, so the asymptote stops mattering."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain two-pass thread mention reconcile to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/threads/scanThreads.ts:reconcileMentions`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

Existing `thread_mentions` rows: `m1 = {th=loopd, sourceLine=2, tagText='loopd'}`, `m2 = {th=health, sourceLine=8, tagText='Health'}`. The user inserts 5 new lines at the top of the entry — so `parsed` now has `{th=loopd, lineIndex=7, tagText='loopd'}` and `{th=health, lineIndex=13, tagText='Health'}`. Walk Pass 1 and Pass 2 — what gets matched, what gets inserted, what gets deleted, and how many rows does the `m2`-with-+5-shift case keep?

Write your answer. 3–5 sentences minimum. Then open `src/services/threads/scanThreads.ts` L169–L230 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/threads/scanThreads.ts` to support what exists
→ Point to `src/services/todos/scanTodos.ts` (the sibling Map+Set version) if you chose the alternative

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
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (sticky-note metaphor + frontend bridge to react-window scroll restoration) and Move 3 principle after the Comparison block. Algorithm/trace structure preserved.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (notebook-sticky-note-shifted-pages scenario → naming the fuzzy-match-with-displacement-window pattern → bolded "what depends on getting this right" pivot with `thread_mentions` durability stakes → before/after bullets walking a `#health` tag shifted by 3 lines → one-line summary "anchor on identity, allow a bounded slip on position").

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care + How it works to anchor on real software (replaced notebook-with-sticky-note analogy with `git blame --follow` line tracking and react-window scroll restoration).
