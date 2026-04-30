# loopd — Feature Spec: Today, Habits Expansion, and Threads

Last updated: 2026-04-26 · revision 1

A continuity feature for loopd. Three pieces working together:

1. **Habits expansion** — recurrence rules (daily / weekly / M/W/F / etc.), full CRUD, cadence-aware streak tracking
2. **Threads** — `#tag` system for project attribution. Real `threads` table with autocomplete in journal and todos.
3. **Today view** — new bottom-nav tab combining habits-due-today + thread cards sorted by staleness + recent captures

This spec extends [`spec.md`](./spec.md) and the [thinking-modes spec](./loopd-thinking-modes-spec.md). It assumes familiarity with the existing habit tracker (Section 6.4 of spec.md), data model (Section 5), Notion sync (Section 6.8), and architectural principles (Section 10) of loopd.

---

## 1. Purpose & Origin

The user-stated friction: *"I want something where I can see what I've worked on previous days so I can focus on other tasks without leaving them stale."*

That isn't a scheduling problem. It's a **continuity problem**. The user works across multiple personal projects (loopd, contrl, dpth, buffr) and the failure mode is: a project goes a few days without attention and starts feeling stale, by which point the cost of context-switching back into it is higher than picking up something new. The result is project drift — capture stays high (drops, todos, ideas keep flowing into the journal), but follow-through fragments.

This feature is designed to solve that single friction. It doesn't try to be a calendar, a planner, or a time-blocked daily view. It's a **continuity dashboard** — a today-tab that surfaces what's been getting attention, what's going stale, and what anchor routines are due, so neglect becomes visible instead of invisible.

The three pieces serve distinct roles:

- **Habits** are *anchors* — recurring disciplines with a cadence (daily journal, M/W/F pull-ups, weekly vlog edit). Existing feature, expanded with proper cadence rules and CRUD.
- **Threads** are *attributions* — `#tag` mentions in entries and todos that group activity by project. New feature.
- **Today view** is a *consumption surface* — pulls from habits, threads, and recent captures into a single screen.

**What this spec is not:**
- Not a scheduler. No time slots, no drag-and-drop, no minute-precision planning.
- Not a project management tool. Threads are lightweight attributions, not full project objects.
- Not a calendar. No week or month grid view at v1.
- Not a re-architecture of the dashboard. The existing dashboard stays. Today is an additional tab.

**Scope at v1:** Habits CRUD + recurrence rules + cadence-aware streaks; threads table + `thread_mentions` junction + autocomplete + scanner; today view; full bidirectional Notion sync for habits and threads.

---

## 2. Data Model

### 2.1 Habits table — extended

The existing `habits` table (per [spec.md § 5](./spec.md#5-data-model)) gains cadence and metadata fields:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid (existing) |
| `name` | TEXT | (existing) — display name |
| `slug` | TEXT | **new** — lowercased, hyphenated, unique. Used internally and for any future tag overlap. |
| `icon` | TEXT | **new** — optional emoji or lucide icon name |
| `color` | TEXT | **new** — optional hex; defaults from a palette |
| `cadence_type` | TEXT | **new** — `'daily' \| 'weekdays' \| 'weekly' \| 'specific_days' \| 'n_per_week'` |
| `cadence_days` | TEXT | **new** — JSON array, semantics depend on `cadence_type` (see § 2.1.1) |
| `cadence_count` | INTEGER | **new** — used by `n_per_week` cadence (e.g. 3 means "3x per week") |
| `archived` | INTEGER | **new** — 0 or 1; archived habits don't appear on Today but their data persists |
| `notion_page_id` | TEXT | **new** — populated by Notion sync (§ 7) |
| `notion_last_synced` | TEXT | **new** |
| `created_at` | TEXT | (existing) |
| `updated_at` | TEXT | (existing) |

**CHECK constraints:**
```sql
CHECK (cadence_type IN ('daily','weekdays','weekly','specific_days','n_per_week'))
```

**Indexes:**
- `habits(archived)` — used by the today view filter
- `habits(slug)` — uniqueness lookup
- `habits(notion_page_id)`

#### 2.1.1 Cadence semantics

| `cadence_type` | What `cadence_days` holds | Example |
|---|---|---|
| `daily` | `null` | Journal — every day |
| `weekdays` | `null` | Standup — Mon–Fri only |
| `weekly` | `[N]` (single day, 0=Sun ... 6=Sat) | Vlog edit — Sundays → `[0]` |
| `specific_days` | `[N, N, ...]` (any subset) | Pull-ups — M/W/F → `[1, 3, 5]` |
| `n_per_week` | `null`; uses `cadence_count` | Cardio 3x/week → `cadence_count = 3` |

The cadence engine computes "is this habit due today?" from these fields. See § 4.3 for the algorithm.

### 2.2 New `threads` table

Mirrors the lightweight metadata pattern (similar to `habits`).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `name` | TEXT | display name (e.g. "loopd", "contrl") |
| `slug` | TEXT UNIQUE | lowercased, hyphenated. **Source of truth for tag matching** (see § 3.2). |
| `icon` | TEXT | optional emoji or lucide icon |
| `color` | TEXT | optional hex; defaults from a palette |
| `target_cadence_days` | INTEGER | nullable; if set, staleness measured against this target (e.g. 2 = "should be touched every 2 days") |
| `archived` | INTEGER | 0 or 1 |
| `pinned` | INTEGER | 0 or 1; pinned threads always sort first on Today regardless of staleness |
| `notion_page_id` | TEXT | nullable |
| `notion_last_synced` | TEXT | nullable |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |

**Indexes:**
- `threads(slug)` UNIQUE — primary lookup path for the scanner
- `threads(archived)` — today view filter
- `threads(notion_page_id)`

### 2.3 New `thread_mentions` junction

One row per `#tag` occurrence. Source-of-truth for "where is this thread mentioned?"

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `thread_id` | TEXT | FK → `threads.id` |
| `entry_id` | TEXT | nullable — set when mention is in journal prose |
| `entry_date` | TEXT | denormalized for query speed |
| `todo_id` | TEXT | nullable — set when mention is in a `[]` todo line |
| `source_line` | INTEGER | line index in entry text where the mention occurred |
| `tag_text` | TEXT | the literal text of the tag as typed (e.g. "loopd", "Loopd"); preserved for analytics |
| `created_at` | TEXT | ISO timestamp |

**Constraint:** `(entry_id IS NOT NULL) OR (todo_id IS NOT NULL)` — every mention must have a source.

**Indexes:**
- `thread_mentions(thread_id, created_at)` — used for staleness math and the "recent activity" thread card
- `thread_mentions(entry_id)` — used by the two-pass scanner reconcile
- `thread_mentions(todo_id)` — same for todo mentions
- `thread_mentions(entry_date)` — used for "entries this week" stat

A single entry tagging `#loopd` and `#contrl` produces two rows. A single entry tagging `#loopd` twice produces one row (de-duped at scan time within the same entry).

### 2.4 Updates to existing tables

`sync_deletions.entity_type` CHECK extended:
```sql
-- before: ('entry'|'todo'|'habit'|'nutrition'|'knowledge_drop')
-- after:  ('entry'|'todo'|'habit'|'nutrition'|'knowledge_drop'|'thread')
```

(`'habit'` already exists and continues to handle archived/deleted habits.)

### 2.5 TypeScript types

```typescript
// src/types/habit.ts (extended)
export type CadenceType = 'daily' | 'weekdays' | 'weekly'
                        | 'specific_days' | 'n_per_week';

export interface Habit {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  color?: string;
  cadenceType: CadenceType;
  cadenceDays: number[] | null;   // 0=Sun ... 6=Sat
  cadenceCount: number | null;    // for n_per_week
  archived: boolean;
  notionPageId?: string;
  notionLastSynced?: string;
  createdAt: string;
  updatedAt: string;
}

// src/types/thread.ts (new)
export interface Thread {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  color?: string;
  targetCadenceDays: number | null;
  archived: boolean;
  pinned: boolean;
  notionPageId?: string;
  notionLastSynced?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMention {
  id: string;
  threadId: string;
  entryId?: string;
  entryDate: string;
  todoId?: string;
  sourceLine: number;
  tagText: string;
  createdAt: string;
}

// Computed view shape for the Today page
export interface ThreadCard {
  thread: Thread;
  lastMentionAt: string | null;
  daysSinceLast: number | null;     // null if never mentioned
  staleness: 'fresh' | 'aging' | 'stale' | 'cold';
  entriesThisWeek: number;
  openTodos: number;
  recentTodos: Array<{ todoId: string; text: string; type: TodoType }>;  // top 3
}
```

---

## 3. The `#tag` System

### 3.1 The marker

`#` followed by a slug-like identifier. Adds a new entry to the marker table from [spec.md § 2](./spec.md#2-drops--the-inline-marker-idiom):

| Marker | Trigger | Destination | Extracted fields |
|---|---|---|---|
| `#tag` | inline anywhere in entry prose OR in a `[]` todo line | `thread_mentions` junction | `thread_id`, `tag_text`, source pointer |

**Match rules:**
- The pattern is `#[a-zA-Z][a-zA-Z0-9-]*` — must start with a letter, alphanumerics + hyphens after.
- Case-insensitive matching: `#Loopd`, `#loopd`, `#LOOPD` all resolve to the same thread (slug `loopd`).
- Tags are detected anywhere on a line, including inline mid-sentence: *"spent the morning on #loopd then went to lunch"* registers a `loopd` mention.
- Tags inside `[]` todo lines are detected too: `[] fix the auth bug #loopd` registers a `loopd` mention attributed to the todo.
- Tags inside code spans (backticks) or code blocks (triple-backticks) are **not** matched. Protects prose like `` `git #branch` ``.
- A tag the scanner doesn't recognize (no matching thread slug) is **not** registered as a mention. The text remains in prose; no error, no banner. The user creates the thread via the autocomplete (§ 5) and existing entries get re-scanned on next edit. (For a one-time backscan of historical mentions, see § 8.)

### 3.2 Slug resolution

The scanner lowercases the matched tag text and looks it up in `threads.slug`. Match → register mention. No match → ignore.

This means `#loopd` and `#Loopd` always hit the same thread — there is no path to two threads with the same slug. The CRUD page (§ 6.2) enforces slug uniqueness on create.

No aliases at v1. If you want `#loopd` and `#journal-app` to point to the same thread, you create one thread and the other isn't matched — there's no merging of slugs.

### 3.3 Two-pass matching for entry mentions

Same idiom as todos and nutrition (Architectural Principle 7):

1. **Pass 1 — exact reconcile:** for the current entry, find existing `thread_mentions` rows whose `(thread_id, source_line)` matches the parsed mentions. Keep them. Update `tag_text` if it changed (e.g. user changed `#Loopd` to `#loopd` — same thread, same line, just preserve the literal).
2. **Pass 2 — line-index fallback:** mentions whose source_line shifted (insert a line above) get matched by `(thread_id, tag_text)` proximity within ±3 lines.
3. **Unmatched existing rows** for this entry are deleted. **Unmatched parsed mentions** are inserted as new rows.

For todo mentions, the reconcile is simpler — the join key is `todo_id`, which is stable across edits. New mentions for a todo: insert. Removed mentions: delete.

### 3.4 The scanner — [`src/services/threads/scanThreads.ts`](../src/services/threads/scanThreads.ts)

Runs at commit time alongside the existing scanners (after `scanTodos`, after `scanNutrition`, before any Notion sync). Three responsibilities:

1. **Scan entry prose** for `#tag` mentions, reconcile against existing `thread_mentions` rows for that entry.
2. **Scan each todo's text** for `#tag` mentions (todo text often references projects), reconcile against existing rows for that todo.
3. **Update each affected thread's `updated_at`** so staleness recomputes on next render.

Order matters in [`useEntries.editEntry`](../src/hooks/useEntries.ts):
```
edit text → scanTodos (creates/updates todo rows + meta)
         → scanNutrition
         → scanThreads (now has access to todo IDs from this entry)
         → notion sync queue
```

Threads scanner runs *after* todos because it needs `todo_id` references for tags inside `[]` lines.

### 3.5 Performance

For a typical entry with 0–5 tags, the scanner is a single regex pass + a few table lookups. For an entry with 20 tags (unlikely but possible), still bounded. The work scales linearly with mention count — same as todos.

---

## 4. Habits Expansion

### 4.1 What changes

The existing `habits` table and toggle UX stay. What's added:

- Cadence rules per habit (§ 2.1.1)
- Cadence-aware streak tracking — non-due days don't break streaks
- Full CRUD (create, edit, archive)
- Today view derives "due today" from the cadence engine

### 4.2 Backfill

Existing habits get default values:
- `slug` = derived from `name` (lowercase, hyphenate spaces)
- `cadence_type` = `'daily'` (matches existing assumed behavior)
- `cadence_days` = null
- `cadence_count` = null
- `archived` = 0

SecureStore-gated: `habits_cadence_backfill_v1_done`. Migration runs once at boot.

The user can edit each migrated habit afterward to set its real cadence (e.g. change pull-ups from `daily` to `specific_days [1,3,5]`).

### 4.3 The cadence engine — [`src/services/habits/cadence.ts`](../src/services/habits/cadence.ts)

Pure function: `isDueOn(habit: Habit, date: Date): boolean`.

```typescript
function isDueOn(habit: Habit, date: Date): boolean {
  const day = date.getDay(); // 0=Sun ... 6=Sat
  switch (habit.cadenceType) {
    case 'daily':         return true;
    case 'weekdays':      return day >= 1 && day <= 5;
    case 'weekly':        return habit.cadenceDays?.[0] === day;
    case 'specific_days': return habit.cadenceDays?.includes(day) ?? false;
    case 'n_per_week':
      // Due any day this week if not yet completed cadenceCount times
      return needsMoreThisWeek(habit, date);
  }
}
```

`n_per_week` requires reading the habit's check-in history for the current week — slightly more expensive but bounded (max 7 reads per habit per render).

### 4.4 Streak math — extended

The existing streak logic (consecutive-days-completed) doesn't distinguish due-days from off-days, which means a M/W/F habit currently breaks streak on Tuesdays. The new logic:

- A streak counts **due days** only.
- A due day with no check-in **breaks** the streak.
- A non-due day **doesn't affect** the streak (neither extends nor breaks it).

The 28-day heatmap on the dashboard updates accordingly: due-day-completed = filled, due-day-missed = empty/red, non-due-day = neutral gray.

### 4.5 CRUD — [`app/more/habits.tsx`](../app/more/habits.tsx) (new path under the More tab)

Standard CRUD page:

- **List** — all non-archived habits, with their cadence summary ("M/W/F", "daily", "3x/week").
- **Create** — name, icon, color, cadence type + days/count.
- **Edit** — same form, prefilled.
- **Archive** — soft delete (sets `archived = 1`). Archived habits stop appearing on Today and stop affecting streak math going forward, but their historical check-ins are preserved.
- **Hard delete** — only available on archived habits, via a "delete forever" confirm. Cascades to delete check-in history.

### 4.6 Notion sync extension

The existing Notion habits DB gains four new properties:

| Notion property | Type | Maps to |
|---|---|---|
| Cadence Type | Select | `cadenceType` |
| Cadence Days | Multi-select | `cadenceDays` (rendered as "Mon", "Wed", ..) |
| Cadence Count | Number | `cadenceCount` |
| Archived | Checkbox | `archived` |

Existing Notion habit DBs without the new properties continue to work — sync defaults `cadence_type` to `'daily'` on pull, skips the new properties on push when missing. One-time toast on first sync after this feature ships.

Source-of-truth: same as todos (§ 11.2 of thinking-modes spec). `name` is local-canonical; cadence and archived are bidirectional.

---

## 5. Tag Autocomplete in the Editor

### 5.1 Where it triggers

The journal editor (and the todo quick-create modal — § 6.5 of thinking-modes spec) detect when the user types `#` followed by zero or more identifier characters. The trigger position becomes the anchor for the popover.

### 5.2 Popover behavior

- **`#` alone** — popover opens with **all non-archived threads, sorted by recency of mention** (`thread_mentions.created_at DESC`, distinct by thread_id, top 8 visible).
- **`#l`, `#lo`, `#loo`** — filter to threads whose slug starts with the typed substring, recency-sorted within the filter.
- **`#xy` (no matches)** — popover shows only the inline-create option (see § 5.3).
- **Space, return, or punctuation** ends the autocomplete and commits the tag as typed.
- **Tap outside / escape** dismisses the popover without committing.

The popover renders close to the cursor — above the line if there's room, below otherwise.

### 5.3 Inline create

Per the user-stated direction: lenient. The popover always shows a **"+ create #foo"** option at the bottom (where `foo` is whatever the user has typed after `#`).

Tapping it:
1. Inserts the tag text at cursor.
2. Creates a new thread with `name = "foo"`, `slug = "foo"`, default icon/color.
3. Closes the popover.
4. The next commit-time scan picks up the just-inserted `#foo` and creates a `thread_mentions` row.

Naming the thread inline doesn't open a modal — it uses the typed slug as both name and slug. The user can rename it later from the threads CRUD page (§ 6.2).

This is the *only* intentional difference from "act like nutrition" — nutrition is plain free-text, threads have an enforced uniqueness constraint and slug system. The inline create flow makes it feel as smooth as nutrition while keeping the data model clean.

### 5.4 Implementation notes

The autocomplete component lives at [`src/components/TagAutocomplete.tsx`](../src/components/TagAutocomplete.tsx) and is wired into:
- [`app/editor/[date].tsx`](../app/editor/[date].tsx) — the journal editor
- [`app/todos.tsx`](../app/todos.tsx) — the inline todo quick-create (when adding `[]` items from the todos page; see thinking-modes spec § 8.7 — though that was deferred)

For React Native, this is a positioned overlay tracking cursor coordinates. The journal editor already does similar overlay work for the keyboard toolbar; reuse that positioning logic.

---

## 6. The "More" Tab Restructure

### 6.1 Nav update

Five existing tabs become six:

| Tab | Route | Notes |
|-----|-------|-------|
| Home | `/` | unchanged |
| Record | (modal) | unchanged |
| Journal | `/journal/[date]` | unchanged |
| Today | `/today` | **new** (see § 7) |
| Todos | `/todos` | unchanged |
| More | `/more` | **new** — hub for Nutrition, Habits, Threads |

The previous Nutrition tab moves into More. This is the user-stated structure.

### 6.2 The More hub — [`app/more/index.tsx`](../app/more/index.tsx)

Simple list of links:

```
─────────────────────────────────────
more
─────────────────────────────────────
≡  nutrition         52 entries this week  →
≡  habits            5 active · 3 due today →
≡  threads           4 active · 1 stale     →
─────────────────────────────────────
↗  settings                                →
↗  notion sync                             →
─────────────────────────────────────
```

Each entry shows a one-line stat. Tap → navigate. Settings and Notion sync also live here (already do; just consolidate).

### 6.3 The Threads CRUD — [`app/more/threads.tsx`](../app/more/threads.tsx)

| Action | Behavior |
|---|---|
| List | All non-archived threads, sorted by `pinned DESC, last_mention_at DESC` |
| Create | name, slug (auto-derived from name, editable), icon, color, target_cadence_days (optional) |
| Edit | same form, prefilled. Editing slug warns if existing mentions reference the old slug — they auto-update on next scan. |
| Archive | soft delete. Archived threads disappear from Today and autocomplete but mentions stay in DB. |
| Pin | toggle `pinned`. Pinned threads always sort first on Today. |
| Hard delete | only on archived. Cascades to delete `thread_mentions`. |

Slug uniqueness is enforced — create attempts with an existing slug get a "slug already exists" inline error.

### 6.4 The Habits CRUD — [`app/more/habits.tsx`](../app/more/habits.tsx)

Per § 4.5.

---

## 7. The Today View — [`app/today.tsx`](../app/today.tsx)

The new tab. Three sections, top-to-bottom: anchors (habits), threads, recent captures.

### 7.1 Layout

```
─────────────────────────────────────
today
tuesday · apr 28 · 6 threads · 2 going stale
─────────────────────────────────────
ANCHORS
─────────────────────────────────────
[journal · written · 28d streak]   [pull-ups · due · M/W/F]
[cold shower · done · 12d streak]  [vlog clip · not yet · daily]
─────────────────────────────────────
THREADS                            manage →
─────────────────────────────────────
[loopd · fresh · 4 entries · 9 open · 3 expanded]
  ⊕ going with notion-only sync, dropping supabase plan
  ◊ vlog mode that auto-detects format from clip count
  ◊ build a thought tracker view next to nutrition
─────────────────────────────────────
[contrl · 2d ago · 2 entries · 5 open]
  ! rep counter misses last rep when set ends fast
  ◊ depth ratio calibration per user height
─────────────────────────────────────
[dpth · 5d ago · STALE · 4 open]
  ◊ curriculum parser handles nested codeblocks better
  going stale — pick one open item or archive the thread
─────────────────────────────────────
[buffr · 12d ago · COLD]
  cold — archive to clean up the view, or revive with a journal mention
─────────────────────────────────────
RECENT CAPTURES                    all todos →
─────────────────────────────────────
☐ build a thought tracker view ...      [idea]
☐ draft the sprint planning doc          [todo]
☐ is RNGH 2.30 compatible with rea...    [question]
─────────────────────────────────────
```

### 7.2 Anchors section

Renders all non-archived habits using the cadence engine to compute "due today" status.

| Habit state | Visual |
|---|---|
| Due today, not yet checked in | Default tile, "due today" subtitle |
| Due today, checked in | Green-tinted tile, "done" subtitle, streak count |
| Not due today | Faded tile, "next: Wed" subtitle |

Tapping a tile that's due-not-checked-in toggles the check-in (matches existing dashboard behavior for habit toggles). Tapping a tile in any other state opens the habit in the CRUD page.

Tile grid: 2 columns. If more than 6 habits, the section becomes scrollable horizontally with all habits in a single row (or stays 2-column with a "show all" link — designer's call at build time).

### 7.3 Threads section

Renders all non-archived threads as cards, sorted by:
1. `pinned` first
2. Then by staleness (fresh → aging → stale → cold)
3. Within same staleness, by `lastMentionAt DESC`

Each card shows:
- Thread name + colored dot
- Staleness label ("touched today", "2d ago", "5d ago — STALE", "12d ago — COLD")
- Activity stats: entries this week, open todos for this thread, expanded count
- Top 3 recent open todos for this thread (joined from `todo_meta` filtered by mentions)
- For stale/cold threads, an inline hint nudging an action (pick an item, archive, etc.)

Tap a card → opens the thread detail page (§ 7.4). Tap a todo within the card → opens the side-panel expansion modal (same as `/todos`).

### 7.4 Staleness computation — [`src/services/threads/staleness.ts`](../src/services/threads/staleness.ts)

Hybrid model per the user-stated direction.

```typescript
function computeStaleness(thread: Thread, lastMentionAt: string | null): Staleness {
  if (!lastMentionAt) return 'cold';
  const daysSince = differenceInDays(new Date(), new Date(lastMentionAt));
  const target = thread.targetCadenceDays;

  if (target) {
    // User-set cadence target — staleness measured against the target
    if (daysSince <= target) return 'fresh';
    if (daysSince <= target * 2) return 'aging';
    if (daysSince <= target * 4) return 'stale';
    return 'cold';
  } else {
    // Default activity-based
    if (daysSince <= 1) return 'fresh';
    if (daysSince <= 3) return 'aging';
    if (daysSince <= 7) return 'stale';
    return 'cold';
  }
}
```

The default thresholds (1/3/7 days) are tunable — first-pass guess based on personal-project rhythms. Worth revisiting after dogfooding.

### 7.5 Recent captures section

Reuses the existing `SmartTodoList` component (per thinking-modes spec § 9 — which flattens it to chronological top 5). Same data, same rendering.

---

## 8. Backfill

Three SecureStore-gated migrations, run once at boot in [`app/_layout.tsx`](../app/_layout.tsx):

1. **`habits_cadence_backfill_v1_done`** — § 4.2. Adds default cadence values to existing habits.
2. **`threads_table_init_v1_done`** — creates the `threads` and `thread_mentions` tables. No-op if user has no existing entries.
3. **`thread_mentions_backfill_v1_done`** — runs *only after* the user has created at least one thread (otherwise there's nothing to scan for). Walks all entries and todos, scans for `#slug` matches against the `threads.slug` table. Inserts mentions. Cheap — single pass, no LLM. The first thread create operation triggers this if the flag isn't set.

Backfills run in the background, non-blocking. Failed rows are skipped with logs.

---

## 9. Notion Sync

Bidirectional. New orchestrators for habits-extension and threads.

### 9.1 Habits — extends the existing `syncAllHabits()`

Per § 4.6. Mapper extension in [`src/services/notion/habitsMapper.ts`](../src/services/notion/habitsMapper.ts) handles the new properties with safe defaults for missing fields.

### 9.2 Threads — new `syncAllThreads()`

New optional Notion DB: **Threads**.

| Notion property | Type | Maps to |
|---|---|---|
| Name | Title | `name` |
| Slug | Rich text | `slug` |
| Icon | Rich text | `icon` |
| Color | Rich text | `color` |
| Target Cadence (days) | Number | `targetCadenceDays` |
| Archived | Checkbox | `archived` |
| Pinned | Checkbox | `pinned` |

Source-of-truth rules:

| Field | Source | Pull behavior |
|---|---|---|
| `name` | Bidirectional | Standard merge |
| `slug` | Local | Slug edits in Notion are **rejected** (slug changes can break existing mentions; force user to do this from the loopd CRUD which handles re-scanning). Log a warning. |
| `icon`, `color`, `target_cadence_days`, `archived`, `pinned` | Bidirectional | Standard merge |
| `created_at` | Local | Never overwritten |

Mentions (`thread_mentions`) are **not synced** to Notion. They're a derived index over entries and todos; the entries and todos already sync. If you wanted to query "what was tagged loopd" in Notion, you'd filter the Entries and Todos DBs by text containing `#loopd`. Not perfect, but avoids syncing 100s of junction rows.

### 9.3 New row from Notion (created in Notion, no local match)

Standard idiom (matches todos § 11.3 of thinking-modes spec). On pull, if a Notion thread page has no matching local row, create a new local thread. Slug taken from the Notion Slug field; if empty, derive from name. If the derived slug collides with an existing local thread, append `-1`, `-2`, etc.

### 9.4 Autosync wiring

[`app/_layout.tsx`](../app/_layout.tsx) sequence:
```
syncAll()           — entries
syncAllTodos()      — todos + todo_meta
syncAllHabits()     — habits (now with cadence)
syncAllThreads()    — threads (new)
syncAllKnowledgeDrops()  — if drops feature is on
```

Order matters: threads after habits (no dependency), but threads before any feature that references threads.

### 9.5 Manual sync triggers

[`app/settings/notion-sync.tsx`](../app/settings/notion-sync.tsx) gains:
- "Sync threads now" button
- "Reset threads sync timestamp" button
- Threads DB ID input (fourth or fifth, depending on whether knowledge drops shipped)

### 9.6 Notion guide update

[`app/settings/notion-guide.tsx`](../app/settings/notion-guide.tsx) gains a Threads section covering the new DB schema, the Slug-is-local-only rule, and a note that mentions don't sync.

---

## 10. Service Layer — extends [spec.md § 7](./spec.md#7-service-layer--srcservices)

| Path | Purpose |
|---|---|
| `habits/cadence.ts` | Cadence engine: `isDueOn(habit, date) → boolean` |
| `habits/streaks.ts` | Cadence-aware streak computation, replaces existing |
| `habits/migrate.ts` | One-time backfill of cadence defaults on existing habits |
| `threads/scanThreads.ts` | `#tag` parser; two-pass reconcile against `thread_mentions` |
| `threads/crud.ts` | Thread CRUD (create / edit / archive / pin / hard-delete) |
| `threads/staleness.ts` | Pure staleness computation per § 7.4 |
| `threads/migrate.ts` | One-time backfill: scan all entries + todos for `#slug` matches |
| `threads/getThreadCards.ts` | Aggregates thread + recent mentions + open todos for the today view |
| `today/getAnchors.ts` | Habits-due-today computation for the today view |
| `today/getRecentCaptures.ts` | Top 5 recent todos (reuses `getRecentTodos` from thinking-modes spec) |
| `notion/threadsMapper.ts` | Bidirectional property mapping for the threads DB |
| `notion/sync.ts` (extended) | New `syncAllThreads()` orchestrator |
| `components/TagAutocomplete.tsx` | The autocomplete popover used in editor and todo quick-create |

**Updates to existing files:**

- `database.ts` — schema changes for `habits` (cadence fields), new `threads` table, new `thread_mentions` table, sync_deletions CHECK extension.
- `services/habits/crud.ts` — extended for cadence fields, archive flag.
- `services/habits/scan.ts` (or wherever check-ins are written) — no logic change but consumes cadence engine.
- `useEntries.editEntry` — adds `scanThreads` call after `scanTodos` and `scanNutrition`.
- `app/_layout.tsx` — three new backfill checks; new `syncAllThreads()` in autosync chain.
- `app/index.tsx` — existing dashboard untouched (per user direction, today is *additive*).
- `app/(tabs)/_layout.tsx` (or wherever GlobalBottomNav is configured) — six tabs, with the previous Nutrition tab moved to More.
- `app/editor/[date].tsx` — wire in `TagAutocomplete`.

---

## 11. Architectural Principles — adherence checklist

| Principle | How this feature honors it |
|---|---|
| 1. DB is single source of truth | Today reads habits, thread_mentions, and todo_meta directly. No derived in-memory state. |
| 2. Prose is canonical | `#tag` mentions are derived from prose. Removing a tag from prose deletes the mention row. Same idiom as todos and nutrition. |
| 3. Save on keystroke; scanners on commit | Tag autocomplete writes to entry text (which saves on keystroke). The threads scanner runs at commit. The autocomplete's "create new thread" action is the *one* exception — it writes to `threads` table immediately, but only when the user explicitly taps the "+ create" option. |
| 4. Read DB before deleting | Thread archive / hard-delete re-fetches before mutating. Cascade rules explicit. |
| 5. Live refs in focus cleanup | N/A. |
| 6. Don't auto-delete during sync | Threads queue via `sync_deletions` like everything else. |
| 7. Two-pass matching | § 3.3 — exact reconcile, then line-index fallback. |
| 8. Backfills SecureStore-gated | § 8 — three flags. |
| 9. Classifier output editable, override permanent | N/A for this feature. (Threads have no classifier.) |
| 10. Heuristic before LLM | N/A — no LLM in this feature. |

A new principle this feature suggests:

> **11. Mentions are derived; metadata is stored.** When a feature creates a relationship between two objects (here: threads ↔ entries via tags), the relationship rows are *derived* from a canonical source (prose) and rebuilt at scan time. The metadata about the relationship subject (here: thread name, color, archived) is stored in its own table and survives between scans. Don't store derived data; don't derive metadata.

---

## 12. Implementation Order

| Step | What | Est. |
|------|------|------|
| 1 | Migration: extend `habits` table with cadence fields | 1h |
| 2 | Migration: new `threads` and `thread_mentions` tables + sync_deletions CHECK | 1–2h |
| 3 | Types: `habit.ts` extension, `thread.ts` new | 1h |
| 4 | Cadence engine: `cadence.ts` + tests covering all 5 cadence types | 2–3h |
| 5 | Streak math: `streaks.ts` extension for cadence-awareness | 2h |
| 6 | Habits backfill: migrate existing habits with default `daily` cadence | 1h |
| 7 | Habits CRUD page under `/more/habits` | 3–4h |
| 8 | Threads scanner: `scanThreads.ts` with two-pass + todo + entry mention paths | 3–4h |
| 9 | Threads CRUD page under `/more/threads` | 3–4h |
| 10 | Tag autocomplete component (popover, recency sort, filter, inline create) | 4–5h |
| 11 | Wire autocomplete into journal editor | 2h |
| 12 | Wire autocomplete into todo quick-create (if present) | 1h |
| 13 | Hook `scanThreads` into `useEntries.editEntry` | 0.5h |
| 14 | Threads backfill: scan all existing entries + todos for matches | 2h |
| 15 | Staleness engine: `staleness.ts` + tests | 1–2h |
| 16 | Today page: layout, anchors section, threads section, recent captures | 4–5h |
| 17 | More hub page + restructure nav (six tabs, Nutrition moves to More) | 2–3h |
| 18 | Notion habits mapper extension (cadence properties) | 2h |
| 19 | Notion threads mapper + new `syncAllThreads()` orchestrator | 3–4h |
| 20 | Notion settings page: threads DB ID input, sync now, reset timestamp | 1–2h |
| 21 | Notion guide: threads section + habit cadence guidance | 1–2h |
| 22 | Test pass: cadence accuracy, streak edge cases (e.g. M/W/F with one missed Wed), tag autocomplete UX, two-pass reconcile on edited tag, Notion bidirectional with Slug-rejected-on-pull | 4–5h |

**Total: ~44–58h.**

Suggested cuts for a faster v1:
- Defer threads Notion sync (~8–11h saved). Threads stay local-only at v1.
- Defer pinning + target cadence on threads (~3h saved). Default activity-based staleness only.
- Defer the threads backfill (~2h). Mentions only get scanned for new entries going forward.

Even with all three cuts, ~30h is the floor — this is a sizable feature with three new pieces.

---

## 13. What This Spec Does NOT Cover

- **Time-blocked planning** — no time slots, no minute-precision schedules. Out of scope.
- **Drag-and-drop** of todos onto times. Out of scope.
- **Calendar view** — no week or month grid. Out of scope.
- **Project-level objects beyond threads** — no roadmaps, no milestones, no deadlines per thread. v2 candidate.
- **Tag aliases** — `#loopd` and `#journal-app` cannot point to the same thread without a manual merge. v2 candidate.
- **Tag co-occurrence analytics** — "show me all entries tagging both #loopd and #idea". v2 candidate.
- **Collaborative threads** — single-user only.
- **Habit reminders / push notifications** — out of scope.
- **Habit data on dashboards beyond Today and the existing 28-day heatmap** — v2.
- **Thread-level Notion sync of mentions** (§ 9.2). Mentions are derived, entries/todos already sync.
- **Auto-archive stale threads** — user-initiated only.

---

## 14. Open Questions

- **Default staleness thresholds** (1/3/7 days for fresh/aging/stale, cold beyond 7) — first-pass guess. Worth revisiting after a week of dogfooding.
- **Habit tile grid layout** — 2-column with overflow scroll, or single horizontal scrollrow, or other? § 7.2 leaves this for build time.
- **Slug edit re-scanning behavior** — when user renames thread `loopd` → `loopd-app`, the existing mentions reference the old slug in `tag_text`. Two options: (a) bulk-update `tag_text` and force re-scan of all entries containing the old text, or (b) leave the mentions and let the next normal scan reconcile. Default: (b), simpler. Confirm.
- **n_per_week cadence semantics for streaks** — if a habit is "3x per week" and you do it Mon/Wed/Fri, streak = 3? Or streak = 1 (one full week completed)? Default: streak counts completed-weeks where target was hit.
- **Tag visibility in rendered prose** — does `#loopd` render as a clickable inline pill in the read-only journal view, or stays plain text? v1 assumes plain text in editor, plain text in read view. v1.1 candidate: render as a clickable pill in the read view.
