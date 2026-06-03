# The local-first observability paradox — when the user can't tell the cloud is broken
## Industry name(s): local-first sync · offline-first invariant · silent-failure user blindness · Type: Pattern, architecture-shaped

> Local-canonical reads make a local-first app feel correct even when its cloud mirror has stopped accepting writes. The user is the worst possible signal for cloud-side failure. The only honest detection has to fire from the cloud's silence, not the user's complaint.

## Zoom out, then zoom in

```
  LAYERS — buffr's data path under normal and broken conditions
  ┌─────────────────────────────────────────────────────────────┐
  │ UI layer                                                     │
  │   reads from SQLite always   ✓ feels correct regardless     │
  ├─────────────────────────────────────────────────────────────┤
  │ Service layer                                                │
  │   writes to SQLite first; queues push to Supabase            │
  ├─────────────────────────────────────────────────────────────┤
  │ Local store — buffr.db (SQLite, canonical)                   │
  │   always available; always reflects user's own writes        │
  ├─────────────────────────────────────────────────────────────┤
  │ Sync engine — debounced push, batched pull                   │
  │   ┌────────────────────────────────────────────────────────┐ │
  │   │ ★ if this stops working, ZERO user-visible signal ★    │ │
  │   └────────────────────────────────────────────────────────┘ │
  ├─────────────────────────────────────────────────────────────┤
  │ Cloud store — Supabase Postgres (mirror)                     │
  │   silent target; only visible to operators via the dashboard │
  └─────────────────────────────────────────────────────────────┘
```

The architectural choice that makes buffr feel snappy and offline-capable — local-canonical reads — is the same choice that makes cloud-side failure structurally invisible to the user. There is no "loading spinner that never resolves," no "request failed" toast, no UI affordance whose absence signals "the cloud isn't seeing your data." Every read serves from local. Every write hits local first. The cloud is downstream of every user-facing surface.

Zoom in: the user opens buffr, types into today's entry, and sees their text rendered back to them — the SQLite write is synchronous from the UI's perspective. Sync runs in the background, debounced to 5 seconds. If sync is silently failing (the [`01-success-only-log-guard.md`](./01-success-only-log-guard.md) failure mode), the next read continues to serve from SQLite, which continues to reflect the user's own writes. **The user's experience is indistinguishable from a healthy system. For days.**

This is not a bug in local-first. It is a structural property. The design buys correctness and snappy feel; it pays for them with the user's inability to notice cloud-tier failure.

## Structure pass

```
  layers   ─ UI / Service / Local store / Sync engine / Cloud store

  axes     ─ canonical-ness:    local is canonical, cloud is mirror
             ─ failure visibility: who sees a failure when one occurs?
             ─ feedback latency:   how soon does the user notice?

  seams    ─ UI ←→ Local store: the "always-fresh" illusion
             ─ Local store ←→ Cloud: the silent-failure surface
             ─ Cloud ←→ Operator:    the only one who can see it,
                                     and only if they're watching
```

The middle seam is the load-bearing one. The system is designed so that the user's eyes never reach the cloud — every screen they see is rendered from local. Cloud-side failure has no UI affordance to attach itself to.

## How it works

### Move 1 — the data-flow asymmetry

```
  THE TWO PATHS

  reads                    writes
   ┌─────────┐              ┌─────────┐
   │   UI    │              │   UI    │
   └────┬────┘              └────┬────┘
        │                        │
   ┌────▼────┐              ┌────▼────┐
   │ SQLite  │              │ SQLite  │  ← write lands here
   │ (local) │              │ (local) │    synchronously
   └─────────┘              └────┬────┘
        ▲                        │
        │                        │ async push
        │ never                  │ (debounced 5s)
        │ reaches                │
        │ here ────►          ┌──▼──────┐
                              │Supabase │  ← may quietly fail
                              │ (cloud) │    here forever
                              └─────────┘
```

The user's eyes never reach the cloud. There is no read path that goes UI → cloud. Every screen is rendered from SQLite. The cloud is a sink, not a source, for the user-facing experience.

### Move 2 — three classes of failure, three visibility profiles

```
  failure class A — UI-visible
   ┌──────────────────────────────────────────────────┐
   │ red-screen / thrown error in render path         │
   │ → user sees it immediately. fires a bug report.  │
   └──────────────────────────────────────────────────┘

  failure class B — local-write-visible
   ┌──────────────────────────────────────────────────┐
   │ SQLite constraint violation; canceled write       │
   │ → user sees "didn't save" if there's UI for it.   │
   │   buffr's UI does NOT currently render this.      │
   └──────────────────────────────────────────────────┘

  failure class C — cloud-side, silent
   ┌──────────────────────────────────────────────────┐
   │ RLS deny / schema missing / network-permanent    │
   │ → SQLite is fine. UI is fine. user is fine.      │
   │   ★ NO USER-VISIBLE SIGNAL EXISTS ★              │
   │   the only observer is the cloud itself.         │
   └──────────────────────────────────────────────────┘
```

Class C is the load-bearing failure class for buffr. It includes every PostgREST resolve-with-error case from `01-success-only-log-guard.md`. The user is structurally the worst possible reporter for Class C failures.

### Move 3 — the only honest detection

```
  THE ONLY DETECTION THAT WORKS
   ┌──────────────────────────────────────────────────┐
   │ a HEARTBEAT alert on the cloud side:             │
   │   "no successful push from user U in N hours,    │
   │    despite local writes being known to exist"    │
   └──────────────────────────────────────────────────┘

  why this shape and not a threshold:
   ─ thresholds need a healthy baseline to compare against;
     a single-user app's baseline is too small.
   ─ a heartbeat fires on SILENCE, which is exactly what
     Class C failures produce.
   ─ silence is detectable; user complaint is not, because
     the user has no signal to complain about.
```

The implication is operational: to detect Class C failures, buffr must instrument *the cloud's view* of the user. The instrumentation cannot live inside the app, because the app cannot see the cloud. (More precisely: the app can be instructed to ping a "I-just-pushed-successfully" beacon, but the *alert* must fire from a system that watches *for the absence* of the beacon. That system is outside the app by definition.)

## Primary diagram

```
  the paradox, one image

   USER          APP             LOCAL DB         CLOUD
    │             │                │                │
    │ types       │                │                │
    ├─────────────▶                │                │
    │             │  write         │                │
    │             ├────────────────▶                │
    │             │                │  OK            │
    │             │◀───────────────┤                │
    │  sees write rendered (from local)             │
    │◀────────────┤                │                │
    │             │                │                │
    │             │  push (5s later)                │
    │             ├────────────────────────────────▶│
    │             │                │            ╳   │ ← Class C
    │             │  silent failure (PGRST301)      │
    │             │◀────────────────────────────────┤
    │             │                │                │
    │  sees nothing.                                │
    │  reads local. perfectly content.              │
    │  cloud is empty. forever.                     │
    ▼                                               ▼

         the only observer that can fire:
         a HEARTBEAT on the cloud side.
```

The user is fine. The cloud is empty. Nobody knows.

## Implementation in codebase

The local-canonical reads are everywhere. The pattern is the entire app.

```ts
// src/services/entries/read.ts  (illustrative — pattern, not literal path)

export async function getEntriesForDay(date: string) {
  // local DB is canonical. no cloud read path exists.
  return db.query<Entry>(
    `SELECT * FROM entries WHERE date = ? AND deleted = 0 ORDER BY id`,
    [date]
  );
}
```

```ts
// src/services/entries/write.ts

export async function appendToEntry(date: string, text: string) {
  await db.exec(
    `UPDATE entries SET text = text || ?, updated_at = ? WHERE date = ?`,
    [text, Date.now(), date]
  );
  // ★ no await on cloud push. it's queued for the sync orchestrator,
  //   which is debounced. failure to reach the cloud will NOT prevent
  //   this function from returning successfully.
  scheduleSync();
}
```

**Line-by-line read:**

- The read function never touches Supabase. There is no `else` branch that falls through to a network call. The pattern is *not* "try cloud, fall back to local"; the pattern is *only* local.
- The write function returns success the moment SQLite acknowledges. The cloud push is scheduled, not awaited.
- `scheduleSync()` enters the orchestrator. The orchestrator's silent-error guard ([`01-success-only-log-guard.md`](./01-success-only-log-guard.md)) means the push can fail completely with no signal anywhere.

**What an instrumentation pass actually looks like, code-side:**

```ts
// new: a "I just pushed successfully" beacon
async function pushTable(table: string, ctx: SyncCtx) {
  const result = await /* ... existing push logic ... */;
  if (result.succeeded > 0 && !result.error) {
    await reportPushSuccess({ table, userId: ctx.userId, ts: Date.now() });
  }
  return result;
}

// the alert lives outside the app, in cloud infra:
//   "for user U, no reportPushSuccess in 24h despite writes_pending > 0"
//   → page someone, or send the user an in-app notification
```

The in-app beacon is cheap (one HTTP call on success). The alert is what does the work, and it must live in a place that can see the *absence* of beacons. That's outside the app — a tiny cron-driven SQL query against Supabase's `synced_at` columns and a comparison to the heartbeat log.

**Why this isn't built yet:** buffr is a single-user app today. The user *is* the operator. When the 0009 incident fired, the operator (Rein) noticed because they checked the Supabase dashboard for unrelated reasons. The single-user-equals-operator collapse means the heartbeat alert's audience is the same person as the heartbeat source. Once buffr has more than one user, the heartbeat's audience and the affected user diverge — and the heartbeat becomes the only structurally correct detection.

## Elaborate

The local-first observability paradox is structural to *every* local-first architecture, not just buffr. The same shape shows up in:

- **Obsidian Sync** — local vault is canonical; sync failures are surfaced via an unobtrusive icon. Many users miss it for days.
- **Apple Notes / iCloud** — local notes are canonical; iCloud sync failures often surface only as "no longer appearing on other device."
- **Linear's local cache** — reads are local-fast; cloud-write failures surface as "this comment didn't post," which is a *write-visible* signal because Linear's UI surfaces write state explicitly.

Notice the spread: Linear's UI rendering of write state moves the failure visibility from Class C back into Class B. The architectural decision "render write state explicitly in the UI" is the *single design move* that closes the paradox. Buffr does not currently make this move. The UI renders the user's text from local; it does not render "synced" or "pending" or "failed" states.

This is the design lever for buffr's Phase B: if cloud-side failure must be visible without operator instrumentation, the UI has to render write state. A small per-entry indicator ("synced" / "pending" / "error") would move the paradox from structural to operational. It costs UI complexity and a column in the entries table to track per-row sync state. The breakpoint where it's worth paying that cost is "first user who isn't the operator."

**Why this finding sits alongside the silent-error guard.** [`01-success-only-log-guard.md`](./01-success-only-log-guard.md) is the *mechanism* of silent failure. This file is the *user-side blindness* that makes the mechanism so damaging. Fixing only the mechanism (adding `|| r.error` to the guard) makes the failure loud *to the engineer reading `adb logcat`* but still silent *to the user*. Both findings have to be addressed to close the loop — engineer-visible signal AND user/operator-visible alert.

## Interview defense

**Q [mid]:** "Why is local-first hard to observe?"

**A:** "Because the user reads from local. Every screen they see is rendered from the local store, so cloud-side failure has no UI affordance to attach itself to. The user can be perfectly content for days while the cloud silently rejects every write. The implication is that the user is the *worst* signal for cloud failure — the architecture removed every channel through which they could notice."

```
   user ───────► local ◄─── canonical
                 │
                 │ async push
                 ▼
                cloud  ← may be empty for days

   no read path goes UI → cloud.
   no failure path goes cloud → UI.
   the user has no signal.
```

**Q [senior]:** "What's the only honest detection you can build?"

**A:** "A heartbeat alert that fires on the cloud's *silence*. The alert lives outside the app — a small monitor that watches Supabase's `synced_at` columns and pages when a user with known-pending writes hasn't pushed successfully in N hours. The instrumentation inside the app is just a beacon that reports successful pushes; the alert is what does the work, and it must be outside the app because it has to fire on absence of beacons."

```
   inside app:  beacon on push success   (cheap)
   outside app: alert on beacon absence  (load-bearing)
                                                   
   the alert audience must NOT be the affected user.
   that's the whole point of the design.
```

**Q [arch]:** "Linear renders per-comment sync state in the UI. Should buffr?"

**A:** "Linear's choice moves cloud failure from Class C (structurally invisible) into Class B (write-visible). It costs UI complexity and a per-row sync-state column. For buffr today, single-user, operator-equals-user: not worth it. For buffr at first non-operator user: it becomes the cheapest correct detection. The trigger to invest is 'first user who can't read the Supabase dashboard.' Before then, the heartbeat alert outside the app is enough."

```
   buffr today:        operator detection via heartbeat
   buffr at user >1:   UI-rendered write state per row
                                                       
   the trigger is "the user and the operator
   are different people."
```

## Validate

### Level 1 — reconstruct the diagram

Sketch the read-path/write-path asymmetry showing that no read path reaches the cloud. Mark Class C failures and note that the user has no signal.

### Level 2 — explain it out loud

Under 90 seconds: name the asymmetry, name the three failure classes, say which class buffr is structurally blind to, give the heartbeat-alert shape.

### Level 3 — apply to a new scenario

A team is building a local-first note-taking app and asks how to surface sync failures. Walk the two design moves: (a) render per-note sync state in the UI (closes the paradox); (b) cloud-side heartbeat (catches the structural blindness). Name the trade-off — UI complexity vs operational complexity — and the breakpoint.

### Level 4 — defend the decision

Defend or oppose: "Buffr should not be local-first; it should be cloud-first with optimistic UI."

The defense is correctness-of-feel and offline-capability — both real wins. The cost is exactly this paradox; the mitigation is the heartbeat alert. The opposing case is that "cloud-first with optimistic UI" makes failures Class B (UI-visible) for free, at the cost of feel under poor connectivity. For buffr's actual usage pattern (daily journaling, often outdoors, often offline), local-first is the right call; the paradox is the tax, and the heartbeat alert is how you pay it.

## See also

- [`audit.md`](./audit.md) — Pass 1's #2 finding (this one).
- [`01-success-only-log-guard.md`](./01-success-only-log-guard.md) — the mechanism this finding makes invisible.
- `../study-system-design-dsa/01-system-design/07-cloud-sync-mirror.md` — the architectural choice that creates this paradox.
- `../study-software-design/04-layers-and-abstractions.md` — the layering that makes the cloud structurally downstream of the UI.
- `../study-testing/01-what-is-tested-and-what-isnt.md` — why "the user noticed" is not a viable testing or monitoring strategy.
