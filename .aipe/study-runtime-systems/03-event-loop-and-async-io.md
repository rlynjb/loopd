# The event loop and async I/O — the most important model in buffr
## Industry name(s): event loop, microtask queue, async I/O · Type: Foundational

> Hermes runs a standard JS event loop: macrotasks (setTimeout, I/O callbacks) and microtasks (resolved Promises). The loop is single-threaded; every `await` is a yield. Buffr's whole runtime correctness rests on this model.

## Zoom out, then zoom in

```
  THE LOOP

  while (true) {
    take a macrotask;   ← e.g., setTimeout fire, fetch resolve
    run to completion;
    drain microtasks;   ← all Promises resolved during macrotask
    render if needed;
  }
```

Zoom in: a Promise that resolves during a macrotask runs its `.then` chain immediately after the macrotask finishes (in the microtask drain). Subsequent macrotasks have to wait their turn. This is what makes async code feel "right next" and "not right next" depending on the kind of yield.

## Structure pass

```
  layers   ─ macrotask queue ─ microtask queue ─ render
  axes     ─ priority (microtask > macrotask)
             ─ blocking (each task runs to completion)
  seams    ─ await ←→ microtask : continuation after Promise resolves
```

## How it works

### Move 1 — await yields to the microtask queue

```
  async function f() {
    const x = await fetchSomething();  // yields here
    doMore(x);                          // resumes after Promise resolves
  }
  
  the resume happens during the next microtask drain.
```

### Move 2 — long synchronous chunks block everything

```
  if doMore(x) runs for 50ms without await, the UI is frozen 50ms.
  break it up: chunk with `await new Promise(r => setTimeout(r,0))`.
```

### Move 3 — the principle: yield often when on the UI path

```
   ┌──────────────────────────────────────────────────┐
   │ in a single-threaded async runtime, fairness is  │
   │ the programmer's responsibility. yield often on  │
   │ the UI thread; never tight-loop without yielding.│
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// sync engine is async-correct; runs after debounce timer fires
function scheduleSync() {
  clearTimeout(timer);
  timer = setTimeout(runSync, 5000);  // 5s debounce
}

async function runSync(ctx) {
  for (const table of tables) {
    await pushTable(table, ctx);  // each is an await; UI breathes between
  }
}
```

The loop's per-table `await` is the yield. Between tables, the UI gets a chance to render.

## Elaborate

The event-loop discipline maps directly to React Native's frame budget. Each frame is ~16ms; the UI render runs as part of the macrotask drain. A 100ms chunk in any task can drop ~6 frames. Buffr's sync engine doesn't have this problem (per-table awaits); the risk would be a CPU-bound chain (e.g., a custom tokenizer) running synchronously.

## Interview defense

**Q [mid]:** What happens when I `await fetch(...)`?

**A:** The function suspends. The current macrotask continues. When the fetch resolves (on a native thread), a microtask is queued; the function resumes during the next microtask drain.

**Q [senior]:** What's the worst event-loop bug you've debugged?

**A:** Tight loops in a chain's input prep — synchronous string processing that could have been native or chunked. Showed up as jank during sync.

## Validate

### Level 1 — sketch the loop with macrotask + microtask.

### Level 2 — explain why await yields.

### Level 3 — apply: a 500-line input that takes 80ms to process. Move to a native module, or chunk in JS with `setImmediate`.

### Level 4 — defend: "Sync engine should fire as a setInterval." Wrong; debounce is event-driven, not periodic.

## See also

- `01-runtime-map.md`
- `02-processes-threads-and-tasks.md`
- `07-backpressure-bounded-work-and-cancellation.md`
