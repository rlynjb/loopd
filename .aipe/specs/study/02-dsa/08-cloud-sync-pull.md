# Cloud sync pull — paginated, conflict-resolved, server-time anchored

> **Industry term:** Cursor-based pagination / watermark sync *(industry standard)*

> Pull only what's new since last pull, in 200-row pages, resolving conflicts row-by-row. Anchor to server time, not local clock.

**See also:** → [07-cloud-sync-push](./07-cloud-sync-push.md) · → [01-system-design/07-cloud-sync-mirror](../01-system-design/07-cloud-sync-mirror.md) · → [01-system-design/08-conflict-last-write-wins](../01-system-design/08-conflict-last-write-wins.md)

---

## Quick summary
- **What:** select cloud rows where `updated_at > last_pull_at`, page by 200 ASC, run `chooseWinner(local, cloud)` per row, stamp `synced_at = serverTime` on accepted rows.
- **Why here:** cursor-by-timestamp is monotonic — the next page picks up rows written during the loop. Server time avoids local clock skew.
- **Tradeoff:** per-row `chooseWinner` does an extra local SELECT. Acceptable; pull is rarely the hot path.

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

## Pseudocode

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

---

## When brute force is fine

The "brute" alternative is full-table pull (no cursor, no pagination). On any non-trivial table that's unworkable — would re-pull every row every time. Pagination is mandatory.

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

- **Server-time anchor** — gives: skew-immune. Costs: an extra RPC per pull.
- **Per-row local SELECT** — gives: precise conflict decisions. Costs: O(n) extra local reads (cheap; SQLite is fast).
- **Page size 200** — gives: balanced memory + roundtrips. Costs: arbitrary; tunable.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand that "OFFSET vs cursor" is about correctness, not just performance. With OFFSET, a row inserted into the middle of the result set during the loop causes a row to be skipped or duplicated; with `WHERE updated_at > cursor` ordered ASC, the cursor only moves forward and inserts during the loop are picked up on the next call automatically. The interviewer wants to hear me name "monotonic cursor" and explain *why* it's safe under concurrent writes — not just say "200/page is fast."

### Likely questions

[mid] Q: What happens if the same row is updated during the pull and lands in two different pages?
      A: It can only land in two pages if its `updated_at` advances past the page-1 cursor and into page 2's window. That means the row was newer than my cursor *at the start*, got fetched in page 1, then got updated *again* by another writer before I read page 2. On page 2 I see the new version, run `chooseWinner` against my freshly-applied local copy, and the newer cloud row wins. The double-apply is harmless because upserts are idempotent and `chooseWinner` always picks the newer `updated_at`.

[senior] Q: Why does `chooseWinner` get called per-row instead of trusting the cloud row blindly?
         A: Because the user could have edited locally while the device was offline. If I just upserted every cloud row, I'd overwrite local edits that haven't been pushed yet. `chooseWinner(local, cloud)` compares `updated_at` — if the local copy is newer (the user typed something), I skip the cloud row and let the next push send the local version. It's the read counterpart of the LWW write semantics. The cost is one local SELECT per row, which is sub-millisecond on SQLite.

[arch] Q: What about network partitions during a multi-page pull — what's the recovery path?
       A: If the partition kills the connection mid-loop, `recordPullSuccess` never fires, so `last_pull_at` stays at the previous value. On the next pull, the cursor starts from the old `last_pull_at` and re-fetches everything from the partition point onward. Per-row I'm idempotent (chooseWinner + upsert), so the re-fetched rows that I'd already applied just get re-applied to the same value. No data loss; some duplicate network work. The only risk is if a row got *deleted* on the cloud during the partition — pull doesn't see deletes (it filters by `updated_at`), so I'd miss it. That's the soft-delete column's job; deleted rows still have a `deleted_at` and a fresh `updated_at`, so they propagate.

### The question candidates always dodge
Q: You're using strict `>` on the cursor. What happens when two rows have identical `updated_at` timestamps at the page boundary?

A: I lose one. If page 1 ends with a row at `updated_at = T`, and there's another row also at `updated_at = T` that didn't fit in the page, my next query is `WHERE updated_at > T` — which excludes the second row entirely. It's a real bug. I haven't hit it in practice because (a) Postgres `now()` resolves to microseconds and collisions are rare under single-writer load, and (b) the row would still come back on the *next* update because `updated_at` would advance. The principled fix is a composite cursor `(updated_at, id)` with the predicate `(updated_at, id) > (cursor_t, cursor_id)`, which makes the ordering total. I haven't done it because at single-user scale the collision rate is effectively zero, but I'd ship the fix the moment I had two writers because then microsecond collisions become routine. It's the kind of bug that's invisible until it's catastrophic.

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
