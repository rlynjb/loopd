# Heuristic before LLM (the cost gate)

> Every new todo runs through `heuristicClassify` first (regex-only, no network). The LLM classifier is fired only when the heuristic returns `null`.

**See also:** → [02-dsa/10-heuristic-first-classifier](../02-dsa/10-heuristic-first-classifier.md) · → [09-async-classification](./09-async-classification.md)

---

## Quick summary
- **What:** cheap deterministic check first; expensive LLM call only if the cheap check is uncertain.
- **Why here:** the LLM classifier costs ~$0.0001 per todo. A heavy journaling day produces 30+ todos. Heuristic catches the easy 60-70% for free.
- **Tradeoff:** the heuristic intentionally over-fires `null`. False negatives cost one cheap LLM call. False positives would be silent and require a manual override — bias is firmly toward null.

---

## Heuristic before LLM — diagram

```
  new todo created
        │
        ▼
   heuristicClassify(text)
        │
        ├─ returns 'todo'  → set type='todo', confidence='heuristic', SKIP LLM
        │
        └─ returns null    → insert with confidence=null
                              │
                              ▼
                          if not done: scheduleClassify(todoId, text)  ← async
                                            │
                                            ▼
                                       call Haiku/4o-mini
                                            │
                                            ▼
                                       updateTodoMeta(todoId, type, confidence)
```

---

## How it works

The heuristic is a series of ordered regex tests (see [02-dsa/10-heuristic-first-classifier](../02-dsa/10-heuristic-first-classifier.md) for the algorithm). Returns either `'todo'` (confident) or `null` (uncertain).

Confident `'todo'` results bypass the LLM entirely — meta is inserted with `classifierConfidence='heuristic'`.

`null` results insert with `classifierConfidence=null`, then fire `scheduleClassify(todoId, text)` async. The scan returns immediately; the LLM call lands later via DB update + event.

---

## The same shape repeats elsewhere

- `expand.ts:218` refuses to expand when `meta.type == 'todo'` — no expansion shape exists for plain todos, so no LLM call.
- `compose.ts` falls back through `variants.clean → caption → summary.summary` — no LLM call to "compose", just a deterministic shape selection.

**Pseudocode (the gate, generalized):**

```
  cheap = freeDeterministicCheck(input)
  if cheap.isConfident: return cheap.result      // no LLM
  return await llmCall(input)
```

---

## In this codebase

- `src/services/todos/heuristicClassify.ts` → the regex tables.
- `src/services/todos/reconcileMeta.ts` → calls heuristic before insert.
- `src/services/todos/classify.ts` → `scheduleClassify`, fired only on `null`.

---

## Elaborate

### Where this pattern comes from
"Cheap first, expensive second" cascades are foundational — disk cache → DRAM → page fault, CDN → origin, regex → parser. The AI-era version puts a regex (or any deterministic check) in front of the LLM.

### The deeper principle
**Pay for the answer you can't compute. Don't pay for the answer you can.** Most decisions are easy. Only the hard ones deserve a model.

### Where this breaks down
- New input shapes the heuristic doesn't know about. The LLM picks up the slack — graceful degradation, but the cost goes up.
- Multi-language users where English-only regex misses obvious cases.

### What to explore next
- [02-dsa/10-heuristic-first-classifier](../02-dsa/10-heuristic-first-classifier.md) → the regex algorithm.
- [09-async-classification](./09-async-classification.md) → what happens when the heuristic returns `null`.

---

## Tradeoffs

- **Heuristic gate** — gives: 60-70% of todos classified for free. Costs: a regex table to maintain.
- **Bias toward `null`** — gives: false-positives are impossible. Costs: more LLM calls than strictly necessary.
- **Async LLM on `null`** — gives: scan returns fast. Costs: brief window where the row shows `type='todo'` before being upgraded.

---

## Interview defense

### What an interviewer is really asking
The cost-gate question is really "do you have a cost model?". They want to see that I picked a regex pre-filter because I did the math, not because it sounded clever. The number to drop: classify is ~$0.0001 per call, a heavy day is 30+ todos, and the heuristic catches roughly half of them for free. That's a halving of LLM cost on the highest-volume chain in the app.

### Likely questions

[mid] Q: What does `heuristicClassify` return when it can't classify, and what happens next?
      A: It returns `null`. `reconcileMeta.ts` inserts the meta row immediately with `classifierConfidence=null` (so the row exists synchronously), and if the todo isn't done yet it fires `scheduleClassify(todoId, text)` without awaiting. The async LLM call lands later via `updateTodoMeta` and emits `CLASSIFY_PROGRESS_EVENT` so `/todos` can re-render. The user sees the row appear instantly with `type='todo'` placeholder; the badge upgrades milliseconds-to-seconds later.

[senior] Q: Why bias the heuristic toward `null` instead of toward catching more cases?
         A: False negatives cost one cheap LLM call. False positives are silent — the heuristic confidently labels a question as a todo, the LLM never runs, and the user has to manually open the picker to fix it (which then locks the row via `user_overridden_type`). The asymmetry is: a wrong heuristic is irreversible without user action, a `null` heuristic costs a fraction of a cent. So I bias hard toward `null`. The heuristic only fires `'todo'` for the cleanest verb-led actionable shape; everything ambiguous goes to the LLM.

[arch] Q: At 10× the user volume, would you still keep the heuristic, or replace it with a small classifier model?
       A: I'd keep it as the first layer and add a small local classifier as the second layer before the LLM as the third. The heuristic at zero cost is unbeatable for the obvious cases — there's no model that does better than regex on "buy milk". A tiny on-device classifier (something like a fine-tuned distilbert) could catch the 30% the heuristic misses but the LLM gets right, taking another bite out of cost. The LLM stays the fallback. The cost gate just gets more layers.

### The question candidates always dodge
Q: Doesn't the heuristic miss things? You're proud of "60-70% caught for free" but that means 30-40% of the easy-to-classify todos still hit the LLM unnecessarily.

A: Yes. The heuristic only catches the obvious 'todo' shape — anything verb-led with an actionable noun. Everything else returns `null` and goes to the LLM. That's the design: the heuristic is a free filter, not a complete classifier. The 50/50 split between heuristic-classified and LLM-classified is fine; the goal was to halve the LLM cost, not eliminate it. The reason I didn't push the heuristic harder is exactly the false-positive risk above — every regex I add risks confidently mis-labeling something the LLM would have got right. The current `heuristicClassify.ts` is intentionally conservative: a small set of high-precision patterns. I'd rather pay $0.0001 per LLM call than re-debug a regex that fires on ambiguous text.

### One-line anchors
- "Pay for the answer you can't compute. Don't pay for the answer you can."
- "The heuristic is a free filter, not a complete classifier."
- "Bias toward `null`. False negatives cost a fraction of a cent; false positives need user action."
- "Halve the cost on the highest-volume chain. That's the whole win."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
