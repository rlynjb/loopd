# Debounced push trigger

**Industry name(s):** Debouncing, write coalescing
**Type:** Industry standard · Language-agnostic

> Every write site calls `schedulePush()`. The timer resets on every call. Five seconds after the last call fires, `pushAll()` runs.

**See also:** → [01-local-first-request-flow](./01-local-first-request-flow.md) · → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md)

---

## Why care

Type fast into the search box on any production app — Google, Linear, Algolia's docs. The autocomplete doesn't fire a request on every keystroke; it waits until you've stopped typing for ~300ms and then fires one request with the final query. Lodash's `_.debounce` ships this primitive; React Query exposes it via `useDebouncedCallback`; React 18's `useDeferredValue` is a related shape. Without the debounce, every keystroke costs a round-trip; with it, a 50-character search produces one round-trip instead of fifty. Same work; fewer trips; same final state.

The question debouncing answers is one any system with bursty input has to answer: when a single user action produces dozens of small events that all want to trigger the same expensive work, how do you collapse them into one fire without losing any of the input? Not "skip every other event" — that drops state. The answer is *debouncing*: every new event resets a timer; the work runs once when the timer expires after a quiet window.

**What depends on getting this right:** whether the cloud sync layer sends one HTTPS upsert per typing burst or one per keystroke, and whether a write that hit SQLite at t=4.9s gets shipped or lost on app kill at t=5s. In this codebase every synced write in `database.ts` calls `schedulePush()` (`src/services/sync/schedulePush.ts` L14–L21). The body is one line of state plus one setTimeout: `clearTimeout(timer); timer = setTimeout(fire, PUSH_DEBOUNCE_MS)` where `PUSH_DEBOUNCE_MS = 5_000`. When `fire()` finally runs, it checks an in-flight `pushing` boolean — if a previous push is still uploading, it re-arms instead of racing — and then calls `pushAll()` to walk the 10-table `SyncableTable` registry. The local write is always synchronous; only the cloud publish gets batched.

Without debounce (push on every write):
- User types `[] call mom write spec book dentist` — 30 characters, 30 autosaves
- 30 HTTPS upserts fire, one per keystroke
- Cellular data and battery burn; Supabase rate limits trip after a sustained burst
- Final state is identical to one upsert at the end

With debounce (5s quiet window):
- Same 30 keystrokes; 30 SQLite writes; 30 calls to `schedulePush()` each resetting the timer
- 5s after the last keystroke, `fire()` runs `pushAll()` once
- One HTTPS upsert carries the final state
- App kill at t=4.9s: the writes are still in SQLite; the next launch's `pushAll()` picks them up via the dirty filter

Debounce once, after the burst is over — same shape as `_.debounce` on a production search box.

---

## How it works

Lodash's `_.debounce(fn, 5000)` is the canonical pattern. Every call to the debounced function resets a timer; the inner function fires only after the timer has been quiet for the configured window. React Query's `useDebouncedCallback` ships the same primitive for client-side handlers; the Gmail autosave that batches keystrokes runs on the same shape. loopd's `schedulePush()` is this pattern applied to cloud sync — every `database.ts` write resets a 5-second timer; `pushAll()` fires once after the burst is over. That's the whole strategy: turn a stream of small events into one batched fire at the end of the quiet window.

### `schedulePush()` — the debounce trigger

Every synced write in `database.ts` calls `schedulePush()`. The body is one line of state plus one setTimeout: `if (timer) clearTimeout(timer); timer = setTimeout(fire, PUSH_DEBOUNCE_MS)`. If you're coming from frontend, you've debounced search inputs with `lodash.debounce` or with a cleanup function in `useEffect` — same exact pattern here, except the work being deferred is a network upsert instead of a re-render, and the input source is `database.ts` writes instead of an `<input onChange>`. Concrete consequence: if the user types `[] call mom` at t=0, `[] write spec` at t=2s, then backgrounds the app at t=3s, both writes hit SQLite synchronously (the row is canonical the moment it lands), the timer was reset at t=2s, and `fire()` is scheduled for t=7s. At t=3s the cloud is still empty; at t=7s the push runs. Boundary: the debounce window assumes typing comes in bursts shorter than 5s; if the user types one keystroke every 6 seconds, every keystroke triggers its own push. That's fine — it's the wrong scenario for debounce, but the wrong scenario costs no more than no-debounce would.

### `fire()` — the timer callback that respects in-flight pushes

When the timer expires, `fire()` checks a single boolean: `pushing`. If a push is already in flight (e.g. the previous burst's push is still upserting to Supabase), `fire()` calls `schedulePush()` again instead of starting a second push. Think of it like React's `flushSync` being declined when you're already inside a render — the framework doesn't queue a parallel render; it makes you wait. Concrete consequence: if a push that started at t=7s is still uploading at t=12s (slow network, big batch), and another write at t=10s scheduled a second fire for t=15s, the t=15s `fire()` sees `pushing = true` and re-arms for t=20s. The in-flight push is never clobbered; the new writes never get lost (they're already in SQLite and will be `updated_at > synced_at` on the next pass). Boundary: this is single-process — two parallel `pushAll()` calls would race on `synced_at`. The re-arm guard prevents that.

### `pushAll()` — the orchestrator over the SyncableTable registry

`fire()` calls `pushAll()`, which walks a registry of `SyncableTable` entries (10 entries: `entries`, `projects`, `vlogs`, `day_meta`, `ai_summaries`, `nutrition`, `habits`, `todo_meta`, `threads`, `thread_mentions`) and calls `pushTable()` for each. `pushTable()` selects dirty rows (`updated_at > synced_at`), upserts them to Supabase, and stamps `synced_at = now()` on success. If you've ever written a Redux saga that walks an array of action creators in sequence, this is the same shape — the registry is the array, the `pushTable()` call is the work. The orchestration is sequential per table because Supabase is the bottleneck, not the local query — running 10 tables in parallel would only thrash the same HTTPS pipe. Concrete consequence: if 8 of the 10 tables are clean (no dirty rows), they return in microseconds; the actual work is concentrated on the 1–2 tables that received writes during the burst. Boundary: this scales linearly with table count and per-table dirty row count; the burst-batching means it scales with *bursts* not *keystrokes*, which is the load profile the user actually produces.

### The 5-second tuning knob

`PUSH_DEBOUNCE_MS = 5_000` lives at `src/services/sync/schedulePush.ts` L9 — it's the only parameter the whole pattern exposes. Shorter feels chattier (more round-trips per typing burst, more battery and data on cellular); longer means a longer "is my last write in the cloud?" window after the user stops typing. 5s is the empirical sweet spot for journaling cadence (people type a sentence, pause, type the next sentence; a 5s gap reliably signals end-of-burst). Concrete consequence: an app kill at t=4.9s loses the cloud copy of the most recent burst (still in SQLite, picked up on next launch's `pushAll()`); an app kill at t=5.1s loses nothing. Boundary: if a second device starts polling, the freshness lag becomes visible — 5s is too long for "I edited on my phone and opened my tablet immediately." The day a second device joins is the day this number drops to 1s (or per-write).

This is what people mean by "write-behind cache": make the user's writes synchronous on the device, defer the publish-to-the-world step, batch the bursts. The kernel's page cache does it. Database group commit does it. Log-structured merge trees do it. Every collaborative editor that "feels responsive" does it. The full picture is below.

---

## Debounced push — diagram

```
  ┌─ UI / write sites ──────────────────────┐
  │  user keystroke ──┐                     │
  │  user keystroke ──┤                     │
  │  user keystroke ──┼──▶ schedulePush()   │
  │  user keystroke ──┘                     │
  └─────────────────────┬───────────────────┘
                        │
                        ▼
  ┌─ Service layer (sync) ──────────────────┐
  │  clearTimeout(timer)                    │
  │  timer = setTimeout(fire, 5000)         │
  │                  │                      │
  │                  │ 5s of no calls       │
  │                  ▼                      │
  │  fire():                                │
  │    if pushing: schedulePush()  ← re-queue│
  │    else:        pushAll()               │
  └─────────────────────┬───────────────────┘
                        │
                        ▼
  ┌─ Network / Provider ────────────────────┐
  │  pushAll() → per-table upserts to       │
  │  Supabase Postgres                      │
  └─────────────────────────────────────────┘
```

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

We traded "every write hits the network" for "the network only sees the settled state of a burst." The cost is a 5-second window where a write is durable locally but not yet replicated to cloud — survivable because local SQLite is the canonical store, not the cloud.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (5s debounce)     │ Alternative (push per write) │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Network calls    │ ~1 push per typing burst     │ ~60 pushes per typing burst  │
│ during typing    │ (~10–30 s of writes)         │ (one per keystroke autosave) │
│ Push duration    │ batched 50/row upserts —     │ 60× ~100 ms rtt each =       │
│                  │ ~200 ms total                │ 6 s of network activity      │
│ Money (network)  │ trivial — Supabase free tier │ trivial in $, but ratelimits │
│                  │ at journaling cadence        │ kick in on burst             │
│ Battery cost     │ one radio wake per burst     │ radio held active per char   │
│ App-kill risk    │ up to 5 s of cloud-lagged    │ ~ms of risk per keystroke    │
│                  │ writes if OS kills mid-window│ — narrower window            │
│ Code surface     │ +schedulePush.ts (~25 LOC) + │ no central scheduler — each  │
│                  │ a call in every write fn     │ write does its own push      │
│ Server load      │ tens of writes per minute    │ hundreds per minute mid-     │
│                  │                              │ burst → wasted ratelimit     │
│ Recovery on kill │ boot-time pushAll() catches  │ same boot-time path needed   │
│                  │ what missed last session     │ anyway — but rarely fires    │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

There's a window between a write hitting SQLite and that write reaching Supabase. In the steady state it's ~5 seconds (the debounce); under app kill it can stretch until the next cold start fires the boot-time `pushAll()`. For solo journaling the canonical store is local SQLite, so "in SQLite but not in cloud" is the same as "saved" from the user's standpoint — but it does mean a freshly-killed device can be ahead of cloud for hours if the user doesn't relaunch.

Sustained slow networks are tolerated by the `if (pushing) schedulePush()` re-arm guard, but the dirty set grows unboundedly if `pushAll()` consistently runs longer than 5 seconds. We've never observed this in journaling — typing bursts are short and `pushAll()` runs in ~200 ms — but at the limit the design produces an ever-growing tail of unsynced rows.

The 5-second number is a configuration: shorter feels chattier, longer means more kill-window exposure. The empirical sweet spot for journaling cadence may not transfer to a different write pattern (rapid form filling, multi-line paste). Anyone forking this code for a non-journaling app would need to re-tune.

### What the alternative would have cost

If every keystroke pushed immediately, a 60-character typing burst would mean 60 Supabase upserts over ~6 seconds of network activity, holding the radio active and burning battery roughly 50× harder than the debounced version. Money-wise both options are free at journaling cadence; the cost is in latency and ratelimits — Supabase's free-tier ratelimit would kick in mid-burst, dropping writes silently. We'd then need a retry queue to re-send them, which is a worse version of the dirty-set query we already have.

The code-surface saving from "no debouncer" is small — ~25 LOC of `schedulePush.ts` would disappear, but each write function in `database.ts` would gain an explicit push call (already a present "rule" in the codebase, just now with no batching). Net: no real code savings, plus 50× the round-trips.

### The breakpoint

Fine until the write pattern changes. If loopd starts shipping a feature that produces sustained writes for minutes (e.g., live transcription writing one row per token), the dirty set grows faster than the debounce can clear it, and the `if (pushing) schedulePush()` re-arm guard becomes a queue-grower rather than a tolerance mechanism. The fix is parallel per-table pushes (`Promise.all` over the registry) plus larger batch sizes (50 → 500), which is roughly a day of work — not done because journaling never gets there.

### What wasn't actually a tradeoff

A "push on screen blur" / "push on background" approach was not on the table. The OS doesn't guarantee a background hook on app kill — Android can kill the process without notice. Relying on a lifecycle event to push would mean ~100% of OS-kill scenarios end with cloud-lagged data, which is much worse than the 5-second worst case we have today. The boot-time `pushAll()` is the correct fallback because cold start is the only event the OS guarantees.

---

## Tech reference (industry pairing)

### Native `setTimeout` / `clearTimeout`

- **Codebase uses:** JavaScript `setTimeout` / `clearTimeout` directly in `src/services/sync/schedulePush.ts` (L14–L21) — no debounce library, no scheduler abstraction.
- **Why it's here:** the debounce is a single timer reset on every write; bringing in a library would add a wrapper around two native APIs that already do exactly what's needed.
- **Leading today:** native timer APIs — `adoption-leading` for single-key debounce, 2026.
- **Why it leads:** zero dependency cost; behaviour is the JS runtime spec, not a library version; the timer reset pattern is one line.
- **Runner-up:** `lodash.debounce` — `adoption-leading` for multi-key debounce or trailing+leading edge customization; RxJS `debounceTime` — `innovation-leading` when the same flow needs throttling/filtering composed with debouncing.

### `@supabase/supabase-js` + Supabase Postgres

- **Codebase uses:** `@supabase/supabase-js` v2 invoked from `src/services/sync/orchestrator.ts → pushAll()` (L38–L60), which walks the 10-table `REGISTRY` and upserts dirty rows per table.
- **Why it's here:** the eventual destination of every debounced burst — Postgres is the durable mirror that survives device loss; the debounce determines *when* writes land, this determines *where*.
- **Leading today:** Supabase — `adoption-leading` for Postgres-as-a-service, 2026.
- **Why it leads:** managed Postgres + auth + RLS + Storage in one console; SDK mirrors PostgREST, so an upsert with `onConflict` is one call.
- **Runner-up:** Neon + Drizzle — `innovation-leading` typed SQL with branch-per-PR; Convex is the reactive-first alternative when the eventual mirror should fan out to subscribed clients.

---

## Summary

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

```
[backs-out-within-5s timeline]

  T+0  user types "[]"  → keystroke → SQLite write (sync)
                       → schedulePush() arms timer @ T+5

  T+1  user navigates away (screen-blur)
                       → no push hook on blur
                       → timer still pending

  T+5  fire() → pushAll() runs → upsert to Supabase
       (regardless of whether the user is still on screen)

  if OS kills the app between T+1 and T+5:
        SQLite write survives; cloud is behind by 1 burst
        → next cold start runs boot-time pushAll() → catches up
```

[senior] Q: Why 5 seconds and not 1 second? You'd lose less on app kill.

A: 1 second was the first thing I tried. The problem is journaling cadence: a user typing a thought pauses every couple of seconds to think, and a 1s debounce would fire mid-pause, then again at the end of the burst — two pushes per thought instead of one. 5 seconds is empirically the smallest interval that captures a typical sentence as one batch. The cost is up to 5 seconds of "in SQLite but not in cloud" exposure on app kill, but the local writes survive that — only the cloud-mirror lags. If I had a use case where the kill-window mattered (e.g., user starts a write on phone, expects it on tablet within seconds), I'd reduce to 2s and accept the doubled push count.

```
                  Path taken (5s debounce)              Alternative (1s debounce)
                  ──────────────────────────────        ──────────────────────────────
batches a sentence yes — typical pauses ~2s             no — fires inside the pause,
                                                         then again at sentence end
pushes per thought ~1                                    ~2
kill-window risk  up to 5s of cloud-lagged writes       up to 1s of cloud-lagged writes
cross-device fresh ~5–10 s after burst ends             ~1–6 s after burst ends
network calls/min ~10–20 at peak typing                 ~30–60 at peak typing
                                                         (still saved vs per-keystroke)
right answer when journaling: long, paused              quick-form: rapid, no pauses
                                                         (e.g., chat input, payments)
trigger to retune cross-device sync becomes load-       form-style features ship in app
                  bearing                               (different write cadence)
```

[arch] Q: What if the network is so slow that `pushAll()` takes longer than 5 seconds — what happens to writes that arrive during the push?

A: `fire()` checks `if (pushing) schedulePush()` — it re-arms the timer instead of starting a second push. New writes during the in-flight push update local SQLite normally, bumping `updated_at` past `synced_at`. When the in-flight push completes, the next `schedulePush()` arms the timer again, and 5s after the next quiet write, `pushAll()` picks up the still-dirty rows via `WHERE updated_at > synced_at`. The design tolerates slow networks; it just means the catch-up takes another debounce cycle. The case where it actually fails is sustained writes faster than `pushAll()` can complete — the dirty set grows unboundedly. In practice, journaling never gets there; if it did, the fix is parallel per-table pushes or larger batch sizes.

```
At sustained writes faster than pushAll() can complete:

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — autosave to SQLite is sync       │
  └─────────────────────────────────────────────┘
              │
  ┌─ schedulePush() re-arm guard ───────────────┐
  │ becomes a queue-grower not a tolerance gate │  ◀── BREAKS FIRST
  │ each completed push triggers re-arm; new    │     (dirty set grows unboundedly
  │ writes during push pile on next dirty set    │      because produce-rate > drain-rate)
  └─────────────────────────────────────────────┘
              │
  ┌─ pushAll() sequential per-table loop ───────┐
  │ Supabase rtt × N tables × ceil(dirty/50) =  │
  │ throughput ceiling                           │
  │ fix: Promise.all per table + batch size 500 │
  └─────────────────────────────────────────────┘
              │
  ┌─ Network / Supabase ratelimit ──────────────┐
  │ free tier kicks in at sustained high rate    │
  │ silently drops requests; needs explicit     │
  │ retry-on-429                                 │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Your debounce is 5 seconds and you've shipped this. What's the data-loss case you haven't tested?

A: The case I haven't end-to-end tested is "user types in airplane mode for an hour, then the OS kills the app while it's still backgrounded." Locally, the data is fine — every keystroke went to SQLite synchronously. But on next launch, `app/_layout.tsx` runs the boot-time `pushAll()`, which only succeeds if the network has come back — if the user's still in airplane mode on next launch, the push silently fails and the next debounce cycle hits when network returns. I haven't reproduced this end-to-end with `adb` because the device is my actual phone and I don't want to risk my own journal data. The mitigation I've actually tested is the smaller version: 5-second window kill via the OS task switcher, where local data survived. The real test I owe this design is the multi-day-offline case, and it's on my list.

```
                  Path taken (boot-time catch-up)       Suggested (proactive flush on bg)
                  ──────────────────────────────        ──────────────────────────────────
when push fires   timer expiry OR cold-start            timer expiry OR backgrounded event
                                                          OR cold-start
OS-kill window    up to 5s (debounce) per session       theoretical 0s — BUT Android may
                                                          kill before the bg handler runs
guarantee level   cold start IS guaranteed by OS        bg hook is best-effort, not guaranteed
network needed?   yes on next launch                    yes on bg — same problem moved earlier
when local data   never — local writes synchronous      same — local is canonical regardless
is at risk
test coverage     covered by 5s-OS-kill test            requires multi-day-offline test
                                                          (real risk, real device, owed)
honest gap        boot-time push silently fails if      bg hook + boot-time both silently
                  airplane mode persists on relaunch    fail when offline persists
mitigation we add no automatic retry — depends on       same — no automatic retry either way
                  user reopening app online
```

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

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram; added architectural-layer labels to the primary diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 + v1.23.0 pass: inserted `## Tech reference (industry pairing)` section between Tradeoffs and Summary with `###` per tech + five labelled bullets each.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (mental-model opening / layered walkthrough with frontend bridges / principle paragraph); each move-2 sub-section now carries its technical term, frontend bridge, concrete consequence, and boundary condition.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (busy-cafe waiter-clearing-once scenario → debounce named as the answer → bolded "what depends on getting this right" with schedulePush/PUSH_DEBOUNCE_MS stakes → before/after walking a 30-keystroke typing burst → one-line "the waiter clears once, after the burst is over").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced waiter-at-cafe-clearing-table analogies with search-box autocomplete debouncing + Lodash _.debounce + React Query useDebouncedCallback + Gmail autosave). Both Move 1s were missed by the original triage agent.
