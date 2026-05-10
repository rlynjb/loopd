# Two-pass thread mention reconcile — line-shift tolerant

> **Industry term:** Fuzzy match with displacement tolerance *(language agnostic)*

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

- **±3 tolerance** — gives: small line shifts preserve identity. Costs: a 4-line shift loses identity; the threshold is arbitrary.
- **Linear find in Pass 2** — gives: simple code, fast in practice. Costs: O(n × m) — but n × m is tiny per entry.
- **Update sourceLine + tagText separately** — gives: each is a small idempotent UPDATE. Costs: two write paths instead of one combined update.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I can defend O(n×m) on a hot path with a straight face. The honest answer is that "hot path" is a relative term — `reconcileMentions` runs on every entry commit, but per-entry tag count is bounded at a handful, so n×m is bounded at ~50. A Map allocation per call would cost more than the loop saves. The interviewer wants to see if I'm picking complexity classes by measurement, not by reflex.

### Likely questions

[mid] Q: Why does Pass 2 use `±3` instead of `±5` or `±10`?
      A: Three is the tolerance window for "the user added a paragraph above this tag and didn't move the tag itself." Empirically that's the most common shift — people add context, not displace tags. At ±10 I'd start matching across unrelated sections of the entry; the same `#health` tag in two different contexts could swap identities. ±3 keeps the match tight enough that confusion is rare and small enough that the linear scan stays cheap.

[senior] Q: Why isn't Pass 2 indexed by `(threadId, tagText)` like Pass 1 could be?
         A: Because the third predicate is a *range*, not an equality. `|sourceLine - lineIndex| <= 3` doesn't fit a hash key — I'd need a sorted index per `(threadId, tagText)` group plus a binary search. At n+m around 10, building that structure costs more in allocation and indirection than the linear scan it would replace. I bounded the inputs at the call site — `parseTags` only returns tags within one entry — so the constant cost is what's actually paying.

[arch] Q: What if a single entry grew to 10,000 lines with 500 tags? Does the algorithm survive?
       A: The algorithm scales as O(n × m) so 500 × 500 = 250k ops per pass, two passes — still under 10ms in JS. What breaks first is the assumption that `parseTags` runs on every commit. At 10k lines and 500 tags I'd want to debounce the scan, or only re-parse the dirty range of the text. The data shape itself stops fitting one entry at that point — the migration is to split entries, not to optimize the algorithm.

### The question candidates always dodge
Q: You have a sibling algorithm in `01-two-pass-scan-todos` that uses Map + Set for O(n+m). Why didn't you make this one O(n+m) too? Isn't that just inconsistency?

A: It's deliberate but it does look inconsistent on a quick read. The todo scan has up to 30 entries' worth of carryover floating around — when you reconcile a multi-day view, n and m can both grow to a few hundred — so the Map+Set actually pays. `reconcileMentions` runs strictly per-entry; n and m never get above a handful. Building a Map for a 5-element lookup is more allocation than the linear scan it replaces. I weighed it and the constant matters more than the asymptote at this scale. If `reconcileMentions` ever started running across multiple entries (a cross-entry rebuild), I'd rewrite it; I'd rather the rewrite happen at the moment the constraint changes than carry premature optimization.

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
