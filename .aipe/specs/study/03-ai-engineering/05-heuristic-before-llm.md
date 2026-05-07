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
