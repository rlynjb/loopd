# Heuristic before LLM (the cost gate)

**Industry name(s):** Cascading classifier, cheap-first / expensive-second
**Type:** Industry standard · Language-agnostic

> Every new todo runs through `heuristicClassify` first (regex-only, no network). The LLM classifier is fired only when the heuristic returns `null`.

**See also:** → [02-dsa/10-heuristic-first-classifier](../02-dsa/10-heuristic-first-classifier.md) · → [09-async-classification](./09-async-classification.md)

---

## Why care

The cheapest LLM call still costs money, takes 300+ milliseconds, and can fail. If your product runs an AI on every keystroke or every new row, you'll burn through a budget that buys you nothing for inputs a regex could have answered. The fix is to ask "do I actually need a model for this?" before every call — and most of the time, on the easy inputs, the answer is no.

The heuristic-first pattern is a two-stage classifier: a cheap deterministic check decides whether the input is easy enough to handle without the model, and only the residual uncertain cases pay for inference. It belongs to the family of "cascade" or "early-exit" classifiers — the same shape as spam filters that rule out obvious junk before the ML model, content moderation pipelines that block known-bad hashes before vision models, and CPU branch predictors that take the fast path when the prediction is confident. You've already seen this in production LLM stacks where a regex or BM25 layer sits in front of a vector DB, and in routing layers (LangChain routers, LiteLLM fallbacks) that send small inputs to small cheap models and only escalate when they have to. Here's how that actually works in this codebase.

---

## How it works

The heuristic is a series of ordered regex tests (see [02-dsa/10-heuristic-first-classifier](../02-dsa/10-heuristic-first-classifier.md) for the algorithm). Returns either `'todo'` (confident) or `null` (uncertain).

Confident `'todo'` results bypass the LLM entirely — meta is inserted with `classifierConfidence='heuristic'`.

`null` results insert with `classifierConfidence=null`, then fire `scheduleClassify(todoId, text)` async. The scan returns immediately; the LLM call lands later via DB update + event. The diagram below shows it end-to-end.

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

**Heuristic:**     `src/services/todos/heuristicClassify.ts` → `heuristicClassify()` L71–L102 + regex tables L12–L62
**Caller:**        `src/services/todos/reconcileMeta.ts` → `reconcileTodoMetaForEntry()` L48–L92 calls heuristic before insert; falls through to `scheduleClassify()` L13–L46 on `null`
**LLM fallback:**  `src/services/todos/classify.ts` → `classifyTodo()` L90–L120 (with `SYSTEM_PROMPT` L12–L25)

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

We traded a regex-table to maintain for catching 60-70% of todos at zero cost — and biased the gate hard toward `null` so the LLM absorbs every ambiguous case rather than the heuristic confidently mislabelling them.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (heuristic gate)    │ Alternative (LLM every todo)   │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Money            │ ~50% of todos free; remainder  │ 100% × $0.0001 = ~$0.003/day   │
│ ($/1k tokens)    │ at $0.0001 each (Haiku/4o-mini)│ heavy-day (30 todos); ~$1/year │
│                  │ → ~$0.0015/heavy-day; ~$0.50/yr│ per user                       │
│ Latency          │ confident 'todo' returns sync; │ every todo round-trips ~300ms  │
│                  │ heuristic ~0.1ms regex test    │ to Haiku/4o-mini; async hides  │
│                  │                                │ it but rate-limit pressure up  │
│ Format reliability│ 'todo' label cannot be wrong  │ LLM hallucinates rare label    │
│                  │ — regex precision is 100% on   │ shapes (~0.5%); validate.ts    │
│                  │ patterns that match            │ rejects → row stuck at null    │
│ False-positive   │ impossible — bias toward null │ ~0.5-1% wrong-confident labels │
│ risk             │ is the whole design            │ → silent UX bug; needs picker  │
│                  │                                │ + user_overridden_type to fix  │
│ Capacity / rate  │ free path drains no quota      │ 100% of todos hit Anthropic/   │
│ limits           │                                │ OpenAI quota; 429s on bursts   │
│ Cognitive load   │ "regex first, LLM second" —    │ "every todo calls the model" — │
│                  │ one rule; regex table reads    │ simpler mental model but more  │
│                  │ as a precision-tuned list      │ failure modes downstream       │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The regex table in `heuristicClassify.ts` L12–L62 is maintenance code that drifts as new input shapes appear. A user who writes journal entries in Spanish, or uses gerund-led action lines ("buying groceries today"), or writes in passive voice ("groceries need buying") gets every line routed to the LLM — the heuristic is intentionally English-imperative-biased. That's a real category of users who pay full LLM cost on every todo. The table will need periodic re-tuning if usage shifts.

We also accept more LLM calls than strictly necessary because the bias is hard toward `null`. A line like "fix the dashboard before EOD" is *obviously* a todo to a human but the heuristic returns `null` if the regex doesn't catch the leading verb shape — the LLM picks it up at ~$0.0001 and labels it correctly. We pay the unnecessary cents to avoid the silent mislabel.

The async window between insert (sync, with placeholder `type='todo'`) and update (LLM responds) means the user briefly sees a row with the wrong badge if the LLM's eventual answer is `idea` or `reflect`. The window is ~300ms-2s in good network conditions, longer or unbounded under failure. The `/todos` banner via `getClassifyInFlight()` is the only signal that classification is still in flight.

### What the alternative would have cost

Sending every todo to Haiku/4o-mini would cost ~$0.0001 × 30 ambiguous todos × 365 days = ~$1/user/year — trivially affordable in absolute terms. The hidden cost is latency on the keystroke path. Without the async fire-and-forget, every commit waits for 30 round-trips at ~300ms each — that's 3-9 seconds of editor freeze on a heavy day. Even with the async pattern, every todo enters the in-flight queue and rate limits start mattering on bursts (a 100-todo entry would hit 429s).

The deeper cost is failure-mode amplification. The heuristic gate is deterministic — if it returns `'todo'`, it's right. Routing everything to the LLM means every todo can fail in three new ways: malformed JSON, hallucinated label, network error. The validation gate catches the first two; the user_overridden_type lock cleans up the third when the user manually corrects. Without the heuristic, 100% of todos go through the full failure-mode surface; with it, ~50% bypass it.

The cost of removing the heuristic isn't dollars — it's the increased volume on every downstream system (validator, retry path, lock, sync queue).

### The breakpoint

The pattern flips at ~$10 LLM cost per user per year (volume × price). At today's Haiku 4.5 / GPT-4o-mini pricing, that's ~3000 LLM-classify calls per user per year — far above any realistic single-user volume. The breakpoint shifts up if Anthropic drops Haiku pricing 5× or down if a user writes 200+ todos per day. A secondary trigger: if the regex table drifts so badly that the heuristic catches <30% of obvious todos, the maintenance cost stops being justified.

A different breakpoint: if the codebase adds a *second* cost-gated chain (say, a "quick rewrite" feature that runs on every clip), the heuristic-first pattern generalises into a shared `cheapFirstThenLLM(input, heuristic, llmCall)` utility. With one consumer today, the abstraction would have one caller and zero payback.

### What wasn't actually a tradeoff

Embedding the heuristic in the prompt ("if this is obviously a todo, return immediately") was never an option. The whole point of the gate is to avoid the LLM round-trip; folding it into the prompt would pay the network cost on every call to skip the network cost. A pre-prompt heuristic is the right shape; a prompt-side heuristic is a category error.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk / claude-haiku-4-5

- **Codebase uses:** `@anthropic-ai/sdk` with `claude-haiku-4-5` (via `classifyTodo` in `classify.ts`) — the LLM that fires only when the heuristic returns `null`.
- **Why it's here:** the cost gate exists specifically because even Haiku costs ~$0.0001/call; the heuristic skips this call for ~50% of todos.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling that wrappers sometimes flatten or delay.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures and `useChat` hook.

---

## Summary

Heuristic-before-LLM is a two-stage cascade classifier: a cheap deterministic check decides whether the input is easy enough to skip the model, and only the residual uncertain cases pay for inference. In this codebase every new todo runs through `heuristicClassify()` in `src/services/todos/heuristicClassify.ts` (L71–L102, regex tables L12–L62) before any LLM call — confident `'todo'` results bypass the model entirely; `null` results insert with `classifierConfidence=null` and fire `scheduleClassify()` async. The constraint that drove it is cost on the highest-volume chain — classify is ~$0.0001 per call on Haiku/4o-mini and a heavy journaling day produces 30+ todos, so the heuristic catching 60-70% for free is the whole win. The cost is a regex table to maintain and a bias toward `null` that fires more LLM calls than strictly necessary — but false negatives cost a fraction of a cent while false positives would be silent and need user-initiated overrides.

Key points to remember:
- Heuristic returns `'todo' | null` — never anything else; the asymmetry is the whole design.
- `'todo'` bypasses the LLM entirely (`classifierConfidence='heuristic'`); `null` schedules the LLM async.
- Bias is firmly toward `null`: false negatives cost ~$0.0001, false positives need a manual override and lock the row.
- The same shape repeats elsewhere — `expand.ts:218` refuses to expand `meta.type == 'todo'`; `compose.ts` deterministically falls through `variants.clean → caption → summary.summary`.
- The cost is more LLM calls than strictly necessary and a regex table that must be updated when new input shapes appear.

---

## Interview defense

### What an interviewer is really asking
The cost-gate question is really "do you have a cost model?". They want to see that I picked a regex pre-filter because I did the math, not because it sounded clever. The number to drop: classify is ~$0.0001 per call, a heavy day is 30+ todos, and the heuristic catches roughly half of them for free. That's a halving of LLM cost on the highest-volume chain in the app.

### Likely questions

[mid] Q: What does `heuristicClassify` return when it can't classify, and what happens next?
      A: It returns `null`. `reconcileMeta.ts` inserts the meta row immediately with `classifierConfidence=null` (so the row exists synchronously), and if the todo isn't done yet it fires `scheduleClassify(todoId, text)` without awaiting. The async LLM call lands later via `updateTodoMeta` and emits `CLASSIFY_PROGRESS_EVENT` so `/todos` can re-render. The user sees the row appear instantly with `type='todo'` placeholder; the badge upgrades milliseconds-to-seconds later.

```
[heuristic-returns-null flow]

  heuristicClassify("fix the dashboard before EOD")
        │
        ▼  returns null (no clean verb-led match)
  reconcileMeta inserts row sync
        │   type='todo' placeholder, classifierConfidence=null
        ▼
  if !todo.done: scheduleClassify(todoId, text)   ← FIRE, no await
        │   reconcile returns; UI re-renders
        ▼  (network call lands later)
  classifyTodo → Haiku/4o-mini → updateTodoMeta(type, confidence)
        │
        ▼  emit CLASSIFY_PROGRESS_EVENT
  /todos re-fetches metas, badge upgrades from 'todo' → real type
```

[senior] Q: Why bias the heuristic toward `null` instead of toward catching more cases?
         A: False negatives cost one cheap LLM call. False positives are silent — the heuristic confidently labels a question as a todo, the LLM never runs, and the user has to manually open the picker to fix it (which then locks the row via `user_overridden_type`). The asymmetry is: a wrong heuristic is irreversible without user action, a `null` heuristic costs a fraction of a cent. So I bias hard toward `null`. The heuristic only fires `'todo'` for the cleanest verb-led actionable shape; everything ambiguous goes to the LLM.

```
                  Path taken (bias toward null)        Alternative (aggressive heuristic)
                  ─────────────────────────────        ─────────────────────────────────
false negative    1 LLM call ~$0.0001                  0 cost — gets caught by heuristic
cost              recoverable: LLM labels correctly
false positive    impossible — null is "I don't know"  ~0.5-1% wrong-confident labels
risk              never confidently wrong              silent UX bug, user must pick
recovery          LLM picks up the label               only via manual picker →
                                                       user_overridden_type=true (sticky)
regex table       small, high-precision patterns       wider, more permissive — adds
maintenance       ~50 LOC                              false-positive risk per pattern
% caught free     ~50% (heuristic is conservative)     ~75-85% (more aggressive)
$ saved/yr        ~$0.50 (heavy single user)           ~$0.75 — gain trivial vs UX cost
```

[arch] Q: At 10× the user volume, would you still keep the heuristic, or replace it with a small classifier model?
       A: I'd keep it as the first layer and add a small local classifier as the second layer before the LLM as the third. The heuristic at zero cost is unbeatable for the obvious cases — there's no model that does better than regex on "buy milk". A tiny on-device classifier (something like a fine-tuned distilbert) could catch the 30% the heuristic misses but the LLM gets right, taking another bite out of cost. The LLM stays the fallback. The cost gate just gets more layers.

```
At 10× user volume (300 todos/day, ~$10/user/year LLM cost):

  ┌─ Heuristic (regex, free) ───────────────────┐
  │ catches ~50% — unchanged                    │
  └────────────────┬────────────────────────────┘
                   │ null falls through
                   ▼
  ┌─ Small local classifier (NEW) ──────────────┐
  │ on-device distilbert/MobileBERT             │  ◀── NEW LAYER
  │ catches ~30% of remaining at zero $ cost    │
  │ ~10-50ms inference; bundled in app          │
  └────────────────┬────────────────────────────┘
                   │ low-confidence falls through
                   ▼
  ┌─ Cloud LLM (Haiku/4o-mini) ─────────────────┐
  │ catches the residual ~20%                   │  ◀── RATE-LIMIT-BREAKS-FIRST
  │ at 10× volume: 60 LLM calls/user/day        │     (currently free path absorbs
  │ → quota pressure on Anthropic/OpenAI         │      bursts; LLM-only would hit
  │                                              │      429s at this volume)
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Doesn't the heuristic miss things? You're proud of "60-70% caught for free" but that means 30-40% of the easy-to-classify todos still hit the LLM unnecessarily.

A: Yes. The heuristic only catches the obvious 'todo' shape — anything verb-led with an actionable noun. Everything else returns `null` and goes to the LLM. That's the design: the heuristic is a free filter, not a complete classifier. The 50/50 split between heuristic-classified and LLM-classified is fine; the goal was to halve the LLM cost, not eliminate it. The reason I didn't push the heuristic harder is exactly the false-positive risk above — every regex I add risks confidently mis-labeling something the LLM would have got right. The current `heuristicClassify.ts` is intentionally conservative: a small set of high-precision patterns. I'd rather pay $0.0001 per LLM call than re-debug a regex that fires on ambiguous text.

```
                  Path taken (conservative heuristic)  Suggested (push heuristic harder)
                  ──────────────────────────────────   ─────────────────────────────────
% todos free      ~50%                                 ~75-85%
$ saved/year      ~$0.50 per heavy single user         ~$0.75 — incremental ~$0.25
false-positive    0 by design                          ~0.5-1% — silent UX bug
risk
recovery cost     N/A                                  user opens picker → permanent
                                                       user_overridden_type=true lock
debugging         "regex didn't match → LLM ran"       "regex matched but was wrong" →
                  obvious in the data                  must re-read regex table + retest
regex maintenance ~50 LOC, stable                      grows; each new pattern carries
                                                       false-positive risk
LLM cost saved    ~$0.50/user/yr — small absolute,     ~$0.25 marginal — too small to
                  but the test for "is this gate       justify the new failure mode
                  worth it" is binary yes              category
```

### One-line anchors
- "Pay for the answer you can't compute. Don't pay for the answer you can."
- "The heuristic is a free filter, not a complete classifier."
- "Bias toward `null`. False negatives cost a fraction of a cent; false positives need user action."
- "Halve the cost on the highest-volume chain. That's the whole win."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "heuristic before LLM" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/heuristicClassify.ts:heuristicClassify`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user types `[] this is a question right?`. Walk both layers — exactly what does the heuristic decide and why? Does this line ever reach the LLM (`classifyTodo`)? Now do the same for `[] fix the dashboard before EOD` — heuristic returns what, and does the LLM run?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/heuristicClassify.ts` L71–L102 to verify the order of checks.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/heuristicClassify.ts` (the regex-based zero-cost gate) to support what exists
→ Point to `src/services/todos/classify.ts:classifyTodo` (the LLM that absorbs every `null`) if you chose the alternative — what does cost look like with no gate?

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block. No "7-class problem" string present in this file; classification-count drift (7→5 modes) lives in file 13 and is updated there. Heuristic returns `'todo' | null` so the heuristic-gate description is unaffected by the mode-count reduction.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk / claude-haiku-4-5.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.
