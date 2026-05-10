# First-pull bootstrap — full-table restore on fresh device

**Industry name(s):** Full-table bootstrap, initial replication
**Type:** Industry standard · Language-agnostic

> When a new device attaches to existing cloud data, reset every table's `last_pull_at` cursor to NULL and run the regular incremental pull — the cursor logic handles "pull everything since epoch" without a separate code path.

**See also:** → [07-cloud-sync-push](./07-cloud-sync-push.md) · → [08-cloud-sync-pull](./08-cloud-sync-pull.md)

---

## Why care

The instinct on a new feature called "first-time setup" is to write a second code path: a dedicated bulk-loader that knows it's the first run, with its own pagination, its own error handling, its own everything. That code path is then untested in production until someone gets a new device — i.e., months later, with no observability. The better move is to notice that "first run" is just the degenerate case of "incremental run" with the cursor pinned to the beginning of time. Reset the watermark to null, call the regular sync, done. One code path. One set of bugs.

This is the "special case is a parameter, not a fork" principle — the same instinct behind null-object pattern, behind "epoch zero" timestamps that make `WHERE updated_at > 0` cover all rows, behind sentinel rows in databases that make "first" and "subsequent" use the same INSERT. The family is "reduce the surface area by making the rare path a configuration of the common path." Initial replication in CDC systems works this way. Cold-cache fills in CDNs work this way. The cost is one extra pass at install time that re-pages through everything; the benefit is that the install-time code path was exercised on every normal sync for months before it ever ran in anger. Here's how this codebase applies that pattern.

---

## Quick summary
- **What:** `firstPullAll()` walks the 10-table synced list, resets each `sync_meta.last_pull_at` to NULL via UPSERT, then delegates to `pullAll()`. The regular pull's `cursor = last_pull_at ?? '1970-01-01...'` does the rest.
- **Why here:** a fresh device install with non-empty cloud (typical: wiped phone) needs to fetch everything once. The bootstrap detector in `bootstrap.ts` decides when to call this instead of `pushAll`.
- **Tradeoff:** because the cursor logic from `pullTable` is reused, full-table fetch reuses the 200-row pagination — slow on a fresh attach (10k rows = 50 pages = ~10 round-trips per table = ~100 round-trips total) but never blows up.

**Real operation:** `firstPullAll` in `src/services/sync/firstPull.ts`. Called from `bootstrapCloudSync` in `src/services/sync/bootstrap.ts:82` when local is empty and cloud has data.

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

When brute force is fine: only on a dev fixture where you know the total cloud row count is tiny and the device is online. In production, paginated reuse is the only viable shape — and the brute version doesn't actually exist in the codebase because `firstPullAll` reuses `pullTable`.

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

- **Reuse `pullTable` via cursor reset** — gives: zero new sync logic, automatic pagination and resumability. Costs: bootstrap inherits pull's pagination quirks (200/page, strict-`>` cursor edge case at boundaries).
- **Per-table independent reset** — gives: a partial bootstrap (e.g., 7/10 tables done) is resumable per-table. Costs: cross-table consistency isn't transactional — a fresh device could see `entries` with `todoIds` referencing `todo_meta` rows that haven't been pulled yet.
- **SecureStore-gated bootstrap flag** — gives: bootstrap runs exactly once per install. Costs: a botched first-pull that completes "successfully but empty" sets the flag and locks out a retry — `devActions.wipeAndRestoreFromCloud` is the only hatch.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I see this as a separate algorithm or as "incremental pull with a reset." The right answer is the latter: the bootstrap is *not* a different sync engine, it's the incremental engine pointed at epoch. The interviewer wants to hear that I avoided duplicating sync logic by reusing the cursor primitive — and that the choice has consequences (pagination on first-pull, partial-resume across tables, no cross-table consistency).

### Likely questions

[mid] Q: Walk me through what happens during firstPullAll if the network drops after 5 of the 10 tables have synced.
      A: The reset phase wrote NULL to all 10 `sync_meta` rows up-front, so all 10 are still flagged for full pull. `pullAll` walks them in REGISTRY order; let's say tables 1-5 succeeded and stamped `last_pull_at = serverTime`. Tables 6-10 either haven't started or are in mid-page. The network drops. `pullAll` returns a results array where tables 1-5 show `applied: N`, tables 6-10 show `error: <network>`. The bootstrap flag is set only on the orchestrator's success — actually, looking at the code path in `bootstrap.ts:82–86`, the flag is set unconditionally after `firstPullAll()` returns even with errors. That's a real bug: a partial first-pull marks bootstrap done, and the user needs to `wipeAndRestoreFromCloud` to retry. I'd fix it by inspecting the returned results array for any error and bailing on `markBootstrapDone` if so.

[senior] Q: Why reset `last_pull_at` to NULL and rely on `?? '1970-01-01...'`, instead of just writing `'1970-01-01...'` directly into `sync_meta`?
         A: Two reasons. First, the NULL sentinel makes "this table has never been pulled" explicit at the schema level — any future consumer reading `sync_meta` directly sees the unmistakable NULL, not a magic epoch string. Second, the `??` defaulting lives in `pullTable` already (it's how a freshly-installed device handles the first incremental pull too), so the firstPull code stays minimal: just "set NULL, run pullAll." Writing the epoch literal would duplicate magic across two files. NULL = unwritten; the ?? handles the semantics in one place.

[arch] Q: A user has 100,000 rows in entries. firstPullAll runs. What's the user experience?
       A: 100k rows / 200 per page = 500 pages = 500 sequential HTTPS round-trips on the entries table alone. At 200ms latency that's 100 seconds of pulling just for entries, plus the other 9 tables. The UI should show a "restoring from cloud" indicator with progress (currently it doesn't — that's a gap). The pagination is what makes it survivable: each page is a discrete success, and the cursor stamps progress as it goes. If the user kills the app at row 60,000, the next `firstPullAll` call resumes from the last stamped cursor. The alternative (single huge query) would 413 at request size and lose everything.

### The question candidates always dodge
Q: The bootstrap flag is in SecureStore, but the rest of the sync state is in SQLite. What if the user's app data gets wiped but SecureStore persists (or vice-versa)?

A: It's a real desync surface. On iOS / Android, SecureStore lives in the OS keychain while SQLite lives in the app's sandbox — they can be wiped independently. If SQLite gets wiped but SecureStore keeps the bootstrap flag, the next launch sees `local empty + flag set` and treats it as "incremental sync from never," which means the pull cursor reads `last_pull_at = NULL` (because SQLite is empty) and effectively re-runs firstPull... except the bootstrap decision tree never gets there because `isBootstrapDone()` returns true and the function early-exits at L64. The user is stuck with no data and no automatic recovery. The fix is to either move the flag *into* SQLite (lose the "survive app reinstall" property) or to check local emptiness inside `isBootstrapDone` (more complexity). The reason I haven't fixed it is that the wipe-without-reinstall case is genuinely rare on mobile — Android typically wipes both together. But it's the kind of bug a fresh-eyed reviewer would flag in five minutes and they'd be right.

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
