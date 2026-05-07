# Debounced push trigger

> Every write site calls `schedulePush()`. The timer resets on every call. Five seconds after the last call fires, `pushAll()` runs.

**See also:** → [01-local-first-request-flow](./01-local-first-request-flow.md) · → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md)

---

## Quick summary
- **What:** `schedulePush()` (re)arms a 5-second timer. After 5s of write quiet, `pushAll()` walks the registry and pushes every dirty row.
- **Why here:** typing fires hundreds of writes per minute (autosave per keystroke). Pushing each one would melt the network. Debouncing collapses a typing burst into a single push.
- **Tradeoff:** if the app is killed in the 5-second window, the latest writes never reach cloud — but they're still in local SQLite, and the next session's startup pushes them.

---

## Debounced push — diagram

```
  user keystroke ──┐
  user keystroke ──┤        clearTimeout(timer)
  user keystroke ──┼──▶     timer = setTimeout(fire, 5000)
  user keystroke ──┘                                │
                                                    │ 5s of no calls
                                                    ▼
                                               fire():
                                                 if pushing: schedulePush()  ← re-queue
                                                 else:        pushAll()
```

---

## How it works

`schedulePush()` clears any existing timer and starts a new one. The body is a single line: `if (timer) clearTimeout(timer); timer = setTimeout(fire, 5000);`. The next write within 5s resets it; the timer only fires when there's been a 5-second gap.

When the timer fires, `fire()` checks whether a push is already in flight. If yes, it re-arms (so the in-flight push doesn't get clobbered and the new writes are picked up on the next pass). If no, it kicks off `pushAll()`.

`pushAll()` walks the SyncableTable registry and runs `pushTable()` per table. Any table with no dirty rows returns early. The orchestration is sequential per table — Supabase is the bottleneck, not the local query.

The 5-second value is a tuning knob. Shorter feels chattier (more round-trips per typing burst), longer means more risk of unsaved-to-cloud state on app kill. 5s is the empirical sweet spot for journaling cadence.

---

## In this codebase

- `src/services/sync/schedulePush.ts` → `schedulePush()`, the debouncer.
- Every mutator in `src/services/database.ts` calls `schedulePush()` after a synced-table write.
- `src/services/sync/orchestrator.ts` → `pushAll()` runs from the timer.
- App boot in `app/_layout.tsx` also kicks `pushAll()` once on startup to catch up writes from the previous session.

---

## Elaborate

### Where this pattern comes from
Debouncing originated in mechanical switches (literal bouncing) and got adopted by JS UI code in the 2000s for things like search-as-you-type. Sync engines borrowed it later as the cheap way to coalesce many writes into one network call.

### The deeper principle
**Decouple write rate from network rate.** Whatever rate the user can produce writes, your network can handle a fraction of it. Debouncing lets the local DB take the full firehose while the network sees a manageable trickle.

### Where this breaks down
- Apps where every write must be persisted before the user moves on (forms, payments). Debouncing risks losing the last burst.
- Cases where `pushAll()` itself takes longer than the debounce window. The "if pushing: re-queue" guard handles it but a sustained slow network can leave writes piling up.

### What to explore next
- [Cloud sync as a mirror](./07-cloud-sync-mirror.md) → what `pushAll()` actually does.
- [Bootstrap decision tree](./10-bootstrap-decision-tree.md) → the boot-time push that catches up missed bursts.

---

## Tradeoffs

- **5s debounce** — gives: ~1 push per typing burst. Costs: up-to-5s of "writes only in SQLite" risk on app kill.
- **Re-queue if already pushing** — gives: in-flight push isn't disrupted; new writes still land. Costs: in extreme cases the queue can starve if `pushAll()` always runs longer than 5s.
- **Boot-time `pushAll()`** — gives: catches up anything missed last session. Costs: the first few seconds of cold-start network are spent on push, not pull.
