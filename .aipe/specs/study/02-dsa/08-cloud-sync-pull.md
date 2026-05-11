# Cloud sync pull — paginated, conflict-resolved, server-time anchored

**Industry name(s):** Cursor-based pagination, incremental pull
**Type:** Industry standard · Language-agnostic

> Pull only what's new since last pull, in 200-row pages, resolving conflicts row-by-row. Anchor to server time, not local clock.

**See also:** → [07-cloud-sync-push](./07-cloud-sync-push.md) · → [01-system-design/07-cloud-sync-mirror](../01-system-design/07-cloud-sync-mirror.md) · → [01-system-design/08-conflict-last-write-wins](../01-system-design/08-conflict-last-write-wins.md)

---

## Why care

Every "pull what's new since I last checked" feature you've ever used has the same hidden trap: which clock do you trust? If the client picks the cursor from its own clock, a phone that's two minutes fast will skip rows; a phone that's two minutes slow will re-pull the same rows forever. The right answer is to ask the server what time it thinks it is, anchor the cursor to that, and never use the local clock for the watermark. Clock skew between devices is the bug, and stamping with the server's clock is the fix.

This is cursor-based incremental pull — the same shape as RSS feed readers (`Last-Modified` / `If-Modified-Since`), the same shape as event-sourced replication, the same shape as the `WHERE updated_at > ?` pattern in every CDC (change-data-capture) pipeline. The family is "monotonic-cursor sync" — the cursor only moves forward, the predicate is `> cursor`, and pagination is just slicing the result by size. The detail that separates the working version from the broken version is twofold: the cursor must come from a clock both sides agree on (server time, or a logical timestamp), and the per-page write must stamp the row so the next pull doesn't re-flag it as outgoing-dirty. Here's how this codebase applies that pattern.

---

## How it works

A newspaper delivery service that drops off only the editions printed after your last delivery — the carrier reads the last-delivered date stamp from your mailbox, fetches everything dated after that, and stamps your mailbox with today's edition date when done. If you're coming from frontend, this is the same shape as React Query's pagination cursors plus `staleTime` — pull pages of new data anchored to a cursor, advance the cursor only after the page lands. Three moves: ask the server what time it is, page through cloud rows newer than the cursor, write each row with conflict resolution and stamp `synced_at` from the server's clock.

**Real operation:** `pullTable` in `src/services/sync/pull.ts`.

---

## The data

```
  PAGE_SIZE = 200
  serverTime = supabase.rpc('get_server_time')   // avoid using local Date.now
  cursor     = sync_meta[table].last_pull_at ?? '1970-01-01T00:00:00.000Z'
```

**The problem:** pull only what's new since last pull, in 200-row pages, resolving conflicts row-by-row. Don't re-flag a just-pulled row as dirty (so stamp `synced_at` to the same `serverTime`).

---

── Brute force ──────────────────────────────────

Pseudocode (full-table fetch every pull, no cursor):

```
  serverTime = await getServerTime()
  page = supabase.from(table).select('*')   // no .gt, no .order, no .limit
  for cloudRow in page:
    localRow = SELECT * FROM <table> WHERE id = cloudRow.id
    winner = chooseWinner(localRow, cloudRow)
    if winner == 'cloud':
      table.localUpsert(cloudToLocal(cloudRow))
  recordPullSuccess(table, serverTime)
```

Execution trace (cloud has 10,000 rows total; only 350 new since last pull; user pulls):

```
  page = SELECT * FROM table  → 10,000 rows
  scan 10,000 rows:
    9,650 of them are identical to local (chooseWinner says local-wins or no-op)
    350 are newer → upsert + stamp synced_at
  network: 1 huge query, ~5MB payload
  At 100ms server response: feasible but the payload size dominates.
  At 1M rows: payload is 500MB, request times out.
```

Complexity: O(N) network bytes for the *full table* (N=total rows, not N=new rows) · O(N) memory at once.

What goes wrong at scale: the brute version costs you in proportion to total table size, not to what changed. With 10,000 cloud rows and 1 new one, brute pulls all 10,000 — ~5MB on the wire vs ~500B for the cursor version. At 1M rows, brute is 500MB per pull and times out at the HTTP layer. The whole point of incremental sync is to make pull cost proportional to *new data*, not to *total data*; brute force loses that property.

── Optimal ──────────────────────────────────────

The insight: a monotonic cursor (`updated_at > last_pull_at`) makes the cost proportional to *new* rows only. Pagination keeps memory bounded. Anchoring to server time (RPC) avoids local clock skew.

```
  serverTime = await getServerTime()                      // RPC, anchors the pull window
  cursor     = sync_meta[table].last_pull_at ?? '1970-01-01...'
  fetched, applied, skipped = 0, 0, 0

  loop:
    page = supabase.from(table)
                   .select('*')
                   .gt('updated_at', cursor)
                   .order('updated_at', ASC)
                   .limit(200)
    if page.error: break
    if page.data.empty: break
    fetched += page.length

    for cloudRow in page:
      localRow = SELECT * FROM <table> WHERE id = cloudRow.id
      winner = chooseWinner(localRow, cloudRow)
      if winner == 'local':
        skipped++; continue                              // local wins → don't overwrite
      stampedRow = { ...cloudToLocal(cloudRow), synced_at: serverTime }
      table.localUpsert(stampedRow)
      applied++

    cursor = page[last].updated_at
    if page.length < 200: break

  if no error: recordPullSuccess(table, serverTime)
  return { fetched, applied, skipped }
```

**Execution trace** (cloud has 350 newer rows; local conflicts on row 47):

```
  serverTime = "2026-05-07T10:31:00Z"
  cursor = "2026-05-07T09:00:00Z"

  Page 1: 200 rows (cursor → row 200)
    For each row:
      row 47 cloud.updated_at == 09:30, local.updated_at == 09:35
        chooseWinner: local newer → 'local' → skipped
      others: no local row OR cloud newer → upsert local + stamp synced_at = serverTime
    applied=199, skipped=1, cursor = page[199].updated_at

  Page 2: 150 rows (cursor → end)
    All clean → applied=349 total
    150 < 200 → break

  recordPullSuccess(table, serverTime)
  result: fetched=350, applied=349, skipped=1
```

**Complexity:** O(n) network across ⌈n/200⌉ pages · O(PAGE_SIZE) memory at a time.

---

## Why paginate by `updated_at` ASC + cursor

OFFSET pagination would miss rows that arrive during the loop (the window shifts). Cursor-by-timestamp is monotonic — even if cloud writes during the pull, the next page picks them up next time around.

## Why anchor to `serverTime` (RPC) and not `Date.now()`

Local clock skew. If the device clock is 30s behind, pulling rows newer-than-Date.now() would race the cloud's own timestamps and miss data. The server's clock is the authority.

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(N) bytes     │ O(new) bytes     │
  │ Space           │ O(N)           │ O(200) page      │
  │ At 1,000 rows   │ pull all 1,000 │ pull new only    │
  │ At 10,000 rows  │ pull all 10k   │ pull new only    │
  │ Readable?       │ yes            │ yes              │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: only on initial bootstrap when "new = everything" anyway (see [14-firstpull-bootstrap](./14-firstpull-bootstrap.md)). For every subsequent pull, brute is wrong by an order of magnitude.

This is what people mean by "incremental sync via a monotonic cursor." RSS readers do it with `Last-Modified` / `If-Modified-Since`, change-data-capture pipelines do it with `WHERE updated_at > ?`, event-sourced replicas do it with stream offsets. The shared trick is naming the cursor (a value both sides agree on), advancing it only on successful application, and anchoring it to a clock the client doesn't own — server time, logical timestamps, or stream sequence numbers. Anything else lets clock skew silently break the watermark.

---

## In this codebase

**Algorithm:**     `src/services/sync/pull.ts` → `pullTable()` L34–L117 (`PAGE_SIZE = 200` const at L23)
**Server clock:**  `src/services/sync/pull.ts` → `getServerTime()` L25–L33 — RPC wrapper that anchors `last_pull_at` to Postgres's clock, not the device's
**Per-row read:**  `src/services/sync/pull.ts` → `fetchLocalRow()` L118–L129 — used by the conflict gate
**Orchestrator:**  `src/services/sync/orchestrator.ts` → `pullAll()` L61–L82
**Conflict:**      `src/services/sync/conflict.ts` → `chooseWinner()` L20–L31
**RPC contract:**  `supabase/migrations/0003_server_time_rpc.sql` defines `get_server_time()` server-side

---

## Elaborate

### Where this pattern comes from
Cursor-based pagination is the standard for change-data-capture (CDC). DynamoDB Streams, Postgres logical replication, MongoDB change streams — all use a monotonic cursor (LSN, timestamp, sequence number) for the same reason: races during the loop.

### The deeper principle
**Pagination by mutable position (offset) is racy; pagination by monotonic value (timestamp, id) is safe.** The cursor must move forward only and must be a strict-greater-than predicate.

### Where this breaks down
- Two rows with identical `updated_at` at the page boundary — one might be skipped on the next page if the cursor uses strict `>`. Mitigation: tie-breaker on id, or accept the rare double-fetch.
- Massive tables where 200/page is still slow. Increase the page size, or shard the cursor.

### What to explore next
- [07-cloud-sync-push](./07-cloud-sync-push.md) → the write counterpart.
- [01-system-design/08-conflict-last-write-wins](../01-system-design/08-conflict-last-write-wins.md) → the per-row decision.
- Postgres logical replication slots → for the same idea at LSN granularity.

---

## Tradeoffs

We traded one server-time RPC per pull plus a per-row local SELECT for a monotonic cursor that's immune to device clock skew and a per-row LWW gate that protects unpushed local edits.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (cursor + serverTime│ Alternative (full-table fetch  │
│                  │ + per-row conflict)            │ + trust cloud blindly)         │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Network bytes    │ O(new rows)                    │ O(total table)                 │
│ At 10k rows,     │ 350 rows × ~500B = ~175KB      │ 10k rows × ~500B = ~5MB        │
│ 350 new          │                                │ — 28× more bytes               │
│ At 1M rows,      │ unchanged — only new is sent   │ 500MB payload — HTTP times out │
│ 10k new          │                                │ before parse                   │
│ Round-trips/pull │ 1 RPC for serverTime + ⌈new/   │ 1 huge SELECT, no cursor       │
│                  │ 200⌉ pages                     │                                │
│ Memory per pull  │ O(200) page buffer             │ O(N) — full table in RAM       │
│ Conflict safety  │ chooseWinner per row — offline │ cloud always wins — offline    │
│                  │ local edits survive            │ edits silently overwritten     │
│ Clock dependence │ Postgres `get_server_time()`   │ `Date.now()` — 30s device skew │
│                  │ — skew-immune                  │ skips or duplicates rows       │
│ Code complexity  │ ~117 LOC for pullTable +       │ ~50 LOC — no cursor, no page   │
│                  │ helpers + RPC migration        │ loop, no chooseWinner          │
│ Failure mode     │ partition mid-loop → last_pull │ partition mid-pull → next pull │
│                  │ _at unchanged, idempotent      │ re-fetches entire table        │
│                  │ replay                         │                                │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

Every pull pays one extra RPC for `get_server_time()` — round-trip to Postgres before any row work begins. On a 200ms-latency mobile connection that's a fixed 200ms upfront cost regardless of how many rows are new. We accepted it because the alternative (using `Date.now()`) ships a clock-skew bug that's invisible until two devices' clocks disagree, at which point rows silently disappear.

The conflict gate runs one local SELECT per cloud row — at 350 new rows that's 350 SQLite reads. Each is sub-millisecond on this scale, but the pattern is theoretically O(n). The principled fix would be to batch the local read (`SELECT * WHERE id IN (...)`) then join in JS, which we haven't done because per-row reads are fast enough at <1k pulls and the batch shape complicates the chooseWinner contract.

`PAGE_SIZE = 200` is empirical — large enough to amortize round-trip overhead, small enough that one slow page doesn't block the loop visibly. A retuneable per-table size would be more correct (entries pages should be smaller because of text blobs; nutrition pages could be larger) but we picked one constant for orchestrator uniformity.

The strict `>` predicate loses ties. If two rows share `updated_at` at a page boundary, the second one is skipped. Postgres `now()` is microsecond-resolution so collisions are rare under single-writer load, but the bug is real — it surfaces under concurrent writers, exactly when we can least afford lost rows.

### What the alternative would have cost

Full-table fetch (no cursor) would have been ~50 LOC simpler — no `gt('updated_at', cursor)`, no page loop, no `last_pull_at` bookkeeping. At 10k cloud rows with 350 new, the network cost jumps from ~175KB to ~5MB per pull — a 28× hit on mobile bandwidth and battery. At 1M rows the payload is 500MB and the HTTP layer times out before the JSON parser even starts.

Skipping `chooseWinner` and trusting the cloud blindly would have shaved ~30 LOC. It would also silently overwrite local edits the user made offline — typing on the device, going to airplane mode, the next pull arrives and wipes the work. We've already lost data this way in early Phase A; the per-row gate is the scar tissue from that bug.

`Date.now()` as the cursor source instead of the server RPC would have removed the upfront 200ms RPC cost. The hidden price is that a device clock 30s behind the cloud would fetch `WHERE updated_at > (clock - 30s)` — re-pulling the same 30s window forever, or worse, a clock 30s ahead would set `last_pull_at` past rows the cloud hasn't written yet, silently skipping them.

### The breakpoint

Fine until the new-rows-per-pull count exceeds ~5,000, at which point the per-row SELECT gate dominates and the page loop blocks the UI thread visibly. The fix is to batch the local reads (`SELECT WHERE id IN (...)`) into one query per page, then join in JS — a ~30 LOC change to `chooseWinner` that we haven't shipped because at current pull volumes (≤500 new rows) the per-row cost is invisible.

### What wasn't actually a tradeoff

Anchoring `last_pull_at` to server time isn't really a tradeoff against local clock — the local clock is wrong by definition under multi-device sync. We paid 200ms per pull to make the cursor correct, not faster; the RPC is correctness, not optimization.

---

## Tech reference (industry pairing)

### @supabase/supabase-js

- **Codebase uses:** `@supabase/supabase-js` (`.gt` + `.order` + `.limit` cursor-based pagination).
- **Why it's here:** `.gt('updated_at', cursor)` + `.order` ASC + `.limit(200)` is the monotonic pagination that keeps pull cost proportional to new rows only.
- **Leading today:** Supabase — `adoption-leading`, 2026.
- **Why it leads:** managed Postgres + auth + RLS + Storage in one console; SDK mirrors PostgREST directly.
- **Runner-up:** Neon + Drizzle — `innovation-leading` typed SQL with branch-per-PR workflow.

---

## Summary

Cursor-based incremental pull is the family of "fetch only what's new since the last watermark, page through the result, resolve conflicts per row" — the same shape as RSS `If-Modified-Since`, event-sourced replication, and `WHERE updated_at > ?` CDC pipelines. In this codebase `pullTable` in `src/services/sync/pull.ts` selects cloud rows where `updated_at > last_pull_at`, pages them by 200 ASC, runs `chooseWinner(local, cloud)` per row, and stamps `synced_at = serverTime` on accepted rows so the next push doesn't re-flag them as outgoing-dirty. The constraint is that the cursor must come from a clock both sides agree on — Postgres's `get_server_time()` RPC, not the device's `Date.now()` — so clock skew between devices can't skip or duplicate rows. The cost is one local SELECT per row for the conflict gate and one extra RPC per pull for server time, both cheap relative to pull's non-hot-path role. Brute-force full-table fetch is acceptable only at initial bootstrap when "new = everything" anyway.

Key points to remember:
- Monotonic cursor (`updated_at > last_pull_at`) + page-by-200 ASC + strict `>` predicate; OFFSET pagination is racy under concurrent writes.
- The cursor is anchored to server time, never local clock — device clock skew is the bug this prevents.
- `chooseWinner` per row is the read counterpart of LWW writes — local edits in flight don't get overwritten by stale cloud rows.
- Strict `>` loses ties when two rows share `updated_at` at a page boundary — composite cursor `(updated_at, id)` is the fix when collisions matter.
- O(new) bytes on the wire, O(200) memory per page; cost scales with what changed, not with total table size.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand that "OFFSET vs cursor" is about correctness, not just performance. With OFFSET, a row inserted into the middle of the result set during the loop causes a row to be skipped or duplicated; with `WHERE updated_at > cursor` ordered ASC, the cursor only moves forward and inserts during the loop are picked up on the next call automatically. The interviewer wants to hear me name "monotonic cursor" and explain *why* it's safe under concurrent writes — not just say "200/page is fast."

### Likely questions

[mid] Q: What happens if the same row is updated during the pull and lands in two different pages?
      A: It can only land in two pages if its `updated_at` advances past the page-1 cursor and into page 2's window. That means the row was newer than my cursor *at the start*, got fetched in page 1, then got updated *again* by another writer before I read page 2. On page 2 I see the new version, run `chooseWinner` against my freshly-applied local copy, and the newer cloud row wins. The double-apply is harmless because upserts are idempotent and `chooseWinner` always picks the newer `updated_at`.

```
[same-row across two pages flow]

  row R updated_at = 09:30  (fetched in page 1)
        │
        ▼  apply, stamp synced_at = serverTime
  local R updated_at = 09:30
        │
        ▼  another writer updates R to 09:45 mid-pull
  cloud R updated_at = 09:45
        │
        ▼  page 2 includes R (cursor was at 09:35)
  chooseWinner(local 09:30, cloud 09:45) → cloud wins
        │
        ▼  upsert again, same id, idempotent
  no harm — double-apply is a no-op semantically
```

[senior] Q: Why does `chooseWinner` get called per-row instead of trusting the cloud row blindly?
         A: Because the user could have edited locally while the device was offline. If I just upserted every cloud row, I'd overwrite local edits that haven't been pushed yet. `chooseWinner(local, cloud)` compares `updated_at` — if the local copy is newer (the user typed something), I skip the cloud row and let the next push send the local version. It's the read counterpart of the LWW write semantics. The cost is one local SELECT per row, which is sub-millisecond on SQLite.

```
                  Path taken (chooseWinner per row)    Alternative (trust cloud blindly)
                  ────────────────────────────────────  ──────────────────────────────────
local edits       protected — local newer → skipped    overwritten — user's offline work
                                                       silently lost
per-row cost      ~1 SQLite SELECT (sub-ms)            none — direct upsert
LOC               ~30 for conflict gate                ~5 — just upsert each cloud row
real bug seen     never since gate shipped              shipped, lost data in Phase A
LWW symmetry      read-side mirror of LWW writes       writes are LWW but reads aren't —
                                                       inconsistent semantics
verdict           per-row gate is the scar tissue       trust-blindly is the bug we already
                  from a previous bug                   paid for once
```

[arch] Q: What about network partitions during a multi-page pull — what's the recovery path?
       A: If the partition kills the connection mid-loop, `recordPullSuccess` never fires, so `last_pull_at` stays at the previous value. On the next pull, the cursor starts from the old `last_pull_at` and re-fetches everything from the partition point onward. Per-row I'm idempotent (chooseWinner + upsert), so the re-fetched rows that I'd already applied just get re-applied to the same value. No data loss; some duplicate network work. The only risk is if a row got *deleted* on the cloud during the partition — pull doesn't see deletes (it filters by `updated_at`), so I'd miss it. That's the soft-delete column's job; deleted rows still have a `deleted_at` and a fresh `updated_at`, so they propagate.

```
[scale curve — what breaks first at 10× and 100× pull volume]

  new rows/pull   pages   wall time @200ms/RT   per-row gate cost   breaks?
  ─────────────   ─────   ──────────────────   ─────────────────   ──────────────────
  350 (real)      2       ~600ms                ~50ms total          no
  3,500 (10×)     18       ~4s                  ~500ms total          no
  35,000 (100×)   175      ~35s                 ~5s on the gate       per-row SELECT loop
                                                  ◀── BREAKS FIRST    blocks UI thread
  500,000+        2,500    ~9min                 hopeless              need batched
                                                                      `SELECT WHERE id IN (...)`
```

### The question candidates always dodge
Q: You're using strict `>` on the cursor. What happens when two rows have identical `updated_at` timestamps at the page boundary?

A: I lose one. If page 1 ends with a row at `updated_at = T`, and there's another row also at `updated_at = T` that didn't fit in the page, my next query is `WHERE updated_at > T` — which excludes the second row entirely. It's a real bug. I haven't hit it in practice because (a) Postgres `now()` resolves to microseconds and collisions are rare under single-writer load, and (b) the row would still come back on the *next* update because `updated_at` would advance. The principled fix is a composite cursor `(updated_at, id)` with the predicate `(updated_at, id) > (cursor_t, cursor_id)`, which makes the ordering total. I haven't done it because at single-user scale the collision rate is effectively zero, but I'd ship the fix the moment I had two writers because then microsecond collisions become routine. It's the kind of bug that's invisible until it's catastrophic.

```
                  Path taken (strict > on updated_at)  Suggested ((updated_at, id) composite)
                  ────────────────────────────────────  ──────────────────────────────────
predicate         updated_at > cursor                  (updated_at, id) > (cursor_t, cur_id)
total ordering    no — ties possible at microsecond    yes — id breaks ties deterministically
collision rate    near-zero with single writer         routine under concurrent writers
                  (Postgres microsecond now())
data loss risk    one row per collision, per page      none
                  boundary
LOC               unchanged                            +5 LOC — composite cursor build
                                                       and parse
observed bug      never at single-user scale           bug is gone formally
verdict           fine for now — 2nd writer flips      ship the moment 2nd writer joins;
                  this immediately                     the bug is invisible until it
                                                       isn't
```

### One-line anchors
- "Monotonic cursor over OFFSET — concurrent writes don't shift the window."
- "Server time RPC because the device clock can lie; the cloud's clock is the authority."
- "`chooseWinner` per row is the read counterpart of LWW writes."
- "Strict `>` loses ties — composite cursor `(updated_at, id)` is the fix when collisions matter."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain cloud sync pull to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/sync/pull.ts:pullTable`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

You're pulling `entries`. `last_pull_at` is `2026-05-07T09:00Z`. Cloud has 350 rows newer than that. Your device clock is 30 seconds AHEAD of the server. Page 1 returns 200 rows; row 47 in that page has cloud `updated_at = 09:30Z`, and your local copy of that same row has `updated_at = 09:35Z` because you typed offline. Walk what happens during page 1: what `serverTime` value does `last_pull_at` end up at after success, what does `chooseWinner(local, cloud)` return for row 47, and would the answer change if you used `Date.now()` instead of the RPC?

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/pull.ts` L34–L117 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/sync/pull.ts` to support what exists
→ Point to `src/services/sync/conflict.ts:chooseWinner` (the per-row LWW gate that would need to become a `(updated_at, id)` composite cursor predicate to fix the strict-`>` tie-loss) if you chose the alternative

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
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — added v1.14.0 subtitle block + brute-force section + comparison table.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @supabase/supabase-js.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (newspaper-delivery metaphor + frontend bridge to React Query pagination + staleTime) and Move 3 principle after the Comparison block.
