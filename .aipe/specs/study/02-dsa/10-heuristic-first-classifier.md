# Heuristic-first classifier — cheap regex gate before the LLM

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

- `src/services/todos/heuristicClassify.ts` → the function and its regex tables.
- Called from `reconcileTodoMetaForEntry` (see [02-reconcile-todo-meta](./02-reconcile-todo-meta.md)).
- LLM fallback: `src/services/todos/classify.ts` → `classifyTodo()`.

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
