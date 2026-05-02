# loopd — Product & Technical Spec

Last updated: 2026-05-02

A solo-dev, native Android daily-vlogging app. Combines a journal (text + habits + clips) with an AI-assisted vlog editor, a "drops" pattern that extracts typed records (todos, nutrition, thread mentions) from inline prefix markers in prose, an LLM-assisted "thinking modes" layer that classifies todos and produces structured per-type expansions, a `#tag` thread system for project attribution, a daily-schedule tracker that combines habits + threads bucketed by time-of-day on the dashboard, and on-device SQLite as the source of truth with optional bidirectional Notion sync.

Operational setup, build, and deploy instructions live in [`README.md`](../README.md). This doc is the "what the app does and how it's put together" reference for new contributors and future-me.

---

## 1. Purpose & Shape

loopd turns everyday captures (short clips, text jots, habit checkmarks, marked-up todos, nutrition lines, project tags) into a per-day archive with a one-tap vlog render. Core loop:

1. Throughout the day: open the journal for today's date, jot text, check off habits, capture/import clips, and tag actionable lines with simple inline markers (`[] task`, `** food 320 kcal`, `#projectname`).
2. At commit time the prose is scanned by three independent passes: marked lines flow into typed records (todos in `todos_json` + `todo_meta`, nutrition in its own table, mentions in `thread_mentions`) without leaving the prose itself.
3. Todos get a thinking-mode classification (heuristic-first, LLM fallback). Non-todo modes (idea / bug / question / decision / knowledge / content) gain a tap-to-expand affordance that produces structured AI output via per-type prompts.
4. End of day: tap into the editor — AI auto-composes clip order, trims, and text overlays from the day's entries.
5. Tweak in the editor (timeline / text / filter tabs), export to MP4 (saved to `DCIM/loopd/` and sharable).
6. Optional: Notion syncs entries + todos always; habits cadence and threads bidirectionally when their respective DB IDs are configured.

Native-only (React Native / Expo), runs on a development build — not Expo Go, not web. **Android only** — the prebuilt `android/` directory is committed; iOS is not currently supported.

---

## 2. Drops — the inline-marker idiom

A core architectural pattern. **Drops are inline prefix markers in journal prose that the app scans on entry commit and extracts as typed records.** The prose stays the canonical source — drops are derived state, kept in sync via two-pass scanners.

| Marker | Trigger | Destination | Extracted fields |
|---|---|---|---|
| `[]` / `[ ]` / `[x]` | line start (optional `- ` bullet, optional whitespace) | `entries.todos_json` + paired `todo_meta` row | `text`, `done`, plus thinking-mode metadata (see §6.4) |
| `** <food> <N> kcal` | line start OR inline (preceded by whitespace) | `nutrition` table | `name`, `kcal` |
| `#tag` | inline anywhere in entry prose OR inside a `[]` todo line; case-insensitive; ignored inside backticks/code blocks | `thread_mentions` junction (one row per occurrence, deduped per-line per-slug) | `thread_id`, `tag_text` (literal-as-typed), source pointer (`entry_id` and/or `todo_id`), `source_line` |

All three scanners use **two-pass matching** to preserve record identity across text edits:

1. **Pass 1 — exact match.** Text for todos; `(name, kcal)` tuple for nutrition; `(thread_id, source_line)` for thread mentions. Catches unchanged lines and reorderings.
2. **Pass 2 — line-index fallback** via a `sourceLine` field. Handles in-place edits — changing `[] call mom` to `[] call dad` keeps the same row, preserves `id` / `done` / `createdAt`. For threads, fallback also matches `(thread_id, tag_text)` within ±3 lines.

Dashboard interactions **round-trip** into the source prose: toggling a todo's `done` state in `SmartTodoList` rewrites the matching `[]`/`[x]` line in the entry's text so the journal always reflects current state.

For `#tag` specifically: unknown slugs **auto-create a thread on save** at `resolveTagsToThreadIds` in [scanThreads.ts](../src/services/threads/scanThreads.ts). Trades typo-safety for ergonomics; the inline `+ create` chip in the autocomplete remains the immediate-feedback path.

Each drop type has a **one-time backfill migration** (SecureStore-gated) that runs on first launch after the feature ships, picking up markers that pre-date the scanner. The threads backfill additionally short-circuits when zero threads exist locally (re-checks on next boot until the user creates the first thread).

---

## 3. Navigation

**Global bottom nav** ([src/components/nav/GlobalBottomNav.tsx](../src/components/nav/GlobalBottomNav.tsx)) — five tabs, hidden on `/editor/*` and `/settings/*`:

| Tab | Route | Icon |
|-----|-------|------|
| Home | `/` | `house` |
| Record | (modal capture) | red dot |
| Journal | `/journal/[date]` (today) | `penLine` |
| Todos | `/todos` | `listTodo` |
| More | `/more` | `settings` |

Nutrition / Habits / Threads CRUD live under `/more/{nutrition,habits,threads}`. The dashboard's `DAILY SCHEDULE` section (§4) and the per-thread detail page at `/threads/[id]` provide in-context entry points so the More tab is a management hub, not the daily-use surface.

---

## 4. Screens

### `app/_layout.tsx` — root
Runs on app boot:
- Initializes SQLite (`useDatabase`), loads fonts, wraps in error boundary + `NotionSyncProvider` + gesture root.
- Checks `expo-updates` for OTA updates; prompts user to restart if one is fetched.
- If Notion configured and auto-sync enabled: runs `syncAll → syncAllTodos → syncAllHabits → syncAllThreads` (later stages no-op when their respective DB IDs aren't set).
- If AI configured: auto-summarizes yesterday's entries.
- Migrates any pre-transcode clips to 1080p proxies in the background.
- **Backfill migrations**, all SecureStore-gated:
  - `drops_backfill_v1_done` — `[]` markers in pre-existing entries
  - `nutrition_backfill_v1_done` — `** food N kcal` markers
  - `todo_meta_backfill_v1_done` — paired `todo_meta` rows for every existing todo (heuristic-only; no LLM in backfill)
  - `habits_cadence_backfill_v1_done` — derives `slug` from `label` for pre-cadence habits; `cadence_type` defaults to `'daily'` via the column-default
  - `thread_mentions_backfill_v1_done` — lazy backfill that scans every entry + todo for `#tag` matches against the threads table; only runs after the user has at least one thread
- **Classifier catch-up**: boot-time pass that walks every meta row whose `classifier_confidence IS NULL`, skips done-or-overridden rows, and runs the cheap LLM classifier. Self-quiet when no AI is configured.

### `app/index.tsx` — Home / Dashboard
- Greeting (time-of-day) + today's date.
- "Today's Vlog" card — same shape as past-vlog cards; or a "Start Today's Vlog" CTA if empty.
- `total kcal` stat under the vlog card — regex `/(\d+(?:[.,]\d+)?)\s*kcal\b/gi` sums every kcal mention across today's entry text. Catches both bare `N kcal` and `** food N kcal` lines.
- **DAILY SCHEDULE** section — combined HABITS + THREADS tracker. Both rendered as habit-row-style strips (80px name + flex 14-cell strip + right-side count or nav arrow). Bucketed by `time_of_day` (morning → midday → evening → anytime); adaptive mini-headers appear once 2+ buckets are populated by either type. Within a bucket: habits first, then threads. `manage →` link routes to `/more`.
  - Habit rows: tap toggles today's check-in (round-trips into a today entry's `habits_json`); cells render four states (completed / missed / today-pending / neutral); right-side number is the cadence-aware streak.
  - Thread rows: tap toggles a "touched today" mention via `toggleThreadTouchToday` (writes a `thread_mentions` row with NULL `entry_id` AND NULL `todo_id`); the strip is **driven only by manual touches** (not by `#tag` mentions in prose); right-side `→` arrow routes to `/threads/[id]`.
- `SmartTodoList` — last 5 ranked todos via [rankTodos](../src/services/todos/rank.ts) (carryover-from-yesterday → AI → journal priority). Each row gets the type badge (when non-todo) so the dashboard answers "what should I attend to?" with category context. Toggle/edit round-trips into source prose.
- Previous Vlogs — archive section.

### `app/journal/[date].tsx` — daily journal
Dynamic route keyed by `YYYY-MM-DD`. Inline entries with text + habits + clips. Key behaviors:

- **DB-first autosave** on every keystroke (`liveTextRef`, `handleSilentNewText`) — see [CLAUDE.md § Autosave Rules](../CLAUDE.md). Silent saves bypass scanners (no churn mid-word).
- **Commit-time scanners** run from [useEntries.editEntry](../src/hooks/useEntries.ts) when text changes:
  - `scanTodosFromText` merges `[]` matches into `todos_json`.
  - `reconcileTodoMetaForEntry` (fire-and-forget) inserts paired `todo_meta` rows for new todos, runs heuristic, fires LLM classifier if heuristic returned null and the todo isn't done.
  - `scanNutritionForEntry` (fire-and-forget) reconciles `** … kcal` lines against the `nutrition` table.
  - `scanThreadsForEntry` (fire-and-forget; runs **after** scanTodos because it needs final todo IDs for `[]`-line tag attribution) reconciles `#tag` mentions in entry prose AND inside each todo's text against `thread_mentions`. Unknown slugs auto-create a thread.
- **Keyboard toolbar** quick actions: Todo (inserts `[] ` at cursor), Clip (pick/record video), Habit.
- **Nutrition autocomplete** — when the cursor sits after a `** ` marker on the active line, [NutritionAutocomplete](../src/components/journal/NutritionAutocomplete.tsx) renders a horizontal chip bar above the keyboard toolbar.
- **Tag autocomplete** — when the cursor sits immediately after a `#xyz` partial token, [TagAutocomplete](../src/components/journal/TagAutocomplete.tsx) renders a sibling chip bar (same Z order as nutrition autocomplete). Recency-sorted existing threads + a `+ create #xyz` affordance for unknown slugs. Reused on `/todos` for both new-todo and edit-todo inputs.
- Clip import → parallel 1080p H.264 proxy transcode (in-order commit).
- "Vlog" button appears once any clips exist → routes to `/editor/[date]`.

### `app/editor/[date].tsx` — vlog editor
Three tabs under a resizable preview (`windowHeight * 0.45` default, draggable 100–1000):
- **TIMELINE** (default on load): clip strip with playhead + per-clip trim/split/reorder/delete controls.
- **TEXT**: selects an overlay → `TextOverlaySheet`. Header button: **REGENERATE WITH AI**.
- **FILTER**: single active filter (brightness / contrast / saturate preset).

Auto-compose on mount; export pipeline renders text overlays to a Skia canvas → FFmpeg transcode → writes to `exports/[date]/…mp4` and `DCIM/loopd/` → offers `Sharing.shareAsync`.

### `app/todos.tsx` — global todos (flat chronological)
All todos across all entries, joined with their `todo_meta` row. Layout:

- Header: title + subtitle (`"N total · newest first"` or `"M of N shown"`).
- **Status filter** (`Status:` label + horizontal scroll of single-select chips):
  - **ALL** — no status filter
  - **OPEN** (default) — not done AND `stage='todo'`
  - **IN PROGRESS** — not done AND `stage='in_progress'`
  - **DONE** — done (any stage)
  - **BACKLOG** — not done AND `stage='backlog'`
- **Drops filter** (`Drops:` label + horizontal scroll): ALL + one chip per `TodoType` with counts.
- **Threads filter** (`Threads:` label + horizontal scroll, only renders when at least one thread exists): ALL + one chip per thread with `#slug` and a count of todos tagged. AND-combines with the other filters.
- **Flat list, newest first** by `createdAt` DESC. Done items strikethrough in chronological place.
- Per-row affordances (in `metaRow`):
  - `TypeBadge` — colored pill with type icon + label. **No badge for plain `'todo'` rows** — the absence is the signal. Confidence "?" appears on medium/low rows. Tap → `TypeChangePicker`.
  - `StageBadge` — always visible; shows "Open" / "In Progress" / "Backlog". Tap → `StageChangePicker`.
  - `[expand]` (accent) on non-todo rows without an expansion → routes to `/todos/[id]`.
  - `● expanded` (green) on non-todo rows that already have one → same route, view-mode.
  - Relative time + linkable source date.
- Long-press the text → opens `TypeChangePicker` (alternate path).
- TagAutocomplete fires when typing `#` in either the new-todo or edit-todo input.
- **Classifier toast** — absolutely-positioned, debounced; shows `classifying N todos…` while the LLM is in flight. Doesn't shift list layout.
- **AI-not-configured banner** — persistent inline prompt when ambiguous rows exist and no AI key is set. Tap → `/settings/ai`.

### `app/todos/[id].tsx` — full-page expansion view
Full-screen route for the structured AI output. Header (back chevron + type label), scrollable body (original-todo quote + rendered markdown), sticky footer (above the bottom nav, doesn't fight Android's gesture bar):
- **`change type`** → opens the `TypeChangePicker` sheet
- **`re-expand`** (when an expansion already exists) → Alert confirm → overwrites `expanded_md`/`expanded_at`/`model`

Auto-triggers expansion on mount when the row has no `expanded_md` and a non-todo type. Subscribes to `EXPAND_PROGRESS_EVENT` so cross-screen completions surface here too.

### `app/threads/[id].tsx` — thread detail
Per-thread aggregate view. Header shows name + colored dot + pin star + staleness label + stats line. Three sections:
- **OPEN** — open todos tagged with this thread, newest first. Tap row → `/todos`. Tap checkbox → toggle done (calls `updateTodo`, reloads).
- **DONE** — recent 5 completed todos (with `(recent N of total)` counter when truncated).
- **ENTRIES** — every prose mention with line excerpt (~140 chars), sorted newest first. Tap → opens that day's journal.

Reachable by tapping a thread row's `→` arrow on the dashboard tracker, or via "view" affordances elsewhere.

### `app/more/index.tsx` — More hub
List of links with one-line stats: nutrition (entries this week), habits (active count + due-today count), threads (active count + going-stale count). Settings + Notion Sync are reachable from the global header (sync icon + gear icon at top of every screen via `HomeHeader`).

### `app/more/nutrition.tsx` — nutrition log
Flat list of every nutrition row from the local table, newest first. Each row shows food name, source date, and kcal. Tap to jump to the source journal day.

### `app/more/habits.tsx` — habits CRUD
List habits with a sheet-style editor for create/edit. Editor exposes:
- Name
- Time of day chip picker (morning / midday / evening / anytime)
- Cadence type selector (daily / weekdays / weekly / specific_days / n_per_week)
- Day-of-week picker (for `weekly` and `specific_days`)
- Count picker 1–7 (for `n_per_week`)

Trash icon per row hard-deletes (with confirm); past entries' `habits_json` references are preserved (just dangle).

The editor sheet uses `useSafeAreaInsets()` and pads its overlay by `GLOBAL_NAV_HEIGHT + insets.bottom` so the form clears the persistent bottom nav and Android system gesture bar.

### `app/more/threads.tsx` — threads CRUD
List of all threads (active + archived tabs). Editor sheet exposes name, slug (auto-derived from name unless user has manually edited; lowercased, alphanumerics + hyphens), time-of-day, target cadence (days). Pin / archive / hard-delete actions per row. Same safe-area lift as the habits editor.

### `app/settings/`
- [`index.tsx`](../app/settings/index.tsx) — menu.
- [`ai.tsx`](../app/settings/ai.tsx) — provider toggle (Claude Sonnet 4.6 or GPT-4o), API-key input, Test Connection.
- [`notion-sync.tsx`](../app/settings/notion-sync.tsx) — manual full-sync, Entries / Todos / Habits / Threads DB ID inputs, auto-sync toggle, reset-sync-timestamp. Per-DB "Sync now" buttons appear conditionally for Habits + Threads (separate from the main Sync Now).
- [`notion-guide.tsx`](../app/settings/notion-guide.tsx) — nine-step setup guide. Covers Entries DB, Todos DB (optional), Nutrition DB (optional), Habits DB (optional), Threads DB (optional), share-with-integration, copy DB IDs, connect, sync.
- [`updates.tsx`](../app/settings/updates.tsx) — manual OTA check.

---

## 5. Data Model

### SQLite (expo-sqlite) — [src/services/database.ts](../src/services/database.ts)

Eleven tables in `loopd.db`.

| Table | PK | Columns (notable) | Purpose |
|---|---|---|---|
| `habits` | `id` | `label`, `sort_order`, `slug`, `icon`, `color`, `cadence_type`, `cadence_days` (JSON), `cadence_count`, `archived` (column kept for back-compat; UI no longer surfaces it for habits), `time_of_day`, `notion_page_id`, `notion_last_synced`, `updated_at` | User's repeatable disciplines + cadence + time-of-day bucket. The Entries-DB Habits multi-select still governs identity for sync (the optional Habits DB carries cadence metadata) |
| `entries` | `id` | `date`, `text`, `habits_json`, `clips_json`, `todos_json`, `clip_uri`/`clip_duration_ms` (legacy single-clip), `created_at`, `notion_page_id`, `updated_at` | Daily entries; prose is canonical |
| `projects` | `id` | `date` UNIQUE, `status` ('draft'\|'exported'), `clips_json`, `removed_clip_source_keys_json`, `text_overlays_json`, `filter_overlays_json`, `export_uri`, `updated_at` | Editor state per day |
| `vlogs` | `id` | `date`, `clip_count`, `habit_count`, `caption`, `duration_seconds`, `export_uri`, `created_at` | Archive of exported vlogs |
| `day_meta` | `date` | `title`, `updated_at` | Per-day user-rename title |
| `sync_deletions` | `id` autoinc | `entity_type` (`'entry'`\|`'todo'`\|`'habit'`\|`'nutrition'`\|`'thread'`), `entity_id`, `notion_page_id`, `deleted_at` | Queue of deletions to archive in Notion on next sync |
| `ai_summaries` | `date` | `summary_json`, `generated_at`, `model` | Cached AI composition per date |
| `nutrition` | `id` | `name`, `kcal`, `entry_id`, `entry_date`, `source_line`, `notion_page_id`, `created_at`, `updated_at` | Per-line nutrition records, derived from `** food N kcal` prose |
| `todo_meta` | `todo_id` | `entry_id`, `entry_date`, `type`, `stage`, `expanded_md`, `expanded_at`, `model`, `classifier_confidence`, `classifier_model`, `user_overridden_type`, `position`, `created_at`, `updated_at` | 1:1 with each `TodoItem` in `todos_json`. CHECK enforces enums on `type` (7 values), `stage` (3 values), `classifier_confidence` (4 values + null) |
| `threads` | `id` | `name`, `slug` UNIQUE, `icon`, `color`, `target_cadence_days`, `archived`, `pinned`, `time_of_day`, `notion_page_id`, `notion_last_synced`, `created_at`, `updated_at` | Project metadata. `slug` is the matching key for `#tag` mentions; UNIQUE enforces case-insensitive uniqueness |
| `thread_mentions` | `id` | `thread_id`, `entry_id` (nullable), `entry_date`, `todo_id` (nullable), `source_line`, `tag_text`, `created_at` | Junction. App-level invariant: at least one of `entry_id` / `todo_id` is set, EXCEPT for the manual-touch deviation (both NULL when written by `toggleThreadTouchToday`). DB has no CHECK so the deviation is permitted |

Indexes: `entries(date)`, `entries(notion_page_id)`, `entries(updated_at)`, `projects(date)`, `habits(notion_page_id)`, `habits(archived)`, `habits(slug)`, `nutrition(entry_id)`, `nutrition(entry_date)`, `nutrition(name COLLATE NOCASE)`, `nutrition(notion_page_id)`, `todo_meta(entry_id)`, `todo_meta(entry_date)`, `todo_meta(type)`, `todo_meta(updated_at)`, `todo_meta(created_at)`, `threads(slug)` UNIQUE, `threads(archived)`, `threads(notion_page_id)`, `thread_mentions(thread_id, created_at)`, `thread_mentions(entry_id)`, `thread_mentions(todo_id)`, `thread_mentions(entry_date)`.

### Key TypeScript types — [src/types/](../src/types/)

- **`Entry`** ([entry.ts](../src/types/entry.ts)) — `{ id, date, text, habits[], todos[], clipUri?, clipDurationMs?, clips[], createdAt, notionPageId?, updatedAt? }`
- **`TodoItem`** — `{ id, text, done, completedAt?, createdAt?, sourceLine?, notionPageId? }`. `notionPageId` is the canonical Notion-row reference; no duplicate field on `TodoMeta`.
- **`Habit`** — `{ id, label, sortOrder, slug?, icon?, color?, cadenceType?, cadenceDays?, cadenceCount?, timeOfDay?, notionPageId?, notionLastSynced?, updatedAt? }`. New cadence/metadata fields are optional on the type so existing call sites that construct minimal Habit objects (e.g. the Notion-options identity-sync path) keep compiling; the DB layer fills sensible defaults.
- **`CadenceType`** — `'daily' | 'weekdays' | 'weekly' | 'specific_days' | 'n_per_week'`.
- **`TimeOfDay`** — `'morning' | 'midday' | 'evening' | 'anytime'`. Sort order on the dashboard tracker: morning → midday → evening → anytime.
- **`Vlog`** — `{ id, date, clipCount, habitCount, caption?, durationSeconds, exportUri?, createdAt }`.
- **`NutritionEntry`** ([nutrition.ts](../src/types/nutrition.ts)) — `{ id, name, kcal, entryId, entryDate, sourceLine?, notionPageId?, createdAt, updatedAt? }`.
- **`NutritionSuggestion`** — autocomplete row shape.
- **`ClipItem`** ([project.ts](../src/types/project.ts)) — `{ id, entryId, clipUri, caption?, durationMs, trimStartPct, trimEndPct, order, color }`.
- **`TextOverlay`** / **`FilterOverlay`** / **`EditorProject`** — editor types.
- **`AISummary`** ([ai.ts](../src/types/ai.ts)).
- **`TodoType`** ([todoMeta.ts](../src/types/todoMeta.ts)) — `'todo' | 'idea' | 'bug' | 'question' | 'decision' | 'knowledge' | 'content'`.
- **`TodoStage`** — `'todo' | 'in_progress' | 'backlog'`. Internal value `'todo'` surfaces as **"Open"** in the UI.
- **`ClassifierConfidence`** — `'high' | 'medium' | 'low' | 'heuristic'`.
- **`TodoMeta`** — `{ todoId, entryId, entryDate, type, stage, expandedMd?, expandedAt?, model?, classifierConfidence?, classifierModel?, userOverriddenType, position, createdAt, updatedAt }`. **No `notionPageId`** — sync code joins TodoItem ↔ TodoMeta and uses the single id from TodoItem.
- **Six per-type expansion shapes** — `IdeaExpansion`, `BugExpansion`, `QuestionExpansion`, `DecisionExpansion`, `KnowledgeExpansion`, `ContentExpansion`, plus a discriminated `TodoExpansion` union and `ExpandableType = Exclude<TodoType, 'todo'>`.
- **`Thread`** ([thread.ts](../src/types/thread.ts)) — `{ id, name, slug, icon?, color?, targetCadenceDays, archived, pinned, timeOfDay?, notionPageId?, notionLastSynced?, createdAt, updatedAt }`.
- **`ThreadMention`** — `{ id, threadId, entryId, entryDate, todoId, sourceLine, tagText, createdAt }`.
- **`Staleness`** — `'fresh' | 'aging' | 'stale' | 'cold'`. Computed from days-since-last-mention against optional `targetCadenceDays` or default 1/3/7 thresholds.
- **`ThreadCard`** — computed view shape consumed by the dashboard. `{ thread, lastMentionAt, daysSinceLast, staleness, entriesThisWeek, openTodos, recentTodos, activeDates }`. `activeDates` is a `Set<YYYY-MM-DD>` of dates in the last 14 days where the thread had a manual-touch mention (drives the dashboard 14-cell strip; prose `#tag` mentions are deliberately excluded).

---

## 6. Core Features

### 6.1 Journal & Entries
DB-first autosave (every keystroke → SQLite, no React state churn). Drops (todos, nutrition, threads) extract from prose at commit time only — never on keystroke. Empty-entry cleanup runs on focus blur, never inside sync.

### 6.2 Habits, cadence & heatmap
Globally-defined habits with cadence rules + time-of-day buckets. Per-entry logging stays on `entries.habits_json` (no schema break for the legacy logging path).

**Cadence engine** ([habits/cadence.ts](../src/services/habits/cadence.ts)) — pure `isDueOn(habit, date)`:
- `daily` — every day
- `weekdays` — Mon–Fri only
- `weekly` — single weekday from `cadence_days[0]`
- `specific_days` — any subset of weekdays in `cadence_days`
- `n_per_week` — schedule alone says "any day this week is fair game"; the dashboard combines this with check-in history via `needsMoreThisWeek` to decide whether to surface the row as due today

**Cadence-aware streaks** ([habits/streaks.ts](../src/services/habits/streaks.ts)) — a streak counts due-days only. Due-day-completed extends the streak; due-day-missed breaks it; non-due-days are neutral. For `n_per_week`, the streak counts **completed weeks** (a 3x/week habit done Mon/Wed/Fri = 1 week of streak; the current week is "in progress" until it closes).

**Heatmap row** ([HabitHeatmapRow.tsx](../src/components/home/HabitHeatmapRow.tsx)) renders a 14-cell Sunday-anchored strip with four cell states: `completed` (green), `missed` (low-alpha red), `today-pending` (outlined), `neutral` (very dim — for not-due days or future days). Right-side count shows the cadence-aware streak.

**CRUD** at `/more/habits`. Time-of-day chips, cadence-type radio, day-picker (for weekly/specific_days), count picker (for n_per_week). Trash icon hard-deletes; past `habits_json` references on entries dangle harmlessly.

### 6.3 Todos (checkbox drop)
Todos live as `[]` / `[x]` lines in entry prose. The scanner ([scanTodos.ts](../src/services/todos/scanTodos.ts)) merges them into `entries.todos_json` at commit time. Two-pass matching (text + line-index via `sourceLine`) keeps row identity through edits.

[`src/services/todos/rank.ts`](../src/services/todos/rank.ts) ranks the dashboard's `SmartTodoList` (carryover-from-yesterday → AI → journal). [updateTodo](../src/services/todos/crud.ts) round-trips dashboard interactions back into source prose via `rewriteTodoLine`.

### 6.4 Thinking Modes (per-todo classification + structured expansion)
Every `TodoItem` has a paired `todo_meta` row. The 1:1 invariant is enforced by [reconcileMeta.ts](../src/services/todos/reconcileMeta.ts), which runs fire-and-forget after every entry commit.

**Two-stage classification** (heuristic first, LLM fallback):
1. **[heuristicClassify.ts](../src/services/todos/heuristicClassify.ts)** — free, fast. ~50 imperative verbs, modal phrases, deadline patterns return `'todo'`. Question-shape lines and speculative starts return `null`. Heuristic over-fires on null (false negatives cost a cheap LLM call; false positives cost a manual override).
2. **[classify.ts](../src/services/todos/classify.ts)** — when heuristic returns null AND the todo isn't done, fires the cheapest configured model (`gpt-4o-mini` or `claude-haiku-4-5-20251001`) for a single-pass `{type, confidence}` JSON. Module-level in-flight counter exposed via `CLASSIFY_PROGRESS_EVENT` for the toast UI. Boot-time catch-up via `classifyAmbiguousMeta()` walks unclassified, not-done rows.

**`user_overridden_type` lock** — once the user manually picks a type via the picker, `userOverriddenType=1` and the row is locked from future re-classification.

**Stage** (orthogonal to type and done): `'todo'` (default; surfaces as "Open"), `'in_progress'`, `'backlog'`. Per-row `StageBadge` always visible; `StageChangePicker` for changes.

**Position** (orthogonal manual reorder): NULL until the user explicitly reorders any todo; once reorder is invoked, every row gets a dense integer assigned and the sort flips from `createdAt`-DESC to `position`-ASC.

**Expansion** (manual, never automatic):
- Six per-type prompts in [expandPrompts.ts](../src/services/todos/expandPrompts.ts) with chain-of-thought reasoning preambles.
- [expand.ts](../src/services/todos/expand.ts) orchestrator uses the **primary** model (Sonnet 4.6 / GPT-4o), 3-concurrent cap, malformed-JSON auto-retry once with stricter instruction, validates per-type shape.
- [expandSerialize.ts](../src/services/todos/expandSerialize.ts) renders the JSON to compact markdown stored in `expanded_md`.
- Context block (sibling todos + last 3 days of entries with cached AI summaries) is capped at 1000 chars per recent entry to keep tokens bounded.
- View at [`app/todos/[id].tsx`](../app/todos/[id].tsx) — full-page route, not a modal; sticky footer above the bottom nav.

### 6.5 Nutrition (suffix-style drop)
Each `** <food> <N> kcal` line in prose becomes a row in the `nutrition` table, tagged to its source entry and date. Two rows for the same food on the same day = two intake events.

Scanner: [scanNutrition.ts](../src/services/nutrition/scanNutrition.ts). Two-pass matching: exact `(name, kcal)` then line-index. Unmatched existing rows are **deleted** (unlike todos, nutrition rows correspond 1:1 to prose lines).

Autocomplete: [NutritionAutocomplete](../src/components/journal/NutritionAutocomplete.tsx) detects the `** ` marker and renders chips with most-recent kcal values. Tap inserts `<name> <kcal> kcal `.

### 6.6 Threads (`#tag` system)
A lightweight project-attribution layer. `#tag` mentions in journal prose or todo text register as rows in `thread_mentions`, joining one or more entries/todos to a `Thread` with stored metadata (name, slug, color, target cadence, time-of-day bucket).

**Marker rules** ([scanThreads.ts](../src/services/threads/scanThreads.ts)):
- Pattern: `#[a-zA-Z][a-zA-Z0-9-]*` (must start with a letter; alphanumerics + hyphens after).
- Case-insensitive — `#Loopd`, `#loopd`, `#LOOPD` all resolve to slug `loopd`.
- Detected anywhere on a line (prose mid-sentence, the start of a `[]` todo line, etc.).
- Code spans / fenced blocks are masked before regex application so `` `git #branch` `` doesn't register.
- Per-line per-slug deduplication (multiple `#loopd` on the same line collapse to one mention).

**Auto-create on save.** Unknown slugs **auto-create** a Thread row at scan time using the literal-as-typed `tagText` as the display name and the lowercased text as the slug. The inline `+ create` chip on the autocomplete still works as the immediate-feedback path.

**Two-pass reconcile.** Same idiom as todos and nutrition (Principle 7):
1. Pass 1 — exact `(thread_id, source_line)` match.
2. Pass 2 — `(thread_id, tag_text)` within ±3 lines for line-shifted mentions.

Per-todo mentions reconcile against `thread_mentions WHERE todo_id = ?`; per-entry mentions reconcile against `WHERE entry_id = ? AND todo_id IS NULL`. Unmatched parsed → insert; unmatched existing → delete.

**Manual touch.** From the dashboard tracker, tapping a thread row writes a `thread_mentions` row with `entry_id IS NULL AND todo_id IS NULL` (see [touch.ts](../src/services/threads/touch.ts)). This deviates from Principle 11 (mentions are derived from prose) and is the **only** documented exception. Justified because the schema permits it, the staleness math composes uniformly across all mention shapes, and toggling off only deletes the manual row.

**Staleness** ([staleness.ts](../src/services/threads/staleness.ts)) — pure compute. If `targetCadenceDays` is set, staleness measured against it (1× = fresh, 2× = aging, 4× = stale, beyond = cold). Otherwise default thresholds: ≤1d fresh, ≤3d aging, ≤7d stale, >7d cold. Never-mentioned threads = `cold`.

**Lazy backfill** ([threads/migrate.ts](../src/services/threads/migrate.ts)) — SecureStore-gated under `thread_mentions_backfill_v1_done`, with an extra short-circuit: skip when zero threads exist locally. The gate flips on the first boot AFTER a thread exists.

**Mentions are NOT synced to Notion** (see §6.11). They're derived from entries/todos which already sync.

### 6.7 Daily Schedule tracker
Combined dashboard section that merges habits + threads under a single `DAILY SCHEDULE` header. Bucketed by `time_of_day`; adaptive mini-headers (`morning` / `midday` / `evening` / `anytime`) appear once 2+ buckets are populated by either type. Within each bucket: habit rows first, then thread rows.

Both row types share the same layout (80px name + flex 14-cell strip + 36px right-side number / nav arrow). Habit rows use the cadence-aware streak count; thread rows show a `→` nav arrow (tap → `/threads/[id]`). Tapping the body of a thread row toggles a manual touch (§6.6).

The 14-cell strip on thread rows is driven exclusively by manual touches — `#tag` mentions in prose do NOT light up the strip. This was a deliberate decision: prose mentions appear on the thread detail page (where mentions are the whole point), but they don't paint the dashboard's "done today" indicator.

`manage →` link at the section header routes to `/more`.

### 6.8 Vlog Editor
Implementation details:
- `ClipTimeline` uses reanimated shared values so the playhead extrapolates between `onProgress` callbacks without re-renders.
- `PreviewPlayer` uses two video slots; the next clip is preloaded into the inactive slot for seamless transitions.
- Stale `currentTime=0` progress events after scrub→play are suppressed.

### 6.9 AI composition (vlog summary)
[src/services/ai/](../src/services/ai/) — provider-agnostic (Sonnet 4.6 or GPT-4o). `summarize.ts` produces a structured `AISummary`; `compose.ts` maps it onto `ClipItem[]` + `TextOverlay[]` + `FilterOverlay[]`. Cached in `ai_summaries` per date.

### 6.10 Media Pipeline
Full details in [docs/media-pipeline.md](./media-pipeline.md). 1080p H.264 proxy transcode on import (CRF 23) via `@wokcito/ffmpeg-kit-react-native`. Parallel-transcode + in-order-commit. Missing clips re-imported via `clipMatcher.ts`.

### 6.11 Notion Sync
[src/services/notion/sync.ts](../src/services/notion/sync.ts) — four orchestrators. The boot-time auto-sync chain (when configured AND auto-sync enabled): `syncAll → syncAllTodos → syncAllHabits → syncAllThreads`.

- **`syncAll()`** — Entries DB. Pulls + pushes entries, merges habits vocabulary (multi-select options on Entries DB still govern habit identity), archives queued deletions, runs `reimportMissingClips`.
- **`syncAllTodos()`** — Optional second DB. Single schema fetch at start; thread title-column + missing-property set through pull + push.
  - **`text`** — prose-canonical; Notion edits to Title are dropped.
  - **`done`** — bidirectional (last-edited-time merge).
  - **`type`** — Notion change → flip `userOverriddenType=1` (treated as manual override).
  - **`expanded_md`** — pull-down on diff (Notion is read-canonical when local is empty).
  - **`model` / `classifier_confidence` / `user_overridden_type`** — pull-down on diff.
  - **New-from-Notion** — appends `[]` / `[x]` line to today's most recent entry's prose, mints `TodoItem` with Notion's loopdId so the next scan text-pairs cleanly. Paired `TodoMeta` inserted with `userOverriddenType=true`.
- **`syncAllHabits()`** — Optional Habits DB (separate from the Entries-DB multi-select that governs identity). Carries cadence + time-of-day + slug + icon/color metadata bidirectionally. Slug is **local-only** (Notion edits rejected on pull, log warning). Schema-gap tolerance via `detectMissingHabitProperties`. Silent no-op when the DB ID is unset.
- **`syncAllThreads()`** — Optional Threads DB. Bidirectional for `name`, `icon`, `color`, `target_cadence_days`, `archived`, `pinned`, `time_of_day`. Slug is **local-only** (rejected on pull because changing it would invalidate existing mention reconciliation). Mentions are **NOT** synced — they're derived from entries/todos which already sync. New rows from Notion auto-derive a slug if blank, with `-1`/`-2` collision suffixes.
- Schema-gap detection via `detectMissingTodoProperties` / `detectMissingHabitProperties` / `detectMissingThreadProperties`; missing properties listed in `result.debug` (existing DBs without new fields continue to sync, just without the new fields).
- `expanded_md` is split across multiple rich-text blocks for Notion's 2000-char-per-block cap.
- Module-level rate limiter at [`notion/api.ts`](../src/services/notion/api.ts) (350ms gap, 429 retry) serializes ALL Notion calls across all four orchestrators.

Deletions queued in `sync_deletions` per `entity_type` (`entry`, `todo`, `habit`, `nutrition`, `thread`).

### 6.12 OTA Updates
`expo-updates` checks on every app open. Background fetch + restart prompt.

---

## 7. Service Layer — `src/services/`

| Path | Purpose |
|---|---|
| `database.ts` | SQLite schema, migrations, CRUD for all 11 tables; sync-deletion queue; AI summary cache |
| `fileManager.ts` | Pick / record / copy clip; DCIM save; ensure app dirs |
| `ffmpeg.ts`, `ffmpegCommand.ts` | FFmpeg wrapper + 1080p H.264 transcode command builder |
| `clipMigration.ts` | Backfills 1080p proxies for pre-transcode clips |
| `clipMatcher.ts` | Re-sources missing clips from camera roll |
| `exportPipeline.ts` | Final vlog transcode & mux |
| `textBitmap.ts`, `textRenderer.tsx` | Rasterizes text overlays via Skia |
| `todos/scanTodos.ts` | `[]`/`[x]` parser; two-pass merge against `todos_json`; `rewriteTodoLine` for dashboard round-trip |
| `todos/migrate.ts` | One-time backfill of `[]` markers in pre-existing entries (SecureStore-gated) |
| `todos/rank.ts` | Ranking + relative-time formatting for the dashboard `SmartTodoList` |
| `todos/crud.ts` | Entry-scoped todo CRUD; round-trips done/text into prose; enqueues `sync_deletion`; fires threads scan after writes so `#tags` register on save |
| `todos/typeMeta.ts` | Single source for type icon/label/color/order |
| `todos/heuristicClassify.ts` | Free heuristic — text → `'todo'` \| null |
| `todos/classify.ts` | Cheapest-model LLM classifier; module in-flight counter |
| `todos/reconcileMeta.ts` | Inserts/deletes paired `todo_meta` rows on every entry commit; fires classifier for ambiguous, not-done todos |
| `todos/migrateMeta.ts` | One-time `todo_meta` backfill (heuristic only) + `classifyAmbiguousMeta` boot catch-up + `countAmbiguousNotDone` |
| `todos/stageMeta.ts` | Stage icon/label/color (default `'todo'` surfaces as "Open") |
| `todos/reorder.ts` | `ensureAllTodoPositions` + swap helpers; lazy NULL-first sparse-then-dense pattern |
| `todos/expandPrompts.ts` | Six system prompts with reasoning preambles + JSON schemas + context-block builder |
| `todos/expandSerialize.ts` | Per-type JSON → markdown templates |
| `todos/expand.ts` | Expansion orchestrator (primary model, 3-concurrent cap, malformed-JSON auto-retry) |
| `nutrition/scanNutrition.ts` | `** food N kcal` parser; two-pass reconcile against the nutrition table |
| `nutrition/migrate.ts` | One-time nutrition backfill (SecureStore-gated) |
| `habits/cadence.ts` | Pure cadence engine: `isDueOn`, `needsMoreThisWeek`, `summarizeCadence`, ISO-week helpers |
| `habits/streaks.ts` | Cadence-aware streak math + per-cell heatmap state computation |
| `habits/migrate.ts` | One-time `habits_cadence_backfill_v1_done`: derives slugs from labels for pre-cadence habits |
| `threads/scanThreads.ts` | `#tag` parser with code-span masking; resolves slugs to thread IDs (auto-creates unknown); two-pass reconcile against `thread_mentions`; per-todo + per-entry passes |
| `threads/crud.ts` | Thread CRUD with discriminated `CreateResult` (slug-taken / empty-name); `getThreadSuggestions` for the autocomplete (recency-sorted via LEFT JOIN with NULLS LAST) |
| `threads/staleness.ts` | Pure `computeStaleness` + `formatStalenessLabel` |
| `threads/getThreadCards.ts` | Single-pass aggregator for the dashboard: thread + last mention + entries-this-week + open-todos + top-3 recent open todos + 14-day `activeDates` set (manual-touch only) |
| `threads/getThreadDetail.ts` | Per-thread aggregator for `/threads/[id]`: open todos + done todos (recent 5) + entry-prose mentions (with line excerpts) |
| `threads/touch.ts` | `toggleThreadTouchToday` — idempotent dashboard toggle that writes a manual mention with NULL entry_id + todo_id (deviation from Principle 11, documented inline) |
| `threads/migrate.ts` | Lazy `thread_mentions_backfill_v1_done`: scans every entry + todo for `#tag` matches; short-circuits if user has zero threads (re-checks on next boot) |
| `ai/config.ts` | Claude/OpenAI key + provider storage |
| `ai/prompt.ts`, `ai/summarize.ts`, `ai/compose.ts`, `ai/validate.ts` | Vlog summary prompts, LLM calls, compose, validation |
| `notion/api.ts` | `queryDatabase`, `createPage`, `updatePage`, `archivePage`; module-singleton 350ms rate-limiter + 429 retry |
| `notion/config.ts` | Token, DB IDs (Entries / Todos / Habits / Threads), per-sync timestamps, auto-sync flag |
| `notion/mapper.ts` | Entries DB bidirectional property mapping |
| `notion/todosMapper.ts` | Todos DB mapping; reads/writes thinking-mode fields with missing-property tolerance via `availableProperties` set; `detectMissingTodoProperties` for schema-gap detection |
| `notion/habitsMapper.ts` | Optional Habits DB mapping: cadence type/days/count, time-of-day select, slug + icon + color. Slug edits in Notion rejected on pull (log warning) |
| `notion/threadsMapper.ts` | Optional Threads DB mapping: name + icon + color + target cadence + archived + pinned + time-of-day. Slug local-only (Notion edits rejected); mentions never synced |
| `notion/sync.ts` | Orchestrators `syncAll`, `syncAllTodos`, `syncAllHabits`, `syncAllThreads` |

---

## 8. External Integrations

| Integration | Library / endpoint | Used for |
|---|---|---|
| Anthropic | `@anthropic-ai/sdk` (v0.90.0), `claude-sonnet-4-6` (primary) / `claude-haiku-4-5-20251001` (classifier) | Vlog summary, expansion, classifier |
| OpenAI | `fetch` to `api.openai.com`, `gpt-4o` (primary) / `gpt-4o-mini` (classifier) | Alt provider |
| Notion | `fetch` to `api.notion.com/v1` | Two-way sync of entries + todos (with thinking-mode fields); optional opt-in DBs for habits + threads |
| FFmpeg | `@wokcito/ffmpeg-kit-react-native` (v6.1.2) | 1080p proxy transcode + final export |
| DCIM | `expo-media-library` | Save exports to `DCIM/loopd/` |
| Camera roll | `expo-image-picker` / `expo-document-picker` / `expo-media-library` | Clip import |
| Secrets | `expo-secure-store` | Notion token, AI keys, backfill flags |

---

## 9. Tech Stack

| Layer | Pin |
|---|---|
| Expo SDK | 55.0.8 |
| React Native | 0.83.2 |
| React | 19.2.0 |
| TypeScript | 5.9.2 (strict) |
| Router | `expo-router` 55.0.7 (file-based) |
| Animations | `react-native-reanimated` 4.2.1 + `react-native-worklets` 0.7.1 |
| Video | `react-native-video` 6.19.1 |
| Gestures | `react-native-gesture-handler` 2.30.0 |
| Safe area | `react-native-safe-area-context` 5.6.2 |
| Screens | `react-native-screens` 4.23.0 |
| SVG | `react-native-svg` 15.15.3 |
| View shot | `react-native-view-shot` 4.0.3 |
| DB | `expo-sqlite` 55.0.11 |
| Updates | `expo-updates` 55.0.15 + EAS Update |
| Icons | `lucide-react-native` 0.475.0 |
| AI SDK | `@anthropic-ai/sdk` 0.90.0 |
| FFmpeg | `@wokcito/ffmpeg-kit-react-native` 6.1.2 |
| Secrets | `expo-secure-store` 55.0.9 |
| Fonts (bundled) | DM Serif Display, DM Mono, Instrument Sans, Nunito |

Target platform: **Android only** (the prebuilt `android/` directory is committed; iOS is not currently supported).

---

## 10. Architectural Principles

1. **DB is the single source of truth.** UI displays exactly what's in SQLite — no frontend filtering, no hiding via conditional rendering.
2. **Prose is canonical for drops.** `[]` lines, `** … kcal` lines, and `#tag` mentions in `entries.text` are the source; `todos_json`, `todo_meta`, the `nutrition` table, and `thread_mentions` are derived. Round-trips (e.g. dashboard toggle → prose rewrite) keep prose authoritative. Notion never edits source prose — Title-field edits in the Todos DB are dropped on next push.
3. **Save to DB on every keystroke.** Silent, no-state-update DB writes. Refs hold pending values for focus logic only. **Scanners do not run on keystroke** — only at commit (focus blur, screen leave, explicit save).
4. **Always read DB before deleting.** Auto-commit timers and cleanup effects must verify the latest row state before deciding anything destructive.
5. **Never clear live refs in focus cleanup.** `useFocusEffect` cleanups can race idle timers; clearing `liveTextRef` during cleanup caused past data loss.
6. **Don't auto-delete during sync.** Automatic empty-entry cleanup only runs on explicit user-initiated page loads.
7. **Two-pass matching is the way.** Any feature that derives records from prose lines uses `(exact match, then line-index fallback)` so users can edit content in place without losing record identity.
8. **Backfills are SecureStore-gated, one-time.** Any new prose-derived feature ships with a one-time backfill so existing entries pick up the new markers; gate it with a flag (`<feature>_backfill_v<N>_done`) so it never runs twice.
9. **Classifier output is editable; user override is permanent.** Any AI-assigned attribute on a derived row must be overridable by the user, and the override must lock that attribute from future AI mutation. The `user_overridden_type` flag pattern is the template.
10. **Heuristic before LLM.** When a feature needs classification, scoring, or routing, try a deterministic heuristic first. Only fall through to an LLM call when the heuristic is uncertain. Cheaper, faster, and more debuggable.
11. **Mentions are derived; metadata is stored.** When a feature creates a relationship between two objects (here: threads ↔ entries via `#tag`s), the relationship rows are *derived* from a canonical source (prose) and rebuilt at scan time. The metadata about the relationship subject (here: thread name, color, target cadence) is stored in its own table and survives between scans. **One documented deviation:** the dashboard tracker's manual "touch today" toggle writes a `thread_mentions` row with NULL entry/todo (see [services/threads/touch.ts](../src/services/threads/touch.ts)) so users can mark threads done without typing in prose. Justified because (a) the schema permits it, (b) staleness + activity math compose uniformly across mention shapes, (c) toggling off only deletes that manual row.

These live in full in [CLAUDE.md](../CLAUDE.md). Treat them as non-negotiable — each one traces back to a data-loss bug or a deliberate-cost decision.
