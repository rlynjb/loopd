# Bootstrap decision tree

**Industry name(s):** Bootstrap, first-run decision tree
**Type:** Project-specific

> Runs once per install on the first cold start with cloud configured. Decides whether to push, pull, or do nothing. Sets a SecureStore flag so it never runs again.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [09-debounced-push](./09-debounced-push.md)

---

## Why care

Open the Service Worker debug panel in Chrome DevTools and watch what happens on a website's first load vs every subsequent load. First load: no SW exists yet → install. Subsequent load with the same SW version → activate from cache. Subsequent load with a new SW version → install the new one + activate. Install failed → fall back to network. Four possible states, four different code paths, decided by inspecting the actual SW state at boot. The rule isn't "always install" or "always serve from cache"; it's "look at what's actually present, then route."

The question that decision tree answers is one any app with both a local and a cloud store has to answer on first launch: there might be data on the device from a previous install, or nothing. There might be data in the cloud from a previous session on another phone, or nothing. Four combinations, each demanding a different first move. Not "always pull cloud" — that overwrites the user's recent local work. Not "always push local" — that overwrites cloud data that's already converged. The answer is a *first-run decision tree*: a one-shot classifier that inspects both sides at cold start, picks one of four branches, then sets a flag so it never runs again.

**What depends on getting this right:** whether a user's existing work survives the first sync, or whether one side silently overwrites the other. In this codebase `bootstrap()` runs in `app/_layout.tsx` on cold start. Two SecureStore reads gate it: `isCloudConfigured()` checks for `supabase_url` + `supabase_anon_key`, and `cloud_initial_push_done` is the post-decision flag. When neither short-circuits, `bootstrap()` queries both sides cheaply: `localHasData = SELECT COUNT(*) > 0 FROM entries` plus a HEAD-style probe against one canonical cloud table. The two booleans pick a branch: `(no, no)` → no-op, `(yes, no)` → `initial-push` walks every syncable table and pushes everything, `(no, yes)` → `firstPull()` pulls every cloud row in pages, `(yes, yes)` → the awkward case, where Phase A treats local as canonical and logs a warning (Phase B's plan is a UI dialog). The flag prevents re-running because the `(yes, yes)` branch isn't idempotent — running it twice would re-push local over any cloud-side edits since the last boot.

Without an explicit decision tree (initializers scattered, no flag):
- A user installs cloud config after typing locally for a week (`(yes, yes)` state)
- One initializer pulls cloud first, overwriting the week's local writes
- Another initializer pushes local after the pull — sending now-stale data back
- The user opens the app and their week is gone; the cloud is a snapshot from before they typed
- No log line names what happened because there was no decision; the bug was emergent

With the decision tree + flag:
- Same `(yes, yes)` first boot; `bootstrap()` sees both have data, takes the local-canonical branch with warning
- Local week pushes up; cloud's prior state gets LWW-resolved on the next normal pull
- `cloud_initial_push_done` is set; bootstrap exits in <1ms on every subsequent boot
- Normal incremental sync (push + pull with LWW) runs from then on; the cold-start path is invisible

The flag is the Service Worker install-event semantics: once registered, the bootstrap decision stops re-running.

---

## How it works

React Query's hydration check is the same shape. On app boot, the client checks whether the persisted cache exists, whether its version matches the current schema, whether the user's auth state is still valid — and routes the boot flow accordingly: hydrate from cache, refetch on stale match, prompt for re-auth, or run first-time setup. After the check, the boot flag goes down and the app never re-runs the decision until next cold start. The Service Worker install event has the same shape: four states decided once, never re-asked, until you clear site data and force a fresh boot.

The cold-start decision flow in one picture:

```
   cold start
        │
        ▼
   ┌──────────────────────────────┐
   │ check flags first            │  ◄── early-exit gates
   │   isCloudConfigured()?       │     (cheap SecureStore reads)
   │   cloud_initial_push_done?   │
   └──────────────┬───────────────┘
                  │  both flags pass through
                  ▼
   ┌──────────────────────────────┐
   │ inspect both stores          │
   │   localHasData?              │  ◄── cheap COUNT + HEAD
   │   cloudHasData?              │
   └──────────────┬───────────────┘
                  │  4 quadrants
                  ▼
   ┌──────────────────────────────┐
   │ pick one branch              │  ◄── one-time decision
   │ set cloud_initial_push_done  │
   │ normal sync takes over       │
   └──────────────────────────────┘
```

Three reads, one branch, one flag — that's the whole boot-time machine. The four sub-sections below trace each layer.

### The gating reads — SecureStore decides whether to ask at all

`bootstrap()` runs on cold start in `app/_layout.tsx`. Before the decision tree fires, two SecureStore keys gate it: `isCloudConfigured()` checks for `supabase_url` and `supabase_anon_key`; if either is absent, sync is off entirely and bootstrap returns immediately. `cloud_initial_push_done` is the post-decision flag; if `true`, normal incremental sync takes over and bootstrap is skipped. If you're coming from frontend, this is the same shape as a feature flag plus a "have-I-onboarded" boolean in `localStorage` — the flags skip the expensive setup path once the user is past it. Concrete consequence: a user opens the app for the second time on the same device. `isCloudConfigured()` returns true (URL + key cached); `cloud_initial_push_done` returns true (set on the first boot). Bootstrap exits in <1ms; the normal push/pull cycle runs. Boundary: if SecureStore is wiped (uninstall + reinstall, or a corrupt keystore), the flags reset and bootstrap re-runs as if the device were fresh.

The two gates in code-flow form:

```
   bootstrap()  // app/_layout.tsx on cold start
        │
        ▼
   ┌────────────────────────────────────┐
   │ if (!isCloudConfigured()) {         │  ◄── no supabase_url
   │   return; // sync off entirely      │     or no anon_key
   │ }                                    │
   ├────────────────────────────────────┤
   │ if (cloud_initial_push_done) {      │  ◄── already decided
   │   return; // normal sync runs       │     in a previous boot
   │ }                                    │
   └─────────────────┬───────────────────┘
                     │  neither short-circuited
                     ▼
                4-quadrant query runs
```

On the second boot the flag short-circuits in microseconds; the expensive path runs at most once per install.

### The four-quadrant query — local × cloud has-data

When neither flag short-circuits, bootstrap queries both sides cheaply: `localHasData = SELECT COUNT(*) > 0 FROM entries` (cross the syncable tables; one match is enough), and `cloudHasData = HEAD against one canonical cloud table`. The two booleans produce four states: (no, no), (yes, no), (no, yes), (yes, yes). Think of it like a `useEffect` dependency-array boolean tuple that switches between "do nothing," "push," "pull," and "ambiguous — decide carefully" branches. Concrete consequence: a user installs the app on a fresh device, types 4 entries before realising they should enable cloud sync, then sets up Supabase. Next boot: `isCloudConfigured` true, `cloud_initial_push_done` false. Bootstrap runs. `localHasData = true` (4 entries), `cloudHasData = false` (empty project). Branch: `initial-push`. The 4 entries plus their derived `todo_meta`/`thread_mentions` get walked through `pushAll()` once, then the flag is set. Boundary: this assumes the HEAD-style cloud probe is reliable; a network blip during the probe would mis-detect cloud as empty.

The four quadrants laid out:

```
   localHasData = SELECT COUNT(*) > 0 FROM entries
   cloudHasData = HEAD against one canonical cloud table
                            │
                            ▼
   ┌─────────────────────────────────────────────────────┐
   │                       localHasData                   │
   │                  ──────────────────                  │
   │                     no            yes                │
   │              ┌────────────┬─────────────┐            │
   │ cloud   no   │ (no, no)   │ (yes, no)   │            │
   │  Has         │  no-op     │ initial-    │            │
   │  Data        │            │  push       │            │
   │              ├────────────┼─────────────┤            │
   │         yes  │ (no, yes)  │ (yes, yes)  │  ◄── the   │
   │              │ first-pull │  awkward    │     hard   │
   │              │            │  case;      │     one    │
   │              │            │  local wins │            │
   │              └────────────┴─────────────┘            │
   └─────────────────────────────────────────────────────┘
```

Two booleans, four code paths, exactly one runs.

### The branches — `initial-push`, `first-pull`, `no-op`, and the awkward case

- **(no, no):** the user is fresh on both sides. No-op. Flag set; normal sync takes over.
- **(yes, no):** local has data, cloud is empty. `initial-push` runs — walk every syncable table, push everything.
- **(no, yes):** cloud has data, local is empty. `firstPull()` runs (see [02-dsa/14-firstpull-bootstrap](../02-dsa/14-firstpull-bootstrap.md)). Pull every cloud row in pages, upsert locally. No conflict resolution needed because local is empty.
- **(yes, yes) — the awkward case:** both have data. Neither side is obviously canonical. Phase A treats *local as canonical* — pushes local up with a warning log — because the most likely cause is "user installed cloud config later than they thought" and local writes shouldn't be silently lost. Phase B should prompt the user with a UI dialog ("merge or replace?"). The branch is documented and gated behind a flag for future work.

If you're coming from frontend, the awkward case is the same shape as a merge conflict in Git when both branches have committed changes — there's no "correct" answer the tool can pick; it needs human input. The codebase makes a deliberate choice (local wins) under Phase A constraints and explicitly defers the UX. Concrete consequence: a developer installs cloud config after typing locally for a week. Bootstrap sees (yes, yes), pushes local entries, sets the flag. The cloud's prior contents (if any — usually empty in this case) get LWW-resolved when the next normal pull runs. Boundary: this is wrong if the user actually meant "discard local and pull cloud as canonical" — a real-world scenario the prompt would catch.

Each branch in detail, with the awkward case called out:

```
   (no, no)    ─▶ no-op                  → set flag, exit
                   nothing to sync; first-ever install on a
                   fresh device with a fresh project

   (yes, no)   ─▶ initial-push           → walk every syncable
                   table, push all rows; set flag
                   (user typed locally, then enabled cloud)

   (no, yes)   ─▶ firstPull()            → pull every cloud row
                   in pages (200/page); no conflict resolution
                   needed (local was empty); set flag
                   (new device, existing cloud account)

   (yes, yes)  ─▶ AWKWARD — local-wins branch
                   - log warning
                   - push local up (most likely cause:
                     "user installed cloud config later than
                      they thought")
                   - set flag
                   - cloud's prior state gets LWW-resolved
                     on the next normal pull
                   Phase B (planned): UI dialog asks
                     "merge or replace?"
```

The awkward case is the only one with a Phase B follow-up; the other three branches are terminal decisions.

### Why the flag matters — bootstrap is not idempotent on (yes, yes)

If bootstrap ran on every cold start without the flag, the (yes, yes) branch would push local every time, potentially clobbering cloud-side edits that arrived from another device since the last boot. The flag's job is to make bootstrap a one-time decision — once the device has decided how to reconcile its initial state, normal incremental sync (push + pull with LWW) takes over for every subsequent edit. Think of it like a React class component's `componentDidMount` semantic — fire once, then unmount-mount cycle takes over. Concrete consequence: a user with (yes, yes) on first boot has their local pushed. On second boot, the flag is set; bootstrap returns immediately. The normal pull notices any cloud-side edits and runs `chooseWinner` per row, which is the correct conflict-resolution path for the steady state. Boundary: a manual unset of the flag (e.g. by a developer flag-stripper or a dev-actions reset) would re-trigger bootstrap and re-push local, with the same risks as the first run.

Without the flag vs with the flag, on a multi-device timeline:

```
        Without flag (re-runs each boot)         With flag (one-time decision)
   ┌─────────────────────────────────────┐    ┌──────────────────────────────────────┐
   │ boot 1: (yes, yes) → push local      │    │ boot 1: (yes, yes) → push local       │
   │                                      │    │          set cloud_initial_push_done │
   │ (other device pushes its edits to    │    │                                       │
   │  cloud in between)                   │    │ (other device pushes its edits)      │
   │                                      │    │                                       │
   │ boot 2: bootstrap re-runs            │    │ boot 2: flag = true → bootstrap       │
   │         → still (yes, yes)           │    │          skipped in <1ms              │
   │         → push local AGAIN,          │    │          normal incremental sync runs │
   │           clobbering other device's  │    │          LWW resolves cross-device    │
   │           edits                      │    │          edits correctly              │
   │                                      │    │                                       │
   │ data loss every cold start           │    │ cold-start path is idempotent         │
   └─────────────────────────────────────┘    └──────────────────────────────────────┘
```

The flag is the boundary between "we made a one-time decision" and "we're in steady-state sync" — without it, the (yes, yes) branch is a data-loss machine.

This is what people mean by "design the cold-start path as an explicit decision tree." Most apps treat "first run" as a special case scattered across initializers, and you get bugs when one initializer assumes another already ran. Naming the four states, choosing branches per state, and gating the whole thing behind a one-time flag turns "what should happen on first boot?" into a decision the architecture can defend rather than a behaviour that emerges from race conditions. The full picture is below.

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
Any sync engine has a bootstrap problem: "what if the local and remote disagree about who has data?" Most engines either force "cloud wins" (which loses fresh local writes) or "local wins" (which loses everything pre-existing in cloud). Buffr uses the four-quadrant explicit choice because each quadrant has a clearly correct answer except the both-populated case.

### The deeper principle
**Initial state is its own problem; don't try to handle it in the steady-state code.** Steady-state sync (push/pull) assumes both sides have a shared history (the `last_pull_at` watermark). Bootstrap establishes that watermark. Mixing the two would make the steady-state code carry conditional branches forever.

### Where this breaks down
- The both-populated case in Phase A's silent-push fallback can quietly overwrite cloud data. A user who switched devices and reconfigured cloud would expect the cloud to win, but buffr will push the new device's empty-ish local over it. Mitigation: the warning log surfaces in the dev menu.
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

## Tech reference (industry pairing)

### @supabase/supabase-js

- **Codebase uses:** `@supabase/supabase-js` (Supabase JS client).
- **Why it's here:** bootstrap queries the cloud side to check `cloudHasData` before routing to a branch.
- **Leading today:** Supabase — `adoption-leading`, 2026.
- **Why it leads:** managed Postgres + auth + RLS + Storage in one console; SDK mirrors PostgREST directly.
- **Runner-up:** Neon + Drizzle — `innovation-leading` typed SQL with branch-per-PR; Convex is the reactive-first alternative.

### expo-sqlite (WAL)

- **Codebase uses:** `expo-sqlite` with WAL mode.
- **Why it's here:** bootstrap checks `localHasData` via SQLite row count before deciding which branch to take.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** ships with the Expo SDK; battle-tested; mirrors the SQLite C API directly.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding (perf-tier, no bridge overhead).

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
Q: Your "both populated" branch silently picks local and pushes. Walk me through the case where a user replaces their phone, restores their buffr database from a stale backup, and turns cloud sync on for the first time after the restore.

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

A user replaces their phone, restores their buffr backup from two weeks ago (so local SQLite has 14-day-stale data), and turns cloud sync on for the first time after the restore. Cloud has the user's current real data from their old phone. Walk what happens on the next cold start: which quadrant fires, what `cloud_initial_push_done` ends up at, and what does the user *see* — what data is preserved and what is lost?

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

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @supabase/supabase-js, expo-sqlite.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (suitcase-at-baggage-claim metaphor opening / 4 layered sub-sections — SecureStore gates, four-quadrant query, the four branches + awkward (yes,yes) case, why the flag is essential — each with frontend bridges and concrete consequences / principle paragraph on cold-start as explicit decision tree).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (baggage-claim two-suitcases-check-the-tag scenario → first-run decision tree named as the answer → bolded "what depends on getting this right" with bootstrap()/SecureStore-flag stakes → before/after walking a `(yes, yes)` first boot → one-line "the flag is the airport's stamp; once it's on your pass, the gate stops asking").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced airport-baggage-claim-with-suitcases analogies with Chrome DevTools Service Worker install event four-state decision tree + React Query hydration check). Both Move 1s were missed by the original triage agent.

---
Updated: 2026-05-14 — v1.32.0 pass: R1 no-op (Why care + How it works anchors already use level-3 engineering surfaces: Chrome DevTools Service Worker panel + React Query hydration check). Added Move 1 mnemonic diagram (three-layer flow: flags → 4-quadrant query → branch + flag) + 4 Move 2 sub-section diagrams: SecureStore gates in code-flow form, 4-quadrant grid, each-branch-in-detail, with-vs-without-flag two-device timeline. Total: 5 new diagrams.
