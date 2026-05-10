# Debounced push trigger

**Industry name(s):** Debouncing, write coalescing
**Type:** Industry standard · Language-agnostic

> Every write site calls `schedulePush()`. The timer resets on every call. Five seconds after the last call fires, `pushAll()` runs.

**See also:** → [01-local-first-request-flow](./01-local-first-request-flow.md) · → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md)

---

## Why care

You've wired up a "save on every keystroke" autosave and watched your network tab fill up with one request per character. The user is typing fast, you're firing eighty requests in ten seconds, and the server is doing the same work eighty times to settle on a final state that one request could have produced. The naive fix is to save less often; the real fix is to save once at the end of the burst.

Debouncing collapses a stream of rapid events into a single fire at the end of a quiet window. It belongs to the family of "write coalescing" patterns, alongside the kernel's page-cache flush, database group commit, and the way log-structured merge trees batch writes before pushing to disk. You've also seen it in autocomplete UIs that wait for the user to stop typing before hitting the search API, in resize handlers, and in any pub/sub system that batches events before fan-out. The diagram below shows how it composes in this codebase.

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

**Debouncer:**       `src/services/sync/schedulePush.ts` → `schedulePush()` L14–L21 (`PUSH_DEBOUNCE_MS = 5_000` at L9, internal `fire()` L22+)
**Caller pattern:**  Every synced-table mutator in `src/services/database.ts` ends with `schedulePush()` — that's the rule. The 1387-line file has dozens of write functions; each one bumps `updated_at` and arms the timer.
**Timer target:**    `src/services/sync/orchestrator.ts` → `pushAll()` L38–L60 (called from `fire()` when no push is in flight)
**Boot catch-up:**   `app/_layout.tsx` kicks `pushAll()` once on cold start so writes that didn't make it to cloud last session catch up

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

## Quick summary

Debouncing collapses a stream of rapid events into a single fire at the end of a quiet window, decoupling the rate at which writes are produced from the rate at which they hit the network. In this codebase `schedulePush()` in `src/services/sync/schedulePush.ts` (re)arms a 5-second timer on every synced write in `src/services/database.ts`, and after 5s of write quiet `fire()` either kicks off `pushAll()` or re-arms if a push is already in flight. Typing fires hundreds of writes per minute via autosave-per-keystroke, so the constraint was "local sees the firehose, network sees the trickle" — pushing each write would melt the connection. The cost is up to 5 seconds of "in SQLite but not yet in cloud" exposure if the app is killed mid-window, which is acceptable because local SQLite is canonical and the boot-time `pushAll()` in `app/_layout.tsx` catches up on next launch.

Key points to remember:
- Every synced-table mutator in `database.ts` ends with `schedulePush()`; the timer resets on every call and only fires after 5 seconds of write quiet.
- `fire()` re-arms via `schedulePush()` if a push is already in flight — that's what makes slow networks tolerable without clobbering in-flight work.
- Lives in step 2 (Request flow) and step 3 (Caching) of the system-design checklist.
- Boot-time `pushAll()` in `app/_layout.tsx` is the safety net that catches writes orphaned by an app kill inside the 5s window.
- 5 seconds is empirical, not sacred — shorter feels chattier, longer means more risk on app kill; this is the smallest interval that batches a typing burst as one push.

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

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the debounced push trigger to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/sync/schedulePush.ts:schedulePush`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user types in a journaling burst — 60 keystrokes spread over 6 seconds, with one 2-second pause in the middle. Then they background the app. How many times does the timer arm? How many times does it actually fire? What's the state of the in-memory `timer` variable when the app gets backgrounded mid-window? On cold start, what catches up the unfired window?

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/schedulePush.ts` L14–L21 (and `app/_layout.tsx` for the boot kick) to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/sync/schedulePush.ts` (the 5s constant) to support what exists
→ Point to a per-write push (no debounce) at `src/services/database.ts` mutators if you chose the alternative

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
