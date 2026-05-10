# Heuristic-first classifier — cheap regex gate before the LLM

> **Industry term:** Rule-based fast-path / slow-path classification *(language agnostic)*

> Decide whether a line is *definitely a todo* (return `'todo'`) or *uncertain* (return `null`, defer to LLM). Never mis-classify a question or idea as a todo.

**See also:** → [02-reconcile-todo-meta](./02-reconcile-todo-meta.md) · → [03-ai-engineering/05-heuristic-before-llm](../03-ai-engineering/05-heuristic-before-llm.md)

---

## Quick summary
- **What:** ordered regex checks. Speculative + question first (return `null`), then modal + deadline + imperative (return `'todo'`), else `null`.
- **Why here:** every new todo runs this on insert. The LLM classifier only fires when this returns `null`. The heuristic catches ~60-70% of cases for free.
- **Tradeoff:** the heuristic intentionally over-fires `null`. False negatives cost one cheap LLM call. False positives would be silent and require a manual override — so the bias is firmly toward null.

**Real operation:** `heuristicClassify` in `src/services/todos/heuristicClassify.ts`.

---

## The data

```
  IMPERATIVE_VERBS:  Set of ~70 verbs ("call", "fix", "send", ...)
  MODAL_STARTS:      Array of regexes ("gotta", "need to", "should", ...)
  QUESTION_STARTS:   Array of regexes ("why", "how", "what", ...)
  SPECULATIVE_STARTS:Array of regexes ("maybe", "noticed", "idea:", ...)
  DEADLINE_PATTERNS: Array of regexes ("by tomorrow", "EOD", "tonight", ...)
```

**The problem:** decide whether a line is *definitely a todo* (return `'todo'`) or *uncertain* (return `null`, defer to LLM). Never mis-classify a question or idea as a todo.

---

## Pseudocode (decision-order matters)

```
  function heuristicClassify(rawText):
    text = rawText.trim()
    if !text: return null
    if text endsWith '?': return null               // question → null

    for re in SPECULATIVE_STARTS:
      if re.test(text): return null                 // "noticed", "maybe" → null

    for re in QUESTION_STARTS:
      if re.test(text): return null                 // "why", "how" → null

    for re in MODAL_STARTS:
      if re.test(text): return 'todo'               // "gotta", "need to" → todo

    for re in DEADLINE_PATTERNS:
      if re.test(text): return 'todo'               // "by tomorrow" → todo

    if IMPERATIVE_VERBS has firstWord(text): return 'todo'
    return null                                     // ambiguous → defer to LLM
```

**Execution trace** (4 example lines):

```
  "call mom"
    not '?'. not speculative. not question. not modal. no deadline.
    firstWord="call" ∈ IMPERATIVE_VERBS → 'todo' ✓
  "is this still a problem?"
    endsWith '?' → null
  "noticed that the dashboard flickers"
    SPECULATIVE_STARTS /^noticed\b/ matches → null
  "should email the client by EOD"
    not '?'. not speculative. not question.
    MODAL_STARTS /^should\s+/ matches → 'todo' ✓
```

---

## Why this order

Speculative + question checks come *before* modal + imperative because some sentences look modal AND speculative (e.g., "should we maybe ship this?" — would match `^should\s+(we|i)\b` in QUESTION_STARTS first → null, correct). The order encodes priority of evidence.

**Complexity:** O(R) where R = total regex count (~100); roughly O(1) per line.

---

## The bigger pattern

Every "free first, paid second" pipeline in this codebase has the same shape — heuristic classify, then LLM. Same idea: `expandTodo` checks `meta.type == 'todo'` and refuses to expand (no shape to expand into); `getProvider` reads `SecureStore` (sync, fast) before the network call.

---

## When brute force is fine

The "brute" alternative is "just call the LLM on every new todo" — works, costs money, makes typing pause for a few hundred ms while the call runs. The heuristic is what makes the typing path stay fast.

---

## In this codebase

**Function:**         `src/services/todos/heuristicClassify.ts` → `heuristicClassify()` L71–L102 (with helper `firstWord()` L64–L70)
**Regex tables:**     `src/services/todos/heuristicClassify.ts` — `IMPERATIVE_VERBS` L12 (Set of ~70 verbs), `MODAL_STARTS` L26, `QUESTION_STARTS` L37, `SPECULATIVE_STARTS` L44, `DEADLINE_PATTERNS` L57
**Call site:**        `src/services/todos/reconcileMeta.ts` → consulted on insert at L48-L92 (see [02-reconcile-todo-meta](./02-reconcile-todo-meta.md))
**LLM fallback:**     `src/services/todos/classify.ts` → `classifyTodo()` — fires only when `heuristicClassify` returns `null`

---

## Elaborate

### Where this pattern comes from
"Cheap-first-then-expensive" cascades are foundational to systems engineering — disk cache → DRAM → page fault → disk; SQL query plan → seq scan vs index lookup; CDN → origin. The gate-LLM-with-heuristic version is the AI-era application of the same idea.

### The deeper principle
**Every expensive operation deserves a cheap pre-check.** If 60-70% of cases can be decided by a free fast path, the expensive path runs only on the hard 30-40%.

### Where this breaks down
- New patterns the heuristic doesn't know about. Until the regex tables are updated, the LLM picks up the slack — graceful degradation.
- Multi-language users (loopd assumes English regex). Non-English text falls through to `null` and the LLM handles it.

### What to explore next
- [03-ai-engineering/05-heuristic-before-llm](../03-ai-engineering/05-heuristic-before-llm.md) → the cost-gate framing.
- [02-reconcile-todo-meta](./02-reconcile-todo-meta.md) → the call site.

---

## Tradeoffs

- **Heuristic-first** — gives: 60-70% of todos classified for free. Costs: a regex table to maintain.
- **Bias toward `null`** — gives: false-positives are impossible. Costs: more LLM calls than strictly necessary.
- **Order-sensitive checks** — gives: edge cases handled correctly. Costs: order is load-bearing; reordering is a bug.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand that this isn't a classifier — it's a *cost gate*. A real classifier returns the best label; `heuristicClassify` returns `'todo'` only when it's confident, and `null` for everything ambiguous. That asymmetry is the whole design. The interviewer wants to hear me name the dominant cost concern (per-LLM-call $) and explain that the heuristic exists to keep the LLM call rate down, not to be smart on its own.

### Likely questions

[mid] Q: Walk me through what happens for the line "should email the client by EOD" — which check fires first?
      A: It's not empty, doesn't end with `?`. Speculative check runs — none of `maybe|noticed|idea:` match. Question check runs — `^should\s+(we|i)\b` doesn't match because the next word is "email," not "we" or "I." Modal check runs — `^should\s+` matches → returns `'todo'`. The line never reaches DEADLINE or IMPERATIVE because modal already decided. The order encodes "rule out the speculative interpretations first, then look for evidence of action."

[senior] Q: Why does `heuristicClassify` bias toward returning `null` instead of guessing?
         A: Because false positives are silent and false negatives are cheap. If I confidently mark "noticed the dashboard flickers" as `'todo'`, the user sees a checkbox they have to manually clear — friction. If I return `null` and the LLM says `'idea'`, the user sees the right thing 300ms later — invisible. The asymmetry of the failure modes drives the asymmetry of the function. Returning `null` more often costs me more LLM calls; returning `'todo'` wrongly costs the user trust.

[arch] Q: What changes when you support a non-English language?
       A: All ~100 regexes are English-locale. A French entry like "il faut appeler maman" would fall through every check and return `null`, deferring to the LLM. That's actually the correct fallback — graceful degradation. To add French, I'd duplicate the regex tables per locale and dispatch on the user's `Accept-Language` or a settings field. The harder problem is `IMPERATIVE_VERBS` — verb conjugations multiply the table size in any inflected language. At that point the heuristic stops being cheap and the LLM is the right tool. So the architectural answer: heuristics scale poorly across locales; the LLM is the cross-language path.

### The question candidates always dodge
Q: How do you actually know the heuristic catches 60-70%? Where's the data?

A: I don't, precisely. The 60-70% number is a back-of-envelope estimate from manually scanning a few weeks of my own journal — counting how many `[]` lines start with an imperative verb (`call`, `fix`, `send`, `email`, `book`) versus how many are ambiguous. I haven't logged the actual `heur != null` rate or measured how often the LLM later reclassifies a heuristic-tagged row. The honest fix is one extra metric in `reconcileTodoMetaForEntry`: count `heur=='todo' / heur==null` per entry, persist to a debug table, build a tiny dashboard. I haven't done it because the LLM cost at single-user scale is a few cents a month even at 100% LLM-call rate, so the gate's actual hit rate doesn't drive a financial decision. The 60-70% figure is plausible, not proven; if someone funded the multi-user version, the first thing I'd build is the metric and tune the regex tables against real data.

### One-line anchors
- "It's a cost gate, not a classifier — `null` is the safe answer."
- "Order encodes evidence priority: rule out speculative interpretations first."
- "False positives are silent friction; false negatives are cheap LLM calls."
- "60-70% is back-of-envelope — the metric to actually measure it doesn't exist yet."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain heuristic-first classifier to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/heuristicClassify.ts:heuristicClassify`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user types these three lines as new todos:
1. `[] is the new auth flow broken?`
2. `[] should we maybe ship this`
3. `[] fix the dashboard before EOD`

For each line, walk the order of regex checks: which tables fire, which one decides the return value, and does the line ever reach the LLM (`classifyTodo`)? Specifically — does line 2 hit the modal `^should\s+` or the question `^should\s+(we|i)\b`? Why does the order of those two checks matter?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/heuristicClassify.ts` L71–L102 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/heuristicClassify.ts` to support what exists
→ Point to `src/services/todos/classify.ts` (the LLM call that absorbs every `null` from the heuristic) if you chose the alternative

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
