# Async background classification — fire and forget

**Industry name(s):** Asynchronous task / background job pattern
**Type:** Industry standard · Language-agnostic

> The prose scan completes synchronously. Each new ambiguous todo fires an LLM call without awaiting it. The result lands later via DB write + event.

**See also:** → [05-heuristic-before-llm](./05-heuristic-before-llm.md) · → [02-dsa/02-reconcile-todo-meta](../02-dsa/02-reconcile-todo-meta.md)

---

## Why care

You hit "save" and the app freezes for four seconds while an LLM thinks about your input. The interaction was instant the day before AI was added, and now it's slow on every save. The fix isn't a faster model — the fix is to stop waiting. Commit a sensible placeholder synchronously, kick off the model call in the background, and update the row when the answer comes back. The user feels nothing.

Fire-and-forget classification belongs to the family of "asynchronous job" patterns — the same shape as message queues, optimistic UI updates, eventual consistency in databases, and every "we sent you an email" flow that doesn't make the user wait for SMTP. You've already seen this in background workers (Celery, Sidekiq, BullMQ), in webhook-driven AI pipelines where a job queue feeds the model and a callback writes back, and in modern AI products that stream a placeholder reply while computing the real one. Here's how that actually works in this codebase.

---

## How it works

`reconcileTodoMetaForEntry` walks new todos. For each one, it calls heuristic, inserts a meta row immediately (synchronous), and if heuristic returned `null`, fires `scheduleClassify` *without awaiting*. The function returns as soon as all the synchronous inserts are done.

`scheduleClassify` is a tiny wrapper that calls `classifyTodo` and on success calls `updateTodoMeta` with the result. It catches errors and never throws — the user shouldn't see classification failures.

The `/todos` screen subscribes to `CLASSIFY_PROGRESS_EVENT`. When the event fires, it re-fetches the metas and the badges update. This gives the user a "live" feel without the editor commit being blocked.

```
Pseudocode (reconcileMeta.ts):
  function reconcileTodoMetaForEntry(entry):
    for each todo not in existing:
      heur = heuristicClassify(todo.text)
      meta = buildMeta(todo, heur)
      await insertTodoMeta(meta)                    ← synchronous
      if heur == null AND !todo.done:
        scheduleClassify(todo.id, todo.text)        ← FIRE, do NOT await
    for each meta not in current:
      await deleteTodoMeta(meta.todoId)

  function scheduleClassify(todoId, text):
    classifyTodo(text)
      .then(result => result && updateTodoMeta(todoId, {...}))
      .catch(err => log warning)                    ← never throws
```

The diagram below shows the sync-then-async timeline end-to-end.

---

## Async classification — diagram

```
  reconcileTodoMetaForEntry(entry):
       │
       │   for each new todo:
       │     insertTodoMeta(...)               ← synchronous, blocking
       │     if heuristic was null and not done:
       │       scheduleClassify(todoId, text)  ← async, NOT awaited
       │
       ▼
  return                                     ← scan completes, UI re-renders
                                                with type='todo' shown for now
                                              │
              (some milliseconds later)        ▼
  classifyTodo(text)
       │
       ├─ network call to Haiku/4o-mini
       │
       ▼
  updateTodoMeta(todoId, { type, classifierConfidence, classifierModel })
       │
       ▼
  emit('classify-progress')
       │
       ▼
  /todos screen subscribes via on(CLASSIFY_PROGRESS_EVENT)
  → re-fetches metas, re-renders the type badge
```

---

## In this codebase

**Fire site:**           `src/services/todos/reconcileMeta.ts` → `scheduleClassify()` L13–L46 (called from `reconcileTodoMetaForEntry()` L48–L92, NOT awaited)
**LLM call:**            `src/services/todos/classify.ts` → `classifyTodo()` L90–L120
**In-flight tracker:**   `src/services/todos/classify.ts` → `getClassifyInFlight` L37, `CLASSIFY_PROGRESS_EVENT` L38 (event constant the UI subscribes to)
**UI subscriber:**       `app/todos.tsx` — subscribes to `CLASSIFY_PROGRESS_EVENT` (the type-badge update path); `app/todos/[id].tsx` L113 also subscribes for the detail screen

---

## Elaborate

### Where this pattern comes from
Fire-and-forget is the classic responsiveness pattern in UI code — kick off the slow work, return to the user, write back when done. Web apps use it for analytics; mobile apps for image-resize and indexing.

### The deeper principle
**Don't block the user-facing path on best-effort work.** The classifier is best-effort: a failure leaves the row at `type='todo'`, which is a fine default. So the path that updates it doesn't deserve the user's attention.

### Where this breaks down
- Errors are silenced — the user sees a row stuck at `type='todo'` and might not realise the LLM call failed. Mitigation: dev-mode logs, /todos banner.
- Async fires with no concurrency cap could overwhelm the model. Loopd doesn't currently cap classify concurrency (one per `null` heuristic), but the per-entry count is bounded by entry size.

### What to explore next
- [05-heuristic-before-llm](./05-heuristic-before-llm.md) → the cheap gate that decides whether to fire.
- [02-dsa/02-reconcile-todo-meta](../02-dsa/02-reconcile-todo-meta.md) → the algorithm.

---

## Tradeoffs

- **Async fire-and-forget** — gives: editor commit returns instantly. Costs: classification appears later; user might miss it.
- **Event-based UI update** — gives: live feel without polling. Costs: another subscription to manage on screen mount/unmount.
- **Silent failure** — gives: no spurious error toasts. Costs: hard to notice when classification is consistently failing.

---

## Quick summary

Async background classification is the "fire-and-forget" pattern applied to LLM annotation — kick off the slow network call without awaiting it, let the synchronous path return, and write back when the result arrives. In this codebase `reconcileTodoMetaForEntry` inserts each new ambiguous row with a `type='todo'` placeholder and fires `scheduleClassify` without awaiting; `classifyTodo` later calls Haiku/4o-mini, `updateTodoMeta` writes the result, and `CLASSIFY_PROGRESS_EVENT` tells the `/todos` screen to re-render the badge. The constraint that drove it is editor-commit latency — a 30-todo entry with 10 ambiguous lines would otherwise wait 3-5 seconds for sequential round-trips. The cost is that failures are silent: a flaky network leaves rows stuck at `type='todo'` and the user might not notice without the `/todos` banner from `getClassifyInFlight()`.

Key points to remember:
- Synchronous insert with placeholder type, async LLM call, event-driven UI refresh.
- The editor commit never blocks on the network — that's the rule.
- Errors are caught and logged; `scheduleClassify` never throws.
- Failures are eventually-consistent: the next reconcile re-fires on `null`-confidence rows.
- No concurrency cap today — at 100+ ambiguous todos this would need a `MAX_CONCURRENT` like `expand.ts:25`.

---

## Interview defense

### What an interviewer is really asking
"Why fire-and-forget?" tests whether I picked async because of UX latency or just for fun. They want the latency math: 30 todos × 10 ambiguous × ~300ms = 3-5 seconds of editor-commit pause if I awaited them all. They also want to see that I thought about what happens when the async call fails — silent failure isn't ignorance, it's an explicit choice for best-effort work.

### Likely questions

[mid] Q: When `scheduleClassify` fails — say a network error mid-classification — what does the user see?
      A: Nothing immediately. The function catches the error, logs a warning, and never throws — that's how it stays fire-and-forget. The meta row stays at whatever the heuristic returned (usually `type='todo'` placeholder, `classifierConfidence=null`). The next time `reconcileTodoMetaForEntry` runs for that entry — say on the next save — the catch-up logic sees the row still has null confidence and re-fires `scheduleClassify`. So failures are eventually-consistent rather than user-visible. The cost is that a steady stream of failures stays silent unless the dev-mode logs are watched or the `/todos` banner shows persistent in-flight via `getClassifyInFlight()`.

[senior] Q: Why not block the editor commit on classification, with a loading spinner?
         A: Because classification is best-effort — a failure leaves the row at `type='todo'`, which is a fine default. Blocking the user-facing path on best-effort work is the wrong trade. The editor commit is the canonical write (prose to SQLite); making it depend on a network round-trip means a flaky network blocks the user from saving their journal. The async pattern decouples the canonical write from the AI annotation, and that's exactly what the principle "prose-canonical, AI is best-effort" demands. The user sees the row as `type='todo'` for some milliseconds, then the badge upgrades when `CLASSIFY_PROGRESS_EVENT` fires.

[arch] Q: At higher volume — say 100 ambiguous todos in one entry — would the unbounded fire-and-forget pattern still work?
       A: Probably not. Today the codebase doesn't cap classify concurrency (one async call per `null` heuristic), and the per-entry count is implicitly bounded by entry size. At 100 todos the user is briefly hammering the API and would hit rate limits — likely 429s, which `scheduleClassify` would silently swallow. I'd add a concurrency cap (`MAX_CONCURRENT` similar to `expand.ts:25`) and probably a per-entry queue. The pattern stays the same; the bounding becomes explicit rather than implicit.

### The question candidates always dodge
Q: Your error path is "log a warning and move on." A user with a flaky network could have their entire `/todos` screen showing `type='todo'` forever and you'd never alert them. Isn't that just hiding bugs?

A: Yes, and that's a deliberate trade I make for this app. Single user, sporadic use, AI is annotation not canonical data — the cost of a false alarm ("AI failed!" toast every time the train goes through a tunnel) is higher than the cost of silent under-annotation. The mitigation is that `getClassifyInFlight()` exists and the `/todos` banner shows "X classifying…", so a user paying attention sees the count fail to drop. In a multi-user product or one where AI annotation was load-bearing, I'd add explicit error surfacing — a row badge "classify failed, tap to retry", a per-day error count, a settings-panel diagnostic. Today neither cost-benefit calculation flips. The principle is: silent best-effort is fine when AI is best-effort; it stops being fine when AI is canonical. None of loopd's AI is canonical.

### One-line anchors
- "Don't block the user-facing path on best-effort work."
- "Failures are eventually-consistent — next reconcile re-fires."
- "`type='todo'` is a fine default while we wait."
- "Silent best-effort is fine when AI is best-effort. It stops being fine when AI is canonical."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain async background classification to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/reconcileMeta.ts:scheduleClassify`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user commits an entry with 12 new todos. 5 hit the heuristic (return `'todo'`). 7 return `null` and need the LLM. Walk what happens between t=0 (commit fires) and t=2s: which calls return synchronously, which fire async, what does the user see in the editor at each timestamp, and what role does `CLASSIFY_PROGRESS_EVENT` play? If 3 of the 7 LLM calls fail with a network error, what's the visible difference?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/reconcileMeta.ts` L48–L92 and `src/services/todos/classify.ts` L90–L120 to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/reconcileMeta.ts:scheduleClassify` (the fire-and-forget pattern) to support what exists
→ Point to `src/services/todos/expand.ts:25` (`MAX_CONCURRENT = 3`) as the existing example of a concurrency cap that classify *doesn't* have if you chose the alternative

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.
