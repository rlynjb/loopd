# The buffr runtime map — Hermes + native modules
## Industry name(s): JS runtime, RN bridge, Hermes · Type: Foundational

> The app runs in one OS process. JavaScript runs on Hermes' single event-loop thread. I/O happens on native threads via Expo modules. The mental model is "one JS thread + magic async I/O."

## Zoom out, then zoom in

```
  THE STACK

  Android OS
   │
   ├─ ART runtime + RN bridge
   │   │
   │   ├─ Hermes JS engine (one thread)
   │   │   ─ React Native components
   │   │   ─ buffr application code
   │   │
   │   ├─ native modules (off-thread)
   │   │   ─ expo-sqlite-next
   │   │   ─ networking
   │   │   ─ image / camera
```

Zoom in: the JS thread is the only thread buffr's code runs on. Every `await fetch(...)` returns a Promise; the actual HTTP I/O happens on a native worker; the JS thread is free for other tasks until the Promise resolves.

## Structure pass

```
  layers   ─ OS ─ runtime ─ JS engine ─ application
  axes     ─ JS vs native
             ─ sync vs async
  seams    ─ JS ←→ native bridge : asynchronous
             ─ native ←→ OS      : synchronous
```

## How it works

### Move 1 — one JS thread

```
  buffr.app code never spawns a worker. there is no Worker, no
  setTimeout-on-background-thread, no parallel JS execution.
```

### Move 2 — native threads do the heavy lifting

```
  SQLite reads: handled on a native thread, returned via JSI.
  HTTP fetch: native thread, Promise resolves on JS.
  image decode: native thread.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ on RN+Hermes, your concurrency model is "one     │
   │ event loop; await everything." race conditions   │
   │ are between async tasks, not threads.            │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   one JS thread; many native threads

   ┌── Hermes (one thread) ───────────────────┐
   │                                           │
   │   React render        sync orchestrator   │
   │   chain compose       reconcile           │
   │                                           │
   │   awaits Promises whose work runs:        │
   │   ┌──── native thread pool ──────────┐    │
   │   │ SQLite IO  │ HTTP  │ image enc  │    │
   │   └─────────────────────────────────┘    │
   └──────────────────────────────────────────┘
```

## Implementation in codebase

The runtime is whatever Expo SDK ships. Verify in `package.json`:

```json
{
  "dependencies": {
    "expo": "...",
    "react-native": "...",
    "react": "...",
    "expo-sqlite-next": "..."
  }
}
```

No worker spawning anywhere in `src/`.

## Elaborate

The "one JS thread + native I/O" model is the foundation. It means:

- buffr cannot CPU-bound block the UI without freezing everything.
- buffr's only concurrency primitive is `Promise.all` / `Promise.race`.
- shared state across tasks needs no locks (no parallel JS execution); needs only async-correctness discipline.

## Interview defense

**Q [mid]:** How many threads does buffr's code run on?

**A:** One — the JS thread. Native modules use additional threads under the hood, but the app code never sees them.

**Q [senior]:** What's the consequence?

**A:** No race conditions in the traditional sense. No mutexes. But still real bugs: async sequencing errors, double-fires, missed cancellation. Different shape of concurrency bugs.

## Validate

### Level 1 — sketch the JS-thread + native-pool model.

### Level 2 — explain why locks aren't needed.

### Level 3 — apply: a CPU-heavy task (e.g., on-device ML inference). What changes? Needs to move off-thread via a native module or be split into chunks with `setImmediate`-like yields.

### Level 4 — defend: "Use a Worker for sync." Not worth it; sync is I/O-bound, not CPU-bound.

## See also

- `02-processes-threads-and-tasks.md`
- `03-event-loop-and-async-io.md`
- `../study-system-design/00-overview.md`
