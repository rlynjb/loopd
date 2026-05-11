# First-pull bootstrap — full-table restore on fresh device

**Industry name(s):** Full-table bootstrap, initial replication
**Type:** Industry standard · Language-agnostic

> When a new device attaches to existing cloud data, reset every table's `last_pull_at` cursor to NULL and run the regular incremental pull — the cursor logic handles "pull everything since epoch" without a separate code path.

**See also:** → [07-cloud-sync-push](./07-cloud-sync-push.md) · → [08-cloud-sync-pull](./08-cloud-sync-pull.md)

---

## Why care

The instinct on a new feature called "first-time setup" is to write a second code path: a dedicated bulk-loader that knows it's the first run, with its own pagination, its own error handling, its own everything. That code path is then untested in production until someone gets a new device — i.e., months later, with no observability. The better move is to notice that "first run" is just the degenerate case of "incremental run" with the cursor pinned to the beginning of time. Reset the watermark to null, call the regular sync, done. One code path. One set of bugs.

This is the "special case is a parameter, not a fork" principle — the same instinct behind null-object pattern, behind "epoch zero" timestamps that make `WHERE updated_at > 0` cover all rows, behind sentinel rows in databases that make "first" and "subsequent" use the same INSERT. The family is "reduce the surface area by making the rare path a configuration of the common path." Initial replication in CDC systems works this way. Cold-cache fills in CDNs work this way. The cost is one extra pass at install time that re-pages through everything; the benefit is that the install-time code path was exercised on every normal sync for months before it ever ran in anger. The data and the mechanics are in the next blocks.

---

**Real operation:** `firstPullAll` in `src/services/sync/firstPull.ts`. Called from `bootstrapCloudSync` in `src/services/sync/bootstrap.ts:82` when local is empty and cloud has data.

---

## The data

```
  SYNCED_TABLES = [
    'entries', 'projects', 'day_meta', 'vlogs', 'ai_summaries',
    'nutrition', 'habits', 'todo_meta', 'threads', 'thread_mentions',
  ]   // 10 tables

  sync_meta (SQLite):
    ┌────────────────────┬──────────────────┐
    │ table_name         │ last_pull_at     │
    ├────────────────────┼──────────────────┤
    │ entries            │ NULL  (post-reset)│
    │ projects           │ NULL              │
    │ ...                │ NULL              │
    └────────────────────┴──────────────────┘

  cloud Supabase: assume 350 entries, 200 todo_meta, 150 thread_mentions,
                  plus other tables — say ~1,500 rows total.
```

**The problem:** restore the user's full data from cloud to a fresh local SQLite without writing a separate "restore" code path. The regular `pullTable` already handles "pull from cursor"; the trick is making the cursor point to epoch.

---

## How it works

── Brute force ──────────────────────────────────

Pseudocode (full-table fetch per table, no pagination, no cursor):

```
  for table in SYNCED_TABLES:
    page = supabase.from(table).select('*')   // no pagination
    for row in page:
      table.localUpsert(row)
    sync_meta.last_pull_at = serverTime
```

Execution trace (10 tables, ~1,500 cloud rows, no pagination):

```
  table entries:        select all 350 rows in one query → 1 HTTPS round-trip
                        payload ~1.5 MB (text blobs)
  table todo_meta:      select all 200 rows in one query
  table thread_mentions:select all 150 rows in one query
  ...
  table ai_summaries:   select all rows...

  Network: 10 huge SELECTs, peak ~3 MB payload (entries dominates)
  At 2G/3G or partition: any single query failure aborts the bootstrap.
  No resumability — partial progress isn't durable.
  At 100k rows / 50 MB: Supabase REST request hits its hard limit and 413s.
```

Complexity: O(T) round-trips for T tables (constant), but O(N) bytes per request where N = cloud row count.

What goes wrong at scale: at single-user / hundreds-of-rows scale, brute force technically works — 10 large SELECTs in a row. The failure modes are (a) any one SELECT timing out kills the entire bootstrap with no resumability (next attempt re-fetches every table from scratch); (b) payload-size limits on the Supabase REST layer (request entity too large) — once entries.text accumulates, the single query exceeds the limit; (c) memory pressure on low-end Android since the full result set is materialised in JS heap. With 100k rows the brute version blows past Supabase's request limits before it ever starts paginating.

── Optimal ──────────────────────────────────────

The insight: reuse the regular `pullTable` paginated cursor logic by *resetting* the cursor to NULL. The "pull from epoch" semantics already live in `pullTable`'s `cursor = last_pull_at ?? '1970-01-01...'` line — no separate code path needed.

```
  // src/services/sync/firstPull.ts
  async function firstPullAll():
    db = await getDatabase()
    for t in SYNCED_TABLES:
      await db.runAsync(
        INSERT INTO sync_meta (table_name, last_pull_at) VALUES (?, NULL)
          ON CONFLICT(table_name) DO UPDATE SET last_pull_at = NULL,
        [t]
      )
    return pullAll()

  // Inside pullAll() → for each table → pullTable():
  // cursor = sync_meta[table].last_pull_at ?? '1970-01-01T00:00:00.000Z'
  // page-by-200, monotonic cursor, chooseWinner per row, stamp synced_at = serverTime
```

Execution trace (10 tables, 350 entries among ~1,500 cloud rows):

```
  Reset phase:
    Loop 10 tables × 1 UPSERT each = 10 SQLite writes (sub-millisecond)
    sync_meta now has all 10 rows with last_pull_at = NULL

  Pull phase (pullAll → pullTable per table):
    entries:
      cursor = '1970-01-01...' (because NULL)
      page 1: 200 rows fetched, chooseWinner per row (local empty → cloud wins),
              localUpsert × 200, stamp synced_at = serverTime
              cursor = page[199].updated_at
      page 2: 150 rows, applied, 150 < 200 → break
      recordPullSuccess(entries, serverTime)
    todo_meta:    1 page of 200, then end → 200 rows applied
    thread_mentions: 1 page of 150 → applied
    ... (7 more tables)

  Total network: ⌈1,500/200⌉ ≈ 8 page round-trips across 10 tables (most tables
                 hit "< 200 → break" on the first page).
  Wall-clock: ~2-4 seconds on a decent connection.
  Resumable: any single table's failure leaves its last_pull_at NULL or partial;
             next firstPullAll re-runs that table from its cursor.
```

Complexity: ⌈N/200⌉ network round-trips across all tables · O(200) memory per page · O(1) write code (no separate "restore" function — reuses pullTable).

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(T) huge RTs  │ O(N/200) RTs     │
  │ Space           │ O(N) per RT    │ O(200) per page  │
  │ At 1,000 rows   │ 10 huge SELECTs│ ~5 paged calls   │
  │ At 10,000 rows  │ 10 SELECTs (may│ ~50 paged calls  │
  │                 │  413 on entries)│                  │
  │ Readable?       │ yes            │ yes (reuses pull)│
  │ Resumable?      │ no             │ yes (per-table   │
  │                 │                │  cursor)         │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: only on a dev fixture where you know the total cloud row count is tiny and the device is online. In production, paginated reuse is the only viable shape — and the brute version doesn't actually exist in the codebase because `firstPullAll` reuses `pullTable`. The diagram below shows it end-to-end.

---

## Primary diagram

```
                    bootstrapCloudSync()
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
            localHasData()?        cloudHasData()?
                  │                     │
                  └──────────┬──────────┘
                             │
       ┌─────────────┬───────┴────────┬──────────────────┐
       ▼             ▼                ▼                  ▼
   no/no          yes/no          no/yes            yes/yes
   no-op       initial-push   ► first-pull ◄    initial-push-fallback
                                    │
                                    ▼
                            firstPullAll()
                                    │
                            ┌───────┴────────┐
                            ▼                ▼
            for t in SYNCED_TABLES (10):     │
              UPSERT sync_meta               │
              SET last_pull_at = NULL        │
                            │                ▼
                            └────────────► pullAll()
                                              │
                                              ▼
                                pullTable(table) for each table
                                cursor = last_pull_at ?? '1970-01-01...'
                                → walks 200-row pages until end
                                → applies via chooseWinner+upsert
                                → stamps last_pull_at = serverTime
                                              │
                                              ▼
                              local SQLite populated from cloud
                                              │
                                              ▼
                                markBootstrapDone() (SecureStore)
                              { action: 'first-pull', pulled: N }
```

---

## In this codebase

**File:** `src/services/sync/firstPull.ts`
**Function / class:** `firstPullAll()`
**Line range:** L20–L30 (full file is 30 lines including the `SYNCED_TABLES` const at L15–L18)

**Call site:** `src/services/sync/bootstrap.ts:82` — `bootstrapCloudSync()` invokes `firstPullAll()` only when `!hasLocal && hasCloud` (fresh device with cloud data). Other branches: `pushAll()` for initial push, no-op for both-empty.

**Dev hatch:** `src/services/sync/devActions.ts:89` — `wipeAndRestoreFromCloud()` calls `firstPullAll` after deleting local rows and clearing the bootstrap flag. Use case: testing the restore path without uninstalling.

**Reused machinery:**
- `pullAll()` in `src/services/sync/orchestrator.ts` (the loop over `REGISTRY` tables)
- `pullTable()` in `src/services/sync/pull.ts` L34–L117 (cursor + page-by-200, see [08-cloud-sync-pull](./08-cloud-sync-pull.md))
- The `cursor = last_pull_at ?? '1970-01-01...'` line in `pullTable` is what makes "NULL = pull from epoch" work without a code branch.

---

## Elaborate

### Where this pattern comes from
"Reuse the incremental pump by resetting its cursor" is the classic pattern for any CDC (change-data-capture) system that needs an initial backfill. Postgres logical replication, Kafka Connect, Debezium — all express full backfill as "snapshot then stream" but the snapshot phase is the cursor-from-epoch case of the stream phase. The shape is identical in loopd because the cloud uses `updated_at` as a logical clock.

### The deeper principle
**A separate "restore" code path is duplication.** If your incremental sync's cursor includes the epoch, "restore" is just "incremental from epoch." Skip the special case; reset the cursor instead.

### Where this breaks down
- Tables that need *transformation* on initial load but not incremental (rare). Then you do need a separate path.
- Cases where "pull from epoch" exceeds connection lifetime or server timeout. Then the optimal version still wins because the per-table cursor stamps progress as it goes; brute force loses the whole table on a single timeout.

### What to explore next
- [08-cloud-sync-pull](./08-cloud-sync-pull.md) → the incremental machinery this reuses.
- [07-cloud-sync-push](./07-cloud-sync-push.md) → the bootstrap's other branch (local-canonical case).
- `bootstrap.ts` decision tree → when `firstPullAll` vs `pushAll` fires.

---

## Tradeoffs

We traded a dedicated bootstrap code path for a 10-line cursor reset that delegates to the regular pull pump — exercising the install-time code path on every normal sync for months before it ever runs in anger.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (cursor reset +     │ Alternative (dedicated bulk-   │
│                  │ pullAll reuse)                 │ loader code path)              │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Code complexity  │ ~30 LOC firstPull.ts (cursor   │ ~200+ LOC dedicated full-table │
│                  │ reset loop + pullAll call)     │ fetch + pagination + retry +   │
│                  │                                │ progress reporting             │
│ Round-trips      │ ⌈N/200⌉ across all tables       │ T huge SELECTs (one per table) │
│ At 1,500 rows    │ ~8 paged calls                  │ 10 huge SELECTs                │
│ At 100k rows     │ ~500 paged calls per table     │ blocked by Supabase 413         │
│                  │                                 │ request-size limit             │
│ Resumability     │ per-table cursor stamps         │ none — partial progress lost   │
│                  │ progress, network drop          │ on any timeout                 │
│                  │ resumable                       │                                │
│ Code exercised   │ pullTable runs on every normal  │ runs only on fresh device      │
│                  │ sync — battle-tested            │ attach — untested in prod      │
│ Failure mode     │ partial bootstrap → flag still  │ partial pull → bug discovered │
│                  │ set is a real bug; user needs  │ months after ship              │
│                  │ wipeAndRestoreFromCloud         │                                │
│ Memory peak      │ O(200) per page                 │ O(N) — full table in heap     │
│ Cross-table      │ not transactional — entries may │ same — bulk loader doesn't fix │
│ consistency      │ briefly reference unpulled meta │ this either                    │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

Bootstrap inherits the regular pull's quirks. The strict `>` cursor edge case (two rows sharing `updated_at` at a page boundary) applies to first-pull just like incremental pull. The 200-row page size is fixed across all tables, which is empirical for incremental but slightly silly for first-pull (we could fetch larger pages since there's no urgency). We accepted both because the alternative is duplicating the cursor logic and shipping a second code path with a second set of bugs.

Cross-table consistency isn't transactional. A user opening the app mid-firstPull might see `entries.todos_json` referencing `todo_meta` rows that haven't been pulled yet. The defensive `if !meta || !todo` skip in downstream readers (`getThreadCards`, etc.) absorbs this; the workaround is gating UI on `isBootstrapDone()` until the flag flips. The bootstrap is mostly imperceptible (a few seconds) so the user rarely sees this surface.

The SecureStore-gated bootstrap flag has a subtle bug: a partial first-pull that returns without error but with empty data (because the network was already dropped before any row applied) sets the flag and locks out automatic retry. The only hatch is `devActions.wipeAndRestoreFromCloud()`. We've known about this since 2026-05 and haven't fixed it because the failure rate in single-user testing is effectively zero.

The desync between SecureStore (keychain) and SQLite (app sandbox) is a real bug class. On iOS/Android, app data and keychain can be wiped independently. A user who manually clears app data without uninstalling would land with `bootstrapDone=true` but empty SQLite — `isBootstrapDone()` returns true and the function early-exits at L64, leaving them stuck.

### What the alternative would have cost

A dedicated bulk-loader would be ~200+ LOC: full-table SELECTs with custom pagination, retry, progress reporting, and its own cursor scheme. The dealbreaker isn't LOC — it's *test surface*. The dedicated bulk-loader runs only on fresh-device attach, which is rare in production, so bugs in it live in the codebase for months before anyone runs them in anger. The reuse-pull-via-cursor-reset path runs the same code that every normal sync exercises, so bootstrap-relevant bugs are found by ordinary users in the first week of use.

At 100k rows the dedicated bulk version would hit Supabase's REST request-size limit (413 Request Entity Too Large) before it ever reached its retry logic. The paginated reuse handles 100k rows in ~500 paged calls per table — slow (~100s per table on 4G) but correct. The dedicated path requires its own pagination eventually, which is exactly what `pullTable` already implements.

### The breakpoint

Fine until per-table row counts exceed ~50,000, at which point the firstPull becomes a multi-minute operation that needs a UI progress indicator (currently absent). The fix is a callback per page completion + a "restoring 2,400 of 50,000" UI surface — ~30 LOC. We haven't built it because at single-user scale row counts stay in the low thousands.

### What wasn't actually a tradeoff

Choosing NULL over the magic epoch literal `'1970-01-01...'` in `sync_meta.last_pull_at` isn't really a tradeoff — NULL is the explicit "never pulled" sentinel at the schema level, and the `??` defaulting in `pullTable` is the one place the epoch string lives. Writing the literal into `sync_meta` directly would duplicate magic across two files; NULL keeps the semantics in one place.

### Tech reference (industry pairing)

┌─ @supabase/supabase-js ─────────────────────────────────────────┐
│ Codebase uses:    @supabase/supabase-js — pullTable delegates  │
│                   paged .gt + .order + .limit calls to Supabase│
│                   for all 10 SYNCED_TABLES during bootstrap     │
│ Why it's here:    the cursor-based paginated pull that          │
│                   firstPullAll reuses is built on the Supabase  │
│                   SDK's query builder and PostgREST pagination  │
│                                                                 │
│ Leading today:    Supabase — adoption-leading, 2026            │
│ Why it leads:     managed Postgres + auth + RLS + Storage in   │
│                   one console; SDK mirrors PostgREST directly   │
│                                                                 │
│ Runner-up:        Neon + Drizzle                                │
│                   innovation-leading typed SQL with             │
│                   branch-per-PR workflow                        │
└─────────────────────────────────────────────────────────────────┘

┌─ expo-sqlite (WAL) ─────────────────────────────────────────────┐
│ Codebase uses:    expo-sqlite (WAL mode) — localUpsert +       │
│                   sync_meta cursor writes during the bootstrap  │
│                   page-by-page restore into local SQLite        │
│ Why it's here:    per-page localUpsert + per-table cursor stamp │
│                   in sync_meta are the durable progress record  │
│                   that makes bootstrap resumable after a drop   │
│                                                                 │
│ Leading today:    expo-sqlite — adoption-leading, 2026         │
│ Why it leads:     ships with Expo SDK; battle-tested WAL mode   │
│                   for concurrent read/write on-device           │
│                                                                 │
│ Runner-up:        op-sqlite                                     │
│                   innovation-leading JSI-direct binding for     │
│                   performance-tier local DB workloads           │
└─────────────────────────────────────────────────────────────────┘

---

## Summary

Initial replication as "incremental sync with the cursor pinned to epoch" is the family of "special case is a parameter, not a fork" — same instinct as null-object pattern, sentinel timestamps, and CDC backfill in Postgres logical replication, Kafka Connect, and Debezium where snapshot is just the cursor-from-epoch case of the stream. In this codebase `firstPullAll` in `src/services/sync/firstPull.ts` (L20–L30) walks the 10-table `SYNCED_TABLES` list, UPSERTs each `sync_meta.last_pull_at` to NULL, then delegates to `pullAll()` — and `pullTable`'s `cursor = last_pull_at ?? '1970-01-01...'` line is what makes "NULL = pull from epoch" work without a code branch. The constraint is that bootstrap must reuse the incremental machinery so the install-time code path has been exercised on every normal sync for months before it ever runs in anger. The cost is that bootstrap inherits the regular pull's quirks: 200-row pagination means a 10k-row attach takes ~50 paged round-trips per table, and cross-table consistency isn't transactional so `entries` may temporarily reference `todo_meta` rows not yet pulled. The brute-force "one huge SELECT per table" alternative isn't even shipped — it 413s past Supabase's request-size limits and has no resumability.

Key points to remember:
- "First pull" is "incremental pull with `last_pull_at = NULL`" — one code path, not two.
- The NULL sentinel is explicit at the schema level; `??` defaulting to `'1970-01-01...'` lives only in `pullTable`, not duplicated across files.
- Per-table cursor stamps progress as each table completes — a mid-bootstrap network drop is resumable on the next call.
- O(N/200) round-trips total, O(200) memory per page; cross-table consistency is not transactional and accepted as such.
- SecureStore flag + SQLite cursor can desync if one is wiped without the other — rare on mobile but a real bug class.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I see this as a separate algorithm or as "incremental pull with a reset." The right answer is the latter: the bootstrap is *not* a different sync engine, it's the incremental engine pointed at epoch. The interviewer wants to hear that I avoided duplicating sync logic by reusing the cursor primitive — and that the choice has consequences (pagination on first-pull, partial-resume across tables, no cross-table consistency).

### Likely questions

[mid] Q: Walk me through what happens during firstPullAll if the network drops after 5 of the 10 tables have synced.
      A: The reset phase wrote NULL to all 10 `sync_meta` rows up-front, so all 10 are still flagged for full pull. `pullAll` walks them in REGISTRY order; let's say tables 1-5 succeeded and stamped `last_pull_at = serverTime`. Tables 6-10 either haven't started or are in mid-page. The network drops. `pullAll` returns a results array where tables 1-5 show `applied: N`, tables 6-10 show `error: <network>`. The bootstrap flag is set only on the orchestrator's success — actually, looking at the code path in `bootstrap.ts:82–86`, the flag is set unconditionally after `firstPullAll()` returns even with errors. That's a real bug: a partial first-pull marks bootstrap done, and the user needs to `wipeAndRestoreFromCloud` to retry. I'd fix it by inspecting the returned results array for any error and bailing on `markBootstrapDone` if so.

```
[partial firstPull network-drop flow]

  reset phase: 10 sync_meta rows set to NULL
        │
        ▼  pullAll walks REGISTRY
  tables 1-5 succeed → last_pull_at = serverTime each
        │
        ▼  network drops mid-table-6 page
  table 6 returns {error: <network>}
        │
        ▼  pullAll returns results array; tables 7-10 not attempted
  bootstrap.ts:82-86 → markBootstrapDone() runs unconditionally
        │
        ▼
  user stuck: flag set, but tables 6-10 empty   ◀── real bug
  recovery: devActions.wipeAndRestoreFromCloud()
```

[senior] Q: Why reset `last_pull_at` to NULL and rely on `?? '1970-01-01...'`, instead of just writing `'1970-01-01...'` directly into `sync_meta`?
         A: Two reasons. First, the NULL sentinel makes "this table has never been pulled" explicit at the schema level — any future consumer reading `sync_meta` directly sees the unmistakable NULL, not a magic epoch string. Second, the `??` defaulting lives in `pullTable` already (it's how a freshly-installed device handles the first incremental pull too), so the firstPull code stays minimal: just "set NULL, run pullAll." Writing the epoch literal would duplicate magic across two files. NULL = unwritten; the ?? handles the semantics in one place.

```
                  Path taken (NULL + ?? defaulting)    Alternative (literal epoch in sync_meta)
                  ────────────────────────────────────  ──────────────────────────────────
sentinel          NULL — explicit "never pulled"       '1970-01-01...' — magic string
schema reader     any consumer sees NULL — unambiguous reader must know the epoch convention
where lives       ?? defaulting in pullTable only      epoch literal in both pullTable
                  (one place)                          and firstPull.ts
firstPull LOC     ~10 (reset NULL + pullAll)           ~10 (write literal + pullAll) but
                                                       magic duplicated
adding a 3rd      no change — same sentinel works      must remember to write the literal
caller                                                  in every caller
verdict           NULL is the schema-native shape      epoch literal duplicates semantics
```

[arch] Q: A user has 100,000 rows in entries. firstPullAll runs. What's the user experience?
       A: 100k rows / 200 per page = 500 pages = 500 sequential HTTPS round-trips on the entries table alone. At 200ms latency that's 100 seconds of pulling just for entries, plus the other 9 tables. The UI should show a "restoring from cloud" indicator with progress (currently it doesn't — that's a gap). The pagination is what makes it survivable: each page is a discrete success, and the cursor stamps progress as it goes. If the user kills the app at row 60,000, the next `firstPullAll` call resumes from the last stamped cursor. The alternative (single huge query) would 413 at request size and lose everything.

```
[scale curve — what breaks first at 10× and 100× cloud row count]

  cloud rows    pages/table   wall time @200ms   user-visible             breaks?
  ──────────    ───────────   ────────────────   ─────────────────────    ──────────────────
  1,500 (real)  ~1 each       ~2-4s              spinner barely flickers  no
  15,000        ~8 each       ~25s               needs progress indicator no
  100,000       ~500 each      ~100s/table        UI gap real;             progress UI
                                                  resumable via cursor      missing   ◀── BREAKS FIRST
  1M+           ~5k each       ~17 min            unusable w/o progress    needs callback
                                                  + retry on timeout       per-page + UI
```

### The question candidates always dodge
Q: The bootstrap flag is in SecureStore, but the rest of the sync state is in SQLite. What if the user's app data gets wiped but SecureStore persists (or vice-versa)?

A: It's a real desync surface. On iOS / Android, SecureStore lives in the OS keychain while SQLite lives in the app's sandbox — they can be wiped independently. If SQLite gets wiped but SecureStore keeps the bootstrap flag, the next launch sees `local empty + flag set` and treats it as "incremental sync from never," which means the pull cursor reads `last_pull_at = NULL` (because SQLite is empty) and effectively re-runs firstPull... except the bootstrap decision tree never gets there because `isBootstrapDone()` returns true and the function early-exits at L64. The user is stuck with no data and no automatic recovery. The fix is to either move the flag *into* SQLite (lose the "survive app reinstall" property) or to check local emptiness inside `isBootstrapDone` (more complexity). The reason I haven't fixed it is that the wipe-without-reinstall case is genuinely rare on mobile — Android typically wipes both together. But it's the kind of bug a fresh-eyed reviewer would flag in five minutes and they'd be right.

```
                  Path taken (flag in SecureStore)     Suggested (flag in SQLite OR local-empty
                                                       check inside isBootstrapDone)
                  ────────────────────────────────────  ──────────────────────────────────
survives          yes — SecureStore is keychain         no — wiped with app data
reinstall                                               (loses the "auto-restore on
                                                       reinstall" property)
desync surface    SecureStore vs SQLite can be wiped   no — flag follows the data
                  independently
"app data         user stuck: flag set but DB empty;   user gets fresh bootstrap on
 cleared, app     needs wipeAndRestoreFromCloud         next launch automatically
 still installed"
LOC               unchanged                             +5 in isBootstrapDone, or migrate
                                                       flag into sync_meta
observed bug      yes — known since 2026-05            n/a
verdict           rare-but-real bug class; fix when    "check local emptiness in
                  it surfaces in support tickets       isBootstrapDone" is the cheap fix
                                                       that preserves reinstall survival
```

### One-line anchors
- "Bootstrap is not a different sync engine — it's the incremental engine pointed at epoch."
- "Reset `last_pull_at` to NULL; the `??` in pullTable handles the semantics."
- "Per-table cursor = per-table resumability; cross-table consistency is not transactional."
- "SecureStore flag + SQLite cursor can desync; rare on mobile but a real bug class."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain first-pull bootstrap to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/sync/firstPull.ts:firstPullAll`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user reinstalls loopd on a new device. The bootstrap detector runs and sees `!localHasData && cloudHasData`. The cloud has 350 entries, 200 todo_meta rows, 150 thread_mentions, and 5 ai_summaries. The user is on a 4G connection. Walk: how many `sync_meta` writes happen in the reset phase, how many paginated HTTP round-trips total across all 10 tables, what the value of `last_pull_at` is for the `entries` table when the function returns successfully, and what happens if the network drops after 6 tables have completed.

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/firstPull.ts` L20–L30 + `src/services/sync/pull.ts` L34–L117 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/sync/firstPull.ts` to support what exists
→ Point to `src/services/sync/bootstrap.ts:82–86` (the call-site that sets the flag unconditionally) if you chose the alternative

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
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @supabase/supabase-js, expo-sqlite.
