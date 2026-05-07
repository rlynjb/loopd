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
