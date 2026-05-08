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

---

## Interview defense

### What an interviewer is really asking
A 5-second debounce is a number that begs the question "why 5?". The interviewer wants to know whether you picked it deliberately, what the tradeoff is, and whether you understand that debouncing is a write-rate problem, not just a "feels nicer" problem.

### Likely questions

[mid] Q: The user types `[]` then immediately backs out of the screen. Does the push happen?

A: It depends on whether the screen-blur fires within 5 seconds. The keystroke fires `schedulePush()` which arms the 5s timer. If the user backs out within 5s, the timer hasn't fired yet — but `pushAll()` doesn't run on screen-blur, only on the timer. So the push is delayed by the remainder of the 5s window. The data is safe locally because the SQLite write was synchronous; only the cloud-mirror is delayed. If the app is backgrounded long enough that Android kills it, the push catches up on next app launch via the boot-time `pushAll()` in `app/_layout.tsx`.

[senior] Q: Why 5 seconds and not 1 second? You'd lose less on app kill.

A: 1 second was the first thing I tried. The problem is journaling cadence: a user typing a thought pauses every couple of seconds to think, and a 1s debounce would fire mid-pause, then again at the end of the burst — two pushes per thought instead of one. 5 seconds is empirically the smallest interval that captures a typical sentence as one batch. The cost is up to 5 seconds of "in SQLite but not in cloud" exposure on app kill, but the local writes survive that — only the cloud-mirror lags. If I had a use case where the kill-window mattered (e.g., user starts a write on phone, expects it on tablet within seconds), I'd reduce to 2s and accept the doubled push count.

[arch] Q: What if the network is so slow that `pushAll()` takes longer than 5 seconds — what happens to writes that arrive during the push?

A: `fire()` checks `if (pushing) schedulePush()` — it re-arms the timer instead of starting a second push. New writes during the in-flight push update local SQLite normally, bumping `updated_at` past `synced_at`. When the in-flight push completes, the next `schedulePush()` arms the timer again, and 5s after the next quiet write, `pushAll()` picks up the still-dirty rows via `WHERE updated_at > synced_at`. The design tolerates slow networks; it just means the catch-up takes another debounce cycle. The case where it actually fails is sustained writes faster than `pushAll()` can complete — the dirty set grows unboundedly. In practice, journaling never gets there; if it did, the fix is parallel per-table pushes or larger batch sizes.

### The question candidates always dodge
Q: Your debounce is 5 seconds and you've shipped this. What's the data-loss case you haven't tested?

A: The case I haven't end-to-end tested is "user types in airplane mode for an hour, then the OS kills the app while it's still backgrounded." Locally, the data is fine — every keystroke went to SQLite synchronously. But on next launch, `app/_layout.tsx` runs the boot-time `pushAll()`, which only succeeds if the network has come back — if the user's still in airplane mode on next launch, the push silently fails and the next debounce cycle hits when network returns. I haven't reproduced this end-to-end with `adb` because the device is my actual phone and I don't want to risk my own journal data. The mitigation I've actually tested is the smaller version: 5-second window kill via the OS task switcher, where local data survived. The real test I owe this design is the multi-day-offline case, and it's on my list.

### One-line anchors
- "Debouncing decouples write rate from network rate — local sees the firehose, network sees the trickle."
- "5 seconds is empirical, not sacred — it's the smallest window that batches a typing burst as one push."
- "The `if (pushing) schedulePush()` re-arm is what makes slow networks tolerable; without it, the in-flight push would be clobbered."
- "Boot-time `pushAll()` is the safety net — anything missed by app kill catches up on next launch."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
