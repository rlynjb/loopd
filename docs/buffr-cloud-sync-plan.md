# buffr — Cloud Sync Implementation Plan

Working plan for executing [buffr-cloud-sync-spec.md](./buffr-cloud-sync-spec.md). The spec covers *what* and *why*; this doc covers *in what order, with what checkpoints, and what to verify before taking the next step.*

Phases are designed to be **independently shippable / revertible** — each ends in a state where the app still works, the sync layer is partially live, and Notion sync is still operational. **Notion only gets deleted after M7**, the very last step. Until then, both systems can coexist.

Total estimated effort: **~46–62h** per spec §10. Aggressive cut: **~39h** (skip first-pull, skip vacuum, minimal dev menu) — see §M4 fast-path note.

---

## Snapshot — what's currently in tree

Verified 2026-05-02 against the spec's deletion list:

| Path | Status | LOC |
|---|---|---|
| `src/services/notion/sync.ts` | Present | 1,168 |
| `src/services/notion/api.ts` | Present | 128 |
| `src/services/notion/mapper.ts` | Present | 166 |
| `src/services/notion/todosMapper.ts` | Present | 213 |
| `src/services/notion/habitsMapper.ts` | Present | 193 |
| `src/services/notion/threadsMapper.ts` | Present | 160 |
| `src/services/notion/config.ts` | Present | 153 |
| `app/settings/notion-sync.tsx` | Present | — |
| `app/settings/notion-guide.tsx` | Present | — |
| `src/services/sync/` | **Does not exist** | new |
| `supabase/` | **Does not exist** | new |

Total deletion target after M7: **~2,181 LOC** in `notion/` plus the two settings pages plus `NotionSyncProvider`.

---

## Milestones

### M0 — Foundation (no app changes yet)
**Spec steps:** 1, 2, 3 · **Est:** 6–7h · **Ships:** schemas only

1. Create Supabase project. Capture `SUPABASE_URL` + `SUPABASE_ANON_KEY` into `.env` (already gitignored — verify).
2. Add `@supabase/supabase-js` dependency. Don't import it from app code yet.
3. Write [`supabase/migrations/0001_initial_schema.sql`](../supabase/migrations/0001_initial_schema.sql):
   - 10 synced tables per spec §3.2 (skip `sync_deletions`).
   - Every table gets `user_id UUID NOT NULL`, `deleted_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ NOT NULL`.
   - JSONB for the eight JSON columns listed in spec §3.1.
   - CHECK constraints mirror local SQLite where applicable. **Skip the `thread_mentions` "at least one of entry_id/todo_id" CHECK** — manual-touch deviation requires NULL-NULL rows (spec §12 open question, default: app-level invariant only).
   - FK references where they aid integrity; cascade rules per §4.4 ordering.
   - Indexes per spec §3.4.
4. Write [`supabase/migrations/0002_rls_policies.sql`](../supabase/migrations/0002_rls_policies.sql) — policies authored, **`DISABLE ROW LEVEL SECURITY`** on every table per spec §3.6. (Phase B flips this on.)
5. Local migration in `services/database.ts`: bump schema version, add `synced_at TIMESTAMPTZ` and `deleted_at TIMESTAMPTZ` columns to every synced table. Create `sync_meta` table per spec §3.5. Do NOT drop `sync_deletions` yet — that comes in M4.

**Checkpoint:** Apply migrations to a fresh Supabase project. Run `supabase db reset` cleanly. App still launches, Notion sync still works (we touched nothing in app code beyond column additions). No tests yet — schema only.

---

### M1 — Sync engine skeleton (push-only, single table)
**Spec steps:** 4, 5, 9, 10, 11 (push half), 14 (one table only) · **Est:** 8–10h · **Ships:** `entries` table pushes to Supabase

The smallest end-to-end slice: take one table, get its rows into Postgres. This validates the architecture before generalizing.

1. `sync/client.ts` — Supabase singleton, hardcoded `user_id = '00000000-0000-0000-0000-000000000001'`, env-var-driven URL/key.
2. `sync/types.ts` — `SyncableTable<TLocal, TCloud>` interface per spec §6.2.
3. `sync/syncMeta.ts` — CRUD for the `sync_meta` table.
4. `sync/conflict.ts` — `chooseWinner(localRow, cloudRow)` returning the newer one by `updated_at`. Pure function; trivially testable.
5. `sync/push.ts` — generic push: query rows where `updated_at > synced_at`, batch upsert via `INSERT ... ON CONFLICT (user_id, id) DO UPDATE`, stamp `synced_at` on success.
6. `sync/orchestrator.ts` — minimal `pushAll()` that walks a registry of `SyncableTable`s in `pushOrder`. **Pull side is a stub** that returns immediately.
7. `sync/tables/entries.ts` — first SyncableTable implementation. JSON-column conversions go here. **No dashboard/editor wiring yet** — push is dev-menu-triggered only.

**Verify before moving on:**
- `pushAll()` from a Node script / dev menu uploads every local entry to Supabase.
- Re-running `pushAll()` is a no-op (synced_at gating works).
- Edit an entry, run `pushAll()`, observe the cloud row update.
- Concurrency: if two pushes overlap, no duplicate rows (ON CONFLICT handles it).

**Checkpoint:** Manually verify in Supabase web console that `entries` rows match local DB by count and content. **Notion sync is still the canonical cloud system** — cloud-sync is in shadow mode.

---

### M2 — Pull + remaining table modules
**Spec steps:** 7, 11 (pull half), 14 (remaining 9 tables) · **Est:** 10–14h · **Ships:** every synced table round-trips

1. `sync/pull.ts` — generic incremental pull. `SELECT NOW() AS server_time, * FROM <table> WHERE user_id = $1 AND updated_at > $2` per spec §4.7. For each row, route through `conflict.chooseWinner` then upsert local. Stamp `sync_meta.last_pull_at = server_time` only on success.
2. Wire `pullAll()` in `orchestrator.ts` to walk the registry in `pullOrder` (different from pushOrder per spec §4.4).
3. Implement the remaining nine `sync/tables/*.ts` files:
   - `projects.ts`, `dayMeta.ts`, `vlogs.ts`, `aiSummaries.ts`, `nutrition.ts`, `habits.ts`, `todoMeta.ts`, `threads.ts`, `threadMentions.ts`.
   - Each is thin (~50–100 LOC): JSON conversions, type coercions (INTEGER↔BOOLEAN, TEXT↔TIMESTAMPTZ), CRUD calls.
4. Register all ten with the orchestrator with their `pushOrder` / `pullOrder` ranks.

**Verify before moving on:**
- `pushAll()` followed by `pullAll()` from the dev menu is a stable no-op.
- Wipe a single table cloud-side, run `pushAll()`, verify it repopulates.
- Wipe the same table local-side (TRUNCATE), run `pullAll()`, verify it repopulates from cloud.
- The manual-touch deviation: a `thread_mentions` row with NULL entry_id+todo_id round-trips through both directions.

**Checkpoint:** Snapshot current local DB (`cp buffr.db buffr.db.bak`). Round-trip every table. Notion sync still owns the actual auto-sync at boot.

---

### M3 — Soft delete migration (the risky one)
**Spec steps:** 15, 16 · **Est:** 6–8h · **Ships:** every read filters soft-deleted rows; every CRUD soft-deletes instead of hard-deleting

This is the most error-prone phase because it touches every CRUD module and every aggregator query.

1. **CRUD pass** — every `services/*/crud.ts` (todos, threads, habits, nutrition, plus `database.ts`'s entry/project/vlog/dayMeta/aiSummary deletes):
   - Replace hard-delete `DELETE FROM ...` with `UPDATE ... SET deleted_at = ?, updated_at = ? WHERE id = ?`.
   - Stop writing to `sync_deletions` (the queue is going away in M4).
2. **Read-path audit** per spec §6.4 — add `WHERE deleted_at IS NULL` to every `SELECT` on a synced table. Confirmed surfaces from the spec:
   - `todos/rank.ts` (dashboard SmartTodoList)
   - `threads/getThreadCards.ts` (dashboard tracker)
   - `threads/getThreadDetail.ts` (`/threads/[id]`)
   - `nutrition/scanNutrition.ts` (autocomplete suggestions query)
   - `habits/streaks.ts` (heatmap state)
   - `ai/summarize.ts` (recent-entries context block)
   - **`ai/caption.ts` via `getRecentAISummaries`** — spec §3.7 + §12 explicitly call this out as load-bearing
3. **Audit script:** grep for `SELECT.*FROM (entries|projects|vlogs|day_meta|ai_summaries|nutrition|habits|todo_meta|threads|thread_mentions)` and confirm every match either filters `deleted_at IS NULL` or is itself a sync-layer query that needs to see deleted rows.

**Verify before moving on:**
- Delete a todo from the dashboard. It disappears immediately. The DB row still exists with `deleted_at` set.
- The deleted todo does not appear in: SmartTodoList, `/todos`, thread detail OPEN/DONE, dashboard heatmap, vlog summary context, caption-call recent-summaries context.
- Round-trip: delete → push → wipe local → pull → row still has `deleted_at` set, still hidden from UI.

**Checkpoint:** Critical pause. Hard to recover from a missed read-path. **Snapshot DB before this phase. After this phase, run the app for a day on real data and watch for any UI surface where deleted rows leak through.**

---

### M4 — Bootstrap, first-pull, debounced push, vacuum
**Spec steps:** 8, 12, 13, 17, 18, 19 · **Est:** 9–11h · **Ships:** sync runs automatically on boot + on edit; Notion sync still parallel

1. `sync/bootstrap.ts` — detection per spec §5.3:
   - `cloudHasData` × `localHasData` × `bootstrapDone` truth table.
   - **`localHasData && cloudHasData && !bootstrapDone`** is the developer's actual case (months of local, fresh cloud). Prompt is overkill in Phase A; default to **initial push** with a SecureStore flag override.
2. `sync/firstPull.ts` — paginated full-restore. Dependency-ordered table walk. Batch size 200. Set `cloud_initial_push_done = true` on completion.
3. `sync/vacuum.ts` — hard-delete rows where `deleted_at < NOW() - 30 days`. Local AND cloud. Triggered on app open if last vacuum > 24h ago. Order: children before parents (`thread_mentions → todo_meta → nutrition → ... → entries`) to respect FK constraints.
4. `useEntries.editEntry` — after scanners settle, schedule a debounced push (5s window per spec §4.3). **Replace** the existing Notion sync call. (Other crud.ts files do the same.)
5. `app/_layout.tsx` — add the cloud-sync chain alongside (not replacing) the Notion chain. Both run on boot. `cloudSync.bootstrap → cloudSync.pullAll → cloudSync.pushAll`. Wrap in `CloudSyncProvider`.
6. **Drain `sync_deletions`** — one-time bootstrap step gated by `sync_deletions_drained_v1_done`: for each pending row, soft-delete the corresponding cloud row, then drop the local table. Runs after first successful push.

**Fast-path note (spec's aggressive cut):**
- Skip `firstPull.ts` (~5h saved). Initial-push only. Risk: device-loss recovery requires manual SQL from Postgres. Reasonable trade-off for solo Phase A; ship first-pull in v1.x once you've confirmed the cloud state is healthy.
- Skip `vacuum.ts` (~1h saved). Soft-deleted rows accumulate; Postgres free tier is 500MB. Add later.

**Verify before moving on:**
- Cold-start the app. Both Notion and cloud sync run. Both succeed.
- Make an edit. After ~5s, observe the cloud row update via Supabase console.
- Make 50 rapid edits in 5s. Observe **one** push fire (debounce works).
- Disable network, edit, re-enable. Observe queued push fires on next trigger.

**Checkpoint:** Run for several days on real data. **Notion + Supabase both auto-syncing; Notion is still the canonical cloud system you trust.** Switch the trust boundary only after M6 testing passes.

---

### M5 — Settings page + dev menu
**Spec steps:** 20, 21 · **Est:** 5h · **Ships:** visibility into sync state

1. `app/settings/cloud-sync.tsx` — minimal Phase A page per spec §7. Status / last-sync / pending count / Sync Now.
2. Long-press app version → dev menu modal:
   - Force push all
   - Force pull all (incremental)
   - Reset local from cloud (double-confirm; destructive)
   - Show sync status (per-table breakdown from `sync_meta`)
   - Reset cloud database (drops cloud rows for current user_id)
3. Add "Cloud Sync" entry to `app/settings/index.tsx`. Leave "Notion Sync" entry alongside for now.

**Verify:** Each dev-menu action does what it says. Force pull doesn't lose local data. Reset local from cloud rebuilds correctly via firstPull (or aborts cleanly if firstPull was skipped per fast-path).

---

### M6 — Test pass against spec §8.1
**Spec step:** 22 · **Est:** 5–7h · **Ships:** evidence the migration is safe

Walk all 13 test scenarios in spec §8.1 explicitly. Critical ones:

| # | Test | Notes |
|---|---|---|
| 1 | Bootstrap correctness — initial push uploads every existing row across all 10 tables | Compare row counts in Supabase console vs `sqlite3 SELECT COUNT(*)` |
| 2 | Round-trip on every CRUD path | Entry edit, todo toggle, nutrition line, `#tag`, manual touch |
| 3 | First pull on fresh device | If firstPull skipped per fast-path, simulate via dev menu "Reset local from cloud" |
| 4 | **Caption tonal continuity across devices** | New in spec rev 3. Generate on A → pull to B → generate on B → verify caption draws from A's history |
| 5 | Soft delete invisibility | Critical — re-runs M3 verification on real data |
| 6 | Conflict resolution last-write-wins | Two-device test; if no second device, simulate via dev menu |
| 9 | `sync_deletions` drainage worked | Pre-stage one queued Notion deletion before M4 ships |
| 10 | JSONB round-trip | `entries.todos_json`, `ai_summaries.summary_json` (with caption fields) |
| 11 | Caption-shape evolution | Old AI summary row (no caption fields) shows only SUMMARY chip; new row shows all three |
| 13 | Rate-limit absence | 50 edits in 5s; no 429s |

**Additional check beyond spec:** Backup snapshot of local SQLite (`cp buffr.db buffr.db.M6.bak`) before any destructive testing. Until M7 ships, this is the rollback artifact.

**Checkpoint — biggest one in the plan:** Pause for a week of regular use. Both syncs still running. Watch for: missed cloud updates, stale UI showing deleted rows, Postgres growth pattern, any unexpected errors in `sync_meta.last_error`.

---

### M7 — Notion teardown
**Spec steps:** 23, 24 · **Est:** 3h · **Ships:** ~2,200 LOC deleted, single source of truth for cloud

Only after M6 has been live for at least a week without issues.

1. Delete `services/notion/` directory entirely (7 files, 2,181 LOC).
2. Delete `app/settings/notion-sync.tsx` and `app/settings/notion-guide.tsx`.
3. Remove `NotionSyncProvider` from `app/_layout.tsx`.
4. Remove the Notion call sites from `useEntries.editEntry`, `todos/crud.ts`, `threads/crud.ts`, `habits/...`, etc. (M4 already replaced their behavior; this is import cleanup.)
5. Remove "Notion Sync" entry from settings index.
6. Clear Notion-related SecureStore keys (token, DB IDs, last-sync timestamps).
7. Update `docs/spec.md` per spec §13:
   - § 1 last-bullet rewrite
   - § 4 boot-sequence rewrite
   - § 4 settings paths replacement
   - § 6.11 → one-line pointer to cloud-sync spec
   - § 7 service-layer table: drop `notion/*` rows, add `sync/*` rows
   - § 8 integrations: drop Notion, add Supabase
   - § 9 tech stack: add `@supabase/supabase-js`
   - § 10 principles: add Principle 12 ("Cloud is a sync mirror, never the canonical source")
8. `npx tsc --noEmit` — clean.
9. Commit as the satisfying single delete.

---

## Risks & open items not in the spec

1. **Read-path audit completeness.** The grep for `SELECT.*FROM (synced_table)` will catch direct queries; it won't catch queries built via dynamic SQL or wrapped in helpers. Plan a manual UI sweep after M3 — open every screen, check no deleted-row artifact shows.

2. **`projects` and `vlogs` carry device-local file URIs** (spec §12 open questions). The plan ships them as-is per the spec's option (a). Document the trap: a synced `vlogs.export_uri` is meaningless on a different device. Acceptable for solo use; revisit in Phase B.

3. **Vacuum FK ordering.** Hard-deleting a synced row needs FK-aware ordering on the local side (Postgres has CASCADE; SQLite is configured without it in this codebase). The `vacuum.ts` implementation must walk children before parents.

4. **`localHasData && cloudHasData` ABORT branch** (spec §5.3). The spec says "show a dialog." For Phase A, default to "log + continue with initial push" since there's only one user; add the dialog in Phase B. Don't over-engineer for a case that shouldn't happen.

5. **`getRecentAISummaries` MUST add `WHERE deleted_at IS NULL`** (spec §12 explicitly flags this). Add to M3 audit checklist; verify in M6 test 4.

6. **Schema-version coordination.** Local SQLite has its own schema version in `database.ts`. Cloud has Supabase migrations. They evolve independently in this design (per spec §11). After M0, every new local migration that affects synced tables needs a paired Supabase migration — document this rule in CLAUDE.md so future-you doesn't drift.

7. **Snapshot discipline.** Take a `cp buffr.db buffr.db.<milestone>.bak` before each destructive milestone (M3, M4 bootstrap, M7). The DB file isn't in git. The snapshot is the only revert path.

---

## Summary

7 milestones, each independently shippable. M0–M2 add the cloud as a shadow system. M3 is the risky read-path migration. M4 wires it into the live app alongside Notion. M5 + M6 build trust. M7 is the irreversible delete after a week of dual-running.

The spec's 24 steps map to milestones as: **M0 = 1–3, M1 = 4–6 + 9–11 + 14a, M2 = 7 + 11b + 14b, M3 = 15–16, M4 = 8 + 12–13 + 17–19, M5 = 20–21, M6 = 22, M7 = 23–24.**

Recommend starting M0 in a single sitting (it's mechanical) to lock in the schema, then taking M1–M2 over a few sessions to get end-to-end round-trip working. Don't start M3 unless you have a clear afternoon — the read-path audit is the kind of work that needs uninterrupted focus.
