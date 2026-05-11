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

We traded a UI conversation for an algorithmic choice: three of the four quadrants have an unambiguous answer, so we coded them in; the fourth has no good silent answer, and we know it.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (silent classifier│ Alternative (UI prompt for   │
│                  │ + warning on ambiguous case) │  every first-run)            │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Code surface     │ ~100 LOC in bootstrap.ts +   │ same logic + a new boot     │
│                  │ firstPull.ts already exists  │ screen + state machine for   │
│                  │                              │ deferred bootstrap (~300 LOC)│
│ Time-to-first    │ ~50 ms — invisible to user   │ user must tap through prompt │
│ render           │                              │ blocks initial render        │
│ Correct outcome  │ 3/4 quadrants right; 4th     │ all 4 quadrants right        │
│                  │ silently picks local         │ (user disambiguates)         │
│ Data-loss risk   │ real in restore-from-stale-  │ near-zero — user is asked    │
│                  │ backup case (Phase A)        │ when ambiguous               │
│ Phase A user fit │ fine — solo, single device   │ would feel like ceremony for │
│                  │ migration is fresh-install +  │ a use case that never        │
│                  │ firstPull                    │ happens                      │
│ Phase B / multi- │ wrong — Phase B needs the    │ correct shape                │
│ user fit         │ prompt to ship                │                              │
│ Audit trail      │ warning log in dev menu      │ explicit user choice         │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

The `local=yes cloud=yes` quadrant has no algorithmically-correct answer. We silently fall back to "push local over cloud" with a warning log. In Phase A's only user scenario (me, single device, fresh installs use `firstPull`), that fallback never fires — but if it ever fires for a real user it overwrites cloud silently, which is exactly the case where a UI prompt would have saved them.

The warning log lives in the dev menu in `settings/cloud-sync.tsx`. A user without dev-menu access has no signal that the fallback fired. We pay for this in trust: "did anything just get overwritten?" is unanswerable without checking the log, and the log itself is invisible to anyone not looking.

The flag `cloud_initial_push_done` is set after any branch, which means the bootstrap never re-runs on subsequent boots. Clearing the flag (e.g., for testing or a re-bootstrap) requires the dev menu. A user who accidentally cleared their SecureStore via OS storage cleanup would re-trigger bootstrap on next launch and might hit the both-populated fallback — silent overwrite from a UX-layer accident.

### What the alternative would have cost

A UI prompt would have meant a new boot screen with a state machine: defer the bootstrap classification until the user has tapped through. That's ~200 extra LOC plus a new screen file, plus the design work to make "you have data on both sides, here's what's where, pick one or attempt a merge" understandable. The cost shows up at every first-run, not just the ambiguous case — every user, every install, sees the boot screen.

In Phase A that ceremony would feel pointless because the user (me) never hits the ambiguous case. In Phase B (multi-user collaborative, with real device migration) the prompt becomes essential. The decision was "ship Phase A without the prompt and accept the warning log as the Phase A audit trail; build the prompt when Phase B ships."

### The breakpoint

Fine until Phase B opens. The moment multi-device migration becomes a real user flow — second user, restore-from-backup paths, OS-level data transfer — the silent fallback's failure mode (overwriting cloud with stale local) becomes a customer-visible bug. The fix is the boot-screen prompt; it's not optional past that point.

### What wasn't actually a tradeoff

"Always cloud wins on ambiguity" was not on the table. The user who configures cloud sync for the first time after writing for two weeks would lose those two weeks if cloud wins — the cloud is empty, "cloud wins" means we delete local. That's a worse default than the current one. There is no silent rule that handles all four quadrants correctly; the only correct algorithm involves asking the user.

---

## Summary

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

```
[cloud_initial_push_done lifecycle]

  SecureStore (Android Keystore)
        │
        ├── written once: markBootstrapDone() after any branch
        │
        ├── read every cold start: isBootstrapDone()
        │       │
        │       ├── true  → skip bootstrap; steady-state takes over
        │       └── false → run classifier
        │
        └── reset via dev menu: settings/cloud-sync.tsx
                (clears SecureStore key, next cold start re-runs)
```

[senior] Q: Why the four-quadrant decision instead of "just always pull then push"?

A: Because "pull then push" loses the local-only case. If the user has been writing for two weeks before configuring cloud, a default-pull-first fetches an empty cloud, then push sends everything up — that's what I want. But if the user is recovering on a fresh device, the same default pulls the cloud (good), then pushes what's now local (also fine — no-op). The case that breaks "pull then push" is "fresh device, but local has just-installed empty rows from migrations" — push could attempt to upsert empty rows over real data. The four-quadrant version checks counts on both sides explicitly and picks the unambiguous branch in three of four cases. The fourth (both populated) is the genuinely-ambiguous case I handle with a fallback plus a warning.

```
                  Path taken (four-quadrant explicit)    Alternative (pull-then-push default)
                  ──────────────────────────────         ──────────────────────────────────
local-only case   initial-push (correct)                 push sends fine, but pull-first
                                                          fetches empty cloud — wasted RPC
cloud-only case   first-pull (correct)                   pull fetches; push then tries to
                                                          upsert what just landed → bounce
both-empty case   no-op (correct)                        pull empty, push empty → no-op
                                                          works by accident
both-populated   silent fallback push + warning (known   pull cloud over local — silently
                  footgun)                               overwrites local writes
fresh-device-but- detected by localHasData=true on       push would attempt to upsert empty
empty-rows case   non-empty SELECT COUNT                 default rows over real cloud data
ceremony per boot one classifier run, no UI              same one classifier needed anyway
                                                          to detect ambiguous case
unambiguous       3/4 branches algorithmically correct   0/4 cleanly correct without same
quadrants                                                  explicit count check
```

[arch] Q: What happens when a user has data on three devices and turns on cloud sync for the first time on the third device?

A: Three independent bootstraps, in install order. Device 1 hits "local=yes, cloud=no" → initial-push. Device 2's first cloud-enabled cold start hits "local=yes, cloud=yes" → fallback initial-push with a warning, which silently overwrites device 1's pushes for any rows that diverged. Device 3 hits the same fallback. The merge order is "whichever device starts last wins on overlap" — that's wrong, but it's the design's known weakness. The right fix is a UI prompt: "this device has X entries and the cloud has Y entries — pick which to keep, or attempt a merge." That's queued for Phase B; until then, the warning log in the dev menu is the audit trail.

```
At 3+ devices coming online in non-fresh-install order:

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — no boot prompt today             │
  └─────────────────────────────────────────────┘
              │
  ┌─ Bootstrap classifier ──────────────────────┐
  │ device 1: local=yes cloud=no → initial-push │
  │ device 2: local=yes cloud=yes → SILENT      │  ◀── BREAKS FIRST
  │           fallback → push local over device │     (overwrite chain;
  │           1's cloud data                    │      "whichever device boots last
  │ device 3: same fallback → device 2 overwrite│      wins overlapping rows")
  └─────────────────────────────────────────────┘
              │
  ┌─ Steady-state sync ─────────────────────────┐
  │ resumes after first-cold-start — works fine │
  │ on the (now-mangled) shared state            │
  └─────────────────────────────────────────────┘
              │
  ┌─ Phase B fix surface ───────────────────────┐
  │ +boot screen + deferred-bootstrap state mach│
  │ +UI: "this device has X entries, cloud has Y│
  │  — pick which / attempt merge"               │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Your "both populated" branch silently picks local and pushes. Walk me through the case where a user replaces their phone, restores their loopd database from a stale backup, and turns cloud sync on for the first time after the restore.

A: This is the case where the design hurts most. The restored backup is two weeks stale; cloud has the user's current data from their old phone. Bootstrap sees `local=yes, cloud=yes`, runs the fallback initial-push, and overwrites cloud with the stale local rows. The user's last two weeks of work, which existed only on cloud, are now gone. The mitigation today is the warning log — the user has to know to check it. The proper fix is the prompt I mentioned: detect ambiguity and ask. I haven't shipped it because the case requires the user to actively migrate data, which is a Phase B onboarding flow that doesn't exist yet. Phase A's user (me) doesn't restore from backups — when I switch devices, I install fresh and let `first-pull` populate. The honest answer is the design is correct for the workflow that exists and wrong for the one that doesn't, and I haven't built that workflow yet.

```
                  Path taken (silent fallback push)     Suggested (UI prompt before any push)
                  ──────────────────────────────        ──────────────────────────────────
restore-stale-    overwrites cloud with stale local;    user is asked: "local has 14-day-
backup case        2 weeks of cloud-only writes vanish  old data, cloud has fresher — keep
                                                          which, or attempt merge?"
detectability     warning log buried in dev menu        explicit UI moment, user choice
                                                          recorded
worst-case impact ~2 weeks of cloud data silently lost   zero — user can pick or merge
                  for a user who restored from backup
phase-A user fit  invisible — the user (me) doesn't     adds boot ceremony to a flow that
                  hit this case                         never produces ambiguity today
phase-B user fit  blocker — first user on a fresh       essential — the only correct way
                  device after backup-restore           to handle multi-device migration
build cost        zero (already shipped)                ~300 LOC + boot screen + design
                                                          work, ~1 week
ship trigger      Phase B onboarding (real second user, the moment any non-fresh-install
                  device migration flows)               flow becomes a real UX
```

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

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
