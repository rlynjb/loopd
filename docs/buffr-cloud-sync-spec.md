# buffr — Feature Spec: Cloud Sync (Supabase)

Last updated: 2026-05-02 · revision 3

Replaces Notion as the cloud backend for buffr with **Supabase Postgres**. Local SQLite remains canonical. Cloud sync is opt-in per user — eventually a paid tier, initially personal infrastructure for the sole developer.

This spec **deprecates** the Notion sync surface area in [`spec.md`](./spec.md) — specifically:
- § 1 (last bullet of the core loop)
- § 4 boot-time sync chain (`syncAll → syncAllTodos → syncAllHabits → syncAllThreads`)
- § 6.11 (Notion Sync section)
- § 7 service-layer entries under `notion/*`
- § 8 Notion integration row

After this lands, those sections collapse: the boot chain becomes a single `cloudSync.bootstrap → cloudSync.pullAll → cloudSync.pushAll`, the `notion/` directory is deleted, and the Notion guide UI goes away.

This spec is **aligned to the current eleven-table schema** in [`spec.md` § 5](./spec.md#5-data-model) as of 2026-05-02 and the **two-call AI composition chain** in [`spec.md` § 6.9](./spec.md#69-ai-composition-vlog-summary).

---

## 1. Purpose & Origin

The user-stated frictions with Notion as cloud backend:
- **Conflict resolution is fragile.** The "Notion never edits source prose" rule (Principle 2) requires silently dropping Title-field edits in the Todos DB on every push.
- **Rate limits.** 350ms gap between calls + 429 retries; the module-singleton limiter at [`notion/api.ts`](../src/services/notion/api.ts) serializes ALL Notion calls across the four orchestrators.
- **Schema drift.** Adding a property means updating the Notion DB by hand, updating the mapper, and the existing `detectMissingTodoProperties` / `detectMissingHabitProperties` / `detectMissingThreadProperties` machinery exists *because* drift is a normal failure mode.
- **Property mapping overhead.** Every entity gets a mapper file (`mapper.ts`, `todosMapper.ts`, `habitsMapper.ts`, `threadsMapper.ts`). Every new field touches the local schema, the mapper, the notion-guide instructions.
- **Two-thousand-character rich-text cap on `expanded_md`.** Currently worked around with multi-block splitting in `todosMapper.ts`. Goes away.

Replacing Notion with a real Postgres database removes all five.

**The constraint that makes this design distinctive:**

This is **not** "let's make Postgres our primary database." Local SQLite stays canonical. The cloud is a sync mirror — a backup-and-replication layer for users who opt in. The architectural reason: buffr is *prose-canonical* (Architectural Principle 2). The journal entry's text in `entries.text` is the source of truth for everything derived from it (todos in `todos_json`, `todo_meta`, `nutrition`, `thread_mentions`). That source must live with the user, work offline, save on every keystroke. Cloud-as-canonical-store breaks all three properties.

So: **local is home. Cloud is the safety net you opt into.**

**Two phases:**
- **Phase A — personal infrastructure (this spec, v1).** Cloud sync exists, but only for the developer. No auth UX, no payment, no public surface. Hardcoded credentials. Battle-test the sync layer on real data before opening it.
- **Phase B — paid tier (deferred).** Auth UX, payment, multi-user RLS isolation, onboarding flow. A separate spec, written when this one is stable.

Phase B is sketched in § 14 for context but not specified.

---

## 2. Why Supabase

Direct comparison to alternatives, since this contradicts the user's stated stack rule ("no Supabase, no PlanetScale"):

| Option | Verdict |
|---|---|
| **Supabase (recommended)** | Postgres + Auth + Realtime in one. Free tier covers solo for years. Schema migrations transfer cleanly from SQLite. RLS available when Phase B needs it. |
| Turso (libSQL embedded replicas) | Brilliant local-first sync, but no built-in auth. Phase B would require Clerk or similar — two services. |
| PlanetScale | MySQL, no realtime, schema branching is overkill. |
| Neon | Postgres, no auth. Same Phase B problem as Turso. |
| Self-hosted Postgres on a VPS | Real infra to maintain. Outside the user's stated comfort zone. |

The user's "no Supabase" rule was made when the stack target was "Notion as DB, frontend-only Next.js." That rule's *reason* — avoid backend infrastructure — is the same reason Supabase wins now. Both "Notion as DB" and Supabase are managed-backend-no-infra; Supabase is just a real database under the hood.

The auth-included property matters once Phase B arrives. Until then, Supabase functions as "Postgres with an HTTP API," which is exactly what the sync layer needs.

---

## 3. Data Model

### 3.1 Postgres schema mirrors local SQLite

Every local SQLite table that holds user data gets a corresponding Postgres table. The mirror is **structural, not normalizing** — JSON columns in SQLite (e.g. `entries.habits_json`, `entries.clips_json`, `entries.todos_json`) map to Postgres `JSONB`, not to separate normalized tables. Splitting them in Postgres would force two writes per entry edit, double the conflict surface, and break the "schema is identical modulo type conversions" property.

Modulo:
- Add `user_id UUID NOT NULL` to every synced table (Phase A: dummy `'00000000-0000-0000-0000-000000000001'`)
- Add `synced_at TIMESTAMPTZ` (last successful upsert from local)
- Add `deleted_at TIMESTAMPTZ` (soft delete; § 4.5)
- Convert `INTEGER` boolean columns to `BOOLEAN`
- Convert `TEXT` ISO timestamps to `TIMESTAMPTZ`
- Convert `TEXT` JSON columns (`habits_json`, `clips_json`, `todos_json`, `cadence_days`, `removed_clip_source_keys_json`, `text_overlays_json`, `filter_overlays_json`, `summary_json`) to `JSONB`
- Convert SQLite CHECK constraints to Postgres CHECK constraints (syntax-identical for the cases used in [`spec.md` § 5](./spec.md#5-data-model))
- Convert SQLite foreign-key intents (which exist by convention not always by FK) to real Postgres `REFERENCES` clauses

The migration is mechanical. A single script in [`supabase/migrations/0001_initial_schema.sql`](../supabase/migrations/0001_initial_schema.sql) creates all tables.

### 3.2 Tables that get synced

Per the user-stated requirement: *"all tables sync — entries, todos, todo_meta, nutrition, habits, threads, thread_mentions — the whole app state."* The full list per [`spec.md § 5`](./spec.md#5-data-model) is eleven; the breakdown:

| Local table | Sync? | Notes |
|---|---|---|
| `entries` | Yes | Canonical for prose. `habits_json` / `clips_json` / `todos_json` ride along as JSONB. |
| `projects` | Yes | Editor draft state per day. Includes `clips_json`, `text_overlays_json`, `filter_overlays_json`, `removed_clip_source_keys_json` as JSONB. |
| `vlogs` | Yes | Archive of exported vlogs (caption, duration, export URI). Cross-device "did I export this day?" needs this. |
| `day_meta` | Yes | Per-day rename titles. Tiny; trivially syncable. |
| `ai_summaries` | Yes | Per user direction. KB-sized; keeps new-device first-impression fast. **Also load-bearing for the relatable-caption call** (§ 3.7). |
| `nutrition` | Yes | |
| `habits` | Yes | Includes cadence fields, `time_of_day`, `slug`. |
| `todo_meta` | Yes | Per user direction. Avoids re-classifying on a new device. Type, stage, expansion all carry. |
| `threads` | Yes | |
| `thread_mentions` | Yes | Synced. Could be regenerated from prose, but syncing is cheaper than re-scanning all entries on a new device. Includes the manual-touch deviation rows (NULL `entry_id` and `todo_id`) verbatim. |
| `sync_deletions` | **No** | Local-only. Phase A *deletes this table* — soft deletes (§ 4.5) replace its function. Existing pending rows get processed once during Phase A bootstrap (§ 5.3) and the table is dropped after. |

`expo-secure-store` keys (`drops_backfill_v1_done`, `nutrition_backfill_v1_done`, `todo_meta_backfill_v1_done`, `habits_cadence_backfill_v1_done`, `thread_mentions_backfill_v1_done`, AI keys, Notion token until removed, the upcoming `cloud_initial_push_done`) are local-only and never sync.

### 3.3 New columns on every synced table

```sql
-- Added to every synced table in the Postgres mirror
user_id UUID NOT NULL,                    -- Phase A: dummy '00000000-0000-0000-0000-000000000001'
                                          -- Phase B: real auth.users.id
deleted_at TIMESTAMPTZ,                   -- soft delete; row exists but excluded from queries
synced_at TIMESTAMPTZ                     -- last time we successfully upserted this row from local
                                          -- LOCAL ONLY; the cloud doesn't need to know this
```

`updated_at` already exists locally on every synced table per [`spec.md § 5`](./spec.md#5-data-model). The cloud mirrors it. The new local-only `synced_at` column tracks "have we pushed this row's current state to cloud yet?" Cloud doesn't need it.

`deleted_at` is added to **both** local and cloud. Local read paths gain a `WHERE deleted_at IS NULL` filter. The CRUD layer (§ 6.3) handles this transparently.

### 3.4 Indexes

Every synced table gets:
- `(user_id, updated_at DESC)` — for the pull query "give me everything updated since X"
- `(user_id, deleted_at)` partial index where `deleted_at IS NULL` — for normal reads

Existing local indexes per [`spec.md § 5`](./spec.md#5-data-model) (`entries(date)`, `entries(notion_page_id)`, `entries(updated_at)`, etc.) are duplicated on the Postgres side where they aid sync queries. The various `notion_page_id` indexes can be repurposed as `cloud_id` once the Notion code is gone, or just dropped — the new sync uses `id` (the local UUID) as the cross-system identifier.

### 3.5 New local table: `sync_meta`

Tracks per-table `last_pull_at`. Eleven tables × one timestamp each = eleven rows. SecureStore would work but a table makes "show me when each table last pulled" trivially queryable in dev tools.

```sql
CREATE TABLE sync_meta (
  table_name TEXT PRIMARY KEY,    -- 'entries', 'todo_meta', etc.
  last_pull_at TEXT,              -- ISO timestamp from the SERVER (see § 4.7)
  last_push_at TEXT,              -- last successful push for this table
  pending_pushes INTEGER NOT NULL DEFAULT 0,  -- count of dirty rows not yet pushed
  last_error TEXT,                -- last sync error message (cleared on success)
  last_error_at TEXT
);
```

This table is itself **not synced** — it's local sync state.

### 3.6 RLS policies (deferred to Phase B but worth scaffolding)

In Phase A, no RLS. The single user is the developer; data scoping isn't a safety concern. The RLS policies are written in a `0002_rls_policies.sql` migration but **left disabled** (`ALTER TABLE ... DISABLE ROW LEVEL SECURITY`) until Phase B.

When enabled, the policy on every table:
```sql
CREATE POLICY "users access own rows" ON {table}
  FOR ALL USING (auth.uid() = user_id);
```

Standard. No clever logic. Each user sees only their own rows; Postgres enforces it.

### 3.7 `ai_summaries` is now load-bearing for caption quality

[`spec.md` § 6.9](./spec.md#69-ai-composition-vlog-summary) introduced a **two-call AI composition chain**: first call produces the structured `AISummary`, second call ([`ai/caption.ts`](../src/services/ai/caption.ts)) produces a relatable-caption pass that emits `caption`, `alternate`, `detectedTheme`. Both merge into the same `summary_json` blob in the `ai_summaries` row.

The caption call reads **the last 5 cached captions** via `getRecentAISummaries` for tonal continuity. This means on a fresh device after first-pull, the caption quality of newly-generated summaries depends on having historical `ai_summaries` rows present locally.

Implications for sync:
- **`ai_summaries` must be in the sync set.** It already is (§ 3.2), but the reasoning shifts from "speed up first-impression on new devices" to "speed up first-impression AND preserve caption tonal continuity across devices." The latter is harder to undo later.
- **`summary_json` shape evolved without a schema migration.** New rows carry `caption`, `alternate`, `detectedTheme`. Older cached rows (pre-feature) don't, and the editor's TEXT-tab variant chips (PRIMARY / ALT / SUMMARY) only show PRIMARY / ALT when those fields are present. The JSONB column on the cloud side handles the shape evolution transparently — no migration needed.
- **No special handling for partial caption rows.** Per [`spec.md` § 6.9](./spec.md#69-ai-composition-vlog-summary): if the caption call fails, `summarize.ts` swallows the error and the structured summary still ships. Locally, the row is written without caption fields. Cloud sees the same shape. No conflict resolution required.

---

## 4. Sync Architecture

### 4.1 Local SQLite stays canonical

This is the load-bearing principle. Reads always hit local. Writes always hit local first, then queue for cloud sync. The app works fully offline; cloud is asynchronous.

This means **the sync layer is not in the read path.** The journal screen, todos page, dashboard tracker, the editor's variant-chip UI — none wait for cloud responses. They query local SQLite, get data, render. The sync layer runs in the background.

### 4.2 Three operations: push, pull, first-pull

**Push (local → cloud):**
1. Find rows where `updated_at > synced_at` (or `synced_at IS NULL`).
2. For each, `INSERT ... ON CONFLICT (user_id, id) DO UPDATE` to Postgres.
3. On success, set local `synced_at = NOW()`.
4. Soft deletes (rows where `deleted_at IS NOT NULL`) push the same way — Postgres updates `deleted_at`.

**Pull (cloud → local) — incremental:**
1. Read `last_pull_at` from `sync_meta` for this table.
2. Query Postgres: `SELECT NOW() AS server_time, * FROM <table> WHERE user_id = $1 AND updated_at > $2`.
3. For each returned row:
   - If local has no row with this id → insert.
   - If local has a row → compare `updated_at`. Newer wins (§ 4.6).
   - If row has `deleted_at IS NOT NULL` → mark local row as soft-deleted.
4. Update `sync_meta.last_pull_at = server_time` (server clock, § 4.7).

**First-pull (full restore):**
A distinct code path from incremental pull. Triggered when local has no rows for this user AND `cloud_initial_push_done` is unset. Mechanics:
1. Drop the `last_pull_at` filter (download everything).
2. Read tables in dependency order (foreign-key parents before children).
3. Paginate by `created_at ASC` to avoid memory blowup on large datasets.
4. Stream rows into local SQLite in batches of 200.
5. After all tables complete, set `cloud_initial_push_done = true` and stamp every `sync_meta.last_pull_at` to server NOW().

This is the path the previous rev's § 8.1 mentioned in tests but didn't specify. See § 5.3 for when it triggers.

### 4.3 When sync runs

| Trigger | Push? | Pull? |
|---|---|---|
| App opens (cold start) | Yes | Yes (incremental, or first-pull on fresh device) |
| App returns to foreground | Yes | Yes (incremental) |
| After every commit (entry edit, todo toggle, etc.) | Yes (debounced 5s) | No |
| Manual "sync now" button (Phase A: in dev menu) | Yes | Yes |
| Pull-to-refresh on Today/Todos page | No | Yes |

The 5-second push debounce prevents the app from hammering the network on rapid edits. If the user types continuously for a minute, push fires once at the end. Cleaner than the existing Notion auto-sync which runs only on app open.

### 4.4 Sync orchestrator order

The orchestrator runs each table in a defined order, replacing the existing four-orchestrator chain (`syncAll → syncAllTodos → syncAllHabits → syncAllThreads`) with one ordered pass per direction.

**Push order** (local → cloud, parents before children):
```
entries → projects → day_meta → vlogs → ai_summaries
       → todo_meta → nutrition → habits → threads → thread_mentions
```

**Pull order** (cloud → local, parents before children):
```
entries → projects → day_meta → vlogs → ai_summaries
       → habits → threads → todo_meta → nutrition → thread_mentions
```

`thread_mentions` is last in pull because it has FKs to both `entries` (via `entry_id`) and `threads` (via `thread_id`); both must exist locally before mentions can land. `todo_meta` is after `entries` because it FKs to a TodoItem id which lives inside `entries.todos_json`.

Each table runs to completion before the next. Failures log + continue (don't block other tables). Idempotency is via `ON CONFLICT DO UPDATE` on push and `updated_at` comparison on pull — running the same sync twice does nothing the second time.

### 4.5 Soft deletes

Per Architectural Principle 6 ("Don't auto-delete during sync"), the sync layer **never hard-deletes**. The flow:

1. User deletes a row locally → set `deleted_at = NOW()`, increment `updated_at`.
2. Local read paths filter `WHERE deleted_at IS NULL` — invisible to user immediately.
3. Push runs as normal. Postgres row gets new `deleted_at`.
4. Other devices pull, observe soft-delete.

A periodic vacuum (on app open if it's been > 24h since last vacuum) hard-deletes rows where `deleted_at < NOW() - 30 days`. Both locally and in Postgres. Gives a 30-day undo window if needed (not exposed in UI at v1; data is recoverable).

The existing `sync_deletions` table is **deleted** by this spec. It was a workaround for Notion's "no soft delete" semantics. Postgres does soft deletes natively. § 5.3 covers the migration path for any rows pending in `sync_deletions` at cutover.

### 4.6 Conflict resolution

**Last-write-wins, per row, by `updated_at`.** Same idiom as the existing Notion sync against `last_edited_time`. Battle-tested.

The honest cases this resolves cleanly:
- Two devices edit the same entry → device that touched it most recently wins.
- A device offline edits, comes online → if cloud has been edited in the meantime, the *later* `updated_at` wins.
- Soft delete + concurrent edit → later wins. If edit was after delete, delete is undone. If delete was after edit, row stays deleted.

The cases this **does not** resolve cleanly:
- Concurrent edits within the same second → second-precision ties go to last pull. Solo use doesn't hit this; Phase B may need millisecond timestamps or vector clocks.
- A row deleted on one device while edited on another within the same second → ambiguous. Solo doesn't hit this. Phase B should add tie-breaker logic.

Per-field merging (e.g. "merge two concurrent edits to the same entry's prose") is **not done.** That's CRDT territory and overkill for solo use. If two devices edit the same entry simultaneously, one edit wins, the other is lost. Acceptable trade-off.

### 4.7 Clock skew

Don't trust local clocks for `last_pull_at`. Always use the server's `NOW()`:

```sql
SELECT NOW() AS server_time, * FROM <table> WHERE user_id = $1 AND updated_at > $2;
```

Use the returned `server_time` as the next `last_pull_at`. Eliminates the "my phone's clock is 30 seconds fast and I miss a row" class of bugs.

`updated_at` on local writes uses local time. This is fine because it's only ever compared to other `updated_at` values from devices that all communicate through the same server (which sees their `updated_at` as data, not as truth about wall time).

---

## 5. Phase A: Personal Infrastructure

### 5.1 No auth UX

The app does not show login screens, signup screens, or "enable cloud" toggles. Phase A is entirely transparent to the developer.

Configuration:
- A `.env` file (gitignored) holds `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- A hardcoded `user_id` is used for every row: `'00000000-0000-0000-0000-000000000001'`.
- The `auth` package is added but not invoked at the UI layer. The sync service uses the anon key with hardcoded user_id; RLS is disabled.

Don't share dev builds publicly during Phase A. The safety story comes in Phase B with real auth.

### 5.2 Sync controls (dev menu)

A hidden dev menu (long-press app version in settings) exposes:
- **Force push all** — re-uploads every local row, ignoring `synced_at`. For "I deleted the cloud data and want to repush."
- **Force pull all (incremental)** — clears every `sync_meta.last_pull_at` and re-downloads everything.
- **Reset local from cloud** — drops every synced local table, recreates schema, runs first-pull. **Destructive**; double-confirm dialog. The corruption-recovery path.
- **Show sync status** — last push, last pull, count of pending pushes per table, recent errors.
- **Reset cloud database** — drops all Postgres rows for this user_id. For testing.

These don't ship in the public app. Personal-infrastructure debugging only.

### 5.3 Migration from current state (one-time bootstrap)

The developer has months of local data and a working Notion sync. The bootstrap covers both directions: existing local goes to cloud (initial push), and a future fresh install pulls cloud back (first-pull path).

**Detection logic** (runs on every cold start in `app/_layout.tsx`):

```
let cloudHasData    = SELECT EXISTS(SELECT 1 FROM entries WHERE user_id = $1 LIMIT 1)
let localHasData    = SELECT EXISTS(SELECT 1 FROM entries LIMIT 1)
let bootstrapDone   = SecureStore.get('cloud_initial_push_done')

if  bootstrapDone:                             → normal incremental sync
elif !localHasData && !cloudHasData:           → no-op; flip flag
elif  localHasData && !cloudHasData:           → INITIAL PUSH (existing dev path)
elif !localHasData &&  cloudHasData:           → FIRST PULL (fresh device)
elif  localHasData &&  cloudHasData:           → ABORT, prompt user
```

**Initial push** — your current path. Sets `synced_at = NULL` on every row, runs push in dependency order. On completion, sets the flag.

**First pull** — fresh-device path (§ 4.2). Drops `last_pull_at` filter, paginated full-table downloads in dependency order. On completion, sets the flag.

**Both populated (the rare case)** — shouldn't happen in Phase A but defensive. Show a dialog: "Both local and cloud have data. Pick one to keep, the other will be wiped." Defer to user choice. This case can occur if the developer rebuilds the app on a new device while their old device is still syncing.

**Migration of pending `sync_deletions` rows.** Before deleting the table:
1. For each pending row in `sync_deletions`, soft-delete the corresponding cloud row (`UPDATE ... SET deleted_at = NOW()` in Postgres).
2. Drop the `sync_deletions` table locally.
3. Drop the table's CHECK constraint reference and remove its types from code.

This runs once, gated by `sync_deletions_drained_v1_done`.

### 5.4 Migration from Notion sync (cleanup)

The existing `services/notion/` directory and surrounding UI are **deleted** as part of this spec. Specifically:

| Path | Action |
|---|---|
| `services/notion/sync.ts` | Delete |
| `services/notion/api.ts` (rate-limited client) | Delete |
| `services/notion/mapper.ts` (Entries DB) | Delete |
| `services/notion/todosMapper.ts` | Delete |
| `services/notion/habitsMapper.ts` | Delete |
| `services/notion/threadsMapper.ts` | Delete |
| `services/notion/config.ts` | Delete |
| `app/settings/notion-sync.tsx` | Delete |
| `app/settings/notion-guide.tsx` | Delete |
| `NotionSyncProvider` (referenced in `app/_layout.tsx` § 4) | Delete; replace with `CloudSyncProvider` |

`expo-secure-store` keys for the Notion token are removed during the migration (after confirming all data is in Postgres).

The notion guide content is preserved in git history (in case you want to reference it later). The settings page loses the "Notion Sync" entry; gains "Cloud Sync".

---

## 6. The Sync Service Layer

### 6.1 New module — [`src/services/sync/`](../src/services/sync/)

| File | Purpose |
|---|---|
| `sync/client.ts` | Supabase client singleton (env vars, hardcoded user_id in Phase A) |
| `sync/orchestrator.ts` | `pullAll()`, `pushAll()`, `firstPull()`; runs tables in defined order |
| `sync/push.ts` | Generic push: read local rows where `updated_at > synced_at`, upsert to cloud, mark synced |
| `sync/pull.ts` | Generic incremental pull: query cloud since `last_pull_at`, merge into local |
| `sync/firstPull.ts` | Full-restore pull (§ 4.2) — paginated, dependency-ordered, no `last_pull_at` filter |
| `sync/conflict.ts` | The `updated_at` comparison and merge decision |
| `sync/syncMeta.ts` | CRUD for the local `sync_meta` table |
| `sync/types.ts` | `SyncableTable` interface (§ 6.2) |
| `sync/bootstrap.ts` | Detection logic (§ 5.3): initial push vs first pull vs no-op vs abort |
| `sync/vacuum.ts` | 30-day soft-delete vacuum (runs on app open if 24h+ since last vacuum) |

### 6.2 The `SyncableTable` interface

To avoid one bespoke sync function per table, all synced tables conform to:

```typescript
interface SyncableTable<TLocal, TCloud> {
  tableName: string;                                    // 'entries', 'todo_meta', etc.
  pushOrder: number;                                    // dependency rank (§ 4.4)
  pullOrder: number;
  localToCloud(row: TLocal): TCloud;                    // type conversions (booleans, JSONB)
  cloudToLocal(row: TCloud): TLocal;
  localQueryDirty(): Promise<TLocal[]>;                 // updated_at > synced_at
  localUpsert(row: TLocal): Promise<void>;
  localMarkSynced(id: string, syncedAt: string): Promise<void>;
  localGetByIds(ids: string[]): Promise<TLocal[]>;
  localPaginate(cursor: string | null, limit: number): Promise<{rows: TLocal[]; nextCursor: string | null}>;
}
```

Each table gets a thin file implementing this. The orchestrator calls `push(syncableTable)` and `pull(syncableTable)` generically. Adding a new table = implement the interface, register with the orchestrator. No bespoke code.

The ten thin files (one per synced table from § 3.2):
```
sync/tables/entries.ts
sync/tables/projects.ts
sync/tables/dayMeta.ts
sync/tables/vlogs.ts
sync/tables/aiSummaries.ts
sync/tables/nutrition.ts
sync/tables/habits.ts
sync/tables/todoMeta.ts
sync/tables/threads.ts
sync/tables/threadMentions.ts
```

(`sync_deletions` is not synced; doesn't get a file.)

### 6.3 Update existing files

| File | Change |
|---|---|
| `useEntries.editEntry` | After all scanners finish, schedule a debounced push. Replace existing Notion sync queue call. |
| `app/_layout.tsx` | Replace boot-time `syncAll → syncAllTodos → syncAllHabits → syncAllThreads` chain with `bootstrap.detect()` then `cloudSync.pullAll() → cloudSync.pushAll()`. Replace `NotionSyncProvider` with `CloudSyncProvider`. |
| `services/database.ts` | Add `synced_at` column to every synced table (migration). Add `sync_meta` table. Schedule `sync_deletions` table for deletion after § 5.3 bootstrap completes. Add `deleted_at` column to every synced table. Update read queries to filter `WHERE deleted_at IS NULL`. |
| All `crud.ts` files (`todos/crud.ts`, `nutrition/scanNutrition.ts`, `habits/...`, `threads/crud.ts`, etc.) | Replace hard-deletes with soft-delete pattern (`UPDATE ... SET deleted_at = NOW()`). Stop writing to `sync_deletions`. |
| `app/settings/index.tsx` | Replace "Notion Sync" entry with "Cloud Sync". |
| `services/threads/touch.ts` | The manual-touch deviation row (NULL `entry_id` and `todo_id`) syncs verbatim. The discriminated `CreateResult` shape is unaffected. |
| `services/ai/caption.ts` and `services/ai/summarize.ts` | No changes required by the sync layer. Both write to `ai_summaries` via the existing CRUD path; the soft-delete migration of that path picks them up automatically. |

### 6.4 Read-path changes (the `WHERE deleted_at IS NULL` discipline)

Every read query on a synced table needs to filter out soft-deleted rows. The existing CRUD layer is the natural enforcement point — wrap every `SELECT` in CRUD modules to add the filter automatically.

A small audit risk: dashboard ranking ([`todos/rank.ts`](../src/services/todos/rank.ts)), the threads-card aggregator ([`threads/getThreadCards.ts`](../src/services/threads/getThreadCards.ts)), the per-thread detail ([`threads/getThreadDetail.ts`](../src/services/threads/getThreadDetail.ts)), and similar aggregators may write raw queries that bypass CRUD. Each needs a code review pass to add the filter. List of files to verify (likely incomplete):

```
todos/rank.ts
threads/getThreadCards.ts
threads/getThreadDetail.ts
nutrition/scanNutrition.ts (the existing query for last-N-days suggestions)
habits/streaks.ts (heatmap state computation)
ai/summarize.ts (the recent-entries context block for the structured-summary call)
ai/caption.ts (getRecentAISummaries — last 5 cached captions for tonal continuity)
```

The verification step is in § 8.1 testing — "no soft-deleted row appears in any UI surface, AND no soft-deleted `ai_summaries` row leaks into the caption-call context."

---

## 7. Settings & Status UI (Phase A minimal)

[`app/settings/cloud-sync.tsx`](../app/settings/cloud-sync.tsx) — replaces `notion-sync.tsx`. Minimal Phase A version:

```
─────────────────────────────────────
cloud sync
─────────────────────────────────────
status: connected
last sync: 2 minutes ago
pending: 0 changes

───────
[ sync now ]
───────

dev menu (long press buffr version below)
─────────────────────────────────────
buffr 0.4.x (build N)
```

That's it. No connection wizard, no DB ID inputs, no per-DB sync buttons (no per-DB Notion concept anymore), no setup guide. The whole flow is: "is it connected? when did it last sync? how do I force one?"

---

## 8. Testing & Validation

### 8.1 What to test before deleting Notion

This is a one-way migration. Once `services/notion/` is deleted, going back means writing it again. Before pulling that trigger, validate:

1. **Bootstrap correctness — initial push.** Initial push uploads every existing row in all ten synced tables. Verify counts match in Postgres console for: entries, projects, vlogs, day_meta, ai_summaries, nutrition, habits, todo_meta, threads, thread_mentions.
2. **Round-trip.** Edit an entry locally, observe `updated_at` change, observe push (debounced), query Postgres, observe new value. Repeat for: toggling a todo, adding a `**` nutrition line, tagging `#thread`, manual-touching a thread on the dashboard.
3. **First pull from a fresh device.** Wipe local DB, open the app, observe full data restoration via the first-pull path. **Verify the manual-touch deviation rows survive** (the NULL-entry-NULL-todo `thread_mentions` rows the dashboard depends on).
4. **Caption tonal continuity across devices.** Generate a vlog summary on device A; pull to device B; on device B, generate a new summary for a different day. Verify the caption call gets the last 5 captions from device A (via `getRecentAISummaries`) and produces tonally consistent output. **This is the new test case for revision 3.**
5. **Soft delete.** Delete a todo, verify it disappears locally, verify Postgres has `deleted_at` set, verify a fresh device pulls and respects the soft delete. Verify dashboard ranking + thread cards + heatmap do not show the deleted row.
6. **Conflict resolution.** Edit the same entry on two devices (use a simulator + your phone), verify the later edit wins on both. Try the same with a todo done-toggle.
7. **Offline → online.** Disable network, edit a few entries, re-enable, verify all queued changes push.
8. **Clock skew tolerance.** Manually set device clock 5 minutes ahead, edit a row, sync, verify nothing breaks.
9. **`sync_deletions` drainage.** Before migration, leave a queued Notion deletion in `sync_deletions`. After migration, verify it became a soft-delete in Postgres and the table got dropped.
10. **JSONB round-trip.** Edit `entries.habits_json`, sync, fresh-device pull, verify the JSON deserializes identically. Same for `entries.todos_json` (the round-trip from dashboard toggle is critical here — Architectural Principle 2). Same for `ai_summaries.summary_json` including the new caption fields.
11. **Caption-shape evolution.** Verify that an `ai_summaries` row written before the caption feature (no `caption` / `alternate` / `detectedTheme`) round-trips through sync intact, and that the editor's TEXT-tab variant chips correctly show only `SUMMARY` for those rows. Verify a row written *with* caption fields shows `PRIMARY` / `ALT` / `SUMMARY`.
12. **Vacuum.** Manually set a row's `deleted_at` to 31 days ago, force the vacuum, verify it hard-deletes locally and remotely.
13. **Rate-limit absence.** Push a burst of 50 edits in 5 seconds, verify no 429s, no rate-limit errors. (Supabase default rate is 100 req/sec; we're well under.)

### 8.2 Pre-deletion checkpoint

Before deleting `services/notion/`, take a snapshot of the local SQLite (`cp` the file). If the new sync layer has bugs that corrupt local data, restore. Don't trust git for this — the data file isn't in git.

---

## 9. Architectural Principles — adherence checklist

For the reviewer, against [`spec.md § 10`](./spec.md#10-architectural-principles):

| Principle | How cloud sync honors it |
|---|---|
| 1. DB is single source of truth | Local SQLite is the read source. Cloud is a sync mirror, never read directly by UI. |
| 2. Prose is canonical | Local `entries.text` remains canonical. Cloud receives copies. The "Notion never edits source prose" rule is *gone* — no separate edit surface for prose, so the rule is unnecessary. The Title-edit-drop logic in `todosMapper.ts` deletes with the file. |
| 3. Save on keystroke; scanners on commit | Unchanged. Sync runs after scanners, on a 5s debounce. |
| 4. Read DB before deleting | Soft deletes mean local DB always has canonical view. CRUD reads before mutating. Vacuum re-reads before hard-deleting. |
| 5. Live refs in focus cleanup | N/A. |
| 6. Don't auto-delete during sync | Soft deletes only. Vacuum is explicit, gated by 30-day age. |
| 7. Two-pass matching | Unchanged — a scanner concern, not sync. |
| 8. Backfills SecureStore-gated | `cloud_initial_push_done` flag; `sync_deletions_drained_v1_done` flag. |
| 9. Classifier output editable, override permanent | `user_overridden_type` syncs as a regular column. Travels with the row. |
| 10. Heuristic before LLM | Unchanged. |
| 11. Mentions are derived; metadata is stored | Unchanged. Mentions sync as derived rows; not regenerated on the new device. The manual-touch deviation (NULL-entry NULL-todo) syncs verbatim. |

A new principle this feature suggests:

> **12. Cloud is a sync mirror, never the canonical source.** Read paths always hit local. Write paths always commit local first. The cloud lags by design — the user's typed character is in their local DB before any network call begins.

---

## 10. Implementation Order

| Step | What | Est. |
|------|------|------|
| 1 | Create Supabase project; install supabase-js; configure `.env` | 1h |
| 2 | Postgres schema migration: 10 synced tables mirrored, with user_id / deleted_at / synced_at; CHECK constraints; FKs | 3–4h |
| 3 | Local schema migration: add `synced_at` + `deleted_at` columns; create `sync_meta` table; mark `sync_deletions` for drain-and-drop | 2h |
| 4 | `sync/client.ts` — Supabase client with hardcoded user_id | 1h |
| 5 | `sync/types.ts` and `SyncableTable` interface | 1h |
| 6 | `sync/push.ts` — generic push function | 2–3h |
| 7 | `sync/pull.ts` — generic incremental pull with `last_pull_at` tracking | 2–3h |
| 8 | `sync/firstPull.ts` — paginated full-restore pull | 2–3h |
| 9 | `sync/conflict.ts` — last-write-wins with server clock | 1h |
| 10 | `sync/syncMeta.ts` — CRUD for the `sync_meta` table | 1h |
| 11 | `sync/orchestrator.ts` — table-ordered push/pull entry points | 2h |
| 12 | `sync/bootstrap.ts` — detection logic for initial-push vs first-pull vs abort | 2h |
| 13 | `sync/vacuum.ts` — 30-day soft-delete vacuum | 1h |
| 14 | Ten thin `sync/tables/*.ts` files (one per synced table) | 5–7h |
| 15 | Read-path audit: add `WHERE deleted_at IS NULL` everywhere (§ 6.4) — including the new `ai/caption.ts` `getRecentAISummaries` query | 3–4h |
| 16 | Switch CRUD writes to soft-delete pattern across all `services/*/crud.ts` | 3–4h |
| 17 | Update `useEntries.editEntry` to schedule debounced push | 1h |
| 18 | Update `app/_layout.tsx` boot sequence (replace four-orchestrator chain) | 2h |
| 19 | One-time `sync_deletions` drainage on bootstrap | 1h |
| 20 | Cloud-sync settings page (minimal Phase A) | 2h |
| 21 | Dev menu: force push, force pull (incremental), reset local from cloud, sync status, reset cloud | 3h |
| 22 | Test pass: all thirteen scenarios in § 8.1 | 5–7h |
| 23 | Delete `services/notion/`, four mapper files, `app/settings/notion-sync.tsx`, `app/settings/notion-guide.tsx`, `NotionSyncProvider`; remove env vars; update settings index | 2h |
| 24 | Update `spec.md`: deprecate § 6.11; trim § 4 boot sequence; remove `notion/*` rows from § 7; update § 8 integrations | 1h |

**Total: ~46–62h.**

The deletion step (23) is the most satisfying. Removes ~2000 lines of mapper / property-coordination / rate-limiter code.

A faster path exists if you want to ship Phase A in one focused week:

- Skip step 8 (firstPull) and the first-pull branch in step 12 (bootstrap detection); ship only the initial-push path. First-pull lands in v1.x once you've actually used the cloud for a few weeks. Saves ~5h. The risk: if your device dies before first-pull is built, you're recovering manually from Postgres.
- Skip step 13 (vacuum). Soft-deleted rows accumulate forever until you build it. Saves ~1h. Postgres free-tier storage is 500MB; you won't hit it.
- Skip step 21 (full dev menu). Just expose "force push" and "show sync status." Saves ~1h.

Aggressive cut: ~39h. Same architecture, fewer moving parts at v1.

---

## 11. What This Spec Does NOT Cover

- **Auth, signup, login flows** — Phase B.
- **Payment integration** — Phase B (separate spec; could be RevenueCat, Stripe, or platform IAP).
- **RLS enforcement** — policies scaffolded but disabled in Phase A.
- **Multi-device for the developer** — works incidentally because of the hardcoded user_id, but isn't a UX concern.
- **Conflict UI** — silent last-write-wins. No "two versions detected, pick one" dialog.
- **CRDT-grade per-field merging** — out of scope. Solo doesn't need it.
- **Realtime subscriptions** — Postgres-side trigger + Supabase Realtime is available but unused at v1. Pull-on-foreground is sufficient.
- **Encryption-at-rest beyond what Postgres provides** — Supabase encrypts at rest. Phase B may add client-side E2E encryption for paid users.
- **Selective restore UI** — the 30-day soft-delete window means the data is *recoverable* but no UI exposes it. v1.x candidate.
- **Notion data migration tooling for other users** — only the developer's own data. Phase A has no public users.
- **Schema-drift tolerance** — Postgres migrations are committed source-controlled SQL files. Drift between local and cloud is a code review concern, not a runtime tolerance one. (The Notion code's `detectMissingTodoProperties` machinery is unnecessary here.)
- **Sync for SecureStore-managed flags** (backfill flags, AI keys, Notion token-during-deprecation) — these stay device-local.
- **Re-running the AI caption pass for synced summaries.** When cloud sync pulls down an old `ai_summaries` row that lacks caption fields, the editor falls back to `SUMMARY` automatically (per [`spec.md` § 4](./spec.md#4-screens) editor TEXT tab). No automatic backfill — if the user wants a relatable caption for an old day, they tap REGENERATE WITH AI in the editor. v1.x candidate: a "backfill captions" button in dev menu that re-runs `caption.ts` against existing summaries.

---

## 12. Open Questions

- **The 5-second push debounce window** (§ 4.3) — could be longer (30s) if you want fewer cloud writes, or instant if latency matters. Default 5s feels right; revisit after dogfooding.
- **What happens if Supabase is down?** Push silently fails, retries on next trigger. Pull silently fails, app reads from local cache (canonical). User experience: no degradation. The right behavior, but worth confirming the silence.
- **Postgres CHECK enforcement strictness.** Local SQLite CHECKs are documented in [`spec.md § 5`](./spec.md#5-data-model) but are advisory in some places (e.g. the `thread_mentions` invariant about at least one of `entry_id` / `todo_id` is enforced at the app level, not the DB, because of the manual-touch deviation). Postgres should match: app-level invariant for the deviation case, no CHECK on the DB. Confirm.
- **`vlogs.export_uri` is a local file path** (`exports/[date]/...mp4` or `DCIM/buffr/...`). It's user-specific to the device. Sync should preserve the column for cross-device "did I export this?" queries, but the URI itself is meaningless on a different device. Two options: (a) sync the column, accept that it's only valid on the originating device, document the trap; (b) split `vlogs` into "metadata that syncs" + "local file references." Default: (a). It's fine for the metadata to be portable while the file isn't.
- **`projects.clips_json` may reference local file URIs too.** Same trade-off. Default: sync the JSONB; treat `clip_uri` as device-local. A future "cross-device clip mirroring" feature is out of scope.
- **`ai_summaries.summary_json` size after the caption pass.** Each row now carries a structured summary AND `caption` / `alternate` / `detectedTheme`. Still a few KB at most, but worth measuring on a real-data export to confirm bandwidth on first-pull stays reasonable.
- **Does `getRecentAISummaries` need a `WHERE deleted_at IS NULL` filter?** Almost certainly yes — § 6.4's audit list now includes `ai/caption.ts`. The risk if missed: a soft-deleted summary feeds the caption call's tonal-continuity context, producing weird outputs. Worth verifying explicitly in test 4.

---

## 13. Spec Cleanup — what gets deleted from `spec.md`

For the user reviewing this spec alongside [`spec.md`](./spec.md):

| Section | Action |
|---|---|
| § 1 (last bullet of the core loop): "Optional: Notion syncs entries + todos always; habits cadence and threads bidirectionally..." | Replace with "Optional: Cloud sync (paid in v2; personal infrastructure today) backs up every table to Supabase Postgres. Local SQLite stays canonical." |
| § 4 `app/_layout.tsx` — root: the auto-sync chain bullet | Replace `syncAll → syncAllTodos → syncAllHabits → syncAllThreads` with `cloudSync.bootstrap → cloudSync.pullAll → cloudSync.pushAll`. |
| § 4 `app/settings/`: notion-sync.tsx + notion-guide.tsx entries | Replace with `cloud-sync.tsx`. |
| § 6.11 (Notion Sync) | Delete entirely; replace with a one-line pointer to this spec. |
| § 6.9 (AI composition) | **No changes.** The two-call chain is unchanged by cloud sync. This spec just acknowledges it for caption-continuity reasons (§ 3.7, § 8.1 test 4). |
| § 7 (service-layer table): all `notion/*` rows | Delete. Add the new `sync/*` rows. |
| § 8 (External Integrations): Notion row | Delete. Add a Supabase row (`@supabase/supabase-js` for sync). |
| § 9 (Tech Stack): supabase-js gets a new row. | Add `@supabase/supabase-js` row. |
| § 10 (Architectural Principles): Principles 1–11 unchanged. Add Principle 12. | One-line addition. |

The combined spec.md cleanup: ~80 lines deleted, ~10 lines added. The Notion section is the biggest single delete — and it's the most read-friendly change of all the specs in this whole conversation.

---

## 14. Phase B Sketch (deferred, for context only)

When the app opens to other users:

- **Auth:** Supabase Auth with email magic link or OAuth (Apple/Google). Standard, ~1 week.
- **RLS:** flip `ENABLE ROW LEVEL SECURITY` on every table; policies already written.
- **Onboarding:** "Cloud Sync (paid)" entry in Settings. User taps → signup → payment (RevenueCat or Stripe) → "uploading your data..." → done. The `cloud_initial_push_done` flag generalizes to "this user's initial push done."
- **Free tier:** the free-user UX is "Cloud Sync is a paid feature, your data lives only on this device. Tap to learn more / subscribe." In code, the sync orchestrator simply doesn't run if no auth session exists. The whole free-user experience requires zero new code beyond a guard at the top of `cloudSync.pushAll()` and `cloudSync.pullAll()`.
- **Pricing:** TBD. Likely $3–5/month. Supabase free tier covers ~100 paid users; revenue covers infra easily.
- **Privacy posture:** "Your data is encrypted in transit and at rest. Free users' data lives on-device only — we physically cannot access it." (Future: client-side E2E encryption for zero-knowledge cloud.)

The architecture in this spec — local-canonical, soft delete, opt-in sync — supports Phase B with no rewrites. Phase B is ~80% UX work (auth screens, payment, onboarding), 20% data-layer work (enable RLS, real `user_id` from `auth.uid()`).
