# Two-pass thread mention reconcile — line-shift tolerant

> Same shape as the todo two-pass, but Pass 2 uses `±3 line shift` instead of exact line match.

**See also:** → [01-two-pass-scan-todos](./01-two-pass-scan-todos.md) · → [09-tag-parsing-code-fence](./09-tag-parsing-code-fence.md)

---

## Quick summary
- **What:** match parsed-tags-from-text to existing-mention-rows. Pass 1 = exact `(threadId, sourceLine)`. Pass 2 = `(threadId, tagText)` within ±3 lines.
- **Why here:** users often add a few lines above existing tags. The row id should survive that small shift.
- **Tradeoff:** Pass 2 is O(n × m) but per-entry n + m is small (typically <10), so the cost is negligible.

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

## Optimal (the only one in the codebase — no separate brute version)

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

---

## When brute force is fine

Here. Pass 2 is the cheap path. The `find` is linear over a per-entry list — no Map needed because the predicate is "threadId AND text AND |line shift| ≤ 3", which doesn't index cleanly. At per-entry scale (handful of mentions), the constant overhead of building a Map exceeds the savings.

---

## In this codebase

- `src/services/threads/scanThreads.ts` → `reconcileMentions()`.
- `src/services/threads/scanThreads.ts` → `parseTags()` produces the `parsed` input.
- `src/services/database.ts` → `insertMention`, `updateMentionSourceLine`, `updateMentionTagText`, `deleteMention`.

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

- **±3 tolerance** — gives: small line shifts preserve identity. Costs: a 4-line shift loses identity; the threshold is arbitrary.
- **Linear find in Pass 2** — gives: simple code, fast in practice. Costs: O(n × m) — but n × m is tiny per entry.
- **Update sourceLine + tagText separately** — gives: each is a small idempotent UPDATE. Costs: two write paths instead of one combined update.
