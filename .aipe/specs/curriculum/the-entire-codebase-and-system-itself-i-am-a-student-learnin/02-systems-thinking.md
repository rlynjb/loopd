# 02 — Systems thinking in loopd

This is the chapter where loopd is **richest**. The codebase has a small, sharp set of architectural principles (twelve of them, listed in `docs/spec.md` §10) and most of the interesting design decisions trace back to one of those principles. This is also the most transferable category — the patterns here apply equally to backends, distributed systems, and any app with derived state.

If you only read one chapter, read this one.

---

## 2.1 Single source of truth (SQLite is canonical)

**Difficulty:** foundational

**What it is.** A discipline that names exactly **one** datastore as the authoritative answer to "what is true?" Every read goes there; every write commits there first. Other stores (in-memory caches, cloud mirrors, derived views) are downstream and may be stale.

**Where it lives.** Architectural Principle 1 in `docs/spec.md` §10. In the code:

- **The DB layer** at `src/services/database.ts` exposes typed CRUD for all 11 tables. There is no other authoritative store.
- **UI components** read from the DB via custom hooks (`src/hooks/useEntries.ts`, etc.). They do not hold parallel state.
- **The cloud sync layer** in `src/services/sync/` writes to Supabase as a **mirror** — never as the source. The relevant reading paths in `pull.ts:80-101` always upsert *into* the local DB; cloud is read-only as a source.
- **Comment in spec §10:** *"UI displays exactly what's in SQLite — no frontend filtering, no hiding via conditional rendering."*

**Why it exists.** Multiple sources of truth produce divergence bugs. If the UI hides a row but the DB still has it, deleting that row from a different screen leaves an orphan. If the cloud has a different value than local, which one wins on next save? Single-SoT collapses these questions: there is one answer, and the system is structured so you can always go look at it.

**General rule.** Pick one store as the source of truth. Make every other surface a function of that store. When two surfaces disagree, the SoT wins by definition — the disagreement is a bug somewhere downstream, not an open question.

---

## 2.2 Derived state vs. canonical state (prose-as-canonical for drops)

**Difficulty:** foundational

**What it is.** A pattern where the user-facing data (what they typed) is canonical, and all the structured records (todos, nutrition, mentions) are **derived** from it by deterministic scanners that re-run on every commit.

**Where it lives.** Architectural Principle 2 in `docs/spec.md` §10:

> "Prose is canonical for drops. `[]` lines, `** … kcal` lines, and `#tag` mentions in `entries.text` are the source; `todos_json`, `todo_meta`, the `nutrition` table, and `thread_mentions` are derived. Round-trips (e.g. dashboard toggle → prose rewrite) keep prose authoritative."

The three scanners:
- **Todos:** `src/services/todos/scanTodos.ts:53-125` (`scanTodosFromText`).
- **Nutrition:** `src/services/nutrition/scanNutrition.ts`.
- **Threads:** `src/services/threads/scanThreads.ts:37-56` (`parseTags`) + `:65-100` (`resolveTagsToThreadIds`).

The **round-trip** is what makes "prose-canonical" actually work: when the user toggles a todo's done state on the dashboard, `rewriteTodoLine()` at `scanTodos.ts:139-181` rewrites the matching `[]` line in the entry's prose to `[x]` (or vice versa). After the round-trip, prose still tells the truth.

**Why it exists.** Without this discipline, the journal would have two sources of truth — the prose the user typed, and the typed records derived from it. Edits to either side would have to sync to the other, and the sync logic would slowly accumulate edge cases. Naming prose as canonical (and making structured records strictly derivable) collapses that complexity: scanners are pure functions; round-trips are surgical; if scanners broke and you re-ran them, you'd get the same structured records back.

**General rule.** When you have a freeform input (prose, markdown, a config file) and a structured derivation (records, queries, indexes), name the input as canonical and treat the derivation as **rebuildable from scratch at any moment.** This is a strict discipline — it forbids the structured side from holding state the prose can't reproduce — but the payoff is enormous: you can rebuild, re-scan, and roll forward without fear.

---

## 2.3 Two-pass matching (preserve identity through edits)

**Difficulty:** intermediate

**What it is.** A scanner pattern that reconciles parsed-from-prose records against existing-in-DB records by trying two matching strategies in order: exact content match, then line-index fallback. This preserves stable identity (UUIDs, timestamps, classifier outputs) across in-place text edits.

**Where it lives.** Architectural Principle 7 in `docs/spec.md` §10. Three implementations:

1. **Todos** at `src/services/todos/scanTodos.ts:64-88`:
   - Pass 1 — exact text match (case-insensitive, trimmed). Catches unchanged lines and reorderings.
   - Pass 2 — line-index fallback. For unmatched parsed lines, find an existing todo whose `sourceLine` points at that index. Handles "I edited the words but it's still on line 4."
   - Anything left over: parsed-side becomes a fresh todo (new UUID); existing-side becomes a carryover (preserved, but `sourceLine` cleared).

2. **Nutrition** at `src/services/nutrition/scanNutrition.ts` — same two-pass shape with `(name, kcal)` tuple as the exact key. Note: **unmatched existing nutrition rows are deleted**, unlike todos (which carry over). Per the spec: "nutrition rows correspond 1:1 to prose lines" — there's no "I'll undelete it" affordance.

3. **Threads** at `src/services/threads/scanThreads.ts` (and the matching reconcile logic in `services/threads/scanThreads.ts`):
   - Pass 1 — exact `(thread_id, source_line)` match.
   - Pass 2 — `(thread_id, tag_text)` within ±3 lines.

**Why it exists.** Without two-pass matching, every prose edit would create a new row and orphan the old one. That would discard `done` state, classifier output, expansion text, and `position` — all the work the user (and the AI) had invested in the *concept* the line represents. Two-pass matching encodes the intuition that "the same idea, re-typed, is still the same idea."

**General rule.** When you derive records from a freeform source, use two-pass matching: try the most-specific identity (exact content) first, then a positional fallback (line index, byte offset, sequence number). Anything still unmatched is genuinely new on one side or genuinely deleted on the other. The pattern is so general it should be your default the moment you're parsing anything that a user can edit.

---

## 2.4 Idempotent reconciliation (commit can re-run safely)

**Difficulty:** intermediate

**What it is.** A function that produces the correct end-state regardless of whether it has been called before. Calling it twice is the same as calling it once; calling it on a partially-completed prior run finishes the job.

**Where it lives.** `reconcileTodoMetaForEntry()` at `src/services/todos/reconcileMeta.ts:48-91`. The function:

1. Reads existing `todo_meta` rows for the entry.
2. Reads the entry's current `todos_json`.
3. For every TodoItem with no paired meta row → INSERT. (Already-present rows are untouched.)
4. For every meta row whose `todoId` no longer appears → DELETE.

Comment in the file: *"Self-healing: a failed reconcile leaves orphaned/missing meta rows; the next commit sees the gap via the same diff and patches it. Best-effort from the journal's perspective — never throws."*

**Why it exists.** The journal's entry editor calls this fire-and-forget on every commit. If the function crashed or was racy, repeated commits would either accumulate duplicates or leave permanent gaps. Idempotency means each commit is a complete transaction in intent: it converges the meta table to the correct shape, no matter what state it found things in.

**General rule.** Any function that reconciles a derived state from a source should be idempotent and safe to re-run. Test it by calling it twice in a row in any state and asserting the same end-result. This pattern is what makes "fire-and-forget" actually safe.

---

## 2.5 Soft delete with tombstones

**Difficulty:** foundational

**What it is.** Instead of `DELETE FROM table`, you `UPDATE … SET deleted_at = now()`. Reads filter `WHERE deleted_at IS NULL`. The row stays in the table as a tombstone, propagating its delete to other systems via normal sync.

**Where it lives.**
- The pattern is named in spec §6.11: *"Every CRUD delete stamps `deleted_at + updated_at`; reads filter `WHERE deleted_at IS NULL`; the deletion propagates to cloud as a normal sync event."*
- Conflict resolution treats `deleted_at` as just another field, and last-write-wins handles delete-vs-edit collisions. See `src/services/sync/conflict.ts:13-31` (the `Tombstoned` type and `chooseWinner`).
- Sync push/pull both treat tombstoned rows as normal data; see `pushTable` at `src/services/sync/push.ts:9-67` — there's no `WHERE deleted_at IS NULL` filter on dirty-row selection because the tombstone IS the change to push.

**Why it exists.** Three reasons in tension:

1. **Sync requires it.** A hard delete on Device A doesn't propagate to Device B in any way the sync logic can detect — Device B has the row, Device A doesn't, and the absence-of-a-row carries no timestamp. Without tombstones, Device B's next push would re-resurrect the row.
2. **Conflict resolution requires it.** "Edit on Device A, delete on Device B" is a real concurrency case. The newer-`updated_at` rule resolves it cleanly only because both sides write to a timestamped row.
3. **Recoverability.** The user can be given an "undo delete" affordance for free — the row is still there.

**Why it's *not* perfect (yet).** Tombstoned rows accumulate forever in v1. The spec at §6.11 calls this out as a v1.x candidate (a 30-day vacuum job is the obvious fix).

**General rule.** Soft delete is not optional once your data syncs across devices or users. Even single-device apps benefit from "trash → restore" affordances. The cost (an extra column, a `WHERE` filter on every read) is trivial compared to the bugs it prevents.

---

## 2.6 The sync orchestrator — push/pull as separate ordered passes

**Difficulty:** intermediate

**What it is.** A pattern for syncing many tables to a remote: define a `SyncableTable<TLocal, TCloud>` interface that each table implements; the orchestrator iterates a registry in a defined order, calling `push` on each, then `pull` on each.

**Where it lives.**
- Interface: `src/services/sync/types.ts:11-59`. Defines `pushOrder`, `pullOrder`, `cloudConflictColumns`, `localToCloud`, `cloudToLocal`, `localQueryDirty`, `localMarkSynced`, `localUpsert`. Each method is **narrow** — none of them know about other tables.
- Registry: `src/services/sync/orchestrator.ts:23-36`. A flat array of the ten implementations.
- Push: `src/services/sync/push.ts:9-67`. Generic over `TLocal`/`TCloud`. Does the batch/upsert/stamp.
- Pull: `src/services/sync/pull.ts:34-114`. Generic. Paginates by `updated_at ASC`, calls `chooseWinner`, upserts on cloud-or-tie.

**Per-table implementations** live in `src/services/sync/tables/*.ts` — one file per table, each ~100 lines of pure mapping code. See `tables/entries.ts` for the canonical example.

**Why it exists.** Without the abstraction, every new synced table would mean editing the orchestrator, the push code, and the pull code. With it, you write a 100-line file conforming to the interface and add it to the registry. The orchestrator is **closed for modification** but **open for extension**.

The push/pull *order* matters: parents before children (entries before todo_meta, threads before thread_mentions) so foreign-keyish references resolve in the right sequence.

**General rule.** When you need to do "the same operation, in a defined order, on N different things," reach for the **registry + interface** pattern. Each implementation is small and testable in isolation; the orchestrator becomes a one-page file that hardly ever changes.

---

## 2.7 Last-write-wins conflict resolution by `updated_at`

**Difficulty:** intermediate

**What it is.** A conflict-resolution strategy: when the same row exists on local and cloud with different `updated_at` timestamps, the newer one wins. Pure, deterministic, easy to reason about, easy to test.

**Where it lives.** `src/services/sync/conflict.ts:13-31` (`chooseWinner`). Twenty lines, no I/O, returns `'local' | 'cloud' | 'tie'`. Used by `pullTable()` at `pull.ts:85-101`.

The function **does not act** — it just picks. The orchestrator decides what to do with the answer:
- For incremental pull: tie goes to cloud (no work; we're already in the pull path).
- For push: tie goes to local (we're already in the push path).

That asymmetry is intentional: each path has cheap default behavior, and ties go to "no extra work."

**Why it exists.** LWW is the simplest conflict resolver that's correct enough for solo (single-user, multi-device) use. It can lose work in a true concurrent edit (the older edit is silently dropped), but the spec acknowledges this and notes that vector clocks would be the answer in Phase B (multi-user). For now, LWW is the right tool because:

- The user is the only writer — concurrent edits are rare.
- The cost of vector clocks (extra columns, extra logic, harder reasoning) is high.
- LWW handles the common case (sequential edits across two devices) cleanly.

**General rule.** Pick a conflict-resolution strategy that matches your concurrency profile. LWW is great for single-user; per-field merging is great for collaborative editing; vector clocks are great for distributed systems with no central authority. You should be able to **defend your choice** by naming what kind of concurrency you actually expect.

---

## 2.8 Server-time RPC for clock-skew safety

**Difficulty:** advanced

**What it is.** A round-trip to ask the server "what time is it on your clock?" — used as the timestamp for marking what you've synced, instead of the device's local clock.

**Where it lives.** `getServerTime()` at `src/services/sync/pull.ts:25-32`. Calls a Postgres RPC `get_server_time` (defined in `supabase/migrations/0003_server_time_rpc.sql`). The returned ISO timestamp is used as `last_pull_at` after a successful pull.

**Why it exists.** A real bug this prevents: device clock is 5 seconds slow. After pulling rows updated up to `2026-05-03T14:00:00Z`, the device stamps `last_pull_at = 2026-05-03T13:59:55Z` (its local time). Next pull queries `WHERE updated_at > '2026-05-03T13:59:55Z'` — and **re-fetches the same rows**, wasting bandwidth. Worse, if the clock drifts the other way, rows can be **missed**. Server time eliminates the question by anchoring all "have I seen this?" math to the server's clock.

**General rule.** When you're tracking "what have I seen from a remote system?", use timestamps **from the remote system**, not your own clock. Local clocks lie (drift, NTP catch-up, time zone bugs). The remote authority is the only one whose timestamps are coherent for its own data.

---

## 2.9 Bootstrap decision tree (initial-push vs first-pull vs no-op)

**Difficulty:** intermediate

**What it is.** A one-time decision, made on first cold-start after a feature ships, that picks between several startup paths based on the current state of the system.

**Where it lives.** `bootstrapCloudSync()` at `src/services/sync/bootstrap.ts:59-96`. The decision tree:

```
if !cloud_configured                  → skipped
if SecureStore flag already set       → skipped
if !localHasData() && !cloudHasData() → no-op
if  localHasData() && !cloudHasData() → initial-push (first device, fresh cloud)
if !localHasData() &&  cloudHasData() → first-pull   (recovery on a new device)
if  localHasData() &&  cloudHasData() → fallback to initial-push (Phase A heuristic)
```

The flag is `cloud_initial_push_done` in SecureStore; once set, normal incremental sync takes over.

**Why it exists.** The first time a sync feature ships, the system can be in several states — and each state needs a different action. Naming each state explicitly (rather than deciding implicitly inside the sync code) makes the boot path debuggable and reasonable. Also: the decision is **one-shot**; the SecureStore gate guarantees you can't accidentally repeat a destructive bootstrap.

The `both-populated` case is honest about its limits: in Phase A (single user), defaulting to local-as-canonical is the right call. The comment at `bootstrap.ts:88-91` flags that Phase B (multi-user) needs a UI prompt before any destructive action. **That's an exercise** — a good Phase B implementation would expose a "pick which side wins" dialog before the fallback runs.

**General rule.** When a one-time decision has multiple branches and each branch has a different cost, write the decision tree out explicitly with **named cases** and **a gate flag**. Don't fold the branches into other code — the explicit tree is debuggable; the implicit logic is not.

---

## 2.10 Debounced batching (5s push debounce)

**Difficulty:** intermediate

**What it is.** A pattern that defers an expensive operation by some window (here: 5 seconds) and resets the timer on each new call. The expensive operation fires once after activity quiets down, batching up the work.

**Where it lives.** `src/services/sync/schedulePush.ts:1-39`. Every write site in `database.ts` calls `schedulePush()`, which:

1. Clears any pending timer.
2. Sets a fresh 5s timer.
3. On fire, runs `pushAll()` — but if a push is already in flight, **re-schedules** so newest changes don't get stranded waiting.

**Why it exists.** The user types 50 keystrokes per minute on a heavy entry. Pushing on every keystroke would mean 50 round-trips per minute against Supabase — inefficient, expensive, racy. Debouncing collapses bursts of activity into one push event. The 5-second window is a deliberate trade: long enough to batch, short enough that "I closed the app right after typing" still gets the latest data up before the user backgrounds the app.

The **re-queue on in-flight** logic at `schedulePush.ts:23-27` is the subtle part — without it, edits that arrive mid-push would be silently lost (because the flag stayed at `pushing = true` when the timer fired again). The fix is small but load-bearing.

**General rule.** For any "do work in response to bursty user activity," debounce. Pair the debounce with a re-queue-on-in-flight check so concurrent user activity doesn't get stranded. Five seconds is a reasonable default; tune based on what's expensive about the work.

---

## 2.11 Race-safe focus cleanup (the "never clear live refs" rule)

**Difficulty:** advanced

**What it is.** A specific lesson, painfully learned: in React Native + expo-router, `useFocusEffect` cleanup callbacks can race with idle timers and other async work. Clearing in-memory refs (like `liveTextRef`) inside cleanup destroys data that hasn't been flushed to disk yet.

**Where it lives.** Architectural Principle 5 in `docs/spec.md` §10:

> "Never clear live refs in focus cleanup. `useFocusEffect` cleanups can race idle timers; clearing `liveTextRef` during cleanup caused past data loss."

Also Principle 4: *"Always read DB before deleting. Auto-commit timers and cleanup effects must verify the latest row state before deciding anything destructive."*

The DB-first autosave pattern (Principle 3) is the prevention: every keystroke writes to SQLite immediately. The ref is just a holdover for focus-blur logic. So even if the focus cleanup ran "wrong," the data is already safe in SQLite.

**Why it exists.** This is a war story converted to a rule. Earlier versions of the journal lost user-typed text when navigating away mid-edit. The root cause was a focus-cleanup callback that cleared a ref before the idle save timer had fired. Now: refs are never cleared; saves are DB-first; cleanups never delete.

**General rule.** When async operations and lifecycle callbacks coexist, the lifecycle callback is **always the loser** in race conditions. Never put destructive work in a cleanup. Save eagerly to a durable store; treat in-memory state as a transient mirror; let cleanups do nothing destructive.

---

## 2.12 Dynamic import to break circular dependencies

**Difficulty:** advanced

**What it is.** Using `await import('./module')` inside a function (instead of `import` at module scope) so module A can call module B even when module B imports module A.

**Where it lives.** `src/services/sync/schedulePush.ts:30-32`:

```ts
async function fire(): Promise<void> {
  // ...
  pushing = true;
  try {
    const { pushAll } = await import('./orchestrator');
    await pushAll();
  } // ...
}
```

The comment in the file:

> "Dynamic-imports the orchestrator to avoid a circular dependency (database.ts → schedulePush → orchestrator → tables/*.ts → database.ts). The import only resolves on fire, by which time everything else is up."

**Why it exists.** Every sync table implementation imports `getDatabase()` from `database.ts`. The orchestrator imports the table implementations. If `schedulePush.ts` (which `database.ts` imports) statically imported the orchestrator, you'd have a cycle. Dynamic import breaks the cycle by deferring the resolution to runtime, after all modules have loaded.

**General rule.** Circular imports usually mean your modules have a layering problem. Sometimes the layering is correct and the cycle is unavoidable (here: the sync system is genuinely entangled with the DB). In those cases, dynamic import is the right escape hatch — used sparingly, with a comment naming the cycle.

---

## 2.13 Migration-safe schema evolution

**Difficulty:** intermediate

**What it is.** A pattern for evolving a SQLite schema across app versions without breaking existing user data. Run `CREATE TABLE IF NOT EXISTS` for the latest shape; run `ALTER TABLE ADD COLUMN` (wrapped in try/catch for "already exists") for incremental columns.

**Where it lives.** `src/services/database.ts:53-120` (the start of `migrate`). Notice the pattern:

1. `CREATE TABLE IF NOT EXISTS` for every table — defines the shape on a fresh install.
2. `addColumn(table, col, type)` helper at line 108 — wraps `ALTER TABLE ADD COLUMN` in a try/catch that swallows the "duplicate column" error. Idempotent; safe to re-run on any install.

For Postgres (Supabase), the equivalent pattern lives in `supabase/migrations/000N_*.sql` files — versioned, run by `scripts/db-migrate.mjs`.

**Why it exists.** SQLite's `ALTER TABLE` is limited (no `IF NOT EXISTS` for columns; very narrow modification options). The try/catch wrapper is the cheapest way to make column-add idempotent. It also means the migration runs on every cold start without a separate "current version" table — the operations themselves are self-checking.

**General rule.** For local schema evolution, prefer **additive, idempotent** migrations: add a column, never drop one in v1; add an index, don't replace one. Wrap each step so re-running is a no-op. For server schemas, use versioned migration files (an integer prefix is fine) so you can audit what changed when.

---

## 2.14 The deletion queue (deferred delete propagation)

**Difficulty:** intermediate

**What it is.** A separate `sync_deletions` table that records delete intents for systems where the row itself can't carry a tombstone (because it's been hard-deleted or because the integration doesn't support tombstones).

**Where it lives.** Schema in `src/services/database.ts` (`sync_deletions` table). Comment in spec §6.11: *"`sync_deletions` was a Notion-era queue; no longer used."* — the table is preserved for back-compat but the cloud-sync rewrite uses tombstones directly.

**Why it exists.** Notion's API treats archive-the-page as the only delete-equivalent; the local app needed to remember which Notion page IDs to archive on next sync, even if the local row was hard-deleted. The queue persisted those intents. Now that cloud sync uses tombstones (which carry their own delete semantics), the queue is vestigial.

**The lesson.** Even patterns that turn out to be wrong are educational. The shift from "deletion queue" to "tombstones in the row itself" is a real architectural improvement — tombstones are simpler, don't need a separate table, and integrate naturally with last-write-wins. Recognizing when an old pattern is no longer load-bearing is part of systems thinking.

**General rule.** When you change *how* a thing works, audit whether the old supporting infrastructure (queues, flags, tables) is still needed. Vestigial tables are minor; vestigial logic is a debugging hazard.

---

## 2.15 Boundary discipline — what the DB layer does (and doesn't)

**Difficulty:** intermediate

**What it is.** A discipline where each layer of the stack has a clear responsibility, and **does not reach across** to do things that belong to another layer.

**Where it lives.** Look at the shape of `src/services/database.ts`:

- It exposes typed CRUD for every table.
- Every write to a synced table calls `schedulePush()` (line 6 import). That's the **only** non-DB thing the DB layer does.
- It does **not** scan prose. Scanners live in `src/services/{todos,nutrition,threads}/`.
- It does **not** fire AI calls. Those live in `src/services/{ai,todos}/{classify,expand,...}.ts`.
- It does **not** make UI decisions. Components decide what to render based on what the DB returns.

The journal commit flow is a cooperation across layers:
1. Component captures user input.
2. `useEntries.editEntry` (hook) writes to DB and fires the scanners.
3. Scanners read prose, write derived rows.
4. `reconcileTodoMetaForEntry` runs heuristic, fires LLM classifier (fire-and-forget).
5. `schedulePush()` (called from the DB writes) defers a push.

Each step is small, each step is testable, each step is a boundary.

**Why it exists.** Boundaries are where bugs hide. A scanner that secretly fires a UI update is harder to test than one that returns a value the caller decides what to do with. A DB layer that includes AI logic is harder to swap providers in than one that exposes typed data and lets callers decide.

**General rule.** Each layer does one thing. The DB layer stores and retrieves. Scanners parse and reconcile. AI services call models. UI components render. Hooks orchestrate. **Crossing boundaries is allowed, but reluctantly** — and crossings should be one-directional (lower layers don't know about higher layers).
