# Heuristic-first classifier — cheap regex gate before the LLM

**Industry name(s):** Cascading classifier, cheap-first / expensive-second
**Type:** Industry standard · Language-agnostic

> Decide whether a line is *definitely a todo* (return `'todo'`) or *uncertain* (return `null`, defer to LLM). Never mis-classify a question or idea as a todo.

**See also:** → [02-reconcile-todo-meta](./02-reconcile-todo-meta.md) · → [03-ai-engineering/05-heuristic-before-llm](../03-ai-engineering/05-heuristic-before-llm.md)

---

## Why care

If your classifier costs money or milliseconds per call, the cheapest way to make it faster on average is to not call it at all when a regex can answer. Most inputs to most classifiers are easy — they sit in a small handful of obvious patterns — and the expensive model exists only for the hard cases. Routing the easy ones through a cheap gate first and letting the gate abstain (return "I don't know") on anything ambiguous is the single biggest cost lever in any pipeline that mixes deterministic code with a paid model.

This is the cascading-classifier pattern, sometimes called early-exit or cheap-first / expensive-second. It's the same shape spam filters use (rule-based score before the ML model), the same shape OCR pipelines use (whitespace detection before character recognition), the same shape every CDN uses (cache check before origin fetch). The family is "build a hierarchy of classifiers ordered by cost, terminate on the first one confident enough to commit." The asymmetry that makes it work is precision-over-recall on the cheap stage: a false positive there is a silent wrong answer, a false negative is just a deferral to the more expensive stage. Bias toward abstention. Here's how this codebase applies that pattern.

---

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

── Brute force ──────────────────────────────────

Pseudocode (always call the LLM — no heuristic fast path):

```
  function classifyBrute(text):
    return classifyTodo(text)   // always hits Haiku
```

Execution trace (4 incoming todos: "call mom", "is this still broken?", "noticed flicker", "fix bug by EOD"):

```
  "call mom"             → LLM call (~300ms, ~$0.0004)  → 'todo'
  "is this still broken?"→ LLM call (~300ms, ~$0.0004)  → 'question' (mapped → null)
  "noticed flicker"      → LLM call (~300ms, ~$0.0004)  → 'idea'
  "fix bug by EOD"       → LLM call (~300ms, ~$0.0004)  → 'todo'

  4 LLM calls. 4 × $0.0004 = $0.0016. 4 × 300ms = 1.2s.
  At 100 todos/day: ~$0.04 + 30s of LLM time on the typing path.
```

Complexity: O(1) per todo in compute · O(1) memory · O(1) LLM calls per todo (network/$ bound).

What goes wrong at scale: per-todo Haiku cost (~$0.0004) is fine at 10 todos/day but adds up: at 1,000 todos/day single-user it's $0.40/day = ~$150/year just on classification. At multi-user scale with 100,000 todos/day, it's $15k/year for a step that a regex pass could handle 60-70% of for free. Latency is the bigger pain: every new todo would pause the UI for ~300ms while the LLM responds, breaking the "typing never waits on Haiku" guarantee that makes the journaling feel instant.

── Optimal ──────────────────────────────────────

The insight: a cheap regex pass decides the 60-70% obvious cases (`call`, `fix`, `should`, `?`, `noticed`, ...) and only returns `null` (deferring to the LLM) on the ambiguous remainder. The asymmetry — confident `'todo'` vs ambiguous `null` — guarantees no false positives.

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

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(1) net call  │ O(R) regex       │
  │ Space           │ O(1)           │ O(R) tables      │
  │ At 1,000 todos  │ 1,000 LLM calls│ ~300 LLM calls   │
  │ At 10,000 todos │ 10,000 LLM     │ ~3,000 LLM       │
  │ Readable?       │ yes            │ yes (ordered)    │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: at single-user scale and dev/exploration loops, $0.0004 × 100 todos/day = $0.04/day — basically free. The heuristic exists for UX (typing never waits on Haiku) more than for $.

---

## The bigger pattern

Every "free first, paid second" pipeline in this codebase has the same shape — heuristic classify, then LLM. Same idea: `expandTodo` checks `meta.type == 'todo'` and refuses to expand (no shape to expand into); `getProvider` reads `SecureStore` (sync, fast) before the network call.

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

We traded a regex table that must be maintained for a 60-70% cut on LLM call rate and a "typing never waits on Haiku" UX guarantee.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (regex gate + LLM   │ Alternative (always-LLM, no    │
│                  │ fallback)                      │ gate)                          │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Time per todo    │ <1ms for ~70% obvious cases    │ ~300ms for every todo (Haiku   │
│                  │ ~300ms for ~30% ambiguous       │ round-trip)                    │
│ LLM calls/100    │ ~30 calls (70% gated out)      │ 100 calls                      │
│ todos            │                                │                                │
│ Latency on typing│ instant for obvious todos      │ 300ms pause on every new line  │
│ $ at 1k todos/day│ ~$0.12/day                     │ ~$0.40/day                     │
│ $ at 100k/day    │ ~$4.5k/year                    │ ~$15k/year (multi-user scale)  │
│ Code complexity  │ ~100 LOC regex tables + ~30   │ ~10 LOC — direct LLM call      │
│                  │ LOC heuristic function         │                                │
│ Failure mode     │ regex stale → false negative   │ LLM down/slow → typing hangs   │
│                  │ → LLM picks up the slack       │ on every new todo              │
│ Maintenance      │ regex tables grow w/ vocab     │ none — LLM owns vocabulary     │
│ Locale support   │ English-only regex; non-EN     │ multi-lingual at the model    │
│                  │ falls through to LLM           │ layer for free                 │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

`IMPERATIVE_VERBS` is a Set of ~70 English verbs; `MODAL_STARTS`, `QUESTION_STARTS`, `SPECULATIVE_STARTS`, `DEADLINE_PATTERNS` are arrays of ~30 regexes total. Every time a user starts typing in a register the tables don't cover (different idiom, slang, abbreviation), the heuristic returns `null` and we pay an LLM call for what should have been a free decision. The maintenance loop is "notice a regularly-deferred phrasing, add a regex" — that's a manual feedback loop with no instrumentation today.

Non-English locales fall through entirely. A French entry like "il faut appeler maman" matches no regex and defers to the LLM. That's correct fallback, but the cost-saving promise of the gate evaporates for non-English users — they pay 100% LLM rate. The fix is per-locale regex tables, which is O(locale) of work the codebase has not absorbed.

The order is load-bearing. Speculative + question checks come before modal + imperative because "should we maybe ship this?" must hit `^should\s+(we|i)\b` (question) before `^should\s+` (modal). A contributor reordering the blocks for readability would flip the classification of edge cases silently. The tests we'd need to lock the order down don't exist yet.

### What the alternative would have cost

"Always call the LLM" is ~10 LOC instead of ~130 — much simpler. At single-user scale (100 todos/day) it costs ~$0.04/day, basically free. The dealbreaker isn't $; it's UX. Every new `[]` line in the journal would pause for 300ms while Haiku responds. The journaling flow is supposed to feel as fast as plain text editing; the heuristic guarantees that 70% of todos return synchronously and the journaling stays smooth.

At multi-user scale, the $ argument flips. 100k todos/day × $0.0004 = $40/day = $15k/year on classification alone. The 60-70% gate cuts that to ~$4.5k. Whether $11k/year matters depends on the revenue model, but the regex tables are cheap (~130 LOC) compared to optimizing the LLM call rate any other way.

A neural pre-classifier (tiny on-device model) would be more accurate than regex at the cost of binary-size bloat and inference setup. We didn't go that route because (a) the regex's "abstain on uncertain" semantics are simpler to reason about than a probability threshold, and (b) a model on-device that drifts from the cloud LLM's labels is a coordination problem with no clean solution.

### The breakpoint

Fine until non-English users are a real fraction of the user base, at which point the gate's hit rate per-user drops to ~0% for non-English locales and the cost/$ promise evaporates. The fix is per-locale tables, which scales work O(locales × ~130 LOC) — manageable for 5 languages, painful for 20. Beyond that, the on-device tiny model is the right shape.

### What wasn't actually a tradeoff

Returning `null` on uncertainty isn't really a tradeoff against returning the LLM's best guess — `null` is a signal, not a default. A heuristic that guessed wrong on edge cases would silently mis-classify user input and ship friction; the abstention contract is correctness, not laziness.

---

## Summary

Cascading classification is the family of "build a hierarchy of classifiers ordered by cost, terminate on the first one confident enough to commit" — the same shape spam filters use (rule score before ML), OCR pipelines use (whitespace detection before character recognition), CDNs use (cache check before origin fetch). In this codebase `heuristicClassify` in `src/services/todos/heuristicClassify.ts` runs ordered regex checks on every new todo: speculative + question patterns first (return `null` to defer), then modal + deadline + imperative-verb checks (return `'todo'` when confident), else `null` to fall through to the LLM. The constraint is precision-over-recall: false positives become silent wrong checkboxes the user has to clear manually, so the function is biased toward `null` and only commits `'todo'` on clear evidence. The cost is more LLM calls than strictly necessary — every ambiguous line still pays a Haiku round-trip — and a regex table that must be maintained per-locale (English-only today). Brute-force "always call the LLM" is fine financially at single-user scale; the heuristic exists primarily so typing never waits on Haiku.

Key points to remember:
- It's a cost gate, not a classifier — `null` means "I'm not sure, defer to the LLM," not "this isn't a todo."
- Order encodes evidence priority: rule out speculative interpretations (`maybe`, `noticed`, trailing `?`) before looking for action evidence (`should`, `fix`, `by EOD`).
- False positives are silent friction; false negatives are cheap LLM calls — the asymmetry of failure modes drives the asymmetry of the function.
- O(R) regex passes per line with R ≈ 100, effectively O(1); the savings are wall-clock latency and Haiku $ on the 60-70% of obvious cases.
- Non-English text falls through to `null` and the LLM picks up the slack — graceful degradation across locales.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand that this isn't a classifier — it's a *cost gate*. A real classifier returns the best label; `heuristicClassify` returns `'todo'` only when it's confident, and `null` for everything ambiguous. That asymmetry is the whole design. The interviewer wants to hear me name the dominant cost concern (per-LLM-call $) and explain that the heuristic exists to keep the LLM call rate down, not to be smart on its own.

### Likely questions

[mid] Q: Walk me through what happens for the line "should email the client by EOD" — which check fires first?
      A: It's not empty, doesn't end with `?`. Speculative check runs — none of `maybe|noticed|idea:` match. Question check runs — `^should\s+(we|i)\b` doesn't match because the next word is "email," not "we" or "I." Modal check runs — `^should\s+` matches → returns `'todo'`. The line never reaches DEADLINE or IMPERATIVE because modal already decided. The order encodes "rule out the speculative interpretations first, then look for evidence of action."

```
[heuristic check order for "should email the client by EOD"]

  input: "should email the client by EOD"
        │
        ▼  empty/'?' check
  not empty, not '?' → continue
        │
        ▼  SPECULATIVE_STARTS (/^maybe|noticed|idea:/)
  no match → continue
        │
        ▼  QUESTION_STARTS (/^should\s+(we|i)\b/)
  "email" follows "should" — no match → continue
        │
        ▼  MODAL_STARTS (/^should\s+/)
  matches → return 'todo'   ◀── stops here
        │
        ▼
  DEADLINE + IMPERATIVE never run
```

[senior] Q: Why does `heuristicClassify` bias toward returning `null` instead of guessing?
         A: Because false positives are silent and false negatives are cheap. If I confidently mark "noticed the dashboard flickers" as `'todo'`, the user sees a checkbox they have to manually clear — friction. If I return `null` and the LLM says `'idea'`, the user sees the right thing 300ms later — invisible. The asymmetry of the failure modes drives the asymmetry of the function. Returning `null` more often costs me more LLM calls; returning `'todo'` wrongly costs the user trust.

```
                  Path taken (bias toward null)        Alternative (guess on ambiguous)
                  ────────────────────────────────────  ──────────────────────────────────
false positive    impossible — null on uncertain        possible — wrong label commits
                                                       silently
false negative    LLM picks up the slack (~300ms)       no fallback — wrong label sticks
user-visible      checkbox is right or the LLM fixes    user sees wrong checkbox, has to
  failure         it 300ms later                        manually clear it
trust cost        ~0 — silent fix                       high — user notices, distrusts
                                                       classifier
LLM call rate     ~30-40% of todos                      ~0% — but at cost of correctness
verdict           abstention is correctness, not       guessing optimizes the wrong
                  laziness                              metric
```

[arch] Q: What changes when you support a non-English language?
       A: All ~100 regexes are English-locale. A French entry like "il faut appeler maman" would fall through every check and return `null`, deferring to the LLM. That's actually the correct fallback — graceful degradation. To add French, I'd duplicate the regex tables per locale and dispatch on the user's `Accept-Language` or a settings field. The harder problem is `IMPERATIVE_VERBS` — verb conjugations multiply the table size in any inflected language. At that point the heuristic stops being cheap and the LLM is the right tool. So the architectural answer: heuristics scale poorly across locales; the LLM is the cross-language path.

```
[scale curve — what breaks first at 10× and 100× user count or locale count]

  user base       hit rate   LLM cost/100k todos   maintenance      breaks?
  ─────────────   ────────   ───────────────────   ──────────────   ──────────────────
  EN single user  ~70%       $12/day                trivial          no
  EN 10k users    ~70%       $1.2k/day              add regex P/M    no
  + 5 locales     ~50% avg   $2k/day                5× table churn   manageable
  + 20 locales    ~20% avg   $3k/day                hopeless         table maintenance   ◀── BREAKS FIRST
  + inflected     ~5% avg    $4k/day                impossible       drop heuristic,
  languages                                                          go pure-LLM or
                                                                     on-device model
```

### The question candidates always dodge
Q: How do you actually know the heuristic catches 60-70%? Where's the data?

A: I don't, precisely. The 60-70% number is a back-of-envelope estimate from manually scanning a few weeks of my own journal — counting how many `[]` lines start with an imperative verb (`call`, `fix`, `send`, `email`, `book`) versus how many are ambiguous. I haven't logged the actual `heur != null` rate or measured how often the LLM later reclassifies a heuristic-tagged row. The honest fix is one extra metric in `reconcileTodoMetaForEntry`: count `heur=='todo' / heur==null` per entry, persist to a debug table, build a tiny dashboard. I haven't done it because the LLM cost at single-user scale is a few cents a month even at 100% LLM-call rate, so the gate's actual hit rate doesn't drive a financial decision. The 60-70% figure is plausible, not proven; if someone funded the multi-user version, the first thing I'd build is the metric and tune the regex tables against real data.

```
                  Path taken (no instrumentation)      Suggested (hit-rate metric)
                  ────────────────────────────────────  ──────────────────────────────────
hit rate source   back-of-envelope manual estimate     persisted counter per entry
                  (60-70%)                              with rolling weekly stats
LLM reclassify    untracked — can't measure how often  measure heur=='todo' rows the LLM
  rate            heuristic is wrong                    later flips → false-positive rate
financial signal  cents/month — no driver              real cost at multi-user scale —
                                                       drives table tuning
regex tuning      reactive (notice a phrasing, add a   data-driven (LLM reclassifies =
  loop            regex)                                regex needs update)
LOC               0 — no infra                          ~30 LOC counter + ~50 LOC dash
verdict           good enough at single-user scale     first thing to build if user
                                                       base grows
```

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
Updated: 2026-05-10 — added v1.14.0 subtitle block + brute-force section + comparison table.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
