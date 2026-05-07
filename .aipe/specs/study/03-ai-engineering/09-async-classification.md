# Async background classification — fire and forget

> The prose scan completes synchronously. Each new ambiguous todo fires an LLM call without awaiting it. The result lands later via DB write + event.

**See also:** → [05-heuristic-before-llm](./05-heuristic-before-llm.md) · → [02-dsa/02-reconcile-todo-meta](../02-dsa/02-reconcile-todo-meta.md)

---

## Quick summary
- **What:** `reconcileTodoMetaForEntry` returns synchronously. New ambiguous rows insert with `type='todo'` placeholder and fire `scheduleClassify` async; the LLM result writes back via `updateTodoMeta` + emits `CLASSIFY_PROGRESS_EVENT`.
- **Why here:** keeping `reconcileTodoMetaForEntry` synchronous means the editor's commit doesn't block on the network. A 30-todo entry with 10 ambiguous lines would otherwise wait for 10 LLM round-trips — that's a 3-5 second pause when leaving the editor.
- **Tradeoff:** the user briefly sees `type='todo'` on rows that the classifier later upgrades. The `/todos` screen has a small banner showing "X classifying…" via `getClassifyInFlight()`.

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

---

## In this codebase

- `src/services/todos/reconcileMeta.ts` → fires the async classify.
- `src/services/todos/classify.ts` → `scheduleClassify`, `classifyTodo`, `getClassifyInFlight`, `CLASSIFY_PROGRESS_EVENT`.
- `app/todos.tsx` → subscribes to the event for live badge updates.

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
