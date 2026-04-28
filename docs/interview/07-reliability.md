# 07 — Reliability and error handling

> **Three patterns instead of locking.** loopd avoids global mutexes by leaning on idempotent writes, self-healing reconciliation, and a single rate-limited choke point for external calls.

The reliability story in loopd is shaped by what *isn't* there. There are no transactions wrapping the scanner-and-reconcile pipeline. There are no per-entry mutexes. There's no retry middleware. What there is, instead, are three deliberate patterns that combine to make the system robust without any of those mechanisms.

The first pattern is **DB-first writes**. Every keystroke in the journal writes to SQLite *before* React state updates. Even if the app crashes mid-word, the bytes are durable. This is documented in [CLAUDE.md](../../CLAUDE.md) as principle 3 — "Save to DB on every keystroke" — and it's the lesson from past data-loss bugs where focus-cleanup effects raced idle timers. The fix wasn't more locking; it was inverting the order of writes.

The second pattern is **self-healing reconcile**. Instead of trying to keep `todos_json` and `todo_meta` transactionally consistent, I let them drift slightly and patch the diff on the next commit. [`reconcileTodoMetaForEntry`](../../src/services/todos/reconcileMeta.ts) is idempotent: re-running on the same input is a no-op. A failed mid-loop run leaves a deterministic gap that the next run closes. This is the Kubernetes-controller pattern at small scale.

The third pattern is **module-level rate-limiter serialization**. Every Notion API call across all features goes through a single `lastRequestTime` module variable at [`notion/api.ts:7`](../../src/services/notion/api.ts#L7). Concurrent calls from `syncAll` and `syncAllTodos` automatically serialize. There's no "choreograph the syncs" code; the choke point handles it.

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

**Module-level rate limiting** for external API ordering. The 350ms gap at [`notion/api.ts:9-16`](../../src/services/notion/api.ts#L9-L16) means concurrent calls from the entries sync and the todos sync get queued through the same `lastRequestTime` variable and execute serially. No coordination code needed.

Where I haven't implemented locking and probably should: the on-commit scanner runs from `editEntry`, but the boot-time backfill runs from `_layout.tsx`. If the user lands on the journal during backfill, both could hit the same entry. Today this works because reconcile is idempotent — but it's not *deliberate* concurrency control. At scale I'd add per-entry mutexes to prevent double-work, even though correctness already holds.

### Q3 [arch] What's the riskiest dependency in this system?

The Notion API contract.

It's a third-party REST API I don't control, and the schema-gap tolerance I built — [`detectMissingTodoProperties`](../../src/services/notion/todosMapper.ts) — is defensive *for users on older Notion DB schemas*, not for *Notion changing their API*. If they ship a breaking change to the rich-text response shape, my parser at [`todosMapper.ts`](../../src/services/notion/todosMapper.ts) breaks.

The mitigation is the architectural principle that local SQLite is canonical: even if Notion sync stops working entirely, every existing piece of data is intact locally, deletions are queued in `sync_deletions`, and the user keeps using the app. The sync layer is *additive*, not load-bearing.

I'm proudest of this decision specifically because it cost me real work. A "cloud-first" version of this app would have been faster to build but would die the day Notion changed an API. By making SQLite primary, I bought independence — at the cost of writing all the merge logic, the deletion queue, and the schema-gap tolerance by hand. That tradeoff is the kind of thing I want any future architecture I work on to make explicitly, not by accident.

## The hard question

> "What if SQLite gets corrupted? What's your backup story?"

There isn't one beyond Notion sync. If SQLite goes — disk failure, kernel-level filesystem corruption, OS upgrade gone wrong — anything not synced is gone. Photos and clips are saved to DCIM via the standard `expo-media-library` path so they survive an app uninstall, but entries, todo metadata, nutrition records, and AI summaries live only in the app's sandboxed SQLite file.

What I'd add at any larger scale: periodic exports to a backup blob — either on-device to the user's Documents folder or to a cloud store — and a "restore from Notion" path that reverses the sync. The current model assumes the user's Notion DB *is* the long-term backup, which is true for entries and todos and nutrition (those sync) but not for AI summaries or expansion outputs (those don't, today).

The honest framing: backup is a P1 feature for a multi-user product and a P3 feature for a personal app where the user has Notion sync turned on. Today loopd is the latter. The minute it ships to a non-technical user who might not configure Notion at all, backup becomes Day-1 work — daily SQLite snapshot to a user-visible file path, rolled at 30 days, plus an "import" flow on first install of a new device. None of this is hard; it's just not built yet because at this scale it would be theater.

→ [08 — Developer process](./08-developer-process.md)
