# 01 — System design

Every architectural pattern in loopd, with diagrams first and prose second.

---

### Local-first request flow

```
  User taps a button on the Today screen
                │
                ▼
        ┌────────────────┐
        │  React screen  │  app/index.tsx (or any app/* route)
        └───────┬────────┘
                │  imperative call
                ▼
        ┌────────────────┐
        │  React hook    │  useEntries.editEntry, useHabits.toggle, etc
        └───────┬────────┘
                │  delegate
                ▼
        ┌────────────────┐
        │  Service       │  src/services/<domain>/<verb>.ts
        └───────┬────────┘
                │  SQL via expo-sqlite
                ▼
        ┌────────────────┐
        │  database.ts   │  the ONLY file that opens loopd.db
        └───────┬────────┘
                │   1. write (INSERT / UPDATE)
                │   2. set updated_at = now
                │   3. schedulePush()       ← debounced 5s timer
                ▼
        ┌────────────────┐
        │  loopd.db      │  SQLite, WAL, single-process
        └───────┬────────┘
                │  reads on next tick
                ▼
        UI re-renders
                │
                │  (5 seconds later, in the background)
                ▼
        ┌────────────────┐
        │  pushAll()     │  walks the SyncableTable registry
        └───────┬────────┘
                │  HTTPS upsert
                ▼
        Supabase Postgres
```

**What it is:** every user action commits to local SQLite first; the cloud lags by 5 seconds via a debounced background push.
**Why it's used here:** the app needs to work offline (native Android, journaling on the move) and the user is the only writer (Phase A is solo).
**Tradeoff:** other devices won't see your edits until ~5s after you stop typing. Acceptable for solo use; would need a tighter loop or live subscriptions for multi-device.

---

### Authentication boundary

```
  ┌── Phase A (current) ─────────────────────────────────┐    ┌── Phase B (planned) ─┐
  │                                                      │    │                      │
  │   App                                                │    │   App                │
  │    │                                                 │    │    │                 │
  │    │  every cloud write/read includes a hardcoded    │    │    │  Supabase auth   │
  │    │  PHASE_A_USER_ID (UUID in client.ts)            │    │    │  → access token  │
  │    ▼                                                 │    │    ▼                 │
  │   Supabase                                           │    │   RLS on every       │
  │    │                                                 │    │   row: user_id =     │
  │    │  RLS scaffolded but DISABLED                    │    │   auth.uid()         │
  │    │  composite (user_id, id) PKs ARE the schema     │    │                      │
  │    │  gate against cross-user reads                  │    │   Schema gate stays  │
  │    ▼                                                 │    │   the same           │
  │   Postgres                                           │    │                      │
  └──────────────────────────────────────────────────────┘    └──────────────────────┘
```

**What it is:** today there is no end-user authentication — every cloud row is tagged with a single hardcoded `user_id`. Authentication is *scaffolded* (RLS migration `0002` exists but is disabled).
**Why it's used here:** solo product, single user, building features over the wire-up.
**Tradeoff:** until Phase B ships auth, anyone with the Supabase anon key + URL can read the data. Mitigation: keys live in SecureStore; the app has no public surface.

---

### Single-source-of-truth principle

```
              prose in entries.text                ←── canonical
                       │
                       │ scanners run at commit (focus blur, screen leave)
                       │
        ┌──────────────┼──────────────────┬─────────────────┐
        ▼              ▼                  ▼                 ▼
  scanTodos      scanThreads         scanNutrition       (no scanner —
        │              │                  │             habits are first-class)
        ▼              ▼                  ▼
  todos_json   thread_mentions       nutrition rows
        │
        ▼
  reconcileMeta
        │
        ▼
  todo_meta (1:1 with each TodoItem in todos_json)
```

**What it is:** the journal text in `entries.text` is the only writable surface for drops; everything else (`todos_json`, `todo_meta`, `nutrition`, `thread_mentions`) is derived state, rebuilt from prose at commit time.
**Why it's used here:** keeps a single editable place. Two surfaces would mean drift; this way "delete the line in your journal, the todo is gone" works without divergent code paths.
**Tradeoff:** you can't have a todo that doesn't exist as a `[]` line somewhere — except the dashboard's todo-bucket entry path, which adds a `[]` line implicitly.

---

### Two-pass matching

```
  Existing todos:                    New scan of text:
  ┌─────────────────────┐            ┌─────────────────────┐
  │ id=t1 "call mom"    │            │ line 3: "call mom"  │
  │ id=t2 "ship feat"   │            │ line 5: "fix bug"   │
  │ id=t3 "fix bug"     │            │ line 7: "ship feature"│
  └─────────────────────┘            └─────────────────────┘
                                              │
                            ┌─────────────────┴─────────────────┐
                            │                                   │
                            ▼ Pass 1: exact text match          │
                      ┌─────────────────────┐                   │
                      │ "call mom"  → t1 ✓  │                   │
                      │ "fix bug"   → t3 ✓  │                   │
                      │ "ship feat" → ??    │ ← user edited it  │
                      └─────────────────────┘                   │
                                                                │
                            ▼ Pass 2: line-index fallback ◀─────┘
                      ┌─────────────────────────────┐
                      │ line 7 was previously t2    │  → t2 ✓
                      │ (sourceLine match)          │
                      └─────────────────────────────┘
```

**What it is:** every prose-derived feature (todos, threads, mentions) matches existing rows in two passes — exact text first, line-index second.
**Why it's used here:** preserves identity across edits. Pass 1 catches reorderings and unchanged lines; Pass 2 catches "I just edited the words on this same line" without losing the row's id, createdAt, classifier output, or expansion.
**Tradeoff:** can't tell apart "I edited line 7" from "I deleted line 7 and added a new todo" — both look the same to the algorithm. Acceptable; the classifier runs again on the new text either way.

```
Pseudocode (scanTodosFromText):
  matches = collectMatches(text)             // [] lines from prose
  claimed = empty map
  used    = empty set

  // Pass 1
  for i in 0..matches.length:
    prior = first existing where text matches AND id not used
    if prior:
      claimed[i] = prior; used.add(prior.id)

  // Pass 2
  for i in 0..matches.length:
    if claimed has i: continue
    prior = first existing where sourceLine == matches[i].lineIndex AND id not used
    if prior:
      claimed[i] = prior; used.add(prior.id)

  // Build output
  out = []
  for i in 0..matches.length:
    if claimed[i] exists: out.push({ ...claimed[i], text: matches[i].content, sourceLine: i })
    else:                 out.push(newTodo(matches[i]))

  // Carryover: existing todos that matched nothing stay (sourceLine cleared)
  carryover = existing where id not used
  return [...carryover, ...out]
```

---

### Soft delete and the deleted_at column

```
  Read path:                      Write path:
  ───────────                     ────────────
  SELECT *                        UPDATE entries
  FROM entries                       SET deleted_at = now,
  WHERE deleted_at IS NULL  ←        updated_at  = now
                                  WHERE id = ?
  └── always! every read site     │
      filters this column         └── trips schedulePush()
                                    so cloud learns about
                                    the delete
```

**What it is:** every synced table has a `deleted_at TEXT` column. Deletes write a timestamp, not a `DELETE FROM` row. Reads filter it out.
**Why it's used here:** the cloud sync layer needs to know an item was deleted — `DELETE FROM` would just make the row vanish locally and cloud would re-pull it as if it were still there. With a tombstone, push propagates the deletion.
**Tradeoff:** the database grows monotonically. A 30-day vacuum is in the spec but deferred — the volume is small enough that it doesn't matter yet.

---

### The 1:1 invariant (and why it's not a foreign key)

```
  entries.todos_json:  [ {id: "t-abc", text: "..."}, {id: "t-def", text: "..."} ]
                              ▲                              ▲
                              │                              │
                              │  todoId pointer              │  todoId pointer
                              │                              │
  todo_meta rows:       ┌─ id=t-abc ─┐                ┌─ id=t-def ─┐
                        │ entry_id    │                │ entry_id    │
                        │ type=idea   │                │ type=todo   │
                        │ pinned=0    │                │ pinned=1    │
                        │ ...         │                │ ...         │
                        └─────────────┘                └─────────────┘

  Why not a real FK?
  ────────────────────────────────────────────────────────────────────
  todos_json is a JSON array on a single entries row.
  SQLite cannot foreign-key to an element of a JSON column.
  So the application reconciler IS the enforcement.
```

**What it is:** every `TodoItem` in `entries.todos_json` has exactly one matching `todo_meta` row. The reconciler runs after every prose scan: insert missing, delete orphans, leave matched rows alone.
**Why it's used here:** SQLite doesn't support FKs to JSON-array elements. A code-level reconciler is the only option.
**Tradeoff:** a partial reconcile leaves orphans/missing meta rows until the next commit. Acceptable — the next commit's diff sees the gap and patches it (self-healing).

```
Pseudocode (reconcileTodoMetaForEntry):
  existing = getTodoMetasByEntry(entry.id)
  existingByTodoId = map of meta keyed by todoId
  currentIds = set of ids in entry.todos

  for each todo in entry.todos:
    if existingByTodoId has todo.id: continue       // matched, leave alone
    insertTodoMeta(newMetaFromHeuristic(todo))
    if heuristic == null AND not todo.done:
      scheduleClassify(todo.id, todo.text)          // fire LLM async

  for each meta in existing:
    if currentIds has meta.todoId: continue         // still in prose
    deleteTodoMeta(meta.todoId)                     // line gone → meta gone
```

---

### Cloud sync as a mirror

```
  ┌─ Local SQLite ─────────────────┐         ┌─ Cloud (Supabase) ─────────────┐
  │                                │         │                                │
  │   updated_at = canonical       │         │   updated_at = canonical       │
  │   synced_at  = local-only      │         │   (never has synced_at)        │
  │   deleted_at = soft-tombstone  │         │   deleted_at = soft-tombstone  │
  │                                │         │                                │
  │   read: WHERE deleted_at NULL  │         │   read: server-side filtered   │
  │                                │         │                                │
  └────────┬───────────────────────┘         └─────────────▲──────────────────┘
           │                                                │
           │ push:  WHERE updated_at > synced_at            │
           │        upsert in batches of 50                 │
           ├────────────────────────────────────────────────┤
           │ pull:  WHERE updated_at > last_pull_at         │
           │        per-row chooseWinner(local, cloud)      │
           │                                                │
           ▼                                                │
   sync_meta (per-table ledger)                             │
   last_pull_at, last_push_at, pending_pushes               │
```

**What it is:** the local DB is canonical. Cloud is a mirror. Push and pull are independent flows that share the registry of 10 syncable tables.
**Why it's used here:** writes feel instant (no network in the request path). The 5-second debounce on push trades a little staleness for vastly fewer round-trips during typing.
**Tradeoff:** every synced row carries `synced_at` (local-only) and `deleted_at`. Schema noise; worth it.

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

### Conflict resolution: last-write-wins

```
  local.updated_at vs cloud.updated_at:

  ┌────────────────────────────┬───────────────────┐
  │ Comparison                 │ Winner            │
  ├────────────────────────────┼───────────────────┤
  │ local > cloud              │ local (skip pull) │
  │ cloud > local              │ cloud (apply)     │
  │ local == cloud             │ tie → cloud       │
  │ malformed timestamp        │ cloud (defensive) │
  └────────────────────────────┴───────────────────┘
```

**What it is:** pure function in `sync/conflict.ts`. Compares timestamps; whichever side is newer wins. Same-second ties go to cloud.
**Why it's used here:** solo Phase A. Two devices = the user. The honest cases (same person edits on phone, then on tablet) all resolve cleanly with this rule.
**Tradeoff:** unrecoverable for true concurrent multi-user edits. Phase B may need vector clocks if two humans ever share a single workspace.

---

### Debounced push trigger

```
  user keystroke ──┐
  user keystroke ──┤        clearTimeout(timer)
  user keystroke ──┼──▶     timer = setTimeout(fire, 5000)
  user keystroke ──┘                                │
                                                    │ 5s of no calls
                                                    ▼
                                               fire():
                                                 if pushing: schedulePush()  ← re-queue
                                                 else:        pushAll()
```

**What it is:** every write site (every `database.ts` mutator) calls `schedulePush()`. The timer resets on every call. Five seconds after the last call fires, `pushAll()` runs.
**Why it's used here:** typing fires hundreds of writes per minute (autosave per keystroke). Pushing each one would melt the network. Debouncing collapses a typing burst into a single push.
**Tradeoff:** if the app is killed in the 5-second window, the latest writes never reach cloud — but they're still in local SQLite, and the next session's startup pushes them as `updated_at > synced_at`.

---

### Bootstrap decision tree

```
  Cold start
       │
       ▼
   isCloudConfigured?
       │ no  → skipped
       │
       │ yes
       ▼
   isBootstrapDone (SecureStore: cloud_initial_push_done)?
       │ yes → skipped (normal incremental sync takes over)
       │
       │ no
       ▼
   localHasData?    cloudHasData?
       │                 │
       └──────┬──────────┘
              ▼
      ┌───────────────────────────────────────────────────────────┐
      │ local=no  cloud=no    →  no-op            (mark done)     │
      │ local=yes cloud=no    →  initial-push     (mark done)     │
      │ local=no  cloud=yes   →  first-pull       (mark done)     │
      │ local=yes cloud=yes   →  fallback initial-push, log warn  │
      └───────────────────────────────────────────────────────────┘
```

**What it is:** runs once per install on the first cold start with cloud configured. Decides whether to push, pull, or do nothing. Sets a SecureStore flag so it never runs again.
**Why it's used here:** "fresh device recovery" (install → first-pull) and "first cloud connect on existing app" (push existing local → cloud) are different operations. Bootstrap picks correctly.
**Tradeoff:** the both-populated case can't be auto-resolved without a UI prompt. Phase A ships a pragmatic fallback (treat local as canonical) plus a warning log; Phase B should prompt.

---

### Provider abstraction (LLM)

```
  callsite: summarize(date) / classifyTodo(text) / expandTodo(...)  / generateCaption(...)
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │  ai/config.ts        │
                            │  getProvider() → 'claude' | 'openai'
                            └─────────┬────────────┘
                                      │
                ┌─────────────────────┼─────────────────────┐
                ▼                                           ▼
        provider == 'claude'                        provider == 'openai'
                │                                           │
                ▼                                           ▼
        @anthropic-ai/sdk                            raw fetch + JSON
        models.create({ ... })                       /v1/chat/completions
                │                                           │
                └─────────────────────┬─────────────────────┘
                                      ▼
                       same shape: string of model output
                                      │
                                      ▼
                      callsite parses + validates + persists
```

**What it is:** every AI service file (summarize, caption, classify, expand) imports `getProvider`, branches twice (once on the request, once on the model id), then converges on the same downstream parse step.
**Why it's used here:** the app sells AI features but doesn't lock the user into one provider. SecureStore keys can be either; the user picks. Default is Claude.
**Tradeoff:** every caller carries the branch — there is no single `BaseModel.invoke` interface. Two providers, four callsites, eight code paths. Worth it because each path can use the provider's optimal API (Claude SDK vs OpenAI's `response_format: json_object`).

```
Pseudocode (the shape every caller follows):
  provider = await getProvider()
  apiKey   = provider == 'openai' ? await getOpenAIKey() : await getAnthropicKey()
  if !apiKey: return { error: 'no API key' }

  raw = provider == 'openai'
        ? await callOpenAI(apiKey, system, user)
        : await callClaude(apiKey, system, user)

  parsed = extractJson(raw)
  validated = validateAgainstSchema(parsed)
  persist(validated)
```

---

### Manual-touch deviation (Principle 11)

```
  Standard mention shape:                    Manual touch shape:
  ─────────────────────────                  ─────────────────────
  thread_mentions row:                       thread_mentions row:
    thread_id     = ...                        thread_id     = ...
    entry_id      = e123      ← from prose     entry_id      = NULL  ← deviation
    todo_id       = NULL                       todo_id       = NULL
    source_line   = 7                          source_line   = 0
    tag_text      = "loopd"                    tag_text      = ""
    entry_date    = 2026-05-07                 entry_date    = 2026-05-07
    deleted_at    = NULL                       deleted_at    = NULL
                                                          ▲
                                              dashboard tap on a thread
                                              row in the daily-schedule grid
```

**What it is:** the only place the app writes a `thread_mentions` row whose `entry_id` and `todo_id` are both NULL. Marks "I touched this thread today" without any prose attribution.
**Why it's used here:** the daily-schedule grid lets the user tap a thread cell to mark it done for the day. There's no prose to derive from, but the staleness math (`computeStaleness`, `getThreadCards`) consumes `thread_mentions` uniformly — so writing an entry-less mention row is the cleanest signal.
**Tradeoff:** breaks the Principle 11 invariant that "mentions are derived from prose" — explicitly documented as one of two allowed deviations. The 14-day activity strip and the staleness label specifically read these rows by `entry_id IS NULL AND todo_id IS NULL`.

---

### Append-only Postgres migrations

```
  supabase/migrations/
    0001_initial_schema.sql       ── 10 mirror tables, composite (user_id, id) PKs
    0002_rls_phase_b.sql          ── RLS policies (currently DISABLED in Phase A)
    0003_get_server_time.sql      ── RPC the pull path uses
    0004_relax_fks.sql            ── adjust FKs to allow soft-delete edge cases
    0005_todo_meta_pinned.sql     ── ADD COLUMN pinned

  Apply path:
    node scripts/db-migrate.mjs --all-pending
                       │
                       ▼
    pg client connects, walks files in order, executes any not yet applied
```

**What it is:** every Postgres schema change is a new file, never an edit of an existing one.
**Why it's used here:** an applied migration is permanent. Editing `0001` after it ran on cloud would drift the schema.
**Tradeoff:** the migration log gets long. Worth it for the audit trail.

---

### File-routed UI (expo-router)

```
  app/
   ├── _layout.tsx                ── root layout, the boot path
   ├── index.tsx                  ── /            (Today / dashboard)
   ├── todos.tsx                  ── /todos
   ├── todos/
   │    └── [id].tsx              ── /todos/<todoId>
   ├── journal/
   │    └── [date].tsx            ── /journal/2026-05-07
   ├── editor/
   │    └── [date].tsx            ── /editor/2026-05-07
   ├── threads/
   │    └── [id].tsx              ── /threads/<threadId>
   ├── more/
   │    ├── index.tsx, habits.tsx, threads.tsx, nutrition.tsx
   └── settings/
        └── ai.tsx, cloud-sync.tsx, index.tsx, updates.tsx
```

**What it is:** every file under `app/` is a route. `[param]` directories define dynamic segments. `_layout.tsx` is a wrapper that runs on every screen.
**Why it's used here:** matches expo-router's convention so URLs and back-stack work without manual route configuration.
**Tradeoff:** harder to abstract a route shape across many screens — each file is its own thing. For a small app, fine.

---

### Storage layer summary

```
  ┌──────────────────────────────┬────────────────────────────────────────┐
  │ Where the data lives         │ What's there                           │
  ├──────────────────────────────┼────────────────────────────────────────┤
  │ loopd.db (SQLite)            │ 12 tables; canonical state             │
  │ /document/loopd/clips/       │ raw video clips, per-day folders       │
  │ /document/loopd/exports/     │ exported vlog .mp4 files               │
  │ SecureStore                  │ API keys, provider, bootstrap flags    │
  │ Supabase Postgres            │ mirror of 10 tables, NEVER read first  │
  │ Anthropic / OpenAI           │ stateless — never persists user data   │
  └──────────────────────────────┴────────────────────────────────────────┘
```

**What it is:** five storage layers, each with one job. Clips are big and binary, so they go to the filesystem. Secrets go to Keystore. Everything else lives in SQLite, mirrored to Postgres async.
**Why it's used here:** mixing them would make sync hopeless — you can't push raw video bytes through `supabase-js` cleanly, and you don't want the secrets in a queryable table.
**Tradeoff:** clips are device-local. If you reinstall the app, your videos are gone (cloud holds the metadata, not the bytes). Solo product, accepted.
