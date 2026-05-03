# 07 — Reliability and error handling

> **Three patterns instead of locking.** loopd avoids global mutexes by leaning on idempotent writes, self-healing reconciliation, and a single rate-limited choke point for external calls.

The reliability story in loopd is shaped by what *isn't* there. There are no transactions wrapping the scanner-and-reconcile pipeline. There are no per-entry mutexes. There's no retry middleware. What there is, instead, are three deliberate patterns that combine to make the system robust without any of those mechanisms.

The first pattern is **DB-first writes**. Every keystroke in the journal writes to SQLite *before* React state updates. Even if the app crashes mid-word, the bytes are durable. This is documented in [CLAUDE.md](../../CLAUDE.md) as principle 3 — "Save to DB on every keystroke" — and it's the lesson from past data-loss bugs where focus-cleanup effects raced idle timers. The fix wasn't more locking; it was inverting the order of writes.

The second pattern is **self-healing reconcile**. Instead of trying to keep `todos_json` and `todo_meta` transactionally consistent, I let them drift slightly and patch the diff on the next commit. [`reconcileTodoMetaForEntry`](../../src/services/todos/reconcileMeta.ts) is idempotent: re-running on the same input is a no-op. A failed mid-loop run leaves a deterministic gap that the next run closes. This is the Kubernetes-controller pattern at small scale.

The third pattern is **debounced coalescing for the cloud-sync push**. Every write to a synced table calls [`schedulePush()`](../../src/services/sync/schedulePush.ts) which resets a 5-second timer. A burst of edits (typing continuously, toggling a habit, deleting a todo) collapses into one cloud push that fires once after the writes settle. The push is also self-serializing: if a push is already in flight when the timer fires, the helper re-queues itself and waits — no concurrent-push storms. There's no "choreograph the syncs" code; the choke point handles it.

The threads scanner shipped in 2026-04-29 follows the same self-healing pattern: [`scanThreadsForEntry`](../../src/services/threads/scanThreads.ts) runs fire-and-forget after `scanTodos` (because `[]`-line tag attribution needs the final todo IDs), is idempotent on re-run, and lazy-backfills via the `thread_mentions_backfill_v1_done` flag with an extra short-circuit: skip if zero threads exist locally. Without that guard, a fresh install would walk every entry to find no matches; with it, the backfill defers until a thread is created and re-checks on the next boot.

```
              Backfill crash recovery — pattern in detail

  App boot
     │
     ▼
  Read SecureStore: 'todo_meta_backfill_v1_done'
     │
     ├──► flag set ──► skip backfill, return early
     │
     └──► flag unset
              │
              ▼
        ┌───────────────────────────────┐
        │ for each entry in DB:         │
        │   reconcileTodoMetaForEntry   │ ◄── idempotent per-entry
        │   - INSERT missing meta rows  │     (re-run is no-op)
        │   - DELETE orphaned meta rows │
        └────────────────┬──────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
      crash mid-loop          loop completes
              │                     │
              │                     ▼
        flag NEVER set        SecureStore.setItemAsync(KEY)
              │                     │
              ▼                     ▼
        next boot:              next boot:
        runs full pass          flag set → skip
        again                   (no double-work)
              │
              ▼
        per-entry idempotency
        means already-done
        entries no-op; only
        the unfinished tail
        actually does work

  Pattern: mark-after-success + per-item idempotency.
  Cost on retry: full re-walk (cheap because per-entry is no-op).
  Win: zero rollback logic, zero partial-state cleanup.
```

What's not in the code that an interviewer might expect: a streaming retry queue, a circuit breaker, a dead-letter queue for permanently-failed Notion writes. The reason none of these exist is that the failure modes I'm protecting against are network and parser bugs, not multi-process distributed-system failures. At larger scale these absences would matter; at one-user scale they'd be theater.

## Interview questions

### Q1 [senior] What happens if the `todo_meta` backfill crashes halfway through?

Two layers protect against that.

**The flag is set after the work completes.** [`migrateMeta.ts:27`](../../src/services/todos/migrateMeta.ts#L27) shows the pattern: the SecureStore flag is the *last* line of `backfillTodoMeta`. If the loop crashes mid-way — disk full, OOM, OS pause-and-resume bug, anything — the flag was never set. On next boot, the function sees the flag absent and runs the full pass again from scratch.

**Each per-entry operation is itself idempotent.** [`reconcileTodoMetaForEntry`](../../src/services/todos/reconcileMeta.ts) doesn't blindly insert; it walks `todos_json` and `todo_meta` for the same entry and only INSERTs meta rows that are missing or DELETEs ones that are orphaned. Re-running across the full set on next boot just no-ops everything that succeeded last time and continues with what didn't.

The pattern is *mark-after-success + per-item idempotency*. You get crash recovery with no transaction logic, no rollback, no partial-state cleanup. The cost is paying full work-set on retry — but for a one-time backfill of a few hundred entries that's milliseconds. The principle generalizes way beyond this app: any deferred operation that can be re-run safely should be, and the marker should record completion, not intent.

### Q2 [senior] Two writes race — what happens?

I rely on three patterns rather than locking, and I'll trace each.

**DB-first writes.** Every keystroke writes durably to SQLite before any React state update. Even if React renders a stale UI, the bytes are safe — see [`InlineTextInput.tsx:54-61`](../../src/components/journal/InlineTextInput.tsx#L54-L61). Concurrent keystrokes can't lose data because the React render is downstream of the durable write.

**Self-healing reconcile.** Instead of locking `todos_json` and `todo_meta` together, I let them drift slightly and patch the diff on the next commit ([`reconcileMeta.ts:48-90`](../../src/services/todos/reconcileMeta.ts#L48-L90)). The invariant is "eventually consistent, idempotent." If two reconciles run concurrently against the same entry, the SQLite serialization layer (single connection, single thread) effectively serializes them, and the second one sees the first's writes and no-ops anything already done.

**Debounced cloud push** for external API ordering. Every write to a synced table calls [`schedulePush()`](../../src/services/sync/schedulePush.ts) which resets a 5-second timer; bursts of writes collapse into one push. The push helper also guards against concurrent invocations — if a push is already in flight when the timer fires, it re-queues — so no two `pushAll()` calls race against the same row.

Where I haven't implemented locking and probably should: the on-commit scanner runs from `editEntry`, but the boot-time backfill runs from `_layout.tsx`. If the user lands on the journal during backfill, both could hit the same entry. Today this works because reconcile is idempotent — but it's not *deliberate* concurrency control. At scale I'd add per-entry mutexes to prevent double-work, even though correctness already holds.

### Q3 [arch] What's the riskiest dependency in this system?

Supabase.

The Notion sync that previously held this slot was deleted in commit `dc8483a`; cloud sync runs against Supabase Postgres now. If Supabase has an outage, raises pricing, or ships a breaking change to supabase-js, my push/pull layer at [`sync/push.ts`](../../src/services/sync/push.ts) and [`sync/pull.ts`](../../src/services/sync/pull.ts) is exposed.

The mitigation is the same architectural principle that previously protected me from Notion: **local SQLite is canonical** (Architectural Principle 12 — "cloud is a sync mirror, never the canonical source"). Reads always hit local; writes always commit local first; the cloud lags by 5s via the debounced push. If Supabase goes away entirely, every existing piece of data is intact locally, every read path filters `WHERE deleted_at IS NULL` against local, and the user keeps using the app offline-first. The cloud sync layer is the safety net you opt into; it isn't on the read path.

What I'd lose if Supabase disappeared: the cross-device replication path (Phase B's reason to exist) and any data that was created on a device that subsequently dies before pulling locally. The clip files (`Documents/loopd/clips/<date>/*.mp4`) aren't in Supabase Storage anyway — they're a known gap (see [`docs/backlog.md`](../backlog.md)) — so a Supabase outage doesn't make that worse.

I'm proudest of the local-canonical decision because it survived a backend swap. The same architecture that previously protected against Notion changing their API now protects against Supabase changing theirs. The cost is the same: I write all the merge logic by hand. The benefit is the same: every cloud is replaceable. That tradeoff is the kind of thing I want any future architecture I work on to make explicitly, not by accident.

### Q4 [senior] You documented Principle 11 — "mentions are derived" — with one explicit deviation. Why?

The dashboard's "Daily Schedule" tracker lets users tap a thread row to mark it touched today. That tap writes a `thread_mentions` row with `entry_id IS NULL AND todo_id IS NULL`. By Principle 11, mentions should ONLY be derived from prose, so a manual touch is a deviation.

Three reasons it's the right call here:

1. **Schema permits it.** Both `entry_id` and `todo_id` are nullable in the original DDL. The "at least one is set" constraint was app-level (not a CHECK), so I'm not bending the schema, just bending the convention.
2. **Composability.** All mention queries already aggregate uniformly — staleness math, the 14-day strip, entries-this-week — none of them care whether a row came from a scanner or a tap. Adding the manual case didn't require any consumer changes.
3. **Deletion is local.** Toggling off only deletes the manual row; prose-derived mentions for the same day stay intact. There's no risk of a manual toggle clobbering scanner output.

What makes it tolerable as a deviation rather than a bug: it's documented inline at [`services/threads/touch.ts`](../../src/services/threads/touch.ts), the dashboard `activeDates` set is deliberately filtered to manual-only so prose mentions don't accidentally light up the strip, and the principle's existence as a stated rule means anyone adding the *next* feature has a tripwire — if you're tempted to bypass derivation, you have to argue for it the way I argued for this one.

## The hard question

> "What if SQLite gets corrupted? What's your backup story?"

Cloud sync is the backup story now — every synced table (entries, todos with their meta, habits, threads, mentions, nutrition, ai_summaries, projects, vlogs, day_meta) round-trips through Supabase. If SQLite goes, a fresh install + first-pull restores all of it. The dev menu has a "Reset Local From Cloud" button that performs exactly this: wipe local synced tables, run `firstPullAll()` to rehydrate from Postgres.

The honest gap is the **video clips**. Clip files live at `Documents/loopd/clips/<date>/*.mp4`; they're not in Supabase Storage. Cloud sync round-trips `entries.clips_json` (the path references) but not the bytes. If local FS dies, the videos are unrecoverable — phones save the original imports to the camera roll, which the OS-level photo backup typically protects, but the 1080p proxies loopd transcodes from those originals are device-local. This is logged in [`docs/backlog.md`](../backlog.md) as a known gap pending a Supabase Storage push pipeline.

What I'd add for a multi-user product: clip backup behind an opt-in toggle (it's bandwidth-expensive), a periodic SQLite snapshot to user-visible storage as a belt-and-suspenders defense, and a clearer recovery UI that walks the user through "your data is safe, here's how to restore." Today's recovery flow is the dev menu, which is fine for solo Phase A and inadequate for any non-technical user.

The honest framing: cloud sync as backup is *real*, not theatrical, for everything except clip files. The clip gap is the next piece of recovery work whenever I prioritize it, and the sync layer that already exists is the substrate it builds on.

→ [08 — Developer process](./08-developer-process.md)
