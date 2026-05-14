# Tag parsing with code-fence masking — single-pass regex with offset preservation

**Industry name(s):** Tokenizer with mask regions, exclusion-aware regex
**Type:** Industry standard · Language-agnostic

> Strip fenced code blocks and inline code spans before applying the `#tag` regex, so backticked tokens don't register. Preserve byte offsets so line indices stay stable.

**See also:** → [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md)

---

## Why care

Imagine a redaction office processing a stack of pages where certain paragraphs need to be hidden from the reviewer. The clerk could cut the sensitive paragraphs out with scissors — but that shifts every page number, every line citation, every footnote reference downstream. Instead he lays a thick black bar over each sensitive region, same width as the original text. The reviewer can still cite "page 3, line 14" and find the right spot; she just can't read what was there. The geometry of the document — line breaks, page breaks, every offset — survives the redaction.

That is the question this operation answers when text contains regions a parser must ignore (code fences, inline backticks) but those same regions sit in a larger structure (line numbers) that other code keys on: how do you skip the contents without shifting the indices? Not "delete the code fences and renumber later," not "match everything and post-filter inside-code matches" — just *overwrite each masked region with same-length whitespace, then run the inner parser cleanly*. Lexical masking with offset preservation.

**What depends on getting this right:** the contract between `parseTags` and `reconcileMentions`. In this codebase `parseTags` emits `{ slug, tagText, lineIndex }` for each `#tag` in `entries.text`, and `reconcileMentions` keys `thread_mentions` rows on `(threadId, sourceLine)`. If `maskCode` deleted fence contents instead of overwriting them with spaces, every line after a fenced block would shift up — `#health` that was on line 8 of the original text would arrive at `reconcileMentions` claiming line 5. Pass 1 (exact `(threadId, sourceLine)` match against the existing row at line 8) would miss; Pass 2's ±3 window would maybe rescue it; or the existing row would be deleted and a new one inserted with churn on `schedulePush()`. The space-preserving mask is what keeps the line-index contract intact across the parse boundary.

Without offset preservation (delete fences):
- User has `#loopd` at line 0, a 4-line code fence from lines 2-5, `#health` at line 7
- Strip the fence → text is now 4 lines, `#health` is now on line 3
- `reconcileMentions` already has a row for `#health` keyed to `sourceLine=7`
- Pass 1 looks for line 3 → miss; Pass 2 fuzzy-matches within ±3 of line 3 → also miss
- Existing row deleted; new row inserted; cloud sees churn; mention's first-seen timestamp resets

With same-length space mask:
- Fenced region becomes spaces of equal length, newlines preserved
- `#health` stays at line 7 in the masked string
- Per-line regex iteration finds it; emits `lineIndex: 7`
- `reconcileMentions` Pass 1 hits its existing row by exact line; zero churn
- The per-line `seen` Set also prevents two `#loopd` on the same line from double-claiming

Overwrite the masked content; preserve the geometry the next stage depends on.

---

## How it works

A redaction office. Sensitive lines aren't snipped out of the document — that would mess up the page numbers; instead, a thick black bar is laid over them, same length as the underlying text. The reader sees the structure (line breaks, page count) but can't read the masked content. If you're coming from frontend, this is exactly the trick `MonacoEditor` uses for "masked input" fields where the cursor position has to stay accurate even though the character at each position is hidden — replace, don't remove. Two phases: phase 1 walks the string and overwrites every code-fenced region with spaces of equal length; phase 2 scans the masked string for `#tag` matches with line numbers that still point at the original document.

**Real operation:** `parseTags` in `src/services/threads/scanThreads.ts`.

---

## The data

```
  text:
    "Working on #loopd today.
     Code spans: `git checkout #main` should NOT match.
     ```
     #fenced should NOT match either
     ```
     #health quick note"
```

**The problem:** match `#tag` only outside code regions, while keeping line indices stable so downstream reconcile uses the right line numbers.

---

── Brute force ──────────────────────────────────

Pseudocode (single regex, no code-fence masking; post-filter false positives):

```
  function parseTagsBrute(text):
    out = []
    matches = text.matchAll(/(^|[^\w-])#([a-zA-Z][a-zA-Z0-9-]*)/g)
    for m in matches:
      offset = m.index
      // After the fact, decide if this match was inside a code region.
      // This requires re-scanning the text from 0 to count fence/backtick state.
      if isInsideCode(text, offset):
        continue   // false positive — drop it
      lineIndex = text.slice(0, offset).split('\n').length - 1
      out.push({ slug, tagText: m[2], lineIndex })
    return out
```

Execution trace (text with 3 `#tag` candidates: line 0 prose, line 1 inside backticks, line 5 prose):

```
  regex match 1: "#loopd" at offset 11
    isInsideCode(text, 11)?  scan 0..11, fence-depth=0, backtick-depth=0 → false
    keep. lineIndex computed by slicing → 0
  regex match 2: "#main" at offset 38 (inside `git checkout #main`)
    isInsideCode(text, 38)?  scan 0..38, hit backtick at offset 36 → true
    drop.
  regex match 3: "#health" at offset 110 (after fenced block ends)
    isInsideCode(text, 110)? scan 0..110, fence opens line 2, closes line 4, depth=0 again
    keep. lineIndex slicing → 5
  Result: same 2 tags as optimal — but each match requires a fresh 0..offset scan.
```

Complexity: O(L²) worst case — each match's `isInsideCode` and `lineIndex` re-scan the prefix · O(L) space.

What goes wrong at scale: at journal-entry size (a few KB) the L² behavior is invisible. At a 1MB paste it's 1 trillion compare ops worst case — multi-second JS hang. The deeper problem: any approach that decides "was this match in code?" *after* matching makes line-number computation O(matches × text-length). Masking up-front collapses that to one O(L) pass.

── Optimal ──────────────────────────────────────

The insight: mask code regions to *same-length space runs* before regex, so line indices stay stable and a single per-line scan finds all tags in one O(L) pass.

```
  function maskCode(text):
    // Replace fenced ```...``` with same-length runs of spaces (newlines preserved!)
    out = text.replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '))
    // Replace inline `...` with spaces of equal length
    out = out.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
    return out

  function parseTags(text):
    masked = maskCode(text)
    lines  = masked.split('\n')
    seen   = empty set                          // {lineIdx}::{slug} for per-line dedup
    out    = []
    for i in 0..lines.length:
      reset TAG_RE.lastIndex
      while m = TAG_RE.exec(lines[i]):
        slug = m[2].toLowerCase()
        key  = i + '::' + slug
        if seen has key: continue
        seen.add(key)
        out.push({ slug, tagText: m[2], lineIndex: i })
    return out
```

**Execution trace:**

```
  After maskCode:
    line 0  "Working on #loopd today."
    line 1  "Code spans:                          should NOT match."
    line 2  "                                                      "  ← fence opener
    line 3  "                                                      "  ← inside fence
    line 4  "                                                      "  ← fence closer
    line 5  "#health quick note"

  Iterate lines:
    line 0: TAG_RE matches "#loopd" → out += { slug:"loopd", tagText:"loopd", lineIndex:0 }
    line 1: only spaces — no match
    line 2-4: no match
    line 5: matches "#health" → out += { slug:"health", tagText:"Health"|"health", lineIndex:5 }

  Result: 2 tags, line indices 0 and 5 (NOT shifted by the fence block).
```

---

## Why preserve byte offsets via space-replace

The reconcile pass (`reconcileMentions`) keys on `sourceLine`. If `maskCode` collapsed the fence into a single empty line, line 5 would become line 2 and existing mentions at line 5 wouldn't match. Replacing with spaces of equal length keeps line numbers stable.

**Complexity:** O(L) for the regex masks · O(L) for the per-line scan, where L = text length.

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(L²) worst    │ O(L)             │
  │ Space           │ O(L)           │ O(L)             │
  │ At 1,000 chars  │ ~1,000,000 ops │ ~1,000 ops       │
  │ At 10,000 chars │ ~100,000,000   │ ~10,000 ops      │
  │ Readable?       │ no (post-filter│ yes              │
  │                 │  re-scans)     │                  │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: at a few KB per entry both run sub-millisecond. But brute force is also *incorrect*: stripping fences with `.replace(..., '')` shifts line numbers and breaks reconcile. The space-preserving mask is the cheapest correct shape.

This is what people mean by "preserve the geometry, mask the content." The pattern lives in every lexer that has to skip string literals and comments before scanning keywords, every linter that ignores code blocks inside doc comments, every diff tool that strips whitespace without renumbering lines. The shared insight is that downstream consumers depend on offsets (line, column, byte position), and the cheapest way to keep their assumptions intact is to overwrite, not delete.

---

## In this codebase

**Parser:**       `src/services/threads/scanThreads.ts` → `parseTags()` L37–L64 (with helper `maskCode()` L25–L36)
**Tag regex:**    `src/services/threads/scanThreads.ts` → `TAG_RE` constant at L14 — `(^|[^\w-])#([a-zA-Z][a-zA-Z0-9-]*)`
**Consumer:**     `src/services/threads/scanThreads.ts` → `reconcileMentions()` L169–L230 reads `parseTags`'s output and uses `lineIndex` as the join key — the contract this whole pattern preserves

---

## Elaborate

### Where this pattern comes from
The "mask then parse" pattern shows up wherever embedded languages need to be ignored — markdown parsers strip code fences before running inline-format detection, comment strippers replace `/* ... */` with spaces of equal length to preserve line/column for error messages.

### The deeper principle
**When two layers of syntax overlap (markdown + tags), normalise the data before parsing the inner layer.** Don't try to write one regex that handles both — write a normaliser that erases the outer layer and a clean inner parser.

### Where this breaks down
- Languages that allow nested code fences (rare in markdown). The lazy regex `[\s\S]*?` matches greedily-non-greedily but mismatched fences would break it.
- Performance on huge inputs. A 10MB string would allocate 10MB twice (once for the mask, once for the split). Streaming wouldn't allocate but is harder to write.

### What to explore next
- [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md) → what consumes the output.
- markdown-it / remark plugins → the full-power version of the mask-then-parse pattern.

---

## Tradeoffs

We traded a transient extra string allocation for offsets that stay honest, so the downstream join key (`lineIndex`) survives the masking pass intact.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (mask to spaces +   │ Alternative (post-filter false │
│                  │ per-line scan)                 │ positives after regex)         │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Time complexity  │ O(L) — two linear regex passes │ O(L²) worst — each match runs  │
│                  │ + per-line scan                │ a 0..offset re-scan to decide  │
│                  │                                │ "was this inside code?"        │
│ Latency at 2KB   │ <1ms                           │ <1ms — both fine at this N     │
│ entry (real N)   │                                │                                │
│ Latency at 1MB   │ ~5ms                           │ ~1s+ — regex backtracking +    │
│ paste            │                                │ post-filter dominates          │
│ Memory churn     │ 2× extra string allocs (mask   │ no extra string, but re-slice  │
│                  │ outputs) — peak ~3× input      │ per match for line counting    │
│ Code complexity  │ ~40 LOC (maskCode + parseTags) │ ~30 LOC — one regex, one      │
│                  │                                │ isInsideCode helper             │
│ Cognitive load   │ "two-step parse: mask, then    │ "one regex, then post-filter" │
│                  │ scan" — reader can follow      │ — reader misses why offsets    │
│                  │                                │ drift                         │
│ Correctness      │ lineIndex stable through mask  │ lineIndex computed per match;  │
│                  │ — reconcile contract preserved │ stripping fences would shift   │
│                  │                                │ indices and break reconcile    │
│ Failure mode     │ pathological backtick input →  │ pathological input → quadratic │
│                  │ lazy-regex slow but bounded    │ blowup; UI hang on paste       │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

`maskCode` allocates the input string twice — once for fenced-block replacement, once for inline-code replacement. At journal-entry size (a few KB) this is invisible; at 1MB paste it's 3MB peak allocation. We accepted it because the alternative (a streaming line-by-line lexer) is 80+ LOC of state-machine code we haven't needed.

The lazy regex `[\s\S]*?` has worst-case quadratic backtracking on adversarial inputs (lots of unbalanced backticks). For user-typed journal prose this never fires; for a 5MB paste with malformed fences the parse could hang. The mitigation is the implicit cap on entry size — nobody pastes 5MB into a daily journal line.

Per-line dedup uses a `Set<string>` keyed by `lineIdx + '::' + slug`. Memory is bounded by tag count per line, but it's a per-call allocation that contributors won't notice. The reason it exists is that without it, two identical `#loopd` tags on one line would create two `thread_mentions` rows competing for the same `(threadId, sourceLine)` key — silent identity collision in the reconciler.

### What the alternative would have cost

A post-filter shape (`regex matches all #tags, then isInsideCode checks each`) would have been ~30 LOC of code and looked simpler at first read. But each match's `isInsideCode` re-scans the prefix from offset 0 to count fence depth — O(L) per match, O(L²) total. At 1MB paste with 100 matches, that's 100M ops vs the masker's 2M.

The deeper hidden cost: post-filter computes `lineIndex` by slicing `text.slice(0, offset).split('\n').length - 1` per match — another O(L) per match. The optimal version computes line index once via `lines.split('\n')` and uses the array index directly. The masker collapses two O(L²) loops into one O(L) walk.

If we'd taken the "strip fences entirely" shortcut (`.replace(fence, '')`), `lineIndex` would shift by the height of every fenced block. `reconcileMentions` keys on `(threadId, sourceLine)`; every mention after a fence would lose its prior id on the next scan. That's not a tradeoff — that's a correctness regression we'd ship within a week.

### The breakpoint

Fine until input length crosses ~1MB or fence density gets pathological. At that point `maskCode`'s lazy-regex backtracking dominates and the parse can take seconds. The fix is a streaming line-by-line lexer with a fence-state flag — ~80 LOC of state-machine code that allocates once. We haven't built it because journal entries cap at a few KB by usage pattern; the cap is the data shape, not the algorithm.

### What wasn't actually a tradeoff

Choosing same-length space replacement over deletion isn't a tradeoff — deletion would shift line indices and break the reconciler contract. The "tradeoff" is between two correctness states, and only one of them is correct.

---

## Tech reference (industry pairing)

### JavaScript regex with lazy quantifier (no parser library)

- **Codebase uses:** `/```[\s\S]*?```/g` (and inline backtick siblings) inside `parseTags`, replaced with same-length spaces via `String.prototype.replace`. No parser library, no markdown AST.
- **Why it's here:** the masking only needs to identify fence ranges and preserve length; a full markdown parser would build a syntax tree the algorithm never reads.
- **Leading today:** native regex with `*?` lazy quantifier — `adoption-leading` for sparse-marker lexical masking at this scale, 2026.
- **Why it leads:** runtime-builtin, no dependency cost, two lines of code; the lazy quantifier matches the smallest possible fence which is what correctness requires.
- **Runner-up:** `remark` / `unified` markdown parser — `innovation-leading` once the codebase needs proper AST manipulation; here it would add weight for a problem that doesn't need a tree.

### Two-phase lexical scan (no token library)

- **Codebase uses:** phase-1 `maskCode` + phase-2 `#tag` regex match inside `parseTags`. Both phases live in the same file, ~40 LOC total.
- **Why it's here:** the two phases are independent enough to be readable, dependent enough to be co-located; bringing in a lexer framework (`moo`, `chevrotain`) would over-structure a 40-LOC operation.
- **Leading today:** hand-written two-phase scan — `adoption-leading` for sparse-grammar lexing in small codebases, 2026.
- **Why it leads:** the algorithm reads top-to-bottom; the contract between phases (string in, string out, offsets preserved) is enforced by the type signature.
- **Runner-up:** `moo` tokenizer — `adoption-leading` for richer multi-token grammars where the state machine needs to track nested contexts; the right move once the masking has to handle nested fences or escape sequences.

---

## Summary

Lexical masking with offset preservation is the family of "two-phase parsing where phase one neutralises the regions phase two must not see, while preserving the geometry phase two depends on" — overwrite the ignored regions with same-length neutral characters instead of deleting them, so downstream offsets stay honest. In this codebase `parseTags` in `src/services/threads/scanThreads.ts` masks fenced code blocks and inline backtick spans to runs of spaces (preserving newlines), then runs a per-line `#tag` regex with a per-line `seen` Set so duplicate tags on the same line collapse to one mention. The constraint is the contract with `reconcileMentions`, which keys on `(threadId, sourceLine)` — if `maskCode` shifted line numbers, every downstream join would be wrong. The cost is an extra string allocation for the mask plus a small lazy-regex backtracking risk on pathological multi-MB pastes. Both versions run sub-millisecond at journal-entry size; the space-preserving mask is the cheapest correct shape because deleting fence contents would actually break the line index.

Key points to remember:
- Mask code regions to spaces of equal length — newlines preserved so `lineIndex` survives the mask.
- Two-step parse: erase the outer layer (markdown fences/inline code), then run the inner parser (`#tag` regex) cleanly.
- Per-line `seen` Set dedups same-tag-on-same-line before it can collide on `(threadId, sourceLine)`.
- O(L) for both mask passes and the per-line scan; brute "match-then-post-filter" is O(L²) because each match re-scans the prefix.
- Regex is the wrong tool for nested fences — this is a known limit that holds because journaling prose doesn't nest.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand the *contract* between `parseTags` and `reconcileMentions` — they communicate through line indices. If `maskCode` shifted lines, every downstream comparison would be wrong. The interviewer wants to hear that the space-replace strategy isn't a clever trick, it's the only correctness-preserving way to remove code regions while keeping the index space stable. The "mask then parse" two-step is what lets the inner regex stay simple.

### Likely questions

[mid] Q: Why does the fenced-code regex use `[\s\S]*?` instead of `.*?`?
      A: Because `.` in JavaScript regex doesn't match newlines by default. A fenced code block spans multiple lines, so I need the character class `[\s\S]` to mean "any character including newline." The `*?` lazy quantifier ensures I match the shortest fence-to-fence span — without it, `\`\`\`a\`\`\` then \`\`\`b\`\`\`` would match as one giant block instead of two.

```
[fence-regex character class flow]

  input: "```a```\nprose\n```b```"
        │
        ▼  /```.*?```/  uses '.' which excludes \n
  match fails — '.' won't cross newline
        │
        ▼  /```[\s\S]*?```/  uses [\s\S] = "any char including \n"
  match #1 = "```a```"   ◀── lazy quantifier stops at first close
  match #2 = "```b```"   ◀── second pass finds the second fence
        │
        ▼
  both fences masked correctly
```

[senior] Q: Why per-line dedup with a `seen` Set instead of letting the regex find every occurrence?
         A: Because the same tag written twice on one line is one mention, not two — `reconcileMentions` keys on `(threadId, sourceLine)` so two identical mentions on the same line would either collide and lose data or create two database rows that fight for the same identity. The Set-based dedup catches it before insert. I scope it per-line because the *same tag on a different line* is a legitimate second mention — that's a deliberate user signal.

```
                  Path taken (per-line Set dedup)     Alternative (no dedup, let regex run)
                  ────────────────────────────────────  ──────────────────────────────────
"hi #loop #loop"  → 1 mention at lineIdx=0             → 2 mentions at lineIdx=0
                                                        both compete for (threadId, line)
reconcile result  clean insert                          collision → silent identity loss
                                                        or duplicate rows fighting
cross-line dups   "#loop on L0" + "#loop on L3"        same — both kept legitimately
  preserved?      → 2 mentions, different lineIdx       (different sourceLine)
LOC               ~5 LOC for Set guard                  ~0 LOC
correctness model "dedup within line, keep across      "let DB constraint catch it"
                  lines"                                — wrong constraint exists
verdict           cheap correctness gate before DB      DB will reject or silently drop;
                  collision                             worse failure surface
```

[arch] Q: What if a user pastes a 5MB markdown document with hundreds of code fences?
       A: `maskCode` runs two regex passes over the full string, so peak memory is ~3× the input (original + first mask + second mask). At 5MB that's 15MB transient — uncomfortable on a low-end Android. The lazy regex `[\s\S]*?` is also worst-case quadratic on pathological inputs (lots of unbalanced backticks). The migration would be a streaming line-by-line scanner with a fence-state flag — single allocation, no regex backtracking. I haven't built it because journal entries cap out at a few KB; if someone pasted a real document I'd hit the limit and tell them to split it.

```
[scale curve — what breaks first at 10× and 100× input size]

  input size   maskCode time   peak memory    backtracking risk    breaks?
  ──────────   ─────────────   ────────────   ──────────────────   ──────────────────
  2KB (real)   <1ms             ~6KB peak       safe                 no
  20KB (10×)   ~5ms             ~60KB peak      safe                 no
  200KB (100×) ~50ms            ~600KB peak     occasional backtrack UI may stutter on paste
  1MB+         ~500ms+          ~3MB peak       quadratic worst      memory + UI thread   ◀── BREAKS FIRST
  5MB          seconds          ~15MB peak      catastrophic         needs streaming lexer
```

### The question candidates always dodge
Q: What about nested code blocks? Markdown lets you indent a fence inside a list item — does your masker handle that?

A: Not really. The lazy regex `\`\`\`[\s\S]*?\`\`\`` matches the *first* closing triple-backtick after an opener, so a nested fence inside a list-indented fence would match across both, leaving the second fence's contents exposed. In practice nobody nests fences in journaling — this isn't documentation prose, it's a daily log — so the bug doesn't fire. The deeper issue is that I'm using regex to parse a context-sensitive grammar, which is the wrong tool. A proper fix would be a small state machine that tracks fence depth and inline-code spans, basically a tiny markdown lexer; that's 80 lines of code I haven't written. The honest version of the answer: this works for the inputs I've seen, breaks on the inputs I haven't, and the inputs I haven't seen are not user inputs in this app. The day a user pastes nested fences with intent, I'll write the lexer.

```
                  Path taken (lazy regex)              Suggested (small markdown lexer)
                  ────────────────────────────────────  ──────────────────────────────────
nested fences     mis-paired — first close terminates  fence-depth counter handles nesting
                  any open, exposes inner content      correctly
inline + fenced   handled by sequential passes         single pass with state-machine
edge cases        mismatched backticks → bad match     state machine rejects malformed
                                                       gracefully
LOC               ~40 (mask + parse)                   ~120 (lexer + parse)
runtime           O(L) with backtracking risk          O(L) guaranteed, no backtracking
input domain      journal prose — never nests          documentation pastes — may nest
verdict           right call for journaling inputs;    the lexer is the right shape if
                  bug invisible at this domain         input domain ever shifts to docs
```

### One-line anchors
- "Mask to spaces preserves line indices — the contract with `reconcileMentions`."
- "Two-step parse: erase the outer layer, then parse the inner layer cleanly."
- "Per-line dedup catches duplicate tags before they collide on `(threadId, sourceLine)`."
- "Regex is the wrong tool for nested fences; works for journaling because nobody nests."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain tag parsing with code-fence masking to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/threads/scanThreads.ts:parseTags` (and the `maskCode` helper)
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user writes this entry on line 0–6:
```
Working on #loopd today.
Need to remember `git checkout #main` doesn't count.
```` (fence opens line 2)
some code with #fenced inside, also some prose
```` (fence closes line 4)
Pushed #release branch live.
Same #loopd tag again — but on a different line.
```

What does `parseTags` return — how many tags, with which `lineIndex` values, and which (if any) does the per-line `seen` Set deduplicate?

Write your answer. 3–5 sentences minimum. Then open `src/services/threads/scanThreads.ts` L37–L64 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/threads/scanThreads.ts:maskCode` to support what exists
→ Point to `src/services/threads/scanThreads.ts:reconcileMentions` (the downstream that depends on stable `lineIndex`) if you chose the alternative

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
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (redaction-office metaphor + frontend bridge to masked-input fields) and Move 3 principle after the Comparison block.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (redaction-office-with-black-bars scenario → naming lexical-masking-with-offset-preservation → bolded "what depends on getting this right" pivot with `parseTags`/`reconcileMentions` line-index contract stakes → before/after bullets walking a `#health` tag after a 4-line fence with delete vs space-mask → one-line summary "overwrite the masked content; preserve the geometry the next stage depends on").
