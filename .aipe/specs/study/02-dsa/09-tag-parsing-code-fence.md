# Tag parsing with code-fence masking — single-pass regex with offset preservation

> **Industry term:** Lexical region masking (offset-preserving) *(language agnostic)*

> Strip fenced code blocks and inline code spans before applying the `#tag` regex, so backticked tokens don't register. Preserve byte offsets so line indices stay stable.

**See also:** → [03-two-pass-thread-mentions](./03-two-pass-thread-mentions.md)

---

## Quick summary
- **What:** `parseTags(text)` masks code regions to spaces (preserving newlines), then runs a per-line `#tag` regex with per-line dedup.
- **Why here:** users journal in markdown-ish prose; backticked tokens like `` `git #branch` `` should not become thread mentions.
- **Tradeoff:** the masking step allocates a same-length string. Cheap at journal-entry scale; would matter for huge inputs.

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

## Pseudocode

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

---

## When brute force is fine

There isn't really a brute version that's correct. Naive `text.match(/#tag/g)` would mis-match inside code; stripping fences with `.replace(..., '')` would shift line numbers and break reconcile. The space-preserving mask is the cheapest correct shape.

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

- **Mask to spaces** — gives: line numbers stay stable. Costs: extra string allocation.
- **Per-line dedup** — gives: same tag twice on a line counts once. Costs: in-memory `Set`; bounded by tag count per line.
- **Regex-based** — gives: simple, fast, easy to read. Costs: doesn't handle weird edge cases (mismatched fences) gracefully.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand the *contract* between `parseTags` and `reconcileMentions` — they communicate through line indices. If `maskCode` shifted lines, every downstream comparison would be wrong. The interviewer wants to hear that the space-replace strategy isn't a clever trick, it's the only correctness-preserving way to remove code regions while keeping the index space stable. The "mask then parse" two-step is what lets the inner regex stay simple.

### Likely questions

[mid] Q: Why does the fenced-code regex use `[\s\S]*?` instead of `.*?`?
      A: Because `.` in JavaScript regex doesn't match newlines by default. A fenced code block spans multiple lines, so I need the character class `[\s\S]` to mean "any character including newline." The `*?` lazy quantifier ensures I match the shortest fence-to-fence span — without it, `\`\`\`a\`\`\` then \`\`\`b\`\`\`` would match as one giant block instead of two.

[senior] Q: Why per-line dedup with a `seen` Set instead of letting the regex find every occurrence?
         A: Because the same tag written twice on one line is one mention, not two — `reconcileMentions` keys on `(threadId, sourceLine)` so two identical mentions on the same line would either collide and lose data or create two database rows that fight for the same identity. The Set-based dedup catches it before insert. I scope it per-line because the *same tag on a different line* is a legitimate second mention — that's a deliberate user signal.

[arch] Q: What if a user pastes a 5MB markdown document with hundreds of code fences?
       A: `maskCode` runs two regex passes over the full string, so peak memory is ~3× the input (original + first mask + second mask). At 5MB that's 15MB transient — uncomfortable on a low-end Android. The lazy regex `[\s\S]*?` is also worst-case quadratic on pathological inputs (lots of unbalanced backticks). The migration would be a streaming line-by-line scanner with a fence-state flag — single allocation, no regex backtracking. I haven't built it because journal entries cap out at a few KB; if someone pasted a real document I'd hit the limit and tell them to split it.

### The question candidates always dodge
Q: What about nested code blocks? Markdown lets you indent a fence inside a list item — does your masker handle that?

A: Not really. The lazy regex `\`\`\`[\s\S]*?\`\`\`` matches the *first* closing triple-backtick after an opener, so a nested fence inside a list-indented fence would match across both, leaving the second fence's contents exposed. In practice nobody nests fences in journaling — this isn't documentation prose, it's a daily log — so the bug doesn't fire. The deeper issue is that I'm using regex to parse a context-sensitive grammar, which is the wrong tool. A proper fix would be a small state machine that tracks fence depth and inline-code spans, basically a tiny markdown lexer; that's 80 lines of code I haven't written. The honest version of the answer: this works for the inputs I've seen, breaks on the inputs I haven't, and the inputs I haven't seen are not user inputs in this app. The day a user pastes nested fences with intent, I'll write the lexer.

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
