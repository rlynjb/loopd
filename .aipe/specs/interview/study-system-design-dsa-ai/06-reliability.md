# Chapter 6 — Reliability and Error Handling

## Opening — what you're looking at

Reliability in loopd is structured around one principle: a typed character must be durable before the user looks away. Everything else is recoverable. The vlog export can fail and the user can re-export. The AI summary can fail and the user can re-tap. The cloud sync can fail and the next push retries. But a half-typed sentence in a journal entry has no source-of-truth other than the device's RAM, and there's no "retry" for a thought.

That principle drives three observable patterns. First, DB-first autosave (rule 3 in `.aipe/project/rules.md`) — every keystroke commits to SQLite before any state change that could be interrupted. Second, two-pass scanners run only at commit boundaries (focus blur, screen leave) so that mid-keystroke ambiguity never produces partial typed records. Third, fire-and-forget reconciliation — `reconcileTodoMetaForEntry` and the threads/nutrition scanners return Promises that the caller doesn't await, so a slow scanner never blocks the user's next interaction.

Errors are classified by where they can fail. The local DB layer doesn't fail under normal conditions (SQLite is rock-solid; the only failure mode is "device storage full," which surfaces a separate error path). The network layer fails routinely and is wrapped in `try/catch` with `console.warn` logging — pushes retry on the next commit, pulls retry on the next boot. The LLM layer fails irregularly (rate limits, timeouts, malformed JSON) and is handled at the call site: classifier failures are silent, expansion failures surface to the UI, summary failures degrade to the structured-summary fallback. There is no centralized error reporting service yet (no Sentry, no Bugsnag); errors are visible in `adb logcat` during development and silent in production. That's a known gap.

### ASCII diagram — optimistic UI flow with rollback

```
   User taps "toggle done" on a SmartTodoList row in app/index.tsx
                │
                ▼
   ┌────────────────────────────────────────┐
   │  Local state update (optimistic)       │  - row strikes through
   │  setTodos([...])                       │    immediately
   └────────────┬───────────────────────────┘
                │
                ▼
   ┌────────────────────────────────────────┐
   │  updateTodo(id, { done: true })        │  src/services/todos/crud.ts
   │   ├─ rewriteTodoLine in prose          │   1. updates entries.text
   │   ├─ updateEntry(entry.id, { text })   │   2. fires scanner suite
   │   └─ schedulePush()                    │   3. queues 5s cloud push
   └────────────┬───────────────────────────┘
                │
        ┌───────┴───────┐
        │               │
   ┌────▼────┐     ┌────▼────┐
   │ success │     │  fail   │  (e.g. SQLite write fails — rare)
   └────┬────┘     └────┬────┘
        │               │
        │               ▼
        │   ┌────────────────────────────┐
        │   │ catch block in updateTodo  │
        │   │  → reload entries from DB  │   refetch is the rollback;
        │   │  → setTodos(reloaded)      │   local state matches DB truth
        │   │  → console.warn(err)       │
        │   └────────────────────────────┘
        ▼
   No-op — state already matches the new DB value.
   Next sync ledger entry stamps synced_at on success.

   Cloud push lifecycle (independent):
   schedulePush → 5s debounce → pushAll → per-row upsert
        │
        ├─ success: stamp synced_at
        └─ fail: write sync_meta.last_error; next push retries
```

The optimistic update is the user-visible action; the rollback path on failure is "refetch and accept truth." There is no offline-write-replay queue because the local DB *is* the offline queue — if the local write succeeds, the data is durable; if the local write fails, the user sees the original value because we refetched.

---

## Concepts (four-part structure)

### 1. Focus cleanup safety

**Shape.** Three pieces interact during a screen blur on the journal: a `useFocusEffect` cleanup function on the screen, the `liveTextRef` holding the latest typed value, and any pending auto-commit timer (debounced or focus-blur-triggered).

**Rule.** Focus cleanup may not clear `liveTextRef` (rule 5 in `.aipe/project/rules.md`). It may stop timers and fire any pending commit, but the ref itself stays populated until a successful commit replaces it. Empty-entry cleanup (deleting an entry whose text became empty) only runs on explicit page loads, never inside a sync handler or focus callback.

**Failure mode.** A past version cleared `liveTextRef` in cleanup, racing with the auto-commit timer. The race produced the sequence: timer fires → reads ref → ref is empty → commits empty text → real text is lost. Reproducible on screen-rotate-into-blur. The fix was rule 5; the bug is the reason the rule exists.

**Contrast.** The vlog editor's `useFocusEffect` cleanup *does* clear local state (the trim handles, the active overlay) because the editor's state is rebuilt from the `projects` table on remount. The constraint that distinguishes them: the journal's ref holds data not yet in any other store; the editor's state is a view of data that's always in the DB.

### 2. Sync error isolation

**Shape.** Three layers handle a sync push failure: `pushAll()` in `src/services/sync/orchestrator.ts` walks per-table adapters and try/catches each, the `sync_meta` ledger records `last_error` per table on failure, and the next `schedulePush()` re-runs every dirty row regardless of which table failed last time.

**Rule.** A push failure for one table doesn't block other tables' pushes. The orchestrator continues to the next table after logging the error. Rows that failed to push retain `synced_at = NULL`; the next push picks them up. The user sees no error indicator unless they navigate to `/settings/cloud-sync`, which surfaces the per-table `last_error` for inspection.

**Failure mode.** Without per-table isolation, a Supabase deploy that breaks one table's RLS or column shape would block sync for *all* tables. Users would lose backup coverage on healthy data because of an issue with one schema. With isolation, a broken table accumulates dirty rows locally while the rest sync normally; once the broken table is fixed server-side, the next push catches up.

**Contrast.** The summarize chain in `src/services/ai/summarize.ts` has stricter isolation — the relatable caption call is wrapped in `try/catch` *inside* the summarize function so that a caption failure doesn't fail the structured summary, but the structured summary failure *does* fail the whole call. The constraint that distinguishes them: each table's sync is independent (different rows, different schemas), so isolation makes sense; the structured summary is the contract for the editor, so a failure has to surface.

### 3. Backfill idempotency via SecureStore gate

**Shape.** Three pieces define a one-time backfill: the migration function in `src/services/<domain>/migrate.ts`, the SecureStore key (`drops_backfill_v1_done`, `nutrition_backfill_v1_done`, `todo_meta_backfill_v1_done`, `habits_cadence_backfill_v1_done`, `thread_mentions_backfill_v1_done`), and the boot sequence in `app/_layout.tsx` that checks the gate before running.

**Rule.** Every prose-derived feature ships with a one-time backfill that picks up markers in pre-existing entries. The backfill is gated by a SecureStore flag (`<feature>_backfill_v<N>_done`) that flips to `'true'` on success. If the flag is set, the function returns immediately. If it isn't, the function runs the full backfill and sets the flag at the end.

**Failure mode.** Without the gate, every cold boot re-scans every existing entry for backfill markers. At 200 entries × 5 backfills × every boot, that's a measurable startup cost. With the gate, each backfill runs exactly once per device per major version. The flag is per-version so a v2 of the same feature can ship a new backfill (`thread_mentions_backfill_v2_done`) without conflicting with the v1 record.

**Contrast.** The classifier catch-up at boot is *not* gated by a SecureStore flag because it's bounded by an indexed query — `SELECT … FROM todo_meta WHERE classifier_confidence IS NULL AND deleted_at IS NULL`. If the query returns zero rows, the catch-up does nothing. The constraint that distinguishes them: backfills walk every entry's prose (unbounded by index), so they need an explicit "done" gate; the catch-up walks an indexed subset of meta rows, so the index *is* the gate.

---

## Interview questions

### [mid] What happens if the user types into the journal while the device has no internet?

**Model answer.**

The keystroke path is unchanged. `onChangeText` writes to `liveTextRef`, calls `updateEntry()` against local SQLite, and `schedulePush()` queues a 5-second debounced cloud push. The local write succeeds in milliseconds because SQLite is on-device. The user sees no difference — no spinner, no error, no offline indicator. The journal is fully usable offline because all reads and writes hit local SQLite.

The cloud push fires after the debounce. With no internet, the Supabase HTTP request fails. The error is caught in `pushAll()`, logged via `console.warn`, and the failed table's `last_error` is recorded in `sync_meta`. The dirty rows keep `synced_at = NULL`. When connectivity returns, the next `schedulePush()` (triggered by any subsequent edit) re-runs the push and catches up the dirty rows. There is no separate "drain queue" code path — the dirty-row query *is* the queue.

The user can verify in `/settings/cloud-sync` which shows per-table sync status. In normal use, they wouldn't notice the offline period at all.

### [senior] How would you detect a corrupted SQLite file on cold boot?

**Model answer.**

I don't, currently. SQLite has been resilient enough that I haven't built corruption detection. The closest thing to it is the migration runner at the top of `src/services/database.ts`, which runs `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN` on every boot — those would throw if the schema were corrupted, and an unhandled throw in `useDatabase` would surface to the error boundary in `app/_layout.tsx`.

What I'd build first: a boot-time integrity check that runs `PRAGMA integrity_check` (returns `'ok'` if the file is healthy, or a list of errors). If it fails, the app shows a recovery screen with two options — "reset local from cloud" (calls `firstPullFromEpoch` in `src/services/sync/firstPull.ts` to rebuild local from Supabase) or "export raw data" (dumps the raw SQLite file to DCIM for the user to send for support). The first option is already implemented as a dev menu action; the recovery flow would just expose it as a user-facing path.

The deeper answer: corruption recovery in a single-user mobile app is bounded by what the cloud has. With cloud sync working, the worst case is "lose every write since the last successful push" — at most ~5 seconds of data given the debounce. Without cloud sync (Phase A pre-bootstrap), the worst case is total loss. That's the strongest argument for getting users into cloud sync ASAP after install — `bootstrapCloudSync()` runs on first boot specifically to close that vulnerability window.

### [arch] Build me the on-call runbook for the day this app gets featured and 100k users sign up.

**Model answer.**

The first thing that breaks is *not* the app — it's the AI provider rate limits. Every device makes Anthropic / OpenAI calls directly using the user's key. At 100k installs, most users won't have set up an AI key, so the surface is degraded but not down: the journal works, dashboard works, sync works, classifier shows the "no AI configured" banner, expansion is disabled, vlog summary returns a no-op. That's actually the *best* failure mode because it doesn't hit any shared infrastructure.

The second thing that breaks is Supabase. At 100k users × ~10 rows/sec average write rate per active user × 5% concurrent active = ~50k writes/sec at peak. The free tier won't carry that. The runbook would be:

1. Pre-launch: stress-test the schema with `pgbench` — particularly the `entries` and `thread_mentions` upserts, which are the highest-volume. Confirm the `(user_id, id)` unique index handles the conflict path under load.
2. Launch hour: monitor Supabase per-table write latency and the `last_error` distribution in client logs. A common error class would be "connection limit exceeded" — Supabase pgbouncer caps active connections, and the SDK opens one per request. Move to a connection-pooled deployment.
3. Day one: identify the top users by row count and validate that pull pagination (`updated_at ASC`, `LIMIT 1000`) is not running unbounded for power users with backfills. Add a `LIMIT` cap on the pull side and a "restore from cloud" path that's chunked.
4. First incident: a user reports "my journal lost a paragraph." Walk back: do they have cloud sync configured? Does Supabase have the row? Is `synced_at` populated? Is the local row newer than the cloud (LWW lost)? The answer is one of three: device crashed before debounce push, sync was failing silently, or cross-device LWW resolved against them. The first two are bugs; the third is a known limitation.

What I'd add before launch: a Sentry or equivalent (the project has none today) so client errors are aggregated. A telemetry hook in `pushAll()` that reports per-table push latency and error rate to a serverless endpoint so I can see sync health without each user having to check `/settings/cloud-sync`. A feature flag system (Supabase has remote config patterns) so the AI surfaces can be hard-disabled if a provider is having an outage. The structural reliability of the app is fine for 100k users; what's missing is the *observability* I'd need to know it's fine. That's the gap.

---

## The hard question

### "You have no automated test suite, no CI, no error reporting. How do you sleep at night?"

**Model answer (≥200 words).**

I sleep at night because the blast radius of a bug in this app is one user — me — and the data is durable on the device before any layer that could fail gets involved. That's a deliberate property of the architecture: the keystroke commits to local SQLite before React renders, before sync runs, before any LLM call. A bug in the frontend, a bug in sync, a bug in the AI surface — none of them can lose data that's already on disk. The worst they can do is fail to display it, fail to back it up, or produce a wrong derived row. All three are recoverable.

The bigger answer is: the architectural rules in `.aipe/project/rules.md` and `docs/spec.md` §10 are the test contract. There are 12 principles. They were written down because each one corresponds to a specific failure mode I've seen or a specific cost I'm not willing to pay. When I touch code, I touch a rule. The "test" is whether the change still satisfies the rule, and TypeScript strict mode catches the largest class of violations automatically.

What this misses, honestly: regression coverage and observability. A regression in `scanTodos` two-pass matching that doesn't break the happy path could ship undetected. I'd write property-based tests for the three scanners first if I were investing test infrastructure — they're pure functions, easy to test. I'd add Sentry next so client errors are visible. I'd add per-table sync telemetry so silent-fail patterns can be caught. None of this is in v1 because the cost of a regression in single-user mode is bounded by "I notice it tomorrow and fix it." At multi-tenant scale where my users wouldn't tolerate that, the answer flips: tests and observability become preconditions for ship, not deferred work.

The question I take seriously: am I deferring this work because it's genuinely not the highest priority, or because writing tests is less fun than writing features? Some of the deferral is the latter. I name it because lying to myself about it would be the worst version of this answer.
