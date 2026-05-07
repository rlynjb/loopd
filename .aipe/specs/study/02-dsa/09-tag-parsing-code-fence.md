# Tag parsing with code-fence masking — single-pass regex with offset preservation

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

- `src/services/threads/scanThreads.ts` → `parseTags()`, `maskCode()`.
- `src/services/threads/scanThreads.ts` → `reconcileMentions()` consumes the output.

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
