# Bootstrap decision tree

> Runs once per install on the first cold start with cloud configured. Decides whether to push, pull, or do nothing. Sets a SecureStore flag so it never runs again.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [09-debounced-push](./09-debounced-push.md)

---

## Quick summary
- **What:** at boot, if cloud is configured and the bootstrap flag is unset, classify (localHasData, cloudHasData) and run initial-push, first-pull, or no-op accordingly.
- **Why here:** "fresh device recovery" (install → first-pull) and "first cloud connect on existing app" (push existing local → cloud) are different operations. Bootstrap picks correctly.
- **Tradeoff:** the both-populated case can't be auto-resolved without a UI prompt. Phase A ships a pragmatic fallback (treat local as canonical) plus a warning log; Phase B should prompt.

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

## How it works

The bootstrap check runs once on cold start, gated by two SecureStore reads:

1. `isCloudConfigured()` — checks for `supabase_url` and `supabase_anon_key`. If absent, sync is off entirely and bootstrap doesn't run.
2. `cloud_initial_push_done` — the bootstrap flag. If `true`, normal incremental sync takes over and bootstrap is skipped.

Otherwise, it queries both sides:
- `localHasData` — `SELECT COUNT(*) > 0` across the syncable tables.
- `cloudHasData` — a HEAD-style query against one canonical cloud table.

The four-quadrant decision then runs `initial-push`, `first-pull`, or `no-op`. After any branch, the bootstrap flag is set so subsequent boots take the normal incremental path.

The `local=yes cloud=yes` case is the awkward one — neither side is obviously canonical. Phase A treats local as canonical and pushes (with a warning log), because the most likely cause is "user installed cloud config later than they thought" and local writes shouldn't be lost. Phase B should prompt the user.

---

## In this codebase

- `src/services/sync/bootstrap.ts` — the four-way decision and orchestration.
- `src/services/sync/firstPull.ts` — the all-table first-pull walker.
- `src/services/sync/orchestrator.ts` → `pushAll()` is called for the initial-push branch.
- SecureStore key `cloud_initial_push_done` — the run-once flag.

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
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
