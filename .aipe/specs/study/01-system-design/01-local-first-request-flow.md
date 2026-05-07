# Local-first request flow

> Every user action commits to local SQLite first; the cloud lags by 5 seconds via a debounced background push.

**See also:** → [05-soft-delete](./05-soft-delete.md) · → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [09-debounced-push](./09-debounced-push.md)

---

## Quick summary
- **What:** UI → hook → service → `database.ts` → SQLite → schedulePush → Supabase. Every layer is synchronous up to the SQLite write; the cloud catches up later.
- **Why here:** the app must work offline (Android, journaling on the move) and the user is the only writer in Phase A.
- **Tradeoff:** other devices won't see edits until ~5s after typing stops. Acceptable for solo use; needs a tighter loop or live subscriptions for multi-device.

---

## Local-first request flow — diagram

```
  User taps a button on the Today screen
                │
                ▼
        ┌────────────────┐
        │  React screen  │  app/index.tsx (or any app/* route)
        └───────┬────────┘
                │  imperative call
                ▼
        ┌────────────────┐
        │  React hook    │  useEntries.editEntry, useHabits.toggle, etc
        └───────┬────────┘
                │  delegate
                ▼
        ┌────────────────┐
        │  Service       │  src/services/<domain>/<verb>.ts
        └───────┬────────┘
                │  SQL via expo-sqlite
                ▼
        ┌────────────────┐
        │  database.ts   │  the ONLY file that opens loopd.db
        └───────┬────────┘
                │   1. write (INSERT / UPDATE)
                │   2. set updated_at = now
                │   3. schedulePush()       ← debounced 5s timer
                ▼
        ┌────────────────┐
        │  loopd.db      │  SQLite, WAL, single-process
        └───────┬────────┘
                │  reads on next tick
                ▼
        UI re-renders
                │
                │  (5 seconds later, in the background)
                ▼
        ┌────────────────┐
        │  pushAll()     │  walks the SyncableTable registry
        └───────┬────────┘
                │  HTTPS upsert
                ▼
        Supabase Postgres
```

---

## How it works

The UI never talks to Supabase directly. Every write path runs through the hook → service → `database.ts` chain, and the only file that opens `loopd.db` is `database.ts`. That single funnel is what makes "DB is canonical" a hard guarantee instead of a vibe — there's exactly one place to enforce `updated_at` bumps and `schedulePush()` fires.

When a write hits SQLite, the row is immediately visible to the next read. The screen rebuilds from local state; nothing waits on the network. The cloud catches up via a debounced timer that fires `pushAll()` 5 seconds after the last write event.

If the device is offline, the writes pile up locally with `updated_at > synced_at`. On the next session that has network, `pushAll()` selects exactly those dirty rows and upserts them.

---

## In this codebase

- `src/services/database.ts` — the single mouth to SQLite. Every mutator stamps `updated_at` and calls `schedulePush()`.
- `src/hooks/useEntries.ts`, `useDatabase.ts`, `useHabits.ts`, `useDayTitle.ts`, `useExport.ts`, `useProject.ts` — thin React wrappers; they own the query and delegate mutations.
- `src/services/sync/schedulePush.ts` — the 5-second debouncer.
- `src/services/sync/orchestrator.ts` — `pushAll()` walks the SyncableTable registry of 10 tables.

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

| Choice | Cost | Alternative | When you'd pick the alternative |
|---|---|---|---|
| Local commit synchronous | UI doesn't see remote-only edits live | Realtime subscriptions | Multi-device active editing |
| Push debounced 5s | Recent writes can be lost on app kill (still in SQLite though) | Push per-write | Tiny payloads, abundant network |
| Single `database.ts` | Everything funnels through one file | Per-domain DB classes | Larger team, parallel modules |
