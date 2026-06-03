# WebSockets, SSE, streaming, realtime — what buffr doesn't use yet
## Industry name(s): WebSocket, SSE, long-poll, realtime · Type: Foundational

> Buffr has no realtime channel. Sync is debounce-pull, not server-push. Anthropic's streaming responses are supported by the SDK but buffr uses non-streaming for chains. Supabase Realtime is available but not enabled.

## Zoom out, then zoom in

```
  REALTIME PATTERNS BUFFR COULD USE     STATUS

  ─ WebSocket (Supabase Realtime)        not used
  ─ SSE (some LLM streaming)             not used
  ─ HTTP long-poll                       not used
  ─ Anthropic streaming responses        SDK supports; buffr opts out
```

Zoom in: this is intentional. Realtime adds reconnection logic, idle handling, backoff, and a persistent socket — costs that pay off only when a feature needs server-push. Buffr today doesn't.

## Structure pass

```
  layers   ─ socket lifetime ─ message ordering ─ reconnect
  axes     ─ push vs poll
             ─ persistent vs per-call
```

## How it works

### Move 1 — realtime adds complexity

```
  per-call HTTP:    transient socket; clear failure points
  realtime channel: persistent socket; reconnect logic;
                     replay-from-cursor on reconnect;
                     idle handling; subscription state
```

### Move 2 — pull works for buffr's use case

```
  daily journal; single user; no need for "the other user just typed."
  debounce-pull every few seconds gives "feels fresh enough."
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ realtime is the right call when (a) a second     │
   │ party can change the data, or (b) the user       │
   │ expects sub-second cross-device updates. neither │
   │ applies to buffr today. when it does, switch.    │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

No WebSocket usage anywhere in `src/`. The Supabase client is created without Realtime config:

```ts
const supabase = createClient(URL, KEY, {
  db: { schema: 'buffr' },
  // realtime: { ... } ← not configured
});
```

## Elaborate

The "no realtime" choice is deliberate. The day buffr adds collaborative editing or "another user shared a thread with you," realtime becomes table stakes. Until then, the simpler protocol model is the right call.

## Interview defense

**Q [mid]:** Why no realtime?

**A:** Buffr's use case doesn't require server-push. Debounce-pull every few seconds is plenty for single-user single-stream journaling.

**Q [senior]:** When would you add it?

**A:** When a feature needs sub-second cross-device updates (e.g., collab editing) or when the cloud needs to notify the device (e.g., admin-pushed config). Today neither.

## Validate

### Level 1 — name the realtime options.

### Level 2 — explain why per-call HTTP is simpler.

### Level 3 — apply: design real-time todo sync between two devices. WebSocket via Supabase Realtime.

### Level 4 — defend: "Use realtime for everything." Cost of persistent sockets ≠ free; only pay for it when needed.

## See also

- `01-network-map.md`
- `../study-system-design/02-debounced-batched-sync.md`
- `../study-distributed-systems/06-queues-streams-ordering-and-backpressure.md`
