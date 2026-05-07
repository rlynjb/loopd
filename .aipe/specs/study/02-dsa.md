# 02 — Data structures and algorithms

Every algorithm here is grounded in a real loopd operation. The data shapes are the actual shapes; the traces use values you'd see in a real entry.

---

### Two-pass scan: matching prose lines to existing todos — Map + Set

**Real operation:** `scanTodosFromText` in `src/services/todos/scanTodos.ts`. Runs at every commit (focus blur, screen leave) on `entries.text`.

**File:** `src/services/todos/scanTodos.ts`

**The data:**

```
  text (entry.text):
    "Morning notes
     [] call mom
     [] write spec
     [x] book dentist
     idea: refactor scanner"

  existing TodoItem[]:
    [
      { id: "t-A", text: "call mom",      done: false, sourceLine: 1, createdAt: "...", completedAt: null },
      { id: "t-B", text: "draft spec",    done: false, sourceLine: 2, createdAt: "...", completedAt: null },
      { id: "t-C", text: "book dentist",  done: false, sourceLine: 3, createdAt: "...", completedAt: null },
    ]
```

**The problem:** produce a new `TodoItem[]` where existing rows survive across edits. "call mom" is unchanged → keep `t-A`. "draft spec" was edited to "write spec" on the same line → keep `t-B` via line-index fallback. "book dentist" is now `[x]` → keep `t-C`, set `done=true`, stamp `completedAt`.

── Brute force ──────────────────────────────────

**Pseudocode:**

```
  for each line in text:
    for each existing todo:
      if line.text equals existing.text (case-insensitive):
        match!
      else if line.lineIndex equals existing.sourceLine:
        match!
  // O(n × m) with backtracking on duplicates
```

**Execution trace** (lines = 4 [], existing = 3):

```
  step  line                  scan over existing                  claim
  ────  ────────────────────  ──────────────────────────────────  ──────
  1     line 1 "call mom"     t-A.text == ✓                        t-A
  2     line 2 "write spec"   t-A used; t-B.text != ; t-C.text !=  none yet
                              re-scan w/ line-index: t-B.line==2 ✓ t-B
  3     line 3 "book dentist" t-A used; t-B used; t-C.text == ✓    t-C
  4     line 4 "idea: ..."    NOT a [] line, skipped                —
```

**Complexity:** O(n × m) time · O(n) space — where n = `[]` lines, m = existing todos.

**What goes wrong at scale:** a single entry rarely has more than 20-30 todos in this app, so even at O(n × m) the absolute count is tiny (600 ops max). Scale isn't the issue here. The issue is *correctness* on duplicates: a naive loop matches the same existing todo to two different lines.

── Optimal ──────────────────────────────────────

**The insight:** track which existing ids are already claimed (`Set`), and iterate matches in two distinct passes — exact text first (so reorderings always win), line-index second (so single-line edits keep their identity).

**Pseudocode:**

```
  matches = collectMatches(text)             // de-duped [] lines
  claimed = empty Map<int, TodoItem>
  used    = empty Set<string>

  // Pass 1 — exact text match
  for i in 0..matches.length:
    key = matches[i].content.toLowerCase()
    prior = first existing where prior.text.lower == key AND prior.id NOT in used
    if prior:
      claimed[i] = prior
      used.add(prior.id)

  // Pass 2 — line-index fallback
  for i in 0..matches.length:
    if claimed has i: continue
    li = matches[i].lineIndex
    prior = first existing where prior.sourceLine == li AND prior.id NOT in used
    if prior:
      claimed[i] = prior
      used.add(prior.id)

  // Build output
  out = []
  for i in 0..matches.length:
    m = matches[i]
    prior = claimed[i]
    if prior:
      out.push({
        ...prior,
        text: m.content,
        done: m.isDone,
        completedAt: prior.done != m.isDone
                     ? (m.isDone ? now : null)
                     : prior.completedAt,
        sourceLine: m.lineIndex,
      })
    else:
      out.push(newTodo(m))

  // Carry over the unmatched
  carryover = existing where id NOT in used, with sourceLine cleared
  return [...carryover, ...out]
```

**Execution trace** (same input):

```
  Pass 1 (exact text):
    i=0  match "call mom"      → t-A unused, text== ✓     claimed[0]=t-A used={t-A}
    i=1  match "write spec"    → no exact match           claimed[1]=∅  used={t-A}
    i=2  match "book dentist"  → t-C unused, text== ✓     claimed[2]=t-C used={t-A,t-C}

  Pass 2 (line-index):
    i=0  claimed                                        skip
    i=1  claimed[1]=∅, line=2 → t-B sourceLine==2 ✓     claimed[1]=t-B used={t-A,t-B,t-C}
    i=2  claimed                                        skip

  Build out:
    i=0 prior=t-A → out += { id:t-A, text:"call mom",     done:false, completedAt:null }
    i=1 prior=t-B → out += { id:t-B, text:"write spec",   done:false, completedAt:null }
    i=2 prior=t-C → out += { id:t-C, text:"book dentist", done:true,  completedAt:now } ← flipped
    used = {t-A,t-B,t-C}

  Carryover: existing.filter(id ∉ used) → [] (none)

  Result: [t-A, t-B, t-C] — same ids, t-B's text updated, t-C's done flipped.
```

**Complexity:** O(n + m) time after the Map/Set conversion (linear scans, O(1) Set lookups) · O(n + m) space.

**Why it's faster:** the brute-force version does O(m) work *inside* the line loop (re-scanning existing each time) and re-checks already-claimed rows. With a `Set<string>` of used ids and a guarded `Map<int, TodoItem>` of claims, each existing row is touched at most twice (once per pass).

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n × m)       │ O(n + m) amort.  │
  │ Space           │ O(n)           │ O(n + m)         │
  │ At 30 todos     │ 900 ops        │ 60 ops           │
  │ At 300 todos    │ 90,000 ops     │ 600 ops          │
  │ Correctness     │ duplicates ✗   │ Set-guarded ✓    │
  └─────────────────┴────────────────┴──────────────────┘
```

**When brute force is fine:** never. The Set guard isn't an optimization — it's correctness. Two `[]` lines with the same text would both claim the same todo and one would be reused twice.

---

### todo_meta reconciliation: 1:1 invariant — Map + Set diff

**Real operation:** `reconcileTodoMetaForEntry` in `src/services/todos/reconcileMeta.ts`. Runs after `scanTodos` produces final `todos_json`.

**File:** `src/services/todos/reconcileMeta.ts`

**The data:**

```
  entry.todos:                          todo_meta (rows in DB):
    [{id: "t-A", text: ...},              [{ todoId: "t-A", type: "todo", ...},
     {id: "t-B", text: ...},               { todoId: "t-X", type: "idea", ...}]   ← stale
     {id: "t-C", text: ...}]            ← t-C missing
```

**The problem:** insert any TodoItem missing a meta row, delete any meta whose `todoId` isn't in `todos_json` anymore, leave matched rows untouched (preserves user-overridden type).

── Brute force ──────────────────────────────────

**Pseudocode:**

```
  // For every todo, scan all metas (O(n*m))
  for each todo in entry.todos:
    found = existing.find(m => m.todoId == todo.id)
    if not found: insertTodoMeta(todo)

  for each meta in existing:
    found = entry.todos.find(t => t.id == meta.todoId)
    if not found: deleteTodoMeta(meta.todoId)
```

**Complexity:** O(n × m) time · O(1) extra space.

── Optimal ──────────────────────────────────────

**The insight:** build two index structures — a `Map<todoId, meta>` for O(1) "do I already have a meta?" and a `Set<todoId>` for O(1) "is this meta still valid?".

**Pseudocode:**

```
  existing = getTodoMetasByEntry(entry.id)
  byTodoId = Map( existing.map(m => [m.todoId, m]) )
  current  = Set( entry.todos.map(t => t.id) )

  // Insert missing
  for each todo in entry.todos:
    if byTodoId has todo.id: continue
    heur = heuristicClassify(todo.text)
    insertTodoMeta(buildMeta(todo, heur))
    if heur == null AND not todo.done:
      scheduleClassify(todo.id, todo.text)        // fire LLM async (non-blocking)

  // Delete orphans
  for each meta in existing:
    if current has meta.todoId: continue
    deleteTodoMeta(meta.todoId)
```

**Execution trace** (`existing = [t-A meta, t-X meta]`, `entry.todos = [t-A, t-B, t-C]`):

```
  build:
    byTodoId = { "t-A" → metaA, "t-X" → metaX }
    current  = { "t-A", "t-B", "t-C" }

  insert phase:
    t-A: byTodoId has it       → skip
    t-B: not in byTodoId       → heuristic("write spec") = null
                                 insertTodoMeta(t-B, type='todo', confidence=null)
                                 scheduleClassify(t-B, "write spec")  ← async LLM
    t-C: not in byTodoId       → heuristic("book dentist") = 'todo'
                                 insertTodoMeta(t-C, type='todo', confidence='heuristic')
                                 (no LLM — heuristic was confident)

  delete phase:
    metaA (t-A): current has it → skip
    metaX (t-X): current lacks  → deleteTodoMeta(t-X)

  Final: t-A unchanged, t-B inserted (LLM upgrades type later),
         t-C inserted with heuristic, t-X deleted.
```

**Complexity:** O(n + m) time · O(n + m) space.

**Why it's faster:** Map + Set lookups are O(1). Each row is visited at most twice (once when building the index, once when iterating). The async LLM scheduling doesn't block the write — `reconcileTodoMetaForEntry` returns as soon as the synchronous inserts are done.

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(n × m)       │ O(n + m)         │
  │ Space           │ O(1)           │ O(n + m)         │
  │ At 20 todos     │ 400 ops        │ 40 ops           │
  │ Self-healing    │ ✓              │ ✓                │
  └─────────────────┴────────────────┴──────────────────┘
```

**When brute force is fine:** at the 20-todo scale of a typical entry, both run in under a millisecond. The reason the optimal version is in the codebase isn't speed — it's clarity (`byTodoId.has(...)` reads like the invariant).

---

### Two-pass thread mention reconcile — line-shift tolerant

**Real operation:** `reconcileMentions` in `src/services/threads/scanThreads.ts`. Same shape as the todo two-pass, but Pass 2 uses `±3 line shift` instead of exact line match.

**File:** `src/services/threads/scanThreads.ts`

**The data:**

```
  parsed (from current text):
    [{ threadId: "th1", lineIndex: 5, tagText: "loopd" },
     { threadId: "th2", lineIndex: 7, tagText: "Health" }]

  existing (already in thread_mentions):
    [{ id: "m1", threadId: "th1", sourceLine: 5, tagText: "loopd"  },   ← exact match
     { id: "m2", threadId: "th2", sourceLine: 4, tagText: "health" }]   ← shifted +3
```

**The problem:** match parsed-tags-from-text to existing-mention-rows. The user moved a tag down 3 lines by adding lines above; the row id should survive that.

── Pseudocode (skip the brute, the optimal is the only one in the codebase) ──

```
  claimed = empty Map<int, mention>
  used    = empty Set<string>

  // Pass 1: exact (threadId, sourceLine)
  for i in 0..parsed.length:
    p = parsed[i]
    prior = first existing where existing.threadId == p.threadId
                              AND existing.sourceLine == p.lineIndex
                              AND existing.id NOT in used
    if prior: claimed[i] = prior; used.add(prior.id)

  // Pass 2: (threadId, tagText) within ±3 lines
  for i in 0..parsed.length:
    if claimed has i: continue
    p = parsed[i]
    prior = first existing where existing.threadId == p.threadId
                              AND existing.tagText.lower == p.tagText.lower
                              AND |existing.sourceLine - p.lineIndex| <= 3
                              AND existing.id NOT in used
    if prior: claimed[i] = prior; used.add(prior.id)

  // Apply diffs
  for i in 0..parsed.length:
    p = parsed[i]
    prior = claimed[i]
    if prior:
      if prior.sourceLine != p.lineIndex: updateMentionSourceLine(prior.id, p.lineIndex)
      if prior.tagText    != p.tagText:   updateMentionTagText(prior.id, p.tagText)
    else:
      insertMention(makeNew(p))
  for row in existing:
    if row.id NOT in used: deleteMention(row.id)
```

**Execution trace:**

```
  Pass 1:
    i=0 (th1, line 5)  → m1 (th1, sourceLine 5) ✓     claimed[0]=m1, used={m1}
    i=1 (th2, line 7)  → m2 (th2, sourceLine 4) ✗     claimed[1]=∅,  used={m1}

  Pass 2:
    i=1 (th2, line 7, "Health")
        candidate m2: same threadId ✓
                      tagText.lower == "health" == "health" ✓
                      |4 - 7| = 3 ≤ 3 ✓
        claimed[1]=m2, used={m1, m2}

  Apply:
    i=0 prior=m1, no change       → no-op
    i=1 prior=m2, sourceLine 4→7  → updateMentionSourceLine(m2, 7)
                  tagText "health"→"Health" → updateMentionTagText(m2, "Health")

  Done: m1 + m2 both kept. No inserts, no deletes.
```

**Complexity:** O(n × m) per pass time · O(n) space. Within an entry, n + m is small (typically <10).

**When brute force is fine:** here. Pass 2 is the cheap path. The `find` is linear over a per-entry list — no Map needed because the predicate is "threadId AND text AND |line shift| ≤ 3", which doesn't index cleanly.

---

### Ranked todo flatten + sort — array flatten then 3-key compare

**Real operation:** `rankTodos` in `src/services/todos/rank.ts`. Used by the `/todos` page when grouping isn't applied (legacy path; the dashboard now uses position-based sort, but the rank module is still imported).

**File:** `src/services/todos/rank.ts`

**The data:**

```
  entries: [
    { id: "e-yest", date: "2026-05-06", createdAt: "...", todos: [
        { id: "t-1", text: "call mom",   done: false, completedAt: null, createdAt: "2026-05-06T08:00" },
        { id: "t-2", text: "ship feat",  done: true,  completedAt: "2026-05-07T09:00", createdAt: "..." },
    ]},
    { id: "e-tdy",  date: "2026-05-07", createdAt: "...", todos: [
        { id: "t-3", text: "review PR",  done: false, completedAt: null, createdAt: "2026-05-07T10:00" },
        { id: "t-4", text: "fix bug",    done: false, completedAt: null, createdAt: "2026-05-07T10:05" },
    ]},
  ]
  today = "2026-05-07"
  keepDoneMs = 2000
  now = "2026-05-07T10:30:00"
```

**The problem:** flatten across entries, drop completed-too-long todos, then bubble: carried-from-yesterday → ai-generated → today's → all sorted oldest first within each group, with done at the bottom.

── Pseudocode ──

```
  flat = []
  for each entry in entries:
    for each todo in entry.todos:
      if todo.done AND todo.completedAt AND (now - completedAt > keepDoneMs): continue
      source = (not done AND entry.date < today) ? 'carried' : 'journal'
      flat.push({ ...todo, entryId, entryDate, entryCreatedAt, source })

  priority = { carried: 0, ai: 1, journal: 2 }

  flat.sort((a, b):
    if a.done != b.done: return a.done ? +1 : -1     // done at bottom
    if priority[a.source] != priority[b.source]: return priority[a]-priority[b]
    return parseISO(a.createdAt) - parseISO(b.createdAt) )   // oldest first

  return flat
```

**Execution trace:**

```
  Flatten + filter:
    t-1 "call mom"   not done, e.date 05-06 < today 05-07 → source='carried'
    t-2 "ship feat"  done, completedAt 09:00, now 10:30, diff = 5400000ms > 2000ms → DROP
    t-3 "review PR"  not done, e.date == today           → source='journal'
    t-4 "fix bug"    not done, e.date == today           → source='journal'

  flat = [t-1 carried, t-3 journal, t-4 journal]

  Sort:
    a=t-1, b=t-3
      done equal (both false)
      priority: carried 0, journal 2 → t-1 first
    a=t-3, b=t-4
      done equal
      priority equal (journal/journal)
      createdAt: 10:00 < 10:05 → t-3 first

  Final order: [ t-1 (carried), t-3 (journal), t-4 (journal) ]
```

**Complexity:** O(n log n) time (sort dominates) · O(n) space.

**Why this is the optimal:** the alternative (group → sort within groups → concat) is also O(n log n) but allocates more arrays. Compose-into-one-comparator is the cleanest.

---

### Daily-schedule grid cell state — pure decision tree, O(1) per cell

**Real operation:** `cellStateFor` (habits) and `cellStateForThread` (threads) in `src/components/home/cellState.ts`. Computed once per cell on every render of the weekly grid (7 columns × N rows).

**File:** `src/components/home/cellState.ts`

**The data:**

```
  habit: { id, cadenceType: 'specific_days', cadenceDays: [1,3,5], ... }
  dateStr = "2026-05-07"   (Thu, day=4)
  todayStr = "2026-05-07"
  checkedDates = Set<string> { "2026-05-05", "2026-05-06" }
```

**The problem:** map (habit, date, today, checkedDates) → one of 5 states. Must be cheap (called 7 × N times per render) and pure (no DB).

── Pseudocode ──

```
  function cellStateFor(habit, dateStr, todayStr, checkedDates):
    if checkedDates has dateStr:        return 'done'         // 1. check-in always wins
    date = parse(dateStr + 'T12:00:00')
    if not isDueOn(habit, date):        return 'off-day'      // 2. cadence excludes
    if dateStr == todayStr:             return 'pending'      // 3. today
    if dateStr  > todayStr:             return 'upcoming'     // 4. future
    return 'missed'                                           // 5. past + due + uncheck'd
```

**Execution trace** (specific_days = M/W/F → days 1, 3, 5; today is Thu day=4):

```
  Tue 05-05  date < today, day=2:
    checkedDates has "05-05"? YES        → 'done' ✓
  Wed 05-06  date < today, day=3:
    checkedDates has "05-06"? YES        → 'done' ✓
  Thu 05-07  today, day=4:
    checkedDates has "05-07"? NO
    isDueOn(habit, day=4)?                day=4 ∉ [1,3,5] → false → 'off-day'
  Fri 05-08  date > today, day=5:
    checkedDates has "05-08"? NO
    isDueOn(habit, day=5)?                day=5 ∈ [1,3,5] → true
    dateStr > todayStr                    → 'upcoming'
  Mon 05-04  date < today, day=1:
    checkedDates has "05-04"? NO
    isDueOn(habit, day=1)?                day=1 ∈ [1,3,5] → true
    dateStr < todayStr                    → 'missed'
```

**Complexity:** O(1) per cell · O(1) space (the `Set.has` is constant; `isDueOn` is a switch).

**Why pure matters here:** the grid re-renders on every habit toggle, week change, and live-now tick. If `cellStateFor` were impure (DB read, async), the grid would flash. The `checkedDatesByHabit: Map<string, Set<string>>` is built once per render at the parent and passed down — N habits with O(1) map lookup each.

---

### Thread cards aggregate — 4 SQL queries + 2 in-memory joins

**Real operation:** `getThreadCards` in `src/services/threads/getThreadCards.ts`. Runs every dashboard load.

**File:** `src/services/threads/getThreadCards.ts`

**The data:** all threads + thread_mentions + todo_meta + entries.

**The problem:** for each thread, compute `lastMentionAt`, `entriesThisWeek`, `openTodos`, `recentTodos[3]`, `staleness`, `activeDates` (manual-touch days). Then sort by pinned → staleness → recent.

── Pseudocode ──

```
  threads          = getThreads(includeArchived=false)            // ~10s of rows
  lastMentionMap   = getLastMentionByThread()                     // 1 SQL aggregate
  activityRows     = SELECT thread_id, entry_date FROM thread_mentions
                     WHERE entry_id IS NULL AND todo_id IS NULL  // manual-touch only
                       AND deleted_at IS NULL
  weekRows         = SELECT thread_id, COUNT(DISTINCT entry_id) AS cnt
                     FROM thread_mentions
                     WHERE entry_id IS NOT NULL
                       AND entry_date >= weekStartISO
                       AND deleted_at IS NULL
                     GROUP BY thread_id
  todoLinkRows     = SELECT DISTINCT thread_id, todo_id FROM thread_mentions
                     WHERE todo_id IS NOT NULL AND deleted_at IS NULL

  allMetas = getAllTodoMetas()                                    // joined in JS
  metaById = Map(allMetas.map(m => [m.todoId, m]))
  todoTextById = built from getAllEntries() entries

  for each thread:
    linkedTodoIds = todoIdsByThread[thread.id]
    openTodos = 0
    recents = []
    for tid in linkedTodoIds:
      meta = metaById[tid]; todo = todoTextById[tid]
      if !meta || !todo || todo.done: continue
      openTodos++
      recents.push({ tid, todo.text, meta.type, todo.createdAt })
    recents.sort(byCreatedAtDesc).take(3)

    lastAt = lastMentionMap[thread.id] ?? null
    days = lastAt ? differenceInDays(now, lastAt) : null
    staleness = computeStaleness(thread, lastAt, now)

    cards.push({ thread, lastAt, days, staleness, entriesThisWeek, openTodos, recents, activeDates })

  return cards.sort(pinned ↓, stalenessRank ↑, lastAt ↓, name ↑)
```

**Execution trace** (3 threads, 2 mentions each, today = 2026-05-07):

```
  threads = [#loopd, #health, #journal]
  lastMentionMap   = { loopd: "05-07T09:00", health: "05-04T18:00", journal: null }
  activeDates      = { loopd: {05-07}, health: {}, journal: {} }      ← manual touches
  weekRows         = { loopd: 1, journal: 0 }
  todoIdsByThread  = { loopd: {t-1, t-2}, health: {}, journal: {t-9} }

  Iterate:
    #loopd:
      linked = {t-1, t-2}
      t-1 meta exists, not done → openTodos=1, push recent
      t-2 meta exists, done    → skip
      lastAt 05-07T09:00, days=0, staleness=fresh (target=null, days≤1)
      activeDates={05-07}
    #health:
      linked = {}
      lastAt 05-04T18:00, days=3, staleness=aging (default thresholds: 1d/3d/7d)
    #journal:
      linked = {t-9}
      t-9 meta missing → skip (defensive)
      lastAt null     → staleness=cold

  Sort:
    pinned all false → next key
    stalenessRank: fresh(0) < aging(1) < cold(3)
    Result: [#loopd, #health, #journal]
```

**Complexity:** O(T + M + Q) time where T=threads, M=mentions, Q=todos · O(T + M + Q) space. SQL does the heavy work; JS does linear joins.

**Why not run a giant JOIN in SQL?** could. But `getAllEntries` is already in memory (it's the dashboard's primary state) so reusing it is free. Two SQL roundtrips traded for one in-memory join.

---

### Cloud sync push — batch upsert with mid-batch failure tolerance

**Real operation:** `pushTable` in `src/services/sync/push.ts`. Runs from `pushAll()` over the 10-table registry; called by the debounced `schedulePush` after 5s of write quiet.

**File:** `src/services/sync/push.ts`

**The data:**

```
  table.localQueryDirty() → 137 dirty rows
  BATCH_SIZE = 50
  Supabase upsert with onConflict: 'user_id,id'
```

**The problem:** push only what changed, in chunks small enough that one failure doesn't strand the whole table. On per-batch success, stamp `synced_at` so the row is no longer "dirty"; on failure, leave `synced_at` alone so the next push retries the same batch.

── Pseudocode ──

```
  dirty = table.localQueryDirty()                  // SELECT * WHERE updated_at > synced_at
  if dirty.empty:
    recordPushSuccess(table, now, 0)
    return zeroResult

  succeeded, failed = 0, 0
  for offset in 0, 50, 100, ...:
    batch = dirty[offset : offset+50]
    cloudRows = batch.map(localToCloud)
    err = supabase.from(table).upsert(cloudRows, onConflict: 'user_id,id')
    if err:
      failed += batch.length
      lastErr = err.message
      continue                                     // don't stamp synced_at
    stampedAt = now
    for row in batch:
      table.localMarkSynced(row.id, stampedAt)
    succeeded += batch.length

  if failed == 0: recordPushSuccess(...)
  else:           recordSyncError(table, lastErr)
  return { attempted: dirty.length, succeeded, failed }
```

**Execution trace** (137 dirty, batch 2 fails):

```
  batch 1  rows 0-49    upsert OK    stamp 50 rows synced_at  succeeded=50
  batch 2  rows 50-99   upsert ERR   skip stamp                failed=50
  batch 3  rows 100-136 upsert OK    stamp 37 rows synced_at  succeeded=87

  Total: attempted=137, succeeded=87, failed=50
  recordSyncError(table, "<batch-2 err>")

  Next push: localQueryDirty re-selects the 50 rows that didn't get synced_at
             → retries them (idempotent thanks to onConflict + LWW)
```

**Complexity:** O(n) network ops grouped into ⌈n/50⌉ batches; each batch is one HTTPS round-trip · O(BATCH_SIZE) space.

**Why batched, not single upsert:** one giant upsert would make a 50KB+ payload that supabase-js doesn't love, and a network blip would lose all 137 rows of progress. 50 is small enough to retry cheaply, big enough that 200 todos = 4 round-trips.

---

### Cloud sync pull — paginated, conflict-resolved, server-time anchored

**Real operation:** `pullTable` in `src/services/sync/pull.ts`. Runs from `pullAll()`.

**File:** `src/services/sync/pull.ts`

**The data:**

```
  PAGE_SIZE = 200
  serverTime = supabase.rpc('get_server_time')   // avoid using local Date.now
  cursor     = sync_meta[table].last_pull_at ?? '1970-01-01T00:00:00.000Z'
```

**The problem:** pull only what's new since last pull, in 200-row pages, resolving conflicts row-by-row. Don't re-flag a just-pulled row as dirty (so stamp `synced_at` to the same `serverTime`).

── Pseudocode ──

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

**Why paginate by `updated_at` ASC + cursor:** OFFSET pagination would miss rows that arrive during the loop (the window shifts). Cursor-by-timestamp is monotonic — even if cloud writes during the pull, the next page picks them up next time around.

**Why anchor to `serverTime` (RPC) and not `Date.now()`:** local clock skew. If the device clock is 30s behind, pulling rows newer-than-Date.now() would race the cloud's own timestamps and miss data. The server's clock is the authority.

**Complexity:** O(n) network across ⌈n/200⌉ pages · O(PAGE_SIZE) memory at a time.

---

### Tag parsing with code-fence masking — single-pass regex with offset preservation

**Real operation:** `parseTags` in `src/services/threads/scanThreads.ts`. Strips fenced code blocks and inline code spans before applying the `#tag` regex, so backticked tokens like `` `git #branch` `` don't register.

**File:** `src/services/threads/scanThreads.ts`

**The data:**

```
  text:
    "Working on #loopd today.
     Code spans: `git checkout #main` should NOT match.
     ```
     #fenced should NOT match either
     ```
     #health quick note"
```

**The problem:** match `#tag` only outside code regions, while keeping line indices stable so downstream reconcile uses the right line numbers.

── Pseudocode ──

```
  function maskCode(text):
    // Replace fenced ```...``` with same-length runs of spaces (newlines preserved!)
    out = text.replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '))
    // Replace inline `...` with spaces of equal length
    out = out.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
    return out

  function parseTags(text):
    masked = maskCode(text)
    lines  = masked.split('\n')
    seen   = empty set                          // {lineIdx}::{slug} for per-line dedup
    out    = []
    for i in 0..lines.length:
      reset TAG_RE.lastIndex
      while m = TAG_RE.exec(lines[i]):
        slug = m[2].toLowerCase()
        key  = i + '::' + slug
        if seen has key: continue
        seen.add(key)
        out.push({ slug, tagText: m[2], lineIndex: i })
    return out
```

**Execution trace:**

```
  After maskCode:
    line 0  "Working on #loopd today."
    line 1  "Code spans:                          should NOT match."
    line 2  "                                                      "  ← fence opener
    line 3  "                                                      "  ← inside fence
    line 4  "                                                      "  ← fence closer
    line 5  "#health quick note"

  Iterate lines:
    line 0: TAG_RE matches "#loopd" → out += { slug:"loopd", tagText:"loopd", lineIndex:0 }
    line 1: only spaces — no match
    line 2-4: no match
    line 5: matches "#health" → out += { slug:"health", tagText:"Health"|"health", lineIndex:5 }

  Result: 2 tags, line indices 0 and 5 (NOT shifted by the fence block).
```

**Why preserve byte offsets via space-replace:** the reconcile pass (`reconcileMentions`) keys on `sourceLine`. If `maskCode` collapsed the fence into a single empty line, line 5 would become line 2 and existing mentions at line 5 wouldn't match. Replacing with spaces of equal length keeps line numbers stable.

**Complexity:** O(L) for the regex masks · O(L) for the per-line scan, where L = text length.

---

### Heuristic-first classifier — cheap regex gate before the LLM

**Real operation:** `heuristicClassify` in `src/services/todos/heuristicClassify.ts`. Runs *every* time a new todo is created during reconcile. The LLM classifier is fired only when the heuristic returns `null`.

**File:** `src/services/todos/heuristicClassify.ts`

**The data:**

```
  IMPERATIVE_VERBS:  Set of ~70 verbs ("call", "fix", "send", ...)
  MODAL_STARTS:      Array of regexes ("gotta", "need to", "should", ...)
  QUESTION_STARTS:   Array of regexes ("why", "how", "what", ...)
  SPECULATIVE_STARTS:Array of regexes ("maybe", "noticed", "idea:", ...)
  DEADLINE_PATTERNS: Array of regexes ("by tomorrow", "EOD", "tonight", ...)
```

**The problem:** decide whether a line is *definitely a todo* (return `'todo'`) or *uncertain* (return `null`, defer to LLM). Never mis-classify a question or idea as a todo.

── Pseudocode (decision-order matters) ──

```
  function heuristicClassify(rawText):
    text = rawText.trim()
    if !text: return null
    if text endsWith '?': return null               // question → null

    for re in SPECULATIVE_STARTS:
      if re.test(text): return null                 // "noticed", "maybe" → null

    for re in QUESTION_STARTS:
      if re.test(text): return null                 // "why", "how" → null

    for re in MODAL_STARTS:
      if re.test(text): return 'todo'               // "gotta", "need to" → todo

    for re in DEADLINE_PATTERNS:
      if re.test(text): return 'todo'               // "by tomorrow" → todo

    if IMPERATIVE_VERBS has firstWord(text): return 'todo'
    return null                                     // ambiguous → defer to LLM
```

**Execution trace** (4 example lines):

```
  "call mom"
    not '?'. not speculative. not question. not modal. no deadline.
    firstWord="call" ∈ IMPERATIVE_VERBS → 'todo' ✓
  "is this still a problem?"
    endsWith '?' → null
  "noticed that the dashboard flickers"
    SPECULATIVE_STARTS /^noticed\b/ matches → null
  "should email the client by EOD"
    not '?'. not speculative. not question.
    MODAL_STARTS /^should\s+/ matches → 'todo' ✓
```

**Why this order:** speculative + question checks come *before* modal + imperative because some sentences look modal AND speculative (e.g., "should we maybe ship this?" — would match `^should\s+(we|i)\b` in QUESTION_STARTS first → null, correct). The order encodes priority of evidence.

**Complexity:** O(R) where R = total regex count (~100); roughly O(1) per line.

**The bigger pattern:** every "free first, paid second" pipeline in this codebase has the same shape — heuristic classify, then LLM. Same idea: `expandTodo` checks `meta.type == 'todo'` and refuses to expand (no shape to expand into); `getProvider` reads `SecureStore` (sync, fast) before the network call.

---

### Complexity cheat sheet

```
┌────────────────────────────────────────────┬──────────────┬─────────┬──────────────┐
│ Operation                                  │ Time         │ Space   │ At 10×?      │
├────────────────────────────────────────────┼──────────────┼─────────┼──────────────┤
│ scanTodosFromText (per entry)              │ O(n + m)     │ O(n+m)  │ ✓ fine       │
│ reconcileTodoMetaForEntry                  │ O(n + m)     │ O(n+m)  │ ✓ fine       │
│ rankTodos (across entries)                 │ O(n log n)   │ O(n)    │ ✓ fine       │
│ parseTags (single text)                    │ O(L)         │ O(L)    │ ✓ fine       │
│ reconcileMentions (per entry)              │ O(n × m)     │ O(n)    │ ✓ fine — small per-entry n,m │
│ getThreadCards (dashboard load)            │ O(T + M + Q) │ O(T+M+Q)│ ✓ fine       │
│ heuristicClassify (per todo)               │ O(R) ≈ O(1)  │ O(1)    │ ✓ fine       │
│ classifyTodo (LLM)                         │ O(1) calls   │ O(1)    │ ✓ network bound — async per todo │
│ expandTodo (LLM)                           │ O(1) calls   │ O(1)    │ ✓ capped at 3 in-flight  │
│ pushTable (per table)                      │ O(n/50) net  │ O(50)   │ ✓ fine — paginated         │
│ pullTable (per table)                      │ O(n/200) net │ O(200)  │ ✓ fine — paginated         │
│ chooseWinner (per row)                     │ O(1)         │ O(1)    │ ✓ fine       │
│ cellStateFor (per grid cell)               │ O(1)         │ O(1)    │ ✓ fine       │
│ DailyScheduleGrid render (7 × N habits)    │ O(7N)        │ O(N)    │ ✓ fine       │
│ summarize (LLM call + JSON parse)          │ O(1) call    │ O(P)    │ ✓ network    │
│ /todos sort (NULL position rows by createdAt DESC, others ASC) │ O(n log n) │ O(1) │ ✓ fine │
└────────────────────────────────────────────┴──────────────┴─────────┴──────────────┘
```

**No ✗ flags currently.** The codebase has been audited at the algorithm level — every hot path uses Map/Set lookups or pagination. The places that *look* O(n × m) (`reconcileMentions`) are bounded by per-entry small constants that don't scale with the full database.

The honest scaling concern in this codebase is not algorithm complexity but **per-todo LLM cost**. `expand` runs Claude Sonnet at ~$0.04 per call; a careless "expand all" UI would burn through the user's budget. Mitigation in code: `MAX_CONCURRENT = 3` cap in `expand.ts:25`, and the heuristic-first gate on classify so most lines never reach the LLM at all.
