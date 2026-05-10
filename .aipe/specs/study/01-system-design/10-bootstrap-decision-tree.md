# Bootstrap decision tree

**Industry name(s):** Bootstrap, first-run decision tree
**Type:** Project-specific

> Runs once per install on the first cold start with cloud configured. Decides whether to push, pull, or do nothing. Sets a SecureStore flag so it never runs again.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [09-debounced-push](./09-debounced-push.md)

---

## Why care

A user installs your app on a new phone. There might be a year of their data sitting in the cloud, or nothing. There might also be data on the device from a previous use, or nothing. Four combinations, and each one demands a different first move: pull from cloud, push to cloud, do nothing, or stop and ask. Pick wrong on first launch and you either lose their existing work or replace it with a stale snapshot. What's the right move? That's the question this decision tree answers.

A first-run decision tree is a one-shot classifier that runs at cold start, inspects the state of both stores, and routes to exactly one initialization path before normal incremental sync takes over. It belongs to the family of "boot-time reconciliation" patterns, alongside container init scripts, package manager first-install hooks, and the way a fresh Git clone decides whether to pull from origin or set itself up empty. The two-by-two of "local has data" times "remote has data" is the same matrix every backup tool, every dotfile manager, and every multi-device sync product has had to navigate. The next block walks the mechanics.

---

## How it works

The bootstrap check runs once on cold start, gated by two SecureStore reads:

1. `isCloudConfigured()` — checks for `supabase_url` and `supabase_anon_key`. If absent, sync is off entirely and bootstrap doesn't run.
2. `cloud_initial_push_done` — the bootstrap flag. If `true`, normal incremental sync takes over and bootstrap is skipped.

Otherwise, it queries both sides:
- `localHasData` — `SELECT COUNT(*) > 0` across the syncable tables.
- `cloudHasData` — a HEAD-style query against one canonical cloud table.

The four-quadrant decision then runs `initial-push`, `first-pull`, or `no-op`. After any branch, the bootstrap flag is set so subsequent boots take the normal incremental path.

The `local=yes cloud=yes` case is the awkward one — neither side is obviously canonical. Phase A treats local as canonical and pushes (with a warning log), because the most likely cause is "user installed cloud config later than they thought" and local writes shouldn't be lost. Phase B should prompt the user. The diagram below shows it end-to-end.

---

## Bootstrap — diagram

```
  Cold start
       │
       ▼
   isCloudConfigured?
       │ no  → skipped
       │
       │ yes
       ▼
   isBootstrapDone (SecureStore: cloud_initial_push_done)?
       │ yes → skipped (normal incremental sync takes over)
       │
       │ no
       ▼
   localHasData?    cloudHasData?
       │                 │
       └──────┬──────────┘
              ▼
      ┌───────────────────────────────────────────────────────────┐
      │ local=no  cloud=no    →  no-op            (mark done)     │
      │ local=yes cloud=no    →  initial-push     (mark done)     │
      │ local=no  cloud=yes   →  first-pull       (mark done)     │
      │ local=yes cloud=yes   →  fallback initial-push, log warn  │
      └───────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Decision:**         `src/services/sync/bootstrap.ts` → `bootstrapCloudSync()` L59–L96 (with `localHasData()` L36–L43, `cloudHasData()` L44–L58, `isBootstrapDone()` L27–L31, `markBootstrapDone()` L32–L35)
**First-pull:**       `src/services/sync/firstPull.ts` — the all-table first-pull walker invoked from the `local=no, cloud=yes` branch
**Initial-push:**     `src/services/sync/orchestrator.ts` → `pushAll()` L38–L60 — called from the `local=yes, cloud=no` branch (and the awkward both-populated fallback)
**Run-once flag:**    SecureStore key `cloud_initial_push_done` — `BOOTSTRAP_KEY` constant at `bootstrap.ts:18`

---

## Elaborate

### Where this pattern comes from
Any sync engine has a bootstrap problem: "what if the local and remote disagree about who has data?" Most engines either force "cloud wins" (which loses fresh local writes) or "local wins" (which loses everything pre-existing in cloud). Loopd uses the four-quadrant explicit choice because each quadrant has a clearly correct answer except the both-populated case.

### The deeper principle
**Initial state is its own problem; don't try to handle it in the steady-state code.** Steady-state sync (push/pull) assumes both sides have a shared history (the `last_pull_at` watermark). Bootstrap establishes that watermark. Mixing the two would make the steady-state code carry conditional branches forever.

### Where this breaks down
- The both-populated case in Phase A's silent-push fallback can quietly overwrite cloud data. A user who switched devices and reconfigured cloud would expect the cloud to win, but loopd will push the new device's empty-ish local over it. Mitigation: the warning log surfaces in the dev menu.
- Slow networks where the cloud-existence check times out. The fallback assumption (cloud=no when uncertain) could trigger an unwanted initial-push.

### What to explore next
- [Cloud sync as a mirror](./07-cloud-sync-mirror.md) → what runs after bootstrap completes.
- The dev menu in `settings/cloud-sync.tsx` for forced re-bootstrap.

---

## Tradeoffs

- **Run-once flag** — gives: bootstrap doesn't repeat. Costs: clearing it (e.g., for testing) requires the dev menu.
- **Four-way explicit decision** — gives: each branch is clearly correct except one. Costs: the awkward branch (both populated) is a known footgun in Phase A.
- **Local-canonical fallback** — gives: doesn't lose recent local writes. Costs: can overwrite cloud silently in the rare both-populated case.

---

## Quick summary

A first-run decision tree is a one-shot classifier that runs at cold start, inspects the state of both stores, and routes to exactly one initialization path before normal incremental sync takes over. In this codebase `bootstrapCloudSync()` in `src/services/sync/bootstrap.ts` is gated by `isCloudConfigured()` and the `cloud_initial_push_done` SecureStore flag, then classifies `(localHasData, cloudHasData)` into four quadrants — no-op, initial-push via `pushAll()`, first-pull via the all-table walker, or a fallback initial-push for the both-populated case. The constraint was that "fresh device recovery" and "first cloud connect on existing app" are different operations, and mixing them into steady-state push/pull would mean conditional branches forever. The cost is that the `local=yes cloud=yes` quadrant can't be auto-resolved — Phase A silently picks local and pushes (with a warning log), which is the known footgun in the design. The right call when a multi-device migration flow exists is a UI prompt; until then, the dev menu in `settings/cloud-sync.tsx` is the audit trail.

Key points to remember:
- The chain is `isCloudConfigured()` → `isBootstrapDone()` → classify `(localHasData, cloudHasData)` → one of four branches → `markBootstrapDone()`.
- Steady-state sync never has to wonder if it's the first run because `cloud_initial_push_done` short-circuits subsequent boots.
- Lives in step 5 (Failure handling) of the system-design checklist.
- The both-populated fallback can silently overwrite cloud data — the warning log is the only audit trail in Phase A.
- Three quadrants have unambiguous answers; the fourth needs a UI prompt that hasn't shipped yet.

---

## Interview defense

### What an interviewer is really asking
Most sync-engine bugs hide in the bootstrap path. The interviewer wants to know whether you treated initial state as a separate problem from steady state, or whether you tried to handle "cold start" with the same code that handles "incremental sync." They're listening for the four-quadrant decomposition, not vibes.

### Likely questions

[mid] Q: Where does `cloud_initial_push_done` live and what reads it?

A: It's a SecureStore boolean (Android Keystore-backed). `bootstrap.ts` reads it on cold start; if true, bootstrap is skipped and the app falls through to normal incremental push/pull. After a successful bootstrap branch (any of initial-push, first-pull, or no-op), the flag is set to true. The dev menu in `settings/cloud-sync.tsx` exposes a "reset bootstrap" action that clears the flag — used during testing or when a user wants to re-bootstrap from cloud.

[senior] Q: Why the four-quadrant decision instead of "just always pull then push"?

A: Because "pull then push" loses the local-only case. If the user has been writing for two weeks before configuring cloud, a default-pull-first fetches an empty cloud, then push sends everything up — that's what I want. But if the user is recovering on a fresh device, the same default pulls the cloud (good), then pushes what's now local (also fine — no-op). The case that breaks "pull then push" is "fresh device, but local has just-installed empty rows from migrations" — push could attempt to upsert empty rows over real data. The four-quadrant version checks counts on both sides explicitly and picks the unambiguous branch in three of four cases. The fourth (both populated) is the genuinely-ambiguous case I handle with a fallback plus a warning.

[arch] Q: What happens when a user has data on three devices and turns on cloud sync for the first time on the third device?

A: Three independent bootstraps, in install order. Device 1 hits "local=yes, cloud=no" → initial-push. Device 2's first cloud-enabled cold start hits "local=yes, cloud=yes" → fallback initial-push with a warning, which silently overwrites device 1's pushes for any rows that diverged. Device 3 hits the same fallback. The merge order is "whichever device starts last wins on overlap" — that's wrong, but it's the design's known weakness. The right fix is a UI prompt: "this device has X entries and the cloud has Y entries — pick which to keep, or attempt a merge." That's queued for Phase B; until then, the warning log in the dev menu is the audit trail.

### The question candidates always dodge
Q: Your "both populated" branch silently picks local and pushes. Walk me through the case where a user replaces their phone, restores their loopd database from a stale backup, and turns cloud sync on for the first time after the restore.

A: This is the case where the design hurts most. The restored backup is two weeks stale; cloud has the user's current data from their old phone. Bootstrap sees `local=yes, cloud=yes`, runs the fallback initial-push, and overwrites cloud with the stale local rows. The user's last two weeks of work, which existed only on cloud, are now gone. The mitigation today is the warning log — the user has to know to check it. The proper fix is the prompt I mentioned: detect ambiguity and ask. I haven't shipped it because the case requires the user to actively migrate data, which is a Phase B onboarding flow that doesn't exist yet. Phase A's user (me) doesn't restore from backups — when I switch devices, I install fresh and let `first-pull` populate. The honest answer is the design is correct for the workflow that exists and wrong for the one that doesn't, and I haven't built that workflow yet.

### One-line anchors
- "Bootstrap is its own problem; steady-state sync should not carry conditional branches forever."
- "Four quadrants, three unambiguous answers, one fallback — and the fallback has a warning log because it's the known footgun."
- "The run-once flag (`cloud_initial_push_done`) means the steady-state code never has to wonder if it's the first run."
- "The both-populated case needs a UI prompt; until that ships, local wins and the dev menu is the audit trail."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the bootstrap decision tree to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/sync/bootstrap.ts:bootstrapCloudSync`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user replaces their phone, restores their loopd backup from two weeks ago (so local SQLite has 14-day-stale data), and turns cloud sync on for the first time after the restore. Cloud has the user's current real data from their old phone. Walk what happens on the next cold start: which quadrant fires, what `cloud_initial_push_done` ends up at, and what does the user *see* — what data is preserved and what is lost?

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/bootstrap.ts` L59–L96 to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/sync/bootstrap.ts:bootstrapCloudSync` (the silent both-populated fallback) to support what exists
→ Point to where a UI prompt would have to land (likely a new boot screen + a deferred bootstrap call) if you chose the alternative

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
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.
