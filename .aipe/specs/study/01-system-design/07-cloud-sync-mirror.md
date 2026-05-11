# Cloud sync as a mirror

**Industry name(s):** Cloud sync mirror, replication-as-mirror
**Type:** Industry standard · Language-agnostic

> The local DB is canonical. Cloud is a mirror. Push and pull are independent flows that share the registry of 10 syncable tables.

**See also:** → [01-local-first-request-flow](./01-local-first-request-flow.md) · → [05-soft-delete](./05-soft-delete.md) · → [08-conflict-last-write-wins](./08-conflict-last-write-wins.md) · → [09-debounced-push](./09-debounced-push.md) · → [10-bootstrap-decision-tree](./10-bootstrap-decision-tree.md)

---

## Why care

You've used an app that "syncs across devices" and watched it stall on a loading spinner because the server was the only place the data really lived. The moment the network blinked, the app was useless. That happens whenever the cloud is treated as the authoritative store and the device is treated as a thin view of it — every read becomes a remote read, every write becomes a remote write, and the user pays for both.

A replica-as-mirror flip reverses the relationship: the device is authoritative, the cloud is an asynchronously-updated copy that exists for durability and cross-device transfer. It belongs to the family of "asynchronous replication" patterns, alongside Postgres streaming replicas, CDN origin pulls, and email's store-and-forward model. You've seen this in Dropbox (your local folder is real, the cloud is a backup that catches up), in mobile Mail (the inbox renders from a local cache and reconciles in the background), and in any "offline-capable" SDK that exposes a synchronous local API. The next block walks the mechanics.

---

## How it works

Push and pull are separate flows. They share the SyncableTable registry (10 tables) and the `sync_meta` ledger (one row per table tracking `last_pull_at`, `last_push_at`, `pending_pushes`, `last_error`).

Push selects local rows where `updated_at > synced_at` (or `synced_at IS NULL`), batches them by 50, and upserts to Supabase with `onConflict: 'user_id,id'`. On batch success, stamps `synced_at = now` on each row. On batch failure, leaves `synced_at` alone — the next push retries the same batch.

Pull selects cloud rows where `updated_at > sync_meta[table].last_pull_at`, in pages of 200, ordered ASC. For each cloud row it loads the local counterpart and runs `chooseWinner` (last-write-wins). If cloud wins, upserts locally and stamps `synced_at = serverTime`. If local wins, skips.

The pull anchors to `serverTime` (a Postgres RPC) instead of `Date.now()` — local clock skew would otherwise create races against the cloud's own timestamps. The full picture is below.

---

## Cloud sync mirror — diagram

```
┌─ Local storage layer (device) ─────┐         ┌─ Provider layer (Supabase) ────┐
│                                    │         │                                │
│   updated_at = canonical           │         │   updated_at = canonical       │
│   synced_at  = local-only          │         │   (never has synced_at)        │
│   deleted_at = soft-tombstone      │         │   deleted_at = soft-tombstone  │
│                                    │         │                                │
│   read: WHERE deleted_at NULL      │         │   read: server-side filtered   │
│                                    │         │                                │
└────────┬───────────────────────────┘         └─────────────▲──────────────────┘
         │                                                   │
         │  ┌─ Network / sync layer ────────────────────────┐│
         │  │ push: WHERE updated_at > synced_at            ││
         │  │       upsert in batches of 50                 ││
         ├──┤                                               ├┤
         │  │ pull: WHERE updated_at > last_pull_at         ││
         │  │       per-row chooseWinner(local, cloud)      ││
         │  └───────────────────────────────────────────────┘│
         ▼                                                   │
┌─ Local storage layer (bookkeeping) ┐                       │
│   sync_meta (per-table ledger)     │                       │
│   last_pull_at, last_push_at,      │                       │
│   pending_pushes                   │                       │
└────────────────────────────────────┘                       │
                                                             │
                                       (cloud writes go ─────┘
                                        through Network layer
                                        back to provider)
```

---

## In this codebase

**Push:**            `src/services/sync/push.ts` → `pushTable()` L9–L67 (`BATCH_SIZE = 50` const at L7)
**Pull:**            `src/services/sync/pull.ts` → `pullTable()` L34–L117 (`PAGE_SIZE = 200` const at L23, `getServerTime()` L25–L33)
**Orchestrator:**    `src/services/sync/orchestrator.ts` → `pushAll()` L38–L60, `pullAll()` L61–L82 — both walk the 10-table `REGISTRY` defined at L25
**Conflict:**        `src/services/sync/conflict.ts` → `chooseWinner()` L20–L31
**Ledger:**          `src/services/sync/syncMeta.ts` — per-table `last_pull_at`, `last_push_at`, `pending_pushes`, `last_error`
**Per-table glue:**  `src/services/sync/tables/*` — each exports `localQueryDirty`, `localToCloud`, `localFromCloud`, `localMarkSynced`

```
Push pseudocode (push.ts):
  dirty = SELECT * FROM <table> WHERE updated_at > COALESCE(synced_at, '1970-01-01')
  if dirty empty: return success
  for batch of 50 in dirty:
    cloudRows = batch.map(localToCloud)
    supabase.from(table).upsert(cloudRows, onConflict: 'user_id,id')
    if ok: stamp synced_at on each row
    if err: leave synced_at alone — next push retries the same batch

Pull pseudocode (pull.ts):
  serverTime = supabase.rpc('get_server_time')        // avoid clock skew
  cursor = sync_meta[table].last_pull_at ?? '1970-01-01'
  loop:
    page = supabase.from(table).gt('updated_at', cursor).order('updated_at ASC').limit(200)
    if page empty: break
    for cloudRow in page:
      local = SELECT * FROM <table> WHERE id = cloudRow.id
      winner = chooseWinner(local, cloudRow)            // last-write-wins
      if winner == 'local': skip
      else:                 upsert localFromCloud(cloudRow), stamp synced_at
    cursor = max(updated_at) in page
  sync_meta[table].last_pull_at = serverTime
```

---

## Elaborate

### Where this pattern comes from
This is the classic timestamp-cursor sync engine, descended from CouchDB and DynamoDB streams. The `synced_at` column for the local "watermark" + `updated_at` for the truth is a long-standing pattern — separating "when this changed" from "when we last reported it" is what makes incremental sync possible.

### The deeper principle
**Make canonical and derived states explicit.** `updated_at` is canonical (it travels with the row). `synced_at` is derived (it's local bookkeeping). Confusing the two makes sync impossible to reason about; separating them makes both easy.

### Where this breaks down
- Bidirectional realtime where both sides write the same row in the same second. LWW will pick one and silently drop the other; CRDTs or operational transforms become necessary.
- Tables with massive churn where the dirty set per push is huge. Batches of 50 stop being enough; sharding becomes mandatory.

### What to explore next
- [Conflict resolution: last-write-wins](./08-conflict-last-write-wins.md) → the per-row decision in pull.
- [Bootstrap decision tree](./10-bootstrap-decision-tree.md) → first-cold-start logic.
- [02-dsa/07-cloud-sync-push](../02-dsa/07-cloud-sync-push.md) and [02-dsa/08-cloud-sync-pull](../02-dsa/08-cloud-sync-pull.md) for execution traces.

---

## Tradeoffs

We traded ever-fresh cloud reads for instant local writes: the cloud is allowed to lag by seconds because the device never asks it anything during a render. Every sync property — durability, cross-device transfer, recovery — is built on the assumption that the cloud catches up, not that it leads.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (local canonical) │ Alternative (cloud canonical)│
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Read latency     │ ~1 ms (SQLite, on-device)    │ 80–250 ms (Supabase rtt)     │
│ Write latency    │ ~1 ms (SQLite) + 5 s debounce│ 80–250 ms per write          │
│                  │ to cloud                     │                              │
│ Offline behaviour│ full read/write              │ degraded → fully broken      │
│ Cross-device     │ converges after next push    │ instant — server is canonical│
│ freshness        │ + pull (~5–10 s)             │                              │
│ Schema noise     │ +synced_at, +deleted_at on   │ none beyond what cloud needs │
│                  │ every synced table; sync_meta│                              │
│                  │ + sync_deletions tables      │                              │
│ Files added      │ ~12 in src/services/sync/    │ 0 — direct supabase-js calls │
│ Failure blast    │ cloud outage → app fully     │ cloud outage → app fully     │
│ radius           │ functional, sync lags        │ broken                       │
│ Bidirectional    │ LWW silently picks a winner  │ server arbitrates            │
│ realtime         │ → CRDT needed at that scale  │                              │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

Cross-device freshness lags by ~5–10 seconds in the steady state. A user editing on phone A and immediately opening phone B sees the older state until the next push (debounced 5 s) plus next pull (manual or app-foreground triggered) lands. For solo journaling that's invisible; for collaborative editing it would be a bug.

We pay for the local-canonical decision in schema noise. Every synced table carries two extra columns (`synced_at`, `deleted_at`) and the database has two extra local-only tables (`sync_meta`, `sync_deletions`). The `src/services/sync/` directory holds ~12 files (orchestrator, push, pull, conflict, firstPull, bootstrap, schedulePush, syncMeta, devActions, types, tables/*). A new synced entity isn't "add a Supabase table" — it's "add a Supabase migration + a registry entry + a per-table mapper file + insert/update calls that bump `updated_at` + a soft-delete code path + a `schedulePush()` call."

LWW via `chooseWinner` is the resolution rule, and at single-writer scale it's correct. The day a second writer exists, the rule silently picks one and discards the other — no error, no log. That's the price of not running CRDTs.

### What the alternative would have cost

If we had treated the cloud as canonical and the device as a view, every read would be a network round-trip — typical Supabase rtt is 80–250 ms over LTE. The dashboard load (~30 SQL queries) would go from 30 ms total to 2.4–7.5 seconds, every time. Autosave on every keystroke would mean a network write on every keystroke — either we throttle and lose data on crash, or we send everything and pay the round-trip per character.

The offline story would collapse. The user opens loopd on the subway, can't read yesterday's entry, can't write today's. Every "syncs across devices" SaaS app has solved this problem the same way we did — but a cloud-canonical version saves the ~12 files in `src/services/sync/`, the `synced_at` column, and the entire `sync_meta` ledger. It's a real codebase saving if the user could tolerate the latency. They can't.

### The breakpoint

Fine until the app becomes collaborative — two writers on the same row at the same time. LWW is correct exactly once per row per second; concurrent edits to the same field produce undefined ordering. The next architecture isn't "fix LWW" — it's CRDTs (Y.js / Automerge) on the prose layer so edits compose deterministically before scanners run. That replaces `chooseWinner` and rewrites the conflict path; the rest of push/pull/orchestrator survives.

---

## Tech reference (industry pairing)

### @supabase/supabase-js + Supabase Postgres

- **Codebase uses:** Supabase Postgres as the canonical cloud mirror; `supabase.from(table).upsert()` and `.gt('updated_at', ...)` are the two SDK calls the entire push/pull engine is built on; `get_server_time()` RPC anchors the pull cursor.
- **Why it's here:** the cloud-sync-mirror pattern is defined entirely in terms of Supabase's upsert + cursor-query API; the 10-table `REGISTRY`, `sync_meta` ledger, and `chooseWinner` all assume Supabase's conflict semantics and PostgREST interface.
- **Leading today:** Supabase — `adoption-leading` for Postgres-as-a-service, 2026.
- **Why it leads:** managed Postgres + auth + RLS + Storage in one console; SDK mirrors PostgREST; `onConflict` upsert + server-time RPC make the sync engine expressible in ~12 files.
- **Runner-up:** Neon + Drizzle — `innovation-leading` typed SQL with branch-per-PR; Convex is the reactive-first alternative.

### expo-sqlite (WAL)

- **Codebase uses:** `expo-sqlite`, WAL mode, via `database.ts`; local-canonical store that push reads from and pull writes back to.
- **Why it's here:** the "local canonical" half of the mirror pattern depends on `expo-sqlite`'s synchronous WAL writes; `synced_at` and `deleted_at` live as columns in `expo-sqlite` tables, and the dirty-set query (`updated_at > synced_at`) runs locally.
- **Leading today:** `expo-sqlite` — `adoption-leading` for RN local DB, 2026.
- **Why it leads:** ships with the Expo SDK; battle-tested WAL mode; mirrors the SQLite C API directly with zero bridge cost for Expo projects.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding with no bridge cost; the perf-tier alternative for bare React Native projects.

---

## Summary

A replica-as-mirror flip makes the device authoritative and the cloud an asynchronously-updated copy that exists for durability and cross-device transfer — every read renders from the local store, no read path waits on the network. In this codebase `pushTable` in `src/services/sync/push.ts` selects local rows where `updated_at > synced_at`, batches them by 50, and upserts to Supabase with `onConflict: 'user_id,id'`; `pullTable` in `src/services/sync/pull.ts` selects cloud rows newer than `last_pull_at` in pages of 200 and runs `chooseWinner(local, cloud)` per row, with `pushAll` and `pullAll` in `orchestrator.ts` walking the 10-table `REGISTRY`, and `sync_meta` tracking `last_pull_at`, `last_push_at`, `pending_pushes`, and `last_error` per table. The constraint was instant writes — no network in the request path — and the 5-second push debounce trades a little staleness for vastly fewer round-trips during typing. The cost is schema noise (every synced row carries `synced_at` local-only and `deleted_at`), and a missed `synced_at` stamp means a row pushes forever. The pull cursor anchors to `serverTime` from a Postgres RPC instead of `Date.now()` because clock skew would otherwise drop rows in the cursor gap.

Key points to remember:
- Push and pull are separate flows sharing the 10-table `REGISTRY` and the `sync_meta` ledger; each can be retried, scheduled, and tested independently.
- Two cursors: push uses `updated_at > synced_at` (local-only watermark), pull uses `updated_at > last_pull_at` (per-table ledger).
- Lives in step 2 (Request flow) and step 4 (State ownership) of the system-design checklist.
- `updated_at` is canonical and travels with the row; `synced_at` is local bookkeeping and never goes to the cloud.
- LWW via `chooseWinner` is the resolution rule; it breaks down on bidirectional realtime where both sides write the same row in the same second.

---

## Interview defense

### What an interviewer is really asking
The interviewer is checking whether you built a sync engine or whether you're using a service that hides one. "We use Supabase" is a shorthand that gets you nothing if it's followed by "and that handles syncing." The probe is: what runs on each side, what's the cursor, what happens when the device is offline for a week and then comes back, and what's the resolution rule when both sides have edits.

### Likely questions

[mid] Q: How does push know which rows to send?

A: `pushTable` queries `WHERE updated_at > COALESCE(synced_at, '1970-01-01')` against the local table — that's the dirty set. Every successful upsert batch stamps `synced_at = now()` on the rows in that batch, so the next push won't re-send them. `synced_at` is local-only — it never goes to the cloud, because the cloud doesn't need to know when this device last reported. The two timestamps separate "when the row last changed" (canonical, replicates) from "when this device last reported it" (bookkeeping, stays local).

```
[push: who's dirty?]

  SELECT * FROM <table>
  WHERE updated_at > COALESCE(synced_at, '1970-01-01')
        │
        ▼  batch of 50
  supabase.upsert(rows, onConflict: 'user_id,id')
        │
        ├── ok  → stamp synced_at = now() on this batch's rows
        │
        └── err → leave synced_at alone (next push retries same batch)
```

[senior] Q: Why anchor the pull cursor to a Postgres RPC `get_server_time` instead of just `Date.now()`?

A: Clock skew. The pull cursor is `last_pull_at`, and on the next pull I select cloud rows with `updated_at > last_pull_at`. If `last_pull_at` was stamped from the device's clock, and the device's clock is 30 seconds ahead of Supabase's, I'd miss every row whose cloud `updated_at` is in that 30-second gap. Stamping `last_pull_at` from `serverTime` (returned by the RPC) means the cursor is in the same time domain as the rows I'm filtering against. The cost is one extra round-trip per pull cycle; the win is that I never miss rows.

```
                  Path taken (serverTime cursor)        Alternative (Date.now() cursor)
                  ──────────────────────────────        ──────────────────────────────
cursor source     supabase.rpc('get_server_time')       device's local clock
cost              +1 round-trip per pull (~100 ms)      0
clock-skew risk   zero — cursor in same time domain    +30 s device ahead → 30 s gap;
                  as cloud's updated_at                 rows in gap missed FOREVER
                                                        (next pull's cursor skipped past)
failure mode      slower pull                           silent data loss, undetected
when it pays back every pull on every device           never — risk is unbounded
```

[arch] Q: What happens if the table grows to ten million rows? Where does the sync engine break?

A: Several places. The push query `WHERE updated_at > synced_at` has no index on `updated_at` today — at ten million rows that's a full scan per push. The fix is `CREATE INDEX ON <table>(updated_at)` (or partial index on `updated_at WHERE deleted_at IS NULL`). The pull pagination is fine in shape (200/page, ordered by `updated_at`) but assumes a sane index on the cloud side. The `chooseWinner` step does a per-row local SELECT — that's already O(log n) with the PK index, so it scales. The hard ceiling is the push batch size: 50/batch is right for ~hundreds-of-rows-per-day usage; at sustained high write volume, batching by 500 with parallel batches per table would matter.

```
At 10M rows per synced table:

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — reads SQLite local              │
  └─────────────────────────────────────────────┘
              │
  ┌─ Push query (WHERE updated_at > synced_at)  ┐
  │ no index on updated_at today                │  ◀── BREAKS FIRST
  │ full table scan per push (~seconds)         │     (fix: CREATE INDEX
  │ batch size 50 = 200k batches to drain queue │      ON <table>(updated_at)
  │                                             │      WHERE deleted_at IS NULL)
  └─────────────────────────────────────────────┘
              │
  ┌─ Pull pagination ───────────────────────────┐
  │ 200/page, ordered by updated_at ASC         │
  │ shape fine; needs same index on cloud side  │
  └─────────────────────────────────────────────┘
              │
  ┌─ chooseWinner per-row SELECT ───────────────┐
  │ O(log n) with PK index — scales             │
  └─────────────────────────────────────────────┘
              │
  ┌─ Batch size 50 ─────────────────────────────┐
  │ right for ~100s rows/day                    │
  │ at sustained high write, raise to 500 +     │
  │ parallel batches per table                  │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Push and pull both run on `pushAll`/`pullAll` — what guarantees that a row I just pushed isn't immediately pulled back and overwritten?

A: It's not strictly guaranteed; it's resolved by `chooseWinner`. After a successful push, my local row's `updated_at` is unchanged but `synced_at = now`. The cloud row now has the same `updated_at`. On the next pull, the cloud row's `updated_at` equals my local's, which the rule resolves as "tie → cloud" — and cloud upserts back to local. That's idempotent in practice (the data is identical), but it does mean the row briefly bounces. The honest case where this hurts is if the cloud server's timestamp is slightly different from what I stamped on push — that's possible because Supabase may rewrite `updated_at` server-side via a default. The mitigation is that my push doesn't set `updated_at` from the device clock; the cloud trigger or my mapper handles it. If I were paranoid I'd add a `(user_id, id, updated_at)` short-circuit in `chooseWinner` that says "if updated_at is byte-identical, skip" — that's a thirty-line change I haven't shipped because the pingpong has zero observable impact in practice.

```
                  Path taken (chooseWinner LWW)         Suggested (atomic push-then-block-pull)
                  ──────────────────────────────        ──────────────────────────────────
push-pull race    real — pulled row may overwrite       avoided — pull pauses while push runs
                  just-pushed identical row
data integrity    idempotent (identical bytes)          identical guarantee but no replay
observed impact   zero — UI sees no change              zero
extra complexity  none — LWW handles it                 push/pull cross-coordination,
                                                          mutex per table, mid-write semantics
debugging         "why did this row update twice in     "why is push waiting on pull?"
                  the log?" — readable                  much harder to trace
short-circuit fix +30 LOC in chooseWinner               not the simpler option here
when it matters   never on solo single-writer           if observable bounce ships, revisit
```

### One-line anchors
- "Local canonical, cloud mirror — the read path never waits on the network."
- "Push is `WHERE updated_at > synced_at`; pull is `WHERE updated_at > last_pull_at`. Two cursors, two flows, one shared registry."
- "Pull anchors to `serverTime` from a Postgres RPC, not `Date.now()` — clock skew would otherwise drop rows."
- "Per-batch `synced_at` stamping is the integrity bar; one missed stamp means a row pushes forever."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "cloud as a mirror" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/sync/{push,pull,orchestrator}.ts`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user opens loopd on a second device for the first time after using device A for two weeks. Cloud has 14 days of entries. Walk what happens between launch and the first dashboard render: which sync function fires first, what does it select, what's `last_pull_at` set to before vs after, and what does the user see while it's running?

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/bootstrap.ts` L59–L96 and `src/services/sync/pull.ts` L34–L117 to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/sync/orchestrator.ts:pushAll` (the per-table sequential loop) to support what exists
→ Point to a per-table parallel push (`Promise.all` over the registry) or a multi-table RPC if you chose the alternative

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).

---
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram; added architectural-layer labels to the primary diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @supabase/supabase-js, expo-sqlite.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.
