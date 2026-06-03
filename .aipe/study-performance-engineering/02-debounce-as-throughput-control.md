# Debounce as throughput control — coalescing bursts into one cycle
## Industry name(s): debounce, request coalescing, batching · Type: Performance pattern

> The 5s sync debounce turns a burst of dozens of UPDATE statements per second (typing) into one sync cycle every 5s. Removing the debounce would multiply sync push/pull cycles by 100x for active typing periods.

## Zoom out, then zoom in

```
  WITHOUT DEBOUNCE                        WITH DEBOUNCE (5s)

  user types 1 char/100ms                 user types 1 char/100ms
   ─ 10 UPDATEs/s                          ─ 10 UPDATEs/s
   ─ each schedules a sync                 ─ each resets debounce timer
   ─ 10 sync cycles/s                      ─ 1 sync cycle when typing pauses
   ─ network thrashing                     ─ network idle until pause
   ─ battery drain                         ─ battery preserved
```

Zoom in: the debounce isn't "wait 5s then run." It's "wait until 5s of inactivity." A user typing for 30 seconds straight triggers ONE sync cycle, 5s after they stop.

## Structure pass

```
  layers   ─ event ─ debounce ─ batch ─ sync
  axes     ─ event rate vs sync rate
             ─ latency-to-durability tradeoff
  seams    ─ event ←→ debouncer : the rate-limiter
```

## How it works

### Move 1 — debounce coalesces

```
  function scheduleSync() {
    clearTimeout(timer);
    timer = setTimeout(runSync, 5000);  // ★ reset on every call
  }
  
  N calls within 5s window → 1 runSync at the end.
```

### Move 2 — the tradeoff is latency to durability

```
  no debounce:    cloud durability ~100ms post-write (worst battery)
  debounce 5s:    cloud durability ~5s post-write (best battery)
  debounce 60s:   cloud durability ~60s post-write (worst recovery)
  
  5s is the sweet spot for journaling — recovery window is small
  enough that device loss doesn't lose meaningful work.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ debounce turns event rate into sync rate. for    │
   │ buffr this is the throughput control. removing   │
   │ it would 100x sync traffic during typing bursts. │
   │ tuning the window trades latency for battery.    │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   the coalescing effect

   typing burst:    █ █ █ █ █ █ █ █ █ █
   debouncer:       │ │ │ │ │ │ │ │ │ │
                    ▼ ▼ ▼ ▼ ▼ ▼ ▼ ▼ ▼ ▼  resets timer each time
                    ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
                                          
                                          5s of inactivity
                                          ─────────────────►
                                          
   sync runs:                                  ●  (once)
```

## Implementation in codebase

```ts
// pattern; src/services/sync/scheduler.ts
let timer: NodeJS.Timeout | null = null;

export function scheduleSync() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    runSync(ctx).catch(e => console.warn('[buffr sync]', e));
  }, 5000);
}
```

**Line-by-line:**

- `clearTimeout` is the load-bearing call. Without it, sync would run every 5s after first call, regardless of inactivity.
- The `.catch` is necessary because runSync's errors aren't surfaced via the silent-error guard inside; the outer catch logs at least the throw.
- No in-flight guard: if a sync cycle takes > 5s and a new schedule fires, two sync cycles could overlap. Mitigation: add an `inflight` boolean check.

## Elaborate

The debounce pattern generalizes to any "event rate >> work rate" scenario: search-as-you-type, scroll handlers, autosave. The window is always a tradeoff between *responsiveness* (smaller window) and *coalescing benefit* (larger window). 5s is right for journaling; 300ms is right for search; 30s is right for low-importance analytics.

## Interview defense

**Q [mid]:** Why debounce sync?

**A:** Coalescing. The user types fast; we shouldn't sync per-keystroke. Debounce turns 100+ events into 1 sync cycle per pause.

**Q [senior]:** What's the tradeoff?

**A:** Latency to cloud durability. With 5s, the user could lose up to 5s of typing if the device dies. Acceptable for journaling. Unacceptable for banking.

**Q [arch]:** What's the structural risk?

**A:** Two sync cycles overlapping. If runSync takes longer than 5s and new events fire, a second cycle could start. Mitigation: an inflight boolean check at runSync's start.

## Validate

### Level 1 — sketch the coalescing diagram.

### Level 2 — explain the latency/battery tradeoff.

### Level 3 — apply: design autosave for a note app. Smaller window (~500ms) because durability matters.

### Level 4 — defend: "Sync should fire every keystroke for safety." Wrong; 100x cost, 100x battery drain. Local SQLite is already durable.

## See also

- [`audit.md`](./audit.md) — Pass 1's lens 6.
- [`01-cache-shortcircuit-as-cost-ceiling.md`](./01-cache-shortcircuit-as-cost-ceiling.md) — the cost-side analog.
- `../study-system-design/02-debounced-batched-sync.md` — the architecture-side framing.
- `../study-runtime-systems/03-event-loop-and-async-io.md` — the runtime substrate.
