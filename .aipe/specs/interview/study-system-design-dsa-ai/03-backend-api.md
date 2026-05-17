# Chapter 3 — Backend and API Design

## Opening — what you're looking at

There is no Express server. No REST controllers. No GraphQL. The backend of buffr is an on-device SQLite database (`buffr.db`) accessed through `src/services/database.ts`, and a Supabase Postgres mirror reached through ten thin sync adapters in `src/services/sync/tables/`. The "API" is whatever shape `database.ts` exposes to the rest of the app: `getEntriesByDate(date)`, `updateEntry(id, patch)`, `getThreadsActive()`, `upsertAISummary(date, json, model)`. Calls are typed, in-process, and synchronous-looking (they return a Promise but the work is local SQLite I/O measured in milliseconds).

This is not unusual for a single-user mobile app — but it is unusual *for an interview answer* because the candidate has to defend why there is no server when "everyone has a server." The defense is the constraint: this is a personal-archive app on Android, the user owns their data, the data lives on the device, and the cloud's job is to mirror. A server-side API would only make sense if multiple clients had to be authoritative-on-write or if a feature required compute that can't live on-device. Neither is true today; the LLM calls go directly from the device to Anthropic/OpenAI using `expo-secure-store` for the API key.

The shape of the work is therefore: the frontend reads from `database.ts`, writes through `database.ts`, and `database.ts` calls `schedulePush()` on every write to a synced table. `schedulePush` debounces by 5 seconds and then calls `pushAll()` from `src/services/sync/orchestrator.ts`, which walks a registry of `SyncableTable` adapters in a defined order and runs batched upserts against Supabase. On boot, `pullAll()` runs in the opposite-but-related order, pulling rows where `updated_at` is greater than each table's `last_pull_at`. There is one piece of server-side code: a Postgres RPC `get_server_time()` that returns the database clock as a single `timestamptz` so the client doesn't have to trust its own clock.

### ASCII diagram — write path from a CRUD call

```
   updateEntry(id, { text: "…" })   ◀── caller in app/journal/[date].tsx
            │
            ▼
   src/services/database.ts
   ┌──────────────────────────┐
   │ UPDATE entries SET       │
   │   text=?, updated_at=?   │   ◀── stamps updated_at + synced_at=NULL
   │   WHERE id=? AND         │
   │   deleted_at IS NULL     │
   └────────────┬─────────────┘
                │
                ▼
   schedulePush()                  ◀── 5s debounce
            │
            ▼   (after 5s of quiet)
   pullAll() not here — only push.
   pushAll() walks pushOrder:
     entries → projects → vlogs → day_meta
     → ai_summaries → nutrition → habits
     → todo_meta → threads → thread_mentions
            │
            ▼
   For each SyncableTable<TLocal, TCloud>:
       getDirtyRows()  WHERE synced_at IS NULL
       upsertBatch(50) ON CONFLICT (user_id, id) DO UPDATE
       markSynced(ids) → stamps synced_at=now()
            │
            ▼
   If error: writes sync_meta.last_error
   Next push retries the same dirty rows.
```

The pull path is similar but inverted: incremental, paginated by `updated_at ASC`, with `last_pull_at` set from the `get_server_time()` RPC after each successful page so a clock-skewed client doesn't lose a row. The pull order differs from the push order because pulls have to respect FK ordering (threads before thread_mentions, entries before todo_meta) while pushes don't (the receiver does the FK check).

---

## Concepts (four-part structure)

### 1. Serverless writes via debounced batch upsert

**Shape.** Three components participate in every write to a synced table: `database.ts` (the local CRUD function), `schedulePush()` (the 5s debounce), and the per-table `SyncableTable` adapter under `src/services/sync/tables/`. The adapter knows three things — how to read dirty rows from local, how to map `TLocal → TCloud`, and the `ON CONFLICT` upsert SQL.

**Rule.** Every CRUD function in `database.ts` for a synced table calls `schedulePush()` after the local write completes. The push runs after 5 seconds of quiet. Per-table batched upserts use 50 rows per batch with `ON CONFLICT (user_id, id) DO UPDATE`. Successful upsert stamps `synced_at` on the local row.

**Failure mode.** Without the debounce, a fast typist generates a Supabase write per keystroke; the per-second rate limit becomes the typing limit. Without batching, the per-row HTTP overhead (TLS, JSON envelope, single-row insert) dominates; a 500-row backfill push would take minutes. Without the `synced_at` stamp, a network blip mid-batch leaves no record of which rows shipped — the next push duplicates work.

**Contrast.** The journal text autosave does not debounce: every keystroke commits to local SQLite immediately. The constraint that distinguishes them is durability target. Local SQLite is the durability point; the cloud is the backup mirror. Debouncing the *local* write would risk losing a typed character; debouncing the *cloud* write at most delays a backup by 5 seconds.

### 2. Per-row last-write-wins conflict resolution

**Shape.** Three pieces decide which side wins a conflict: each row carries an `updated_at` timestamp, the pure function `chooseWinner(local, cloud)` in `src/services/sync/conflict.ts`, and the upsert SQL on the cloud side which trusts the incoming `updated_at` from the device.

**Rule.** When both local and cloud have changed the same row, the higher `updated_at` wins. Tie goes to local (arbitrarily — the device is already holding the row). The function returns `'local' | 'cloud' | 'tie'` and the orchestrator applies the winner.

**Failure mode.** Without LWW, the second device to sync would either overwrite the first device's edit silently or surface a merge UI for every edit. At single-user × multi-device scale, almost no real conflicts exist (the user is rarely editing the same row from two devices in the same minute), so a heavyweight merge UI is wasted work. LWW gets the right answer >99% of the time and is implementable in 30 lines.

**Contrast.** Free-form `entries.text` is the row most exposed to LWW's weakness: if a user writes a paragraph on phone A while phone B (last synced 10 minutes ago) is still showing the older version, the user editing on phone B's stale state will overwrite phone A's paragraph on the next sync. The mitigation is the 5-second debounce — the window where stale state leads to lost work is small. The full fix is per-line CRDT or operational transform on the text column, which I'd add only when telemetry shows real conflict frequency.

### 3. SyncableTable interface — table-as-plugin

**Shape.** Three things define a sync adapter: the `SyncableTable<TLocal, TCloud>` interface in `src/services/sync/types.ts`, the per-table file under `src/services/sync/tables/` (one file per synced table), and the `pushOrder` / `pullOrder` arrays in `src/services/sync/orchestrator.ts` that name them.

**Rule.** Adding a new synced table is a matter of writing one file that implements `SyncableTable`, then adding the table name to both order arrays. The interface forces the implementer to specify: dirty-row query, local→cloud mapper, cloud→local mapper, upsert SQL, and the table name. The orchestrator never knows table-specific details.

**Failure mode.** Without this abstraction, the orchestrator would carry a giant `switch (tableName)` with per-table mapping logic, and adding a synced table would require editing six different places in the orchestrator. The interface keeps each table's sync code in one file; the orchestrator stays generic.

**Contrast.** The Notion sync layer (deleted in commit `dc8483a`) had a similar shape but used a per-table class hierarchy with inheritance. The decision to flatten to a function-based `SyncableTable` interface was deliberate: classes added boilerplate (constructors, this-binding) without extra capability. The constraint that distinguishes them is the test surface — pure functions are easier to test than methods bound to instance state.

---

## Interview questions

### [mid] Walk me through what happens when I delete a habit on the `/more/habits` screen.

**Model answer.**

The trash icon row calls `deleteHabit(id)` in `src/services/database.ts`. That function does not run a `DELETE` — it runs an `UPDATE habits SET deleted_at = ?, updated_at = ?, synced_at = NULL WHERE id = ?`. Soft delete. Read paths everywhere already filter `WHERE deleted_at IS NULL`, so the row stops showing up on the habits list immediately.

`schedulePush()` fires from inside `deleteHabit`, debounced 5 seconds. After the debounce, `pushAll()` walks the registry, hits the `habits` adapter, sees a dirty row (synced_at is NULL), and runs the batched upsert against Supabase. The cloud row's `deleted_at` and `updated_at` are updated to match. Other devices see the deletion on their next pull because they filter the same way locally.

Past `entries.habits_json` references on completed days dangle harmlessly — they hold the deleted `habit.id` as a string, but no read path ever joins back to `habits` to render the chip; the chip label is stored alongside the ID at log time. That's a deliberate denormalization: it keeps historical days truthful even when the habit definition is gone.

### [senior] Why soft delete instead of hard delete?

**Model answer.**

Three reasons. The first is sync: a hard delete leaves no trace on the local device, so the cloud has nothing to replicate. With soft delete, the deletion is just another row update with a stamped `updated_at` — the existing push pipeline handles it without special casing. The alternative was the old `sync_deletions` table from the Notion era (visible in commit `dc8483a` as the layer that got removed), which queued deletion intents separately. Soft delete is simpler.

The second is recoverability. A user accidentally trashing a thread can be reversed by clearing `deleted_at`. Today there's no undo UI, but the data is there; the dev menu's "reset cloud" action could plausibly include a recovery path. With hard delete, the data is just gone.

The third is cross-device deletion ordering. If device A deletes a row, device B has been offline for an hour and edits the same row, then both devices come back online — under hard delete, B's edit re-creates the row on the cloud and A's deletion is silently undone. Under soft delete, the LWW comparison happens on `updated_at`: if A's deletion stamp is later than B's edit, A wins and the row stays deleted. The right thing happens because deletion is just a special edit.

The cost: soft-deleted rows accumulate. There is no vacuum yet; spec §6.11 calls it out as a v1.x candidate. In practice the volume is tiny because deletions are rare in this app; for a write-heavy multi-tenant system I'd add a daily job that hard-deletes rows where `deleted_at < now() - 30d`.

### [arch] You're hit with a request to support web (a read-only journal viewer, no editing). How does the architecture change?

**Model answer.**

The architecture barely changes for the read-only case. The cloud already has every row (modulo the 5-second sync lag); a Next.js page that signs in with the user's Supabase auth and renders the same SQL queries against Postgres would work. The data shapes match because the sync adapters round-trip the same fields; the cloud row schema is the local schema with `user_id` added. There is no proprietary format.

The interesting work is on the boundary. First, the LLM-derived fields (caption, expansions, classifier confidence) live in the same tables as the user-typed fields, but the Anthropic key is on-device in `expo-secure-store`. The web client can render cached results (the `ai_summaries.summary_json` column has the caption fields) but can't generate new ones. That's fine for read-only. The day a web user wants to "regenerate caption" the call has to move server-side — Cloudflare Worker or Supabase Edge Function — with the user's key encrypted at rest and the prompt template living in code, not on the device.

Second, the prose-canonical scanner pattern wants to re-run when text changes, and the scanners are TypeScript files in `src/services/`. Sharing them between web and mobile is straightforward (no React Native dependencies in `src/services/todos/scanTodos.ts` or `src/services/threads/scanThreads.ts`). The thing that doesn't share is `src/services/database.ts` — it imports `expo-sqlite`. The web equivalent would be a thin adapter over the Supabase client that exposes the same function signatures. Either I introduce a `Persistence` interface and have two implementations, or I split the read API (`getEntriesByDate`, `getThreads`, etc.) from the write API and only port the read API for web. The latter is less work.

Third, write paths from the web (if we ever allow editing) would have to flow through the same sync semantics. The simplest approach: the web client writes directly to Supabase with `updated_at = now()` and the mobile client picks it up on the next pull. That works because LWW is symmetric; the question is whether the web client should also be debounced (yes, same reason) and whether a save indicator should surface (yes, because there's no on-device durability — every web save *is* the cloud save). The architecture survives the addition of web because the cloud row was always the cross-client contract; mobile just happens to keep a local mirror.

---

## The hard question

### "Why is there no actual backend service? Doesn't this mean every client has to know how to talk to Supabase, and you can't change the schema without bumping every device?"

**Model answer (≥200 words).**

Yes — the device-to-Supabase coupling is real, and yes, it limits how I can change the schema. That's a deliberate trade. Putting an actual server between the device and Postgres would let me version the API independently of the storage, but it would also add: a deployment target, a hosting cost, a request-path latency, an auth dance, and a service to keep healthy. For a single-user-per-device app where the cost of a client lagging behind the schema is "the user has to update the app," that's not a worthwhile trade today.

The compatibility strategy is column-additive: every schema change adds nullable columns and the device tolerates unknown columns it doesn't read. If I add a `priority` column to `todo_meta`, devices that don't know about it just don't display priority; devices that do, do. The adapter's `cloud→local` mapper picks the columns it knows. The reverse direction works because new columns are nullable on the cloud side, so a device writing without them produces a valid row. This is the same pattern Protobuf uses for forward compatibility, except enforced by convention rather than the type system.

The breaking-change case is harder. Renaming a column or changing a field's semantic meaning would require a coordinated rollout: dual-write for one release, then read from the new column, then drop the old. I haven't done one yet because the schema has been mostly stable since the project's been in active development and because I control every device. At a real scale (Phase B with paying users on heterogeneous OS versions), I'd move the AI calls server-side first (because they hit per-user rate limits and cost tracking), then *probably* introduce a thin Postgres function layer (`pg_net` + RPCs) before introducing a full backend service. The full backend only earns its weight when there are >2 features that need server compute — until then, a serverless mobile-first design is the right shape.
