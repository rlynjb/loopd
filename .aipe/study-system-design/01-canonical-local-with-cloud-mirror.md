# Canonical-local with cloud-mirror — the architecture's defining choice
## Industry name(s): local-first, offline-first, canonical client store · Type: Architecture pattern

> SQLite on the device is authoritative. Postgres on Supabase is a passive mirror. Every UI read goes to SQLite. Every write lands in SQLite first. The cloud is downstream of every screen.

## Zoom out, then zoom in

```
  THE TWO ASYMMETRIES

  READ asymmetry:
    UI ──► SQLite ──► render
    cloud is never on the read path.

  WRITE asymmetry:
    UI ──► SQLite (sync) ──► return OK
                │
                └─► queue for sync (async, debounced)
    cloud is downstream; "saved" returns before cloud sees the row.
```

Zoom in: the pattern is *not* "cache the cloud locally with stale-while-revalidate." Buffr is the inverse — the cloud is the cache of the local store, not the other way around. SQLite is durable; Postgres is the mirror that survives device loss and lets the user log in elsewhere later.

## Structure pass

```
  layers   ─ UI ─ service ─ SQLite ─ sync ─ Supabase
  axes     ─ canonical-ness     (always: local)
             ─ user-visibility   (cloud is invisible)
             ─ durability        (microseconds locally, seconds in cloud)
  seams    ─ UI ←→ SQLite           : every screen
             ─ SQLite ←→ sync engine : the bridge
             ─ sync ←→ Supabase     : the only cloud path
```

## How it works

### Move 1 — local-first means the cloud cannot block the user

```
  the user's experience is independent of cloud availability.
  device offline → app fully usable.
  cloud down → app fully usable.
  cloud silently rejecting writes → app fully usable
    (★ this is the local-first observability paradox ★)
```

### Move 2 — the cloud's job

```
  the cloud isn't a backend in the request/response sense.
  it has three jobs:
   1. survive device loss (backup)
   2. let the user log in from a new device later (restore)
   3. enable future multi-device (the spec hints at this)
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ in canonical-local, the cloud is a SINK, not a   │
   │ SOURCE. it is the second machine, not the first. │
   │ every architectural decision should preserve     │
   │ this — the moment a UI read reaches the cloud,   │
   │ the local-first guarantee breaks.                │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
  the asymmetry

   READ                            WRITE
   ────                            ─────
                                       
   UI ──► SQLite                    UI ──► SQLite ──► OK
        (canonical)                          │
                                             └──► (async, debounced)
                                                  └──► Supabase
                                                  
  no read ever reaches the cloud.
  no write ever waits for the cloud.
```

## Implementation in codebase

The pattern is everywhere; pick one example:

```ts
// pattern; src/services/entries/read.ts
export async function getEntriesForDay(date: string, userId: string) {
  return db.queryAll<Entry>(
    `SELECT * FROM entries
     WHERE user_id = ? AND date = ? AND deleted = 0
     ORDER BY id`,
    [userId, date]
  );
}
```

```ts
// pattern; src/services/entries/write.ts
export async function appendToEntry(date: string, text: string, userId: string) {
  await db.exec(
    `UPDATE entries SET text = text || ?, updated_at = ?
     WHERE user_id = ? AND date = ?`,
    [text, Date.now(), userId, date]
  );
  scheduleSync();  // ★ not awaited
}
```

**Line-by-line read:**

- Read: no `try { cloud } catch { local }` fallback. The pattern is *only* local; the cloud is not in this function's mental model.
- Write: returns the moment SQLite acknowledges. `scheduleSync()` is fire-and-forget; the orchestrator picks it up on the next debounce tick.
- The cloud's job — survive device loss + restore — is structurally not on the user-facing path.

## Elaborate

The cost of canonical-local is the [local-first observability paradox](../study-debugging-observability/02-local-first-observability-paradox.md) — the user can't tell when the cloud is broken because they never read from it. The mitigation is structural: a heartbeat alert outside the app, not a UI affordance the user has to notice.

The benefit is everything else: instant-feel writes, offline capability, sub-second screens, zero "loading spinner that never resolves" UX failures. For a daily journaling app where the user might be writing in the morning before signal arrives, this is the right call.

The two real alternatives:

- **Cloud-first with optimistic UI** (Linear, Notion): writes go to cloud; UI shows them instantly; sync errors surface via UI indicator. Real-time collab works. Offline mode is limited.
- **Cloud-first with cache** (most web apps): every read is a request; cache is a perf optimization, not a fallback. Offline is broken.

Buffr's canonical-local is the right pick because (a) journaling is a single-user activity (no real-time collab needed), (b) the user often writes in low-signal environments, (c) the value of "I can read my own data instantly" is high.

## Interview defense

**Q [mid]:** Why canonical-local rather than just caching the cloud?

**A:** Because the journaling use case has the user as the only writer. There's no collaborative edit conflict to surface. The local-first design buys instant-feel writes and offline capability for free; the cost is sync complexity and a heartbeat for cloud-side monitoring. For a single-user-multi-device journal, the trade is clearly worth it.

**Q [senior]:** How do you know the cloud is broken?

**A:** Today: a contributor notices via the Supabase dashboard. Tomorrow: heartbeat alert on the cloud's silence. The user *cannot* notice — that's structural, because every UI read comes from local. The alert has to fire on the absence of a successful push beacon, not on user complaint.

**Q [arch]:** When would you stop using this pattern?

**A:** When real-time collaborative editing is required. LWW conflict resolution clobbers concurrent edits; that's unacceptable in a collaborative tool. The migration path is CRDT-based local state with operation-based sync — a different shape entirely. Buffr's spec explicitly does not target collab.

## Validate

### Level 1 — sketch the read-vs-write asymmetry.

### Level 2 — explain why "saved" is returned before the cloud sees the row.

### Level 3 — apply: design a fitness-tracking app where the user's data is private and the user is offline 80% of the time. Walk why canonical-local is correct.

### Level 4 — defend: "Local-first is over-engineering; just cache the cloud." Wrong for the use case — offline mode breaks; UX feels janky on flaky connections. Right for a CRUD admin tool.

## See also

- [`02-debounced-batched-sync.md`](./02-debounced-batched-sync.md) — the bridge that makes canonical-local work.
- [`audit.md`](./audit.md) — Pass 1's lens 5 (storage choice).
- `../study-debugging-observability/02-local-first-observability-paradox.md` — the cost of this pattern.
- `../study-database-systems/01-database-systems-map.md` — the two-engine view.
- `../study-distributed-systems/02-consistency-models.md` — eventual consistency between engines.
