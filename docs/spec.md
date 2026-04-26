# loopd — Product & Technical Spec

Last updated: 2026-04-26

A solo-dev, native Android daily-vlogging app. Combines a journal (text + habits + clips) with a lightweight AI-assisted video editor, a "drops" system that extracts structured records (todos, nutrition) from inline prefix markers in prose, and on-device SQLite as the source of truth, with optional bidirectional Notion sync.

Operational setup, build, and deploy instructions live in [`README.md`](../README.md). This doc is the "what the app does and how it's put together" reference for new contributors and future-me.

---

## 1. Purpose & Shape

loopd turns everyday captures (short clips, text jots, habit checkmarks, marked-up todos and nutrition lines) into a per-day archive with a one-tap vlog render. Core loop:

1. Throughout the day: open the journal for today's date, jot text, check off habits, capture/import clips, and tag actionable lines with simple inline markers (`[] task`, `** food 320 kcal`).
2. At commit time the prose is scanned: marked lines flow into typed records (todos in `todos_json`, nutrition in its own table) without leaving the prose itself.
3. End of day: tap into the editor — AI auto-composes clip order, trims, and text overlays from the day's entries.
4. Tweak in the editor (timeline / text / filter tabs), export to MP4 (saved to DCIM/loopd and sharable).
5. Optional: Notion syncs entries + todos to two separate Notion databases, bidirectionally.

Native-only (React Native / Expo), runs on a development build — not Expo Go, not web.

---

## 2. Drops — the inline-marker idiom

A core architectural pattern. **Drops are inline prefix markers in journal prose that the app scans on entry commit and extracts as typed records.** The prose stays the canonical source — drops are derived state, kept in sync via a two-pass scanner.

Currently shipped:

| Marker | Trigger | Destination | Extracted fields |
|---|---|---|---|
| `[]` / `[ ]` / `[x]` | line start (optional `- ` bullet, optional whitespace) | `entries.todos_json` | `text`, `done` |
| `** <food> <N> kcal` | line start OR inline (preceded by whitespace) | `nutrition` table | `name`, `kcal` |

Both scanners use **two-pass matching** to preserve record identity across text edits:

1. **Pass 1 — exact match** (text for todos, `(name, kcal)` tuple for nutrition). Catches unchanged lines and reorderings.
2. **Pass 2 — line-index fallback** via a `sourceLine` field on the record. Handles in-place edits — changing `[] call mom` to `[] call dad` keeps the same row, preserves `id` / `done` / `createdAt`.

Dashboard interactions **round-trip** into the source prose: toggling a todo's `done` state in `SmartTodoList` rewrites the matching `[]`/`[x]` line in the entry's text so the journal always reflects current state.

Each drop type also has a **one-time backfill migration** (SecureStore-gated) that scans every existing entry on first launch after the feature ships, picking up markers that pre-date the scanner.

---

## 3. Navigation

**Global bottom nav** ([src/components/nav/GlobalBottomNav.tsx](../src/components/nav/GlobalBottomNav.tsx)) — five tabs, hidden on `/editor/*` and `/settings/*`:

| Tab | Route | Icon |
|-----|-------|------|
| Home | `/` | `house` |
| Record | (modal capture) | red dot |
| Journal | `/journal/[date]` (today) | `penLine` |
| Todos | `/todos` | `listTodo` |
| Nutrition | `/nutrition` | `utensils` |

---

## 4. Screens

### `app/_layout.tsx` — root
Runs on app boot:
- Initializes SQLite (`useDatabase`), loads fonts, wraps in error boundary + `NotionSyncProvider` + gesture root.
- Checks `expo-updates` for OTA updates; prompts user to restart if one is fetched.
- If Notion configured and auto-sync enabled: runs `syncAll().then(syncAllTodos)`.
- If AI configured: auto-summarizes yesterday's entries.
- Migrates any pre-transcode clips to 1080p proxies in the background.
- **Backfill migrations**: one-time pass for todos and nutrition drops in pre-existing entries (SecureStore-gated keys `drops_backfill_v1_done`, `nutrition_backfill_v1_done`).

### `app/index.tsx` — Home / Dashboard
- Greeting (time-of-day).
- "Today's Vlog" card — same shape as past-vlog cards; or a "Start Today's Vlog" CTA if empty.
- `total kcal` stat under the vlog card — regex `/(\d+(?:[.,]\d+)?)\s*kcal\b/gi` sums every kcal mention across today's entry text. Catches both bare `N kcal` and `** food N kcal` lines.
- 14-day Habits heatmap — one row per habit, Sunday-anchored.
- `SmartTodoList` — last 5 ranked todos. Toggle/edit round-trips into source prose via [updateTodo](../src/services/todos/crud.ts).
- Previous Vlogs — archive section.

### `app/journal/[date].tsx` — daily journal
Dynamic route keyed by `YYYY-MM-DD`. Inline entries with text + habits + clips. Key behaviors:

- **DB-first autosave** on every keystroke (`liveTextRef`, `handleSilentNewText`) — see [CLAUDE.md § Autosave Rules](../CLAUDE.md). Silent saves bypass scanners (no churn mid-word).
- **Commit-time scanners** run from [useEntries.editEntry](../src/hooks/useEntries.ts) when text changes:
  - `scanTodosFromText` merges `[]` matches into `todos_json`.
  - `scanNutritionForEntry` (fire-and-forget) reconciles `** … kcal` lines against the `nutrition` table.
- **Keyboard toolbar** quick actions: Todo (inserts `[] ` at cursor via forwardRef'd `appendText`), Clip (pick/record video), Habit.
- **Nutrition autocomplete** — when the cursor sits after a `** ` marker on the active line (line-start OR inline), [NutritionAutocomplete](../src/components/journal/NutritionAutocomplete.tsx) renders a horizontal chip bar above the keyboard toolbar. Each chip shows a distinct food name from the local nutrition table with its most-recent kcal value; tapping inserts `<name> <kcal> kcal ` at the cursor.
- Clip import → parallel 1080p H.264 proxy transcode (in-order commit to avoid reorder bugs).
- Auto-delete of fully-empty entries on focus blur.
- "Vlog" button appears once any clips exist → routes to `/editor/[date]`.

Note: the inline structured-todo list UI was removed — todos now live as `[]` lines in prose, displayed naturally as part of the entry text.

### `app/editor/[date].tsx` — vlog editor
Three tabs under a resizable preview (`windowHeight * 0.45` default, draggable 100–1000):
- **TIMELINE** (default on load): clip strip with playhead + per-clip trim/split/reorder/delete controls.
- **TEXT**: selects an overlay → `TextOverlaySheet` (position, fontSize, fontWeight, italic, color, textAlign). Header button: **REGENERATE WITH AI** (re-runs summarize, preserves clip edits). The preview's `TextInput` only autofocuses when the user taps the overlay itself.
- **FILTER**: single active filter (brightness / contrast / saturate preset).

Auto-compose on mount; export pipeline renders text overlays to a Skia canvas → FFmpeg transcode → writes to `exports/[date]/…mp4` and DCIM/loopd → offers `Sharing.shareAsync`.

### `app/todos.tsx` — global todos
All todos across all entries (sourced from `entries.todos_json`), ranked by [rankTodos](../src/services/todos/rank.ts) with filter chips (ALL / OPEN / DONE). Each row: text (full, untruncated), date + relative time. Edit mode uses a multiline `TextInput` that commits on blur. Tap a row's date area to jump to its source journal entry. Delete from this screen also removes the matching `[]` line from the source prose so the next scan won't recreate it.

### `app/nutrition.tsx` — nutrition log
Flat list of every nutrition row from the local table, newest first. Each row shows food name, source date, and kcal. Tap to jump to the source journal day. Empty state explains the `** food 320 kcal` syntax.

### `app/settings/`
- [`index.tsx`](../app/settings/index.tsx) — menu.
- [`ai.tsx`](../app/settings/ai.tsx) — provider toggle (Claude Sonnet 4.6 or GPT-4o), API-key input, Test Connection.
- [`notion-sync.tsx`](../app/settings/notion-sync.tsx) — manual full-sync, entries DB ID, todos DB ID, auto-sync toggle, reset-sync-timestamp.
- [`notion-guide.tsx`](../app/settings/notion-guide.tsx) — seven-step setup guide covering Integration, Entries DB, Todos DB (optional), **Nutrition DB (optional)**, Sharing with Integration, Copying DB IDs, Connect & Sync.
- [`updates.tsx`](../app/settings/updates.tsx) — manual OTA check.

---

## 5. Data Model

### SQLite (expo-sqlite) — [src/services/database.ts](../src/services/database.ts)

Eight tables.

| Table | PK | Columns (notable) | Purpose |
|---|---|---|---|
| `habits` | `id` | `label`, `sort_order`, `notion_page_id`, `updated_at` | User's repeatable daily habits |
| `entries` | `id` | `date`, `text`, `habits_json`, `clips_json`, `todos_json`, `clip_uri`/`clip_duration_ms` (legacy single-clip), `created_at`, `notion_page_id`, `updated_at` | Daily entries; prose is canonical |
| `projects` | `id` | `date` UNIQUE, `status` ('draft'\|'exported'), `clips_json`, `removed_clip_source_keys_json`, `text_overlays_json`, `filter_overlays_json`, `export_uri`, `updated_at` | Editor state per day |
| `vlogs` | `id` | `date`, `clip_count`, `habit_count`, `caption`, `duration_seconds`, `export_uri`, `created_at` | Archive of exported vlogs |
| `day_meta` | `date` | `title`, `updated_at` | Per-day user-rename title |
| `sync_deletions` | `id` autoinc | `entity_type` ('entry'\|'todo'\|'habit'\|'nutrition'), `entity_id`, `notion_page_id`, `deleted_at` | Queue of deletions to archive in Notion on next sync |
| `ai_summaries` | `date` | `summary_json`, `generated_at`, `model` | Cached AI composition per date |
| `nutrition` | `id` | `name`, `kcal`, `entry_id`, `entry_date`, `source_line`, `notion_page_id`, `created_at`, `updated_at` | Per-line nutrition records, derived from `** food N kcal` prose |

Indexes on `entries(date)`, `entries(notion_page_id)`, `entries(updated_at)`, `projects(date)`, `habits(notion_page_id)`, `nutrition(entry_id)`, `nutrition(entry_date)`, `nutrition(name COLLATE NOCASE)`, `nutrition(notion_page_id)`.

### Key TypeScript types — [src/types/](../src/types/)

- **`Entry`** ([entry.ts](../src/types/entry.ts)) — `{ id, date, text, habits[], todos[], clipUri?, clipDurationMs?, clips[], createdAt, notionPageId?, updatedAt? }`
- **`TodoItem`** — `{ id, text, done, completedAt?, createdAt?, sourceLine?, notionPageId? }`. Note: `pinned` was removed in 2026-04. `sourceLine` is the 0-indexed line in the parent entry's text where the `[]` marker was last scanned from — used by the two-pass matching in [scanTodos.ts](../src/services/todos/scanTodos.ts).
- **`Habit`** — `{ id, label, sortOrder, notionPageId?, updatedAt? }`
- **`Vlog`** — `{ id, date, clipCount, habitCount, caption?, durationSeconds, exportUri?, createdAt }`
- **`NutritionEntry`** ([nutrition.ts](../src/types/nutrition.ts)) — `{ id, name, kcal, entryId, entryDate, sourceLine?, notionPageId?, createdAt, updatedAt? }`
- **`NutritionSuggestion`** — `{ name, kcal, lastLoggedAt }` — autocomplete row shape.
- **`ClipItem`** ([project.ts](../src/types/project.ts)) — `{ id, entryId, clipUri, caption?, durationMs, trimStartPct, trimEndPct, order, color }`
- **`TextOverlay`** — `{ id, text, startPct, endPct, fontSize, fontWeight, italic, lineHeight, color, textAlign, position: 'top'\|'center'\|'bottom' }`
- **`FilterOverlay`** — `{ id, filterId, startPct, endPct, brightness, contrast, saturate }`
- **`EditorProject`** — `{ id, date, status, clips, removedClipSourceKeys, textOverlays, filterOverlays, exportUri?, updatedAt }`
- **`AISummary`** ([ai.ts](../src/types/ai.ts)) — `{ headline, summary, mood, clipOrder, clipTrims, textOverlays, filterPreset, generatedAt }`

---

## 6. Core Features

### 6.1 Journal & Entries
Free-form per-day writing with attached habits and clips. Autosave is DB-first: every keystroke writes to SQLite via silent updaters (no React state churn), so app kill, navigation, or timer races can't lose data. Drops (todos, nutrition) are extracted from prose at commit time only, never on keystroke.

### 6.2 Habits & Heatmap
Habits are globally defined (name + sort order) and logged per-entry via `habits_json`. The dashboard renders a 14-day heatmap per habit, Sunday-anchored.

### 6.3 Todos (checkbox drop)
Todos live as `[]` / `[x]` lines in entry prose. The scanner ([scanTodos.ts](../src/services/todos/scanTodos.ts)) merges them into `entries.todos_json` at commit time. Two-pass matching (text + line-index via `sourceLine`) keeps row identity through edits.

[`src/services/todos/rank.ts`](../src/services/todos/rank.ts) flattens + ranks todos for display:

1. Carried from yesterday 🔁 (open todos from prior day)
2. AI-generated ✦
3. Journal-origin 📓

The dashboard's `SmartTodoList` shows the last 5 ranked todos; `/todos` shows all with ALL / OPEN / DONE filters.

[`updateTodo`](../src/services/todos/crud.ts) round-trips dashboard interactions back into source prose via `rewriteTodoLine` — toggling done rewrites `[]` ↔ `[x]`; editing text rewrites the line content. Uses `sourceLine` for precision, falls back to text-match for carryovers.

### 6.4 Nutrition (suffix-style drop)
Each `** <food> <N> kcal` line in prose becomes a row in the `nutrition` table, tagged to its source entry and date. Two rows for the same food on the same day = two intake events (no aggregation at write time).

Scanner: [scanNutrition.ts](../src/services/nutrition/scanNutrition.ts). Two-pass matching: exact `(name, kcal)` then line-index. Unmatched existing rows are **deleted** (unlike todos, nutrition rows correspond 1:1 to prose lines — no concept of carryover).

Autocomplete: [NutritionAutocomplete](../src/components/journal/NutritionAutocomplete.tsx) detects the `** ` marker (line-start or inline preceded by whitespace), queries `getNutritionSuggestions(query, 8)` for distinct food names matching the partial input, and renders chips. Tapping a chip inserts `<name> <kcal> kcal ` (pre-fills the most-recent kcal) via [InlineTextInput](../src/components/journal/InlineTextInput.tsx)'s imperative `replaceRange` handle.

The dashboard's existing kcal regex sum is unchanged — it catches the numeric portion of `** food 320 kcal` lines just like bare `320 kcal` mentions.

### 6.5 Vlog Editor
Notable implementation details:
- `ClipTimeline` uses reanimated shared values so the playhead extrapolates between `onProgress` callbacks without driving re-renders.
- `PreviewPlayer` uses two video slots; the next clip is preloaded into the inactive slot so transitions are a visible swap, not a source-change + reload.
- Stale `currentTime=0` progress events after scrub→play are suppressed via `pendingTransitionRef` + `playStartGuardRef`.

### 6.6 AI composition
[src/services/ai/](../src/services/ai/) — provider-agnostic (Claude Sonnet 4.6 or GPT-4o, configured per-user, key in `expo-secure-store`):
- `summarize.ts` — sends the day's entries, clips, and habits; parses a structured `AISummary`.
- `compose.ts` — `autoCompose(summary, entries, date, dayTitle)` maps summary fields onto `ClipItem[]` + `TextOverlay[]` + `FilterOverlay[]`.
- Summaries are cached in `ai_summaries` per date; regenerate from the editor preserves clip trims/splits.

### 6.7 Media Pipeline
Full details in [docs/media-pipeline.md](./media-pipeline.md). Every imported clip is transcoded to a 1080p H.264 proxy (CRF 23) via `@wokcito/ffmpeg-kit-react-native` before commit. The queue is parallel-transcode + in-order-commit. Missing clips (e.g. after a reinstall) are re-imported from the camera roll via `clipMatcher.ts`.

### 6.8 Notion Sync
Two independent syncs driven from [src/services/notion/sync.ts](../src/services/notion/sync.ts):

- **`syncAll()`** — Entries DB. Pulls recent pages, merges via `last_edited_time` vs. local `updated_at`, pushes local edits, archives queued deletions, syncs the habit vocabulary from the multi-select schema, and runs `reimportMissingClips` so clips that went missing get re-sourced from the camera roll.
- **`syncAllTodos()`** — optional second DB, each `TodoItem` is a page.

The Notion Guide describes a third optional **Nutrition DB**; sync wiring for it is deferred — the local table fills today; the bidirectional pipe lands in a follow-up.

Deletions are queued in `sync_deletions` per `entity_type` (`entry`, `todo`, `habit`, `nutrition`) so each entity's queue is independent. Last-sync timestamps are per-sync, both resettable from settings.

### 6.9 OTA Updates
`expo-updates` checks on every app open. Background fetch + restart prompt. Also reachable from Settings → App Updates.

---

## 7. Service Layer — `src/services/`

| Path | Purpose |
|---|---|
| `database.ts` | SQLite schema, migrations, CRUD for entries / habits / projects / vlogs / nutrition; sync-deletion queue; AI summary cache |
| `fileManager.ts` | Pick / record / copy clip; DCIM save; ensure app dirs |
| `ffmpeg.ts`, `ffmpegCommand.ts` | FFmpeg wrapper + 1080p H.264 transcode command builder |
| `clipMigration.ts` | Backfills 1080p proxies for pre-transcode clips |
| `clipMatcher.ts` | Re-sources missing clips from camera roll |
| `exportPipeline.ts` | Final vlog transcode & mux |
| `textBitmap.ts`, `textRenderer.tsx` | Rasterizes text overlays via Skia for burn-in at export time |
| `todos/scanTodos.ts` | `[]`/`[x]` parser; two-pass merge against `todos_json`; `rewriteTodoLine` for dashboard round-trip |
| `todos/migrate.ts` | One-time backfill of `[]` markers in pre-existing entries (SecureStore-gated) |
| `todos/rank.ts` | Ranking + relative-time formatting for the smart todo list |
| `todos/crud.ts` | Entry-scoped todo CRUD; round-trips done/text into source prose; enqueues `sync_deletion` for Notion-synced removals |
| `nutrition/scanNutrition.ts` | `** food N kcal` parser; two-pass reconcile against the nutrition table (insert / update / delete) |
| `nutrition/migrate.ts` | One-time nutrition backfill (SecureStore-gated) |
| `ai/config.ts` | Claude/OpenAI key + provider storage |
| `ai/prompt.ts`, `ai/summarize.ts`, `ai/compose.ts`, `ai/validate.ts` | Prompt construction, LLM calls, compose from summary, JSON validation |
| `notion/api.ts` | `queryDatabase`, `createPage`, `updatePage`, `archivePage`; module-singleton 350ms rate-limiter + 429 retry |
| `notion/config.ts` | Token, DB IDs, per-sync timestamps, auto-sync flag |
| `notion/mapper.ts`, `notion/todosMapper.ts` | Bidirectional property mapping |
| `notion/sync.ts` | Orchestrators `syncAll` and `syncAllTodos` |

---

## 8. External Integrations

| Integration | Library / endpoint | Used for |
|---|---|---|
| Anthropic | `@anthropic-ai/sdk` (v0.90.0), `claude-sonnet-4-6` | Daily summary / editor auto-compose |
| OpenAI | `fetch` to `api.openai.com`, `gpt-4o` | Alt provider for summary |
| Notion | `fetch` to `api.notion.com/v1` | Two-way sync of entries + todos |
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
| DB | `expo-sqlite` 55.0.11 |
| Updates | `expo-updates` 55.0.15 + EAS Update |
| Icons | `lucide-react-native` 0.475.0 |
| Fonts (bundled) | DM Serif Display, DM Mono, Instrument Sans, Nunito |

Target platform: **Android only** (the prebuilt `android/` directory is committed; iOS is not currently supported).

---

## 10. Architectural Principles

Captured here because they're load-bearing for anyone editing this codebase:

1. **DB is the single source of truth.** The UI displays exactly what's in SQLite — no frontend filtering, no hiding via conditional rendering. If data shouldn't be shown, delete it from the DB.
2. **Prose is canonical for drops.** `[]` lines and `** … kcal` lines in `entries.text` are the source; `todos_json` and the `nutrition` table are derived. Round-trips (e.g. dashboard toggle → prose rewrite) keep prose authoritative.
3. **Save to DB on every keystroke.** Silent, no-state-update DB writes. Refs hold pending values for focus logic only. **Scanners do not run on keystroke** — only at commit (focus blur, screen leave, explicit save).
4. **Always read DB before deleting.** Auto-commit timers and cleanup effects must verify the latest row state before deciding anything destructive.
5. **Never clear live refs in focus cleanup.** `useFocusEffect` cleanups can race idle timers; clearing `liveTextRef` during cleanup caused past data loss.
6. **Don't auto-delete during sync.** Automatic empty-entry cleanup only runs on explicit user-initiated page loads — never inside a sync operation.
7. **Two-pass matching is the way.** Any feature that derives records from prose lines uses `(exact match, then line-index fallback)` so users can edit content in place without losing record identity. New drop types should follow the same pattern.
8. **Backfills are SecureStore-gated, one-time.** Any new prose-derived feature must ship with a one-time backfill so existing entries pick up the new markers; gate it with a flag (`<feature>_backfill_v<N>_done`) so it never runs twice.

These live in full in [CLAUDE.md](../CLAUDE.md). Treat them as non-negotiable — each one traces back to a data-loss bug.
