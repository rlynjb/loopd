# Processes, threads, and tasks — what buffr has
## Industry name(s): process, thread, task, scheduler · Type: Foundational

> One OS process. One JS thread. Native modules use their own thread pools. The "task" buffr's code reasons about is an async function call — a Promise that resolves later.

## Zoom out, then zoom in

```
  THE HIERARCHY

  process     OS-level container; one per app instance
  thread      OS-level execution unit; many per process (native side)
  task        application-level async unit; many per event loop turn
```

Zoom in: the only level buffr's code controls is `task`. The JS thread and the native pool are managed by RN.

## Structure pass

```
  layers   ─ OS thread ─ JS event loop ─ async task
  axes     ─ scope (process-wide vs task-local)
             ─ controllability (RN-managed vs app-managed)
  seams    ─ task ←→ event loop : scheduling
```

## How it works

### Move 1 — tasks are async functions

```
  every chain call, every sync tick, every render — a task.
  the event loop picks up resolved Promises and runs the next chunk.
  no preemption: each chunk runs to completion before the loop yields.
```

### Move 2 — long-running tasks block the loop

```
  if a chunk runs for 100ms, the UI is frozen for that 100ms.
  rule: keep chunks under one frame budget (~16ms) when on the UI path.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ a "task" in buffr is just an async function.     │
   │ there is no scheduler to invoke, no priority,    │
   │ no preemption. cooperate by awaiting often when  │
   │ doing CPU-bound work; never do CPU-bound work    │
   │ at all if you can offload it natively.           │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

There's no process manager, no thread pool, no task queue in `src/`. The "task" abstraction is implicit in `async function`. Examples:

```ts
// each of these is a task from the runtime's POV
async function runSync(ctx) { /* ... */ }
async function composeProseCommit(entry) { /* ... */ }
async function callClassify(input) { /* ... */ }
```

## Elaborate

The "no explicit task primitives" property is what makes RN code feel small. The cost is that any CPU-bound work (image filtering, heavy parsing) must either be offloaded natively or chunked with `setImmediate` to avoid jank.

## Interview defense

**Q [mid]:** What's a "task" in buffr?

**A:** An async function call. The event loop picks up resolved Promises and runs the next chunk. No preemption; cooperative scheduling.

**Q [senior]:** What if I want to parallelize?

**A:** `Promise.all` for I/O-bound parallelism (the native pool handles concurrency). For CPU-bound parallelism on RN, you'd need a Worker or a native module — not currently in buffr.

## Validate

### Level 1 — define process / thread / task.

### Level 2 — explain why locks aren't needed.

### Level 3 — apply: design a "search all entries by keyword" feature. Synchronous SQLite LIKE query or move to FTS5?

### Level 4 — defend: "Add a worker pool." Over-investment for current work.

## See also

- `01-runtime-map.md`
- `03-event-loop-and-async-io.md`
- `04-shared-state-races-and-synchronization.md`
