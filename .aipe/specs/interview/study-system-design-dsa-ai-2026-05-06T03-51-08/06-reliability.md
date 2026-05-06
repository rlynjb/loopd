# Chapter 6 — Reliability and error handling

loopd is a single-user, offline-first app. The reliability target is "the user never loses data, even if every external dependency fails." The way the architecture meets that target is **stratified durability**: the device's SQLite is canonical, every write is synchronous to SQLite, and every external system (cloud sync, AI calls, network) is a *best-effort layer above the canonical store*. If the cloud is down, the user keeps using the app; the next push catches up. If the AI is down, compose fails gracefully and the user composes manually. If the user's network is gone for a week, nothing is lost.

The error-handling style is consequently **fail-quiet-and-self-heal**, not fail-loud. Most failures log a warning to the console and let the next operation retry. The exceptions are user-initiated operations where a silent failure would be confusing — those surface an Alert.

```
Reliability layers (from canonical to ephemeral)

  ┌──────────────────────────────────────────────────────┐
  │  Layer 1: SQLite WAL mode                            │
  │   • Atomic per-statement writes                      │
  │   • Crash-safe (WAL journal recovers on restart)     │
  │   • Single source of truth for every read            │
  │   • If this layer fails, the app is unusable —       │
  │     ErrorBoundary + Alert, no automatic recovery.    │
  └─────────────────────┬────────────────────────────────┘
                        │ write succeeds → row is durable
                        ▼
  ┌──────────────────────────────────────────────────────┐
  │  Layer 2: schedulePush() / pushAll                   │
  │   • Debounced 5s push, retried on next write         │
  │   • Failed batches log + retry next push             │
  │   • last_error stored in sync_meta per table         │
  │   • Self-healing: dirty rows stay dirty until        │
  │     they push successfully.                          │
  └─────────────────────┬────────────────────────────────┘
                        │ best-effort
                        ▼
  ┌──────────────────────────────────────────────────────┐
  │  Layer 3: Reconcilers + scanners                     │
  │   • Pure functions wrapped in try/catch              │
  │   • Failures logged, never thrown into UI            │
  │   • Self-healing: next commit re-runs the diff       │
  │   • reconcileTodoMetaForEntry, scanTodosFromText     │
  └─────────────────────┬────────────────────────────────┘
                        │ best-effort
                        ▼
  ┌──────────────────────────────────────────────────────┐
  │  Layer 4: AI calls + network                         │
  │   • Wrapped in try/catch at every call site          │
  │   • Caption failure ≠ summarize failure              │
  │   • Classifier failure ≠ todo creation failure       │
  │   • User-initiated calls surface error in UI;        │
  │     background calls log + skip.                     │
  └──────────────────────────────────────────────────────┘
```

## Concept 1 — Optimistic UI with implicit rollback

**Shape.** Three pieces: the user gesture (toggle a todo, check a habit), `database.ts` writes the new state to SQLite, the React state setter fires from the parent's `onChanged` callback that re-queries the DB.

**Rule.** The "optimism" is buying speed by writing to SQLite first instead of awaiting the cloud. The "rollback" is *automatic* — if the SQL write fails, `database.ts` throws, the calling screen's catch logs, and the parent's `onChanged` either doesn't fire (no re-render, the user sees the pre-tap state) or fires and reads the same state back from the DB.

**Failure mode.** A naive optimistic UI mutates a React state cache *before* writing, then reverts on error. The failure: if the React revert fires after the user has interacted with another row, the revert can land mid-second-interaction and the state machine gets confused — the user toggles A then toggles B; A's revert fires later, and the user sees A snap back unexpectedly while B is mid-flight. With "DB-first" optimism, there's no React state to revert — the DB *is* the source. The user toggles A, the DB write fails, the UI shows A in its prior state because the DB still says so. No mid-flight surprises.

**Contrast.** The journal screen *does* hold local state for the `TextInput`'s value (the controlled input pattern requires it) and writes through to SQLite on each keystroke. There's no rollback path because there's no external system that can disagree with the device — SQLite is the only writer for the journal's text field. The constraint that distinguishes: the journal is single-author always (only the user types prose); the dashboard's mutations could in principle race with a cloud pull (which writes the DB). The rollback model has to assume the latter case.

## Concept 2 — Error boundaries at the React tree root

**Shape.** Three pieces: `<ErrorBoundary>` from `src/components/ErrorBoundary.tsx` wraps `<AppContent>` in `app/_layout.tsx`; the database-error path shows an `Alert.alert` with the failure reason; the loading path shows a spinner instead of the full app while `useDatabase().ready` is false.

**Rule.** A render-time exception in any screen is caught by the root error boundary and rendered as a fallback screen with a message. The DB-open failure is caught earlier, by the boot sequence, and surfaced as an Alert.

**Failure mode.** Without a root error boundary, a thrown error from any component crashes the React tree and on Android shows the white-screen-of-death (`RNRedboxView` in development; an empty native view in production). The user has to force-quit and reopen, possibly losing in-progress writes (though the DB-first model means recent keystrokes are saved). With a boundary, the crash becomes a recoverable state — the boundary renders an apologetic fallback, the user can navigate away, the next focus event re-renders the screen and likely succeeds.

**Contrast.** The cloud sync layer doesn't use an error boundary because it's not a React component tree — it's a service layer. It uses try/catch at every call site. The constraint that distinguishes: error boundaries catch *render* errors (componentDidCatch lifecycle); they don't catch errors in event handlers, async callbacks, or `useEffect` cleanups. The sync layer is entirely async-callbacks, so try/catch is the only mechanism.

## Concept 3 — Self-healing reconciliation

**Shape.** Three pieces: `reconcileTodoMetaForEntry` (wraps a try/catch around the diff logic and swallows on error), the journal screen (calls reconcile after each commit but doesn't await the result for UI purposes), and the `useFocusEffect` on dashboard / `/todos` (re-reads `getAllTodoMetas` on focus, which surfaces any inconsistency as a UI symptom).

**Rule.** Reconciliation failures are *transient* — the next reconcile call sees the same diff and patches it. There's no "broken state" that requires intervention; there's only "haven't reconciled yet." Eventual consistency on the next commit.

**Failure mode.** A non-self-healing version would mark the entry as "needs manual fix" or block writes until the prior reconcile succeeded. The failure mode of *that* model: a transient SQLite lock fail (rare but real on Android during heavy device load) leaves the entry in "needs manual fix" forever, even though the next attempt would succeed. The user has no UI for "manually reconcile," so the entry's todos drift from `todo_meta` until they restart the app or trigger another commit. Self-healing means every commit is its own consistency point — flaky failure modes are absorbed.

**Contrast.** The cloud sync layer is also self-healing for push failures (dirty rows stay dirty), but it tracks `last_error` per table in `sync_meta`. The constraint that distinguishes: sync errors persist because the *cause* might persist (network down, Supabase outage, key expired). Reconciler errors are within-process and within-second; if it failed once it'll likely succeed in 100ms. So sync gets a status indicator and reconciliation gets nothing — the failure profiles are different.

## Concept 4 — Async error isolation in AI calls

**Shape.** Three pieces: `summarize()` returns `{ summary: AISummary | null, error?: string }` instead of throwing; the caption sub-call is wrapped in its own try/catch inside `summarize` so caption failures don't fail the structured summary; the screen-level call site checks for error and renders a toast or a quiet log.

**Rule.** Every AI call is fail-soft. The return type is an object with a discriminated success path (`summary !== null`) and a discriminated error path (`error: string`). Throwing is reserved for programmer errors (missing required field), not runtime errors (network down, API rate limit).

**Failure mode.** "Throw on error" looks tidier in TypeScript but creates cascading failures. If `summarize` throws when the network is down, and the editor's compose flow doesn't catch, the editor screen crashes. If the boot-time auto-summarize in `app/_layout.tsx:96` throws, the boot sequence stalls until the catch block higher up logs it. Returning an error object forces every call site to handle the error explicitly — usually by skipping the operation and continuing. The boot-time auto-summarize literally just `console.warn`s and moves on; the editor's manual compose surfaces a small "AI unavailable" pill.

**Contrast.** The DB layer in `database.ts` *does* throw on error. SQL errors propagate up. The constraint that distinguishes: a DB error means the canonical store is broken — there's no graceful continuation. Either the DB is recoverable (the screen-level error boundary catches and shows a fallback) or it isn't (the root boot-time DB-open failure fires an Alert). Network-layer errors are *expected* in the lifecycle of the app; storage-layer errors are *exceptional*. They warrant different handling.

## Three interview questions

### `[mid]` — "What happens when the user toggles a todo offline and then comes back online?"

Walk through the flow. The user is offline; they tap the checkbox in `SmartTodoList` on the dashboard. The component calls `updateTodo(t.entryId, t.id, { done: !t.done })` from `src/services/todos/crud.ts`, which calls `updateEntry` in `database.ts` to update both `entries.todos_json` (the canonical record) and rewrites the `[]`/`[x]` line in `entries.text` via `rewriteTodoLine`. The SQL UPDATE bumps `updated_at`, clears `synced_at`, and the function returns. `schedulePush()` fires; the 5-second timer counts down; when it fires, `pushAll()` walks the registry, hits the entries table, runs `localQueryDirty`, sees the row is dirty, attempts the upsert, fails with a network error, and the failure is recorded in `sync_meta.last_error['entries']`. The row stays dirty (no `synced_at` stamp).

The user sees the toggle's effect immediately because the DB-first write means the dashboard's next render reads `done: true` from SQLite. There is no spinner, no rollback, no "try again" message. From the user's perspective, the toggle worked. They keep using the app offline.

The user comes back online. The next time anything writes (a new keystroke in the journal, a habit toggle, etc.), the new write fires `schedulePush()` again. 5 seconds later, `pushAll` runs, the dirty `entries` row is still in the dirty query, the upsert hits the now-reachable Supabase, succeeds, and `localMarkSynced` stamps `synced_at`. From the user's perspective, nothing visible changes because the row was already shown as toggled. The cloud is now in sync.

If they came back online without making any new write, the next `schedulePush()` doesn't fire. The cloud stays out of sync until the next write. That's a real gap — I'd want a "boot-time push" that fires unconditionally (which `app/_layout.tsx:80` actually does on cold start) but no "network-came-back" trigger mid-session. A network-status hook from `expo-network` would close that loop; it's on the deferred backlog because the boot-time push handles 95% of cases (users tend to restart the app after a long offline stretch).

### `[senior]` — "How would you debug a sync failure where one user's writes aren't reaching the cloud?"

Step 1: Open the dev menu in `settings/cloud-sync` (visible after a hidden tap sequence) and check the per-table `sync_meta` ledger. `last_pull_at`, `last_push_at`, `pending_pushes`, `last_error` are all there. If `last_error` is populated for a table, that's the smoking gun — usually it'll be a schema mismatch (cloud is missing a column the local row has) or an auth failure.

Step 2: Run the `localQueryDirty` for the suspect table from the dev menu's "diff" action. It returns the rows the local DB thinks are dirty. If the count is 0 but you expected dirty rows, the bug is local — `updated_at` isn't being bumped on the write path. If the count is high (hundreds), pushes are being attempted but failing — the bug is between the local row and the cloud row.

Step 3: For a specific dirty row, look at the difference between local and cloud. The dev menu's "compare" action takes a row ID and pulls both the local and cloud versions, side-by-side. Mismatches usually fall into three categories: (a) the local has a field the cloud schema doesn't accept (forgot to write a Supabase migration), (b) the cloud has a field the local mapper isn't consuming (forgot to update `cloudToLocal` after a migration), (c) timestamps are skewed (the local's `updated_at` is older than cloud's, so `chooseWinner` picks cloud, and the local "dirty" row gets overwritten on the next pull).

Step 4: If steps 1-3 don't surface the bug, dump the SQL by enabling `EXPO_SQLITE_DEBUG`. The SQL will show every UPDATE and SELECT; you can usually spot the missing `updated_at` bump or the malformed mapper output by reading 30 lines of log.

The reason I have this debugging path baked in: I built it because I was the one debugging the cloud sync M0-M7 milestones. Every time I hit a sync bug, I added the corresponding dev-menu action so the next bug would be diagnosable in <5 minutes instead of 30. The dev menu in `src/services/sync/devActions.ts` is one of the most valuable pieces of the codebase even though no normal user touches it.

### `[arch]` — "How does the reliability story change at 100K users?"

Three meaningful changes.

First, **observability becomes mandatory.** Today's reliability story relies on me being the user — when something fails, I notice on my next session and debug from the dev menu. At 100K users, I need server-side telemetry: every failed push emits an event with anonymized metadata (table name, error class, retry count, time-since-last-success); a dashboard surfaces error rates per table per region. The architecture grows a `reportError` hook that fires from every catch in the sync layer and the AI layer. On-device, that's an event queue that flushes opportunistically — failure to report doesn't fail the operation that emitted it.

Second, **per-user backpressure on the cloud.** The current 5-second debounce works when there's one user pushing per device. With 100K users across millions of devices, a thundering-herd push at 9am Monday morning when everyone opens the app is a denial-of-service against my own Supabase project. The architecture grows jitter: `schedulePush` adds a random 0-2s offset on top of the 5s debounce, so concurrent pushes naturally smear. At higher scale, the per-user push rate is capped by the server — if a user has been pushing 60 times an hour, the next push is delayed (server returns a soft rate-limit code, the client backs off exponentially).

Third, **per-table failure independence.** Today, if `entries` push fails, the orchestrator continues to the next table — but if the failure is a Supabase project being entirely down, every table fails for the same reason and we burn requests. The architecture grows a *circuit breaker*: after N consecutive failures across all tables, push is paused for M minutes. The user-visible effect: a "syncing paused due to repeated failures, retrying in X minutes" indicator. This is a reliability/cost tradeoff — without it, pathological failure modes (like an expired auth token) burn 720 retries per hour per user; at 100K users that's 72M API calls a day for nothing.

What stays. The local-first model — that's the foundation, doesn't change. Self-healing reconciliation — also stays, it's already O(1) per commit. Soft delete via `deleted_at` — stays, no scale at which hard delete becomes correct. The DB-first optimistic-write pattern — stays, because the failure modes are already correct.

## The hard question — "What's missing from the reliability story that you know is missing?"

Three things I know are missing and haven't built. Listing them honestly is more useful than pretending the system is complete.

First, **no server-side observability.** I have no telemetry on the AI failure rate, the sync failure rate, the per-user push success rate, or the boot-time error frequency in production. If a Claude model bump regressed compose quality for 20% of users, I would not know until someone told me. The work to fix this is a `reportError` shim, an Anthropic / Sentry / PostHog integration, and a small dashboard. It's on the deferred backlog. The reason it's not done: I'm the only user, my own console logs are the telemetry. That breaks the second a real user joins.

Second, **no boot-time integrity check.** SQLite is durable across crashes via the WAL journal, but it can develop subtle inconsistencies — say, a `todo_meta` row whose `entry_id` doesn't reference any extant entry. Today there's no startup pass that scans for these. The reconciler covers the journal-screen case (entry → its todo_meta), but doesn't cover the inverse (todo_meta → its entry). A migration that wrote bad data, or a partial SQL transaction (rare in WAL mode but possible on storage failure), could leave a phantom row. The fix is a `verifyIntegrity` function called from `app/_layout.tsx` boot sequence that runs the inverse diff and either auto-fixes or surfaces a one-time alert. Not built; not yet hit in practice.

Third, **no recovery story for a corrupted SQLite file.** If the WAL gets corrupted (rare but real — an OS crash mid-checkpoint, an Android Update reaping the file), the app's startup sequence either fails to open the DB and shows the Alert, or worse, opens it with garbage and silently corrupts the user's data. The fix is a periodic backup (export the DB file to device storage daily, retain N copies) plus a "restore from backup" UI. The cloud is supposed to be the recovery path, but it's only a partial mirror — local-only fields like `synced_at` and `sync_meta` aren't there, and a clean re-pull would lose the user's `position` reorder. So the cloud is a partial recovery, not a complete one. Full local backup + restore is on the backlog and is the right answer for production.

The decision pattern: the reliability story is *good enough for solo daily-vlogging*. It's *not yet good enough for someone whose data I'm responsible for*. The gap between the two is a list of three concrete projects, all known, all deferred consciously. I'd rather articulate the gap than paper over it.
