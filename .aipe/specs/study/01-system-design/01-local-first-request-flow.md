# Local-first request flow

**Industry name(s):** Local-first architecture, offline-first design
**Type:** Industry standard · Language-agnostic

> Every user action commits to local SQLite first; the cloud lags by 5 seconds via a debounced background push.

**See also:** → [05-soft-delete](./05-soft-delete.md) · → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [09-debounced-push](./09-debounced-push.md)

---

## Why care

You've opened a notes app on the subway, typed a sentence, and watched the cursor lag because the app was busy round-tripping every keystroke to a server it couldn't reach. The lag is the network leaking into the request path. The underlying problem is that the user's writes and the publish-to-the-world step are two different operations, and most apps weld them together.

Local-first architecture splits them apart: writes commit to an on-device store synchronously, and a background process races to mirror them somewhere durable later. It belongs to the family of "decouple availability from durability" patterns, alongside write-behind caches and outbox-style replication. You've seen this in Git (commits are local, push is later), in your OS file system (the page cache acknowledges before the disk does), and in modern collaborative editors that work on a plane. Here's how that actually works in this codebase.

---

## How it works

The UI never talks to Supabase directly. Every write path runs through the hook → service → `database.ts` chain, and the only file that opens `loopd.db` is `database.ts`. That single funnel is what makes "DB is canonical" a hard guarantee instead of a vibe — there's exactly one place to enforce `updated_at` bumps and `schedulePush()` fires.

When a write hits SQLite, the row is immediately visible to the next read. The screen rebuilds from local state; nothing waits on the network. The cloud catches up via a debounced timer that fires `pushAll()` 5 seconds after the last write event.

If the device is offline, the writes pile up locally with `updated_at > synced_at`. On the next session that has network, `pushAll()` selects exactly those dirty rows and upserts them. The full picture is below.

---

## Local-first request flow — diagram

```
┌─ UI layer ──────────────────────────────────────────────┐
│   User taps a button on the Today screen                │
│                │                                        │
│                ▼                                        │
│        ┌────────────────┐                               │
│        │  React screen  │  app/index.tsx (or any app/*) │
│        └───────┬────────┘                               │
│                │  imperative call                       │
│                ▼                                        │
│        ┌────────────────┐                               │
│        │  React hook    │  useEntries.editEntry, etc    │
│        └───────┬────────┘                               │
└────────────────┼────────────────────────────────────────┘
                 │  delegate
                 ▼
┌─ Service layer ─────────────────────────────────────────┐
│        ┌────────────────┐                               │
│        │  Service       │  src/services/<domain>/<verb> │
│        └───────┬────────┘                               │
│                │  SQL via expo-sqlite                   │
│                ▼                                        │
│        ┌────────────────┐                               │
│        │  database.ts   │  ONLY file that opens loopd.db│
│        └───────┬────────┘                               │
│                │   1. write (INSERT / UPDATE)           │
│                │   2. set updated_at = now              │
│                │   3. schedulePush()  ← debounced 5s    │
└────────────────┼────────────────────────────────────────┘
                 ▼
┌─ Storage layer ─────────────────────────────────────────┐
│        ┌────────────────┐                               │
│        │  loopd.db      │  SQLite, WAL, single-process  │
│        └───────┬────────┘                               │
│                │  reads on next tick                    │
│                ▼                                        │
│        UI re-renders (back up to UI layer)              │
└────────────────┬────────────────────────────────────────┘
                 │  (5 seconds later, in the background)
                 ▼
┌─ Network / sync layer ──────────────────────────────────┐
│        ┌────────────────┐                               │
│        │  pushAll()     │  walks SyncableTable registry │
│        └───────┬────────┘                               │
│                │  HTTPS upsert                          │
└────────────────┼────────────────────────────────────────┘
                 ▼
┌─ Provider layer ────────────────────────────────────────┐
│        Supabase Postgres                                │
└─────────────────────────────────────────────────────────┘
```

---

## In this codebase

**SQLite mouth:**     `src/services/database.ts` — the only file that opens `loopd.db`. Every mutator stamps `updated_at` and calls `schedulePush()`. The 1455-line file *is* the funnel — the hard guarantee that "DB is canonical" lives here.
**React wrappers:**   `src/hooks/{useEntries,useDatabase,useHabits,useDayTitle,useExport,useProject}.ts` — thin state hooks that own a query each and delegate mutations into `database.ts`.
**Debouncer:**        `src/services/sync/schedulePush.ts` → `schedulePush()` L14–L21 (5s window via `PUSH_DEBOUNCE_MS = 5_000` at L9, internal `fire()` at L22)
**Orchestrator:**     `src/services/sync/orchestrator.ts` → `pushAll()` L38–L60 — walks the 10-table `REGISTRY` defined at L25

---

## Elaborate

### Where this pattern comes from
"Local-first software" came out of CRDT research and the offline-first PWA wave. The motivating insight is that latency to a remote server is *always* observable, even on fast networks; users notice the 200ms pause on every keystroke. Pushing the request out of the UI's critical path solved that.

### The deeper principle
**The user's writes are sacred and synchronous; everything else is best-effort.** Network is a slow optional layer that races to mirror what's already true on the device. If you separate "write" from "publish," each can fail independently without taking the other down.

### Where this breaks down
- Multi-device live collaboration where two humans edit the same row in real time. LWW (last-write-wins) loses too much for that case — vector clocks or CRDTs become necessary.
- Workflows that require server-side validation before commit (payments, anything regulated). The local commit can't be the truth.

### What to explore next
- [Conflict resolution: last-write-wins](./08-conflict-last-write-wins.md) → how local and cloud reconcile when both diverge.
- [Debounced push trigger](./09-debounced-push.md) → why the 5s window is the right shape.
- [Cloud sync as a mirror](./07-cloud-sync-mirror.md) → the larger picture this flow plugs into.

---

## Tradeoffs

We traded cloud freshness and per-module modularity for a synchronous-write UX and a single enforcement point — the user never waits on the network, and the two cloud-sync invariants (`updated_at` bump + `schedulePush()`) live one helper away in one file.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (local-first +      │ Alternative (cloud-first +     │
│                  │ single database.ts funnel)     │ per-domain DB classes)         │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Perceived UX     │ keystroke → SQLite ~1ms; UI    │ keystroke → HTTPS round-trip   │
│  latency         │ never observes network         │ 80–400ms; visible cursor lag   │
│                  │                                │ on subway / kitchen / bed      │
│ Cloud freshness  │ second device sees writes      │ second device sees writes      │
│                  │ ~5s after typing stops         │ ~200ms after each keystroke    │
│ Complexity       │ 1455-line database.ts +        │ 4 per-domain DB classes +      │
│                  │ 1 schedulePush.ts + 1          │ shared base class for         │
│                  │ orchestrator.ts                │ invariants + network retry per │
│                  │                                │ write site                     │
│ Failure blast    │ network down → writes pile up  │ network down → write fails or  │
│  radius          │ locally, push on next session  │ blocks UI; needs explicit      │
│                  │                                │ offline queue anyway           │
│ Failure mode at  │ LWW silently drops one writer  │ realtime conflicts surface     │
│  2 writers       │ — needs CRDT to fix            │ live but require subscriptions │
│ Hire-ability     │ one long file — easy to grep,  │ conventional layered design —  │
│                  │ surprising in 2026             │ familiar from any web app      │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The cloud lags by 5 seconds after the last write. If the user dies, kills the app, or hard-reboots the device in that 5s window, the row is still in SQLite but Supabase doesn't have it until the next session opens and `pushAll()` walks the registry. The cost is real for a second device — open the dashboard on a tablet right after typing on the phone, and the tablet sees yesterday's state. For solo single-device use, the cost is invisible.

The single `database.ts` is 1455 lines. New contributors open it expecting per-domain files and ask why mutators for habits, threads, todos, entries, and projects all share one source. The answer (the two invariants `updated_at` + `schedulePush()` need exactly one enforcement point, and a base class only adds another layer to the explanation) takes a paragraph in the spec. That's onboarding cost we'd pay every hire.

We gave up reactive multi-device feel. Two devices editing the same row do not see each other live — they exchange via the 5s push + the next-pull cycle. For collaborative editing that's a non-starter; the codebase isn't there because the user isn't there.

### What the alternative would have cost

If we had gone cloud-first with optimistic UI, every keystroke fires HTTPS to Supabase and the UI shows the optimistic state until ack. On a fast connection that's ~80ms; on the train it's 400ms or timeouts. We'd need an offline queue anyway (the user opens the app underground), which is `pushAll()` by another name — so we'd carry both the local-first plumbing AND the optimistic-render plumbing. The 5s debounce is what we got back for not paying that double cost.

If we had split `database.ts` into per-domain classes (`EntriesDB`, `TodosDB`, etc.), the invariants would still need one enforcement point — a base class with an `applyMutation` template method, plus discipline that every subclass goes through it. The same code, but four files and one inheritance hop further from the call site. The 1455 lines don't disappear; they get harder to grep.

### The breakpoint

Fine until a second device starts writing the same `user_id` rows concurrently. At that point the LWW resolver in `chooseWinner` silently drops one writer's edits per conflict, and "I typed this and it vanished" becomes a bug the user can reproduce. The fix isn't on the funnel — it's on the conflict layer, which would need per-field CRDTs (Automerge, Y.js) or operational transforms. The local-first shape survives; the conflict resolver gets replaced.

---

## Summary

Local-first architecture commits every user write to an on-device store synchronously and lets a background process race to mirror it somewhere durable later, decoupling availability from durability. In this codebase the chain is UI hook to service to `database.ts` to SQLite, with the only file that opens `loopd.db` being `database.ts`, and `schedulePush()` carrying the row to Supabase 5 seconds after the last write. The constraint was an Android journaling app opened on the train, in the kitchen, in bed — the user expects every keystroke to land instantly regardless of network, and Phase A has a single solo writer. The cost is that other devices won't see edits until ~5s after typing stops, and the 5-second debounce means a write is still local-only if the device dies before the push fires. The day a second device starts writing, last-write-wins becomes the load-bearing failure mode that needs CRDTs.

Key points to remember:
- UI to hook to service to `database.ts` to SQLite is synchronous; cloud catches up via `schedulePush()` 5 seconds after the last write.
- Every synced write must bump `updated_at` AND call `schedulePush()` — both invariants enforced in the single `database.ts` funnel.
- Lives in step 2 (Request flow) of the system-design checklist.
- The 5-second debounce batches typing bursts but means recent writes can be lost from the cloud on app kill (still in SQLite).
- LWW via `chooseWinner` is fine for solo sequential-device use; it becomes wrong when two writers edit the same row concurrently.

---

## Interview defense

### What an interviewer is really asking
Local-first looks like a fashion choice in 2026 — everyone is doing it. The interviewer wants to know whether you picked it because the constraints demanded it, or because the blog posts said so. The honest answer is the constraints: an Android journaling app gets opened on the train, in the kitchen, in bed, and the user expects every keystroke to land instantly regardless of network. The interviewer is checking whether you can name that constraint and trace it back to specific architectural choices.

### Likely questions

[mid] Q: Walk me through what happens between a tap on the Today screen and the row showing up in Postgres.

A: The tap fires a hook method (e.g. `useEntries.editEntry`), which calls a service in `src/services/<domain>/`, which calls `database.ts`. That's the only file that holds the SQLite handle. `database.ts` writes the row, stamps `updated_at = now`, then calls `schedulePush()` — a 5-second debounced timer. The UI re-renders from local SQLite on the next tick. Five seconds after the last write, `pushAll()` walks the SyncableTable registry and upserts dirty rows (`updated_at > synced_at`) to Supabase. The user never waits on Postgres for anything visible.

```
[tap → row-in-Postgres flow]

  React screen / hook
        │  imperative call
        ▼
  Service (src/services/<domain>/)
        │
        ▼
  database.ts   (write + updated_at + schedulePush)
        │
        ▼  ~1ms (UI re-renders from SQLite next tick)
  loopd.db
        │  5s after last write
        ▼
  pushAll() → Supabase Postgres
```

[senior] Q: Why funnel every write through a single `database.ts` instead of per-domain DB classes?

A: Two invariants need to hold on every synced write: bump `updated_at`, and call `schedulePush()`. With one file, those are one helper away. With per-domain classes, they're four files away from being forgotten. I'm a solo developer; the funnel is what makes "DB is canonical" a rule the compiler-ish helps me keep, not a discipline I have to remember. The cost is a long file. If a teammate joined and we had parallel work in the same module, I'd extract per-domain classes — but the invariants would still need to be enforced somewhere, probably a base class.

```
                  Path taken (single database.ts)     Alternative (per-domain DB classes)
                  ──────────────────────────────      ──────────────────────────────────
files             1 (1455 LOC)                        4 + 1 base class
invariant         1 helper away                       1 base class + discipline that
 enforcement                                          subclasses go through it
forget-to-push    impossible — every mutator          easy — a new EntriesDB method
 risk             touches the same helper             written without super() forgets
contributor       "why is this file so long?"         "why a base class for two lines?"
 confusion        — 1 paragraph answer                — same paragraph + inheritance
file count        1                                   5
```

[arch] Q: How does this design break when you go multi-device or multi-user?

A: It doesn't break catastrophically — it gets fuzzy. Two devices editing the same entry at the same time will fight via last-write-wins (`updated_at` resolves it), and the loser's changes silently disappear. That's fine for solo journaling where "two devices at once" is rare, but unacceptable for collaborative editing. The fix is per-field CRDTs or operational transforms, neither of which is cheap to retrofit. For multi-user (post-Phase A), the schema is already keyed on `(user_id, id)` and RLS is scaffolded, so the auth boundary moves but the local-first part stays.

```
At 2 devices writing the same user_id row concurrently:

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — each device renders own SQLite  │
  └─────────────────────────────────────────────┘
              │
  ┌─ Service / database.ts ─────────────────────┐
  │ unchanged — local write still synchronous   │
  └─────────────────────────────────────────────┘
              │
  ┌─ Conflict layer (chooseWinner / LWW) ───────┐
  │ picks winner by updated_at, drops loser     │  ◀── BREAKS FIRST
  │ silently — "I typed this and it vanished"   │     (needs per-field CRDT
  │ becomes a reproducible bug                  │     or operational transform)
  └─────────────────────────────────────────────┘
              │
  ┌─ Cloud (Supabase Postgres) ─────────────────┐
  │ unchanged — composite (user_id, id) PK      │
  │ already isolates per-user                   │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Five seconds is a long debounce. What happens if I kill the app at 4.9 seconds — is my data lost?

A: It's lost from the cloud, not from the device. The write hit SQLite synchronously the moment I typed it, so on next launch the row is there with `updated_at > synced_at` and `pushAll()` picks it up. Where it actually hurts is the multi-device case: if my phone dies before the push fires and I open the app on another device, the second device pulls a stale snapshot. For solo use on a single Android, this is acceptable — I haven't seen a single instance of post-mortem data loss. If I had two-device usage, I'd reduce to 1s or move to per-write push and accept the network chatter. The 5s number isn't sacred; it's the smallest interval that visibly batches typing without making the cloud feel out of date when I open the dashboard.

```
                  Path taken (5s debounce)            Suggested (per-write push)
                  ──────────────────────────────      ──────────────────────────────────
device durability local SQLite — never lost on        local SQLite — never lost on
                  device                              device
cloud durability  lags up to 5s after last write      ~80–400ms after each keystroke
network volume    1 push per typing burst             1 push per keystroke (10–50× more)
battery / data    debounced — cheap                   per-write — expensive on cellular
multi-device      tablet sees stale snapshot if       tablet sees writes ~200ms later
 freshness        phone dies in 5s window
real loss seen    zero in 6 months of solo use        n/a — never built
fix when 2nd      drop to 1s or per-write             already there
 device joins
```

### One-line anchors
- "Local-first matched my reality: solo dev, single Android, sporadic use — the cloud is a nice-to-have, not a load-bearing layer."
- "The single `database.ts` funnel exists to make `updated_at` + `schedulePush()` impossible to forget on a write path."
- "Five seconds isn't a guarantee — it's a tradeoff between cloud freshness and network noise; for one user on one device, it's right."
- "The design assumes the device is canonical; the day there are two devices, last-write-wins becomes the failure mode that needs CRDTs."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the local-first request flow to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/database.ts` + `src/services/sync/schedulePush.ts:schedulePush`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user types `[] call mom`, then 2 seconds later types `[] write spec`, then immediately backgrounds the app. Walk what's in local SQLite vs cloud Postgres at three timestamps: t=2s after second keystroke, t=4s, t=10s (assuming network is healthy). What happens differently if the OS kills the app at t=4s and the user reopens it at t=20s?

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/schedulePush.ts` L14–L21 and `src/services/database.ts` (any mutator) to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/database.ts` to support what exists (the single-funnel guarantee)
→ Point to per-domain modules under `src/services/{todos,threads,nutrition}/` (where you'd push the mutators if you split them up) if you chose the alternative

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet + corrected database.ts line count to 1455.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).

---
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram; added architectural-layer labels to the primary diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
