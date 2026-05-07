# Cloud sync pull — paginated, conflict-resolved, server-time anchored

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

- `src/services/sync/pull.ts` → `pullTable()`.
- `src/services/sync/orchestrator.ts` → `pullAll()`.
- `src/services/sync/conflict.ts` → `chooseWinner()`.
- Postgres RPC `get_server_time()` defined in `supabase/migrations/0003_server_time_rpc.sql`.

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
