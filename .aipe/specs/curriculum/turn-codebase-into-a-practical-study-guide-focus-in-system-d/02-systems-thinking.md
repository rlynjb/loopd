# Chapter 02 — Systems thinking

This is the **system design heart** of the codebase. The patterns here are the ones an interviewer cares about: how data flows, where the truth lives, what happens when two writes race, why deletes are not deletes, and how a sync layer survives clock skew. Every concept below ships in production code you can open and read.

---

## 2.1 Local-first architecture: SQLite as canonical, cloud as mirror · `foundational`

**What it is.** All reads and writes hit the local database first. The network is *eventually* informed, never authoritative. The user's typed character is in their local DB before any network call begins. This is the local-first pattern (Ink & Switch coined the name; Apollo, Linear, Notion all use variants).

**Where it lives.**
- Architectural principle 12 in `docs/spec.md:463`: *"Cloud is a sync mirror, never the canonical source. Read paths always hit local SQLite. Write paths always commit local first; cloud lags by 5s via debounced push."*
- `src/services/database.ts` is the canonical store (every read filters `WHERE deleted_at IS NULL`; every write to a synced table calls `schedulePush()`).
- The 5s debounce: `src/services/sync/schedulePush.ts:9-20`.

**Why it exists.** On Android, on a phone, on a flaky train — the network is unreliable. Latency-blocking the UI on every save is a death sentence for the typing experience. By making the local DB authoritative, the user never waits for a server, and the cloud copy converges in the background. The honest tradeoff: conflicts are real (see §2.7) and you have to design for them.

**General rule.** When the user is producing data interactively, the device they typed it on owns the truth. Cloud is for backup, multi-device convergence, and recovery — never for the typing latency budget. If your read path goes through HTTP, you do not have a local-first app.

---

## 2.2 Single source of truth — DB-first, prose-canonical · `foundational`

**What it is.** Two layered "single source of truth" rules:
1. **DB is the SoT for the UI** — the screen shows exactly what's in SQLite, no frontend filtering or hiding.
2. **Prose is the SoT for derived records** — `[]` lines are the authority over `todos_json`; `** food N kcal` lines are authority over the `nutrition` table; `#tag` mentions are authority over `thread_mentions`. Anything derived rebuilds from prose at scan time.

**Where it lives.**
- Principles 1 + 2 in `docs/spec.md:452-453`.
- The round-trip enforcer: `src/services/todos/scanTodos.ts:139-181` (`rewriteTodoLine`) — when the user toggles a todo on the dashboard, the *prose* is rewritten so the journal still shows the current state.

**Why it exists.** A SoT must be one place. If the prose said `[]` but `todos_json` said `done`, there's no answer to "what is the truth?" By picking prose and forcing every dashboard interaction to round-trip back into prose, the contradiction is structurally impossible. The DB-first half of the rule is the same idea applied one layer up: the UI is not allowed to lie about what's stored.

**General rule.** Pick one source of truth per fact, write it down, and design every other surface to be a *projection* of it. Whenever a user-visible action mutates a derived value, mutate the source instead and let the derivation re-run. This is the journaling-app version of "single source of truth in Redux."

---

## 2.3 Two-pass scanner pattern (alignment-style record-identity preservation) · `intermediate`

**What it is.** A reconcile algorithm with two matching passes:
- **Pass 1 — exact match.** For todos: text content. For nutrition: `(name, kcal)` tuple. For threads: `(thread_id, source_line)`. Catches unchanged lines and reorderings.
- **Pass 2 — line-index fallback.** If pass 1 missed it, look for an existing record at the same `sourceLine` index. Catches in-place edits — `[] call mom` → `[] call dad` keeps the same `id` / `done` / `createdAt`.

This is a degenerate sequence-alignment algorithm: pass 1 is "match by content"; pass 2 is "match by position." Together they handle the four edit operations (insert / delete / update / reorder) with stable record identity.

**Where it lives.**
- Todos: `src/services/todos/scanTodos.ts:53-125` (`scanTodosFromText`).
- Threads: `src/services/threads/scanThreads.ts:169-227` (`reconcileMentions`). Note the threads pass 2 also allows ±3 lines drift (line 200) — looser than todos because mentions can shift more.
- Nutrition: `src/services/nutrition/scanNutrition.ts` (same idiom, exact `(name, kcal)` then line-index).

**Why it exists.** The naive reconcile (delete all, re-insert from text) would invalidate every `id`, every `createdAt`, every `done` flag on every keystroke commit. Users would lose state. The two-pass version preserves identity through arbitrary edits, which is what makes "the prose is the source of truth" actually liveable.

**General rule.** Whenever you derive records from a free-form text source, you need a reconcile algorithm that survives edits. Two passes — content-key first, position-key second — handles 99% of cases. A diff library (LCS-based) is the next step up if you outgrow this. **Architectural principle 7** (`docs/spec.md:458`).

> **Go deeper.** Read the comments in `scanTodos.ts:37-52` — they walk through the four edit cases (no change / reorder / in-place edit / new line) and show which pass catches each one. Then think about: what edit operation does *neither* pass catch? (Answer: a same-line edit that also changes the line index — e.g., the user inserts a blank line above and renames the todo. That degenerates into "carryover" — the unmatched todo stays in the array but with `sourceLine` cleared, line 119–122.)

---

## 2.4 Idempotent SecureStore-gated migrations · `foundational`

**What it is.** One-time backfills that read a flag from `expo-secure-store`, run if the flag is unset, then set the flag. Re-running the app re-checks the flag and short-circuits.

**Where it lives.**
- The pattern: principle 8 in `docs/spec.md:459`.
- The flags: `drops_backfill_v1_done`, `nutrition_backfill_v1_done`, `todo_meta_backfill_v1_done`, `habits_cadence_backfill_v1_done`, `thread_mentions_backfill_v1_done`, `cloud_initial_push_done` (see `docs/spec.md:74-79`).
- The threads backfill has an extra short-circuit when zero threads exist locally — re-checks on next boot until the user creates the first thread (`src/services/threads/migrate.ts`).
- The cloud-sync bootstrap is the same shape: `src/services/sync/bootstrap.ts:18` (`BOOTSTRAP_KEY = 'cloud_initial_push_done'`).

**Why it exists.** When you ship a new prose-derived feature, existing entries don't have the new derived rows. A one-time backfill scans the existing prose and creates the rows. The flag prevents the backfill from re-running on every boot, which would be both wasted work and (worse) potentially corrupt state if the scanner has changed since.

**General rule.** Any operation that's destructive-if-repeated needs a "did I run this already?" flag. SecureStore is a fine place to put it on mobile; on a server, use a migrations table. The threads backfill teaches a subtler lesson: sometimes "did I run this?" should be conditional on prerequisites being met (zero-thread short-circuit), so the gate stays open until the prerequisite arrives.

---

## 2.5 Soft delete + tombstone propagation · `intermediate`

**What it is.** Deletes don't remove rows; they stamp `deleted_at + updated_at`. Reads filter `WHERE deleted_at IS NULL`. Deletions propagate to the cloud as normal sync events (the row is upserted with `deleted_at` set, and the other device sees the tombstone).

**Where it lives.**
- The rule: `docs/spec.md:343` — *"every CRUD delete stamps `deleted_at + updated_at`; reads filter `WHERE deleted_at IS NULL`."*
- Read filter example: `src/services/sync/bootstrap.ts:39-42` (`SELECT COUNT(*) AS c FROM entries WHERE deleted_at IS NULL`).
- The conflict resolver respects tombstones: `src/services/sync/conflict.ts:13` (`Tombstoned` type).

**Why it exists.** Hard deletes are incompatible with last-write-wins sync. If device A deletes a row at 10:00 and device B edits the same row at 10:01, device B's edit must win — but if A's delete is hard, B's edit has no row to update on convergence and the delete is "lost in time." Soft delete preserves the row so LWW can compare timestamps. The honest tradeoff (`docs/spec.md:343`): soft-deleted rows accumulate. There is no 30-day vacuum yet.

**General rule.** If you sync, you soft-delete. If you don't sync, soft-delete is still useful for undo, audit, and "oops" recovery. The vacuum policy can come later — having no vacuum is a known cost; having no tombstones is unrecoverable.

---

## 2.6 Last-write-wins conflict resolution by `updated_at` · `intermediate`

**What it is.** When the same row exists on both local and cloud, the one with the larger `updated_at` wins. Pure function, no I/O, easily testable. Ties go to a configurable side (default: cloud, "the server saw it last").

**Where it lives.** `src/services/sync/conflict.ts:13-31` — the entire algorithm fits in 18 lines:

```ts
export function chooseWinner<T extends Tombstoned>(local: T, cloud: T): 'local' | 'cloud' | 'tie' {
  const lt = Date.parse(local.updated_at);
  const ct = Date.parse(cloud.updated_at);
  if (Number.isNaN(lt) || Number.isNaN(ct)) return 'cloud';
  if (lt > ct) return 'local';
  if (ct > lt) return 'cloud';
  return 'tie';
}
```

The orchestrator decides what to do with each: incremental pull treats ties as cloud-wins (no work); push treats ties as local-wins (we're already in the push code path). See `src/services/sync/pull.ts:84-95`.

**Why it exists.** LWW is the simplest convergent strategy that still resolves real conflicts. For a solo-use app (Phase A), it's correct. The honest unresolved case (`conflict.ts:9-11`): same-second ties go to whichever the comparator favors. For two-device editing of one user, that's fine; for collaborative editing of one document, you'd need vector clocks or CRDTs.

**General rule.** Pick the simplest conflict resolution your data model can tolerate. LWW is the floor; CRDTs are the ceiling. Most apps land between — and most ship LWW first because it's three operators (`>`, `<`, `===`) and a comparator function.

---

## 2.7 Clock-skew-safe pull cursor via server time RPC · `advanced`

**What it is.** Instead of `last_pull_at = new Date().toISOString()` (which uses the device's clock), the pull stamps `last_pull_at` from a Postgres RPC that returns the *server's* current time. This guards against the case where a device's clock is wrong relative to the server's, which would cause rows to be missed (`updated_at > last_pull_at` would be false for rows with skewed timestamps).

**Where it lives.** `src/services/sync/pull.ts:25-32` (`getServerTime()`) and line 47 (`serverTime = await getServerTime()`). After a successful pull, line 111: `await recordPullSuccess(table.tableName, serverTime)`.

**Why it exists.** Mobile devices have wrong clocks more often than you'd think — users disable auto-time, switch timezones mid-trip, run dev builds on emulators with stale time. A 30-second clock skew can cause rows to never sync. Using the server's clock as the cursor anchor eliminates this entire class of bug.

**General rule.** When you sync against a server-side `updated_at`, your cursor must use the server's clock, not the client's. One RPC call per sync run is cheap; the bug it prevents is silent and unbounded.

---

## 2.8 Paginated incremental pull with monotonic cursor · `advanced`

**What it is.** Pull fetches rows where `updated_at > cursor`, ordered ASC, in pages of 200. After each page, advance the cursor to the last `updated_at` seen. Loop until a page returns < PAGE_SIZE rows.

**Where it lives.** `src/services/sync/pull.ts:62-108`. The cursor invariant is on line 105: *"Advance cursor to the highest updated_at in this page; loop will terminate when the next query returns empty."*

**Why it exists.** Pagination is required because Postgres won't ship 50,000 rows in one response. Ordering by `updated_at ASC` (not DESC) with a monotonic cursor ensures we never miss a row that lands during the loop — a row inserted with `updated_at = now()` while we're on page 3 will be picked up when its `updated_at` exceeds the current cursor.

**General rule.** Incremental pull is "fetch by cursor where cursor is monotonic." The cursor *must* advance forward only. If you order DESC or use offset-based pagination, a row inserted mid-loop at position N will appear on page N+1 too (or never, depending on the engine). ASC + cursor is the only correct shape.

> **Go deeper.** Read `pull.ts:104-107` and trace what happens when two rows have the same `updated_at`. The `>` (not `>=`) means a tie at the cursor boundary skips one of them. In practice this is a non-issue (timestamps are millisecond-precise, ties are rare), but it's the kind of off-by-one that bites in the long run. The robust fix is `(updated_at, id) > (cursor_ts, cursor_id)` lexicographic ordering.

---

## 2.9 Topologically-ordered table sync (parents before children) · `intermediate`

**What it is.** Each `SyncableTable` declares a `pushOrder` and a `pullOrder` (different! parents-first for push, may differ for pull). The orchestrator sorts the registry by these orders before walking it.

**Where it lives.**
- The interface: `src/services/sync/types.ts:11-26`.
- The orchestrator: `src/services/sync/orchestrator.ts:43` (push) and `:66` (pull).
- The shape: `src/services/sync/tables/*.ts` (one thin adapter per table).

**Why it exists.** Foreign keys demand order. You cannot insert a `thread_mentions` row that references a `thread_id` if the `threads` row hasn't been pushed yet — the cloud-side FK constraint will reject it. By making `pushOrder` an explicit field on the table adapter, the dependency is visible and enforceable.

**General rule.** When tables have referential dependencies, the sync layer needs a topological sort. Inlining the order in the orchestrator would couple it to the schema; declaring the order *on the adapter* keeps the schema knowledge co-located with the table. This is the same pattern as Rails migration ordering or any database migration tool.

---

## 2.10 Debounced background dispatch with re-queue · `intermediate`

**What it is.** A 5-second debounced trigger: every write calls `schedulePush()`, which resets the timer. The timer fires once N seconds after the *last* call. If a push is already in flight when the timer fires, the function re-schedules itself so latest changes don't get stranded.

**Where it lives.** `src/services/sync/schedulePush.ts:14-38`. The re-queue logic at lines 23–27:

```ts
async function fire(): Promise<void> {
  if (pushing) {
    // A push is already in flight — re-queue so the latest changes don't
    // get stranded waiting for the in-flight push to finish.
    schedulePush();
    return;
  }
  // ...
}
```

**Why it exists.** Naive debounce ("schedule the work, fire after 5s") loses writes that happen during the in-flight push. The re-queue makes the pattern self-healing: a 6th write that arrives during the in-flight push re-arms the timer for 5s after the in-flight push completes.

**General rule.** Debounced dispatch needs a "what if it fires while one's in flight?" answer. Re-queue is the simplest correct one. Cancel-and-restart is wrong (loses the in-flight call's work). Queue-N-pending-pushes is overkill (only the latest matters when the work is "push everything dirty").

---

## 2.11 Race-condition-aware bootstrap state machine · `advanced`

**What it is.** A four-branch decision tree for first-cold-start: `(localHasData, cloudHasData)` produces `no-op`, `initial-push`, `first-pull`, or `initial-push-fallback (both populated)`. Each branch ends by setting the SecureStore flag so the bootstrap never re-runs.

**Where it lives.** `src/services/sync/bootstrap.ts:59-96`. The both-populated case (line 86–95) defaults to initial-push with a `console.warn` and a comment that flags Phase B should expose a UI prompt instead.

**Why it exists.** First-cold-start is the highest-risk moment in any sync app. Get it wrong and you wipe the user's data on the wrong side. The four-branch decision tree makes every case explicit. The honest comment about Phase B is the right move: rather than building a complex "pick a side" UI for solo Phase A, default to the safer choice (local wins) and document the gap.

**General rule.** First-sync is a state machine, not a one-liner. Enumerate the cases with `(localHasData, cloudHasData) ∈ { (false,false), (true,false), (false,true), (true,true) }` and decide each one explicitly. Document the cases you're punting on.

---

## 2.12 Don't-auto-delete-during-sync invariant · `foundational`

**What it is.** A negative principle: automatic empty-entry cleanup runs only on explicit user-initiated page loads, never inside the sync code path or any background cleanup effect.

**Where it lives.** Principle 6 in `docs/spec.md:457`.

**Why it exists.** Past data-loss bug. If sync runs (which pulls cloud rows, briefly making the local row look empty until the merge completes) and a cleanup effect concurrently fires, the cleanup may delete a row the sync is about to populate. The principle is the scar tissue from that incident.

**General rule.** Read the principle list in `docs/spec.md:451-465` end-to-end. Each principle traces back to a specific bug. The pattern: when destructive automation is racing eventual-consistency code, the destructive automation must yield. Make destructiveness opt-in, not background.

---

## 2.13 Read-DB-before-deleting safety check · `foundational`

**What it is.** Auto-commit timers and cleanup effects must verify the latest row state from the DB before deciding anything destructive. Don't trust an in-memory snapshot.

**Where it lives.** Principle 4 in `docs/spec.md:455`. The classic anti-pattern this guards against is `useEffect(() => deleteIfEmpty(state.entry))` where `state.entry` is a stale closure — the user typed since the effect was set up, but the closure still holds the old empty value.

**Why it exists.** React's stale-closure semantics + idle timers + focus cleanup = perfect storm for delete-after-edit bugs. Re-reading the DB at the destructive moment is the cheapest, most reliable check.

**General rule.** Destructive operations always re-read state. Closures and refs are for reads-that-don't-cost-anything-if-stale; destructive ops are not those.

---

## 2.14 Single aggregate query for derived dashboard data · `intermediate`

**What it is.** Instead of N+1 queries (one per thread × one per metric), the dashboard's threads section runs one query per *metric* (last mention, week count, todo links, activity dates) and joins them in JS. Roughly 4–5 queries total for arbitrarily many threads.

**Where it lives.** `src/services/threads/getThreadCards.ts:17-132`. Notice the structure:
- Line 22: `const lastMentionMap = await getLastMentionByThread();` (one query)
- Line 38–46: the 14-day activity strip (one query, grouped by `thread_id`)
- Line 56–63: distinct entries this week (one query, grouped by `thread_id`)
- Line 67–70: distinct todo IDs per thread (one query)
- Line 79–80: all metas + all entries (in-memory join)

Then line 93 maps over threads, joining each metric into a `ThreadCard`.

**Why it exists.** N+1 is a quiet performance killer. With 20 threads and 5 metrics each, the naive version is 100 queries. The aggregate version is 5. On SQLite (which is fast), the difference is the lower bound; on Postgres over network, it's the difference between snappy and unusable.

**General rule.** When you build a dashboard with per-row metrics, write one query per metric (not per row × metric), and join in code. The principle generalizes: *push aggregation as close to the data as you can*. SQL `GROUP BY` is the friend here, not the JS `.reduce`.

---

## 2.15 Documented deviation as a first-class artifact · `intermediate`

**What it is.** When a feature breaks one of the architectural principles, the deviation is *documented at every level* — in the spec, in the principle itself, and in the code with an inline comment explaining why. The dashboard's "manual touch today" toggle for threads (writes a `thread_mentions` row with NULL entry/todo) is the canonical example.

**Where it lives.**
- The spec: `docs/spec.md:302` and `docs/spec.md:462` (principle 11's deviation note).
- The code: `src/services/threads/touch.ts:7-16` — five lines of comment justifying why the manual touch bends "mentions are derived from prose."

**Why it exists.** Principles are useful only if they're enforceable, but real apps have edge cases. Documenting a deviation in three places means future-you (or a contributor) reading any one of them sees the exception. Pretending the principle is universal would force someone to discover the deviation by surprise — and possibly try to "fix" it.

**General rule.** Every principle has exceptions. Write them down at the principle's home, at the code site, and in the spec. A documented deviation is an asset; an undocumented one is a landmine.
