# loopd — Product & Technical Spec

Last updated: 2026-04-23

A solo-dev, native Android daily-vlogging app. Combines a journal (text + habits + todos + clips) with a lightweight AI-assisted video editor, optional Notion sync, and on-device SQLite persistence.

Operational setup, build, and deploy instructions live in [`README.md`](../README.md). This doc is the "what the app does and how it's put together" reference — for new contributors, for future-me, and as an input to future planning.

---

## 1. Purpose & Shape

loopd turns everyday captures (short clips, text jots, habit checkmarks, todos) into a per-day archive with a one-tap vlog render. Core loop:

1. Throughout the day: open the journal for today's date, jot text, check off habits, add todos, capture/import clips.
2. End of day: tap into the editor — AI auto-composes clip order, trims, and text overlays from the day's entries.
3. Tweak in the editor (timeline / text / filter tabs), export to MP4 (saved to DCIM/loopd and sharable).
4. Optional: Notion syncs entries + todos to two separate Notion databases, bidirectionally.

Native-only (React Native / Expo), runs on a development build — not Expo Go, not web.

---

## 2. Navigation

**Global bottom nav** ([src/components/nav/GlobalBottomNav.tsx](../src/components/nav/GlobalBottomNav.tsx)) — four tabs, hidden on `/editor/*` and `/settings/*`:

| Tab | Route | Icon |
|-----|-------|------|
| Home | `/` | `house` |
| Record | (modal capture) | red dot |
| Journal | `/journal/[date]` (today) | `penLine` |
| Todos | `/todos` | `listTodo` |

---

## 3. Screens

### `app/_layout.tsx` — root
Runs on app boot:
- Initializes SQLite (`useDatabase`), loads fonts, wraps in error boundary + `NotionSyncProvider` + gesture root.
- Checks `expo-updates` for OTA updates; prompts user to restart if one is fetched.
- If Notion configured and auto-sync enabled: runs `syncAll().then(syncAllTodos)`.
- If AI configured: auto-summarizes yesterday's entries.
- Migrates any pre-transcode clips to 1080p proxies in the background.

### `app/index.tsx` — Home / Dashboard
- Greeting (time-of-day).
- "Today's Vlog" card — same shape as past-vlog cards; or a "Start Today's Vlog" CTA if empty.
- `total kcal` stat under the vlog card — regex `/(\d+(?:[.,]\d+)?)\s*kcal\b/gi` sums every kcal mention across today's entry text.
- 14-day Habits heatmap — one row per habit, Sunday-anchored.
- `SmartTodoList` — ranked todos across all entries (top N, with "show more").
- Previous Vlogs — archive section.

### `app/journal/[date].tsx` — daily journal
Dynamic route keyed by `YYYY-MM-DD`. Inline entries with text + habits + todos + clips. Key behaviors:
- Silent autosave on every keystroke (`liveTextRef`, `handleSilentNewText`) — the DB is always the source of truth, not React state.
- Keyboard toolbar with quick-add for Todo, Clip, Habit.
- Clip import → parallel 1080p H.264 proxy transcode (in-order commit to avoid reorder bugs).
- Auto-delete of fully-empty entries (no text, habits, todos, clips) on blur.
- "Vlog" button appears once any clips exist → routes to `/editor/[date]`.

### `app/editor/[date].tsx` — vlog editor
Three tabs under a resizable preview (`windowHeight * 0.45` default, draggable 100–1000):
- **TIMELINE** (default on load): clip strip with playhead + per-clip trim/split/reorder/delete controls. Scrub via playhead drag.
- **TEXT**: selects an overlay → `TextOverlaySheet` (position, fontSize, fontWeight, italic, color, textAlign). Header button: **REGENERATE WITH AI** (re-runs summarize, preserves clip edits). The preview's `TextInput` only autofocuses when the user taps the overlay itself, not on TEXT-tab entry.
- **FILTER**: single active filter (brightness / contrast / saturate preset).

Auto-compose on mount: if a cached `AISummary` exists or AI is configured, `autoCompose(summary, entries, date, dayTitle)` populates clips + overlays. Otherwise falls through to `useProject`'s default composer.

Export pipeline: renders text overlays to a Skia canvas → FFmpeg transcode → writes to `exports/[date]/…mp4` and DCIM/loopd → offers `Sharing.shareAsync`.

### `app/todos.tsx` — global todos
All todos across all entries, ranked by `rankTodos` with filter chips (ALL / OPEN / PINNED / DONE). Each todo shows a source badge (📓 journal, ✦ AI, ⭐ pinned, 🔁 carried-from-yesterday), relative time, and links back to its source entry date.

### `app/settings/`
- [`index.tsx`](../app/settings/index.tsx) — menu.
- [`ai.tsx`](../app/settings/ai.tsx) — provider toggle (Claude Sonnet 4.6 or GPT-4o), API-key input, Test Connection.
- [`notion-sync.tsx`](../app/settings/notion-sync.tsx) — manual full-sync, entries DB ID, todos DB ID (optional), auto-sync toggle, reset-sync-timestamp (force full re-sync).
- [`notion-guide.tsx`](../app/settings/notion-guide.tsx) — step-by-step for the two Notion DB schemas.
- [`updates.tsx`](../app/settings/updates.tsx) — manual OTA check.

---

## 4. Data Model

### SQLite (expo-sqlite) — [src/services/database.ts](../src/services/database.ts)

| Table | PK | Columns (notable) | Purpose |
|---|---|---|---|
| `habits` | `id` | `label`, `sort_order`, `notion_page_id`, `updated_at` | User's repeatable daily habits |
| `entries` | `id` | `date`, `text`, `habits_json`, `clips_json`, `todos_json`, `clip_uri`/`clip_duration_ms` (legacy single-clip), `created_at`, `notion_page_id`, `updated_at` | Daily entries |
| `projects` | `id` | `date` UNIQUE, `status` ('draft'\|'exported'), `clips_json`, `removed_clip_source_keys_json`, `text_overlays_json`, `filter_overlays_json`, `export_uri`, `updated_at` | Editor state per day |
| `vlogs` | `id` | `date`, `clip_count`, `habit_count`, `caption`, `duration_seconds`, `export_uri`, `created_at` | Archive of exported vlogs |
| `day_meta` | `date` | `title`, `updated_at` | Per-day user-rename title |
| `sync_deletions` | `id` autoinc | `entity_type` ('entry'\|'todo'\|'habit'), `entity_id`, `notion_page_id`, `deleted_at` | Queue of deletions to archive in Notion on next sync |
| `ai_summaries` | `date` | `summary_json`, `generated_at`, `model` | Cached AI composition per date |

Indexes on `entries(date)`, `entries(notion_page_id)`, `entries(updated_at)`, `projects(date)`, `habits(notion_page_id)`.

### Key TypeScript types — [src/types/](../src/types/)

- **`Entry`** ([entry.ts](../src/types/entry.ts)) — `{ id, date, text, habits[], todos[], clipUri?, clipDurationMs?, clips[], createdAt, notionPageId?, updatedAt? }`
- **`TodoItem`** — `{ id, text, done, completedAt?, createdAt?, pinned?, notionPageId? }`
- **`Habit`** — `{ id, label, sortOrder, notionPageId?, updatedAt? }`
- **`Vlog`** — `{ id, date, clipCount, habitCount, caption?, durationSeconds, exportUri?, createdAt }`
- **`ClipItem`** ([project.ts](../src/types/project.ts)) — `{ id, entryId, clipUri, caption?, durationMs, trimStartPct, trimEndPct, order, color }`
- **`TextOverlay`** — `{ id, text, startPct, endPct, fontSize, fontWeight, italic, lineHeight, color, textAlign, position: 'top'\|'center'\|'bottom' }`
- **`FilterOverlay`** — `{ id, filterId, startPct, endPct, brightness, contrast, saturate }`
- **`EditorProject`** — `{ id, date, status, clips, removedClipSourceKeys, textOverlays, filterOverlays, exportUri?, updatedAt }`
- **`AISummary`** ([ai.ts](../src/types/ai.ts)) — `{ headline, summary, mood, clipOrder, clipTrims, textOverlays, filterPreset, generatedAt }`

---

## 5. Core Features

### 5.1 Journal & Entries
Free-form per-day writing with attached habits, todos, and clips. Autosave strategy is DB-first: every keystroke writes to SQLite via silent updaters (no React state churn), so app kill, navigation, or timer races can't lose data. In-memory refs (`liveTextRef`, `editingEntryRef`) hold pending values for focus/blur logic only — auto-commit timers always read the latest row from the DB before deciding to delete. See [CLAUDE.md](../CLAUDE.md) § Autosave Rules.

### 5.2 Habits & Heatmap
Habits are globally defined (name + sort order) and logged per-entry via `habits_json`. The dashboard renders a 14-day heatmap per habit, Sunday-anchored, with today highlighted. Tapping a cell toggles the habit on today's entry (reuses any existing text-free entry, otherwise creates a new one).

### 5.3 Todos
Todos live inside `entries.todos_json` (one todo per row in that array), so every todo is anchored to a specific date. [`src/services/todos/rank.ts`](../src/services/todos/rank.ts) flattens + ranks:

1. Pinned ⭐
2. Carried from yesterday 🔁 (open todos from prior day)
3. AI-generated ✦
4. Journal-origin 📓

The dashboard shows a short, ranked slice; `/todos` shows the full list with ALL / OPEN / PINNED / DONE filters and a link back to each todo's source date.

### 5.4 Vlog Editor
See `app/editor/[date].tsx` description above. Notable implementation details:
- `ClipTimeline` uses reanimated shared values (`playheadPosAnim`, `playheadRefTimeMs`, `isPlayingSV`, `totalDurationMsSV`) so the playhead can extrapolate between `onProgress` callbacks without driving re-renders.
- `PreviewPlayer` uses two video slots; the next clip is preloaded into the inactive slot so transitions are a visible swap, not a source-change + reload.
- `pendingTransitionRef` + `playStartGuardRef` suppress the stale `currentTime=0` progress event that otherwise snaps the playhead back to clip start after scrub → play.

### 5.5 AI composition
[src/services/ai/](../src/services/ai/) — provider-agnostic (Claude Sonnet 4.6 or GPT-4o, configured per-user, key in `expo-secure-store`):
- `summarize.ts` — sends the day's entries, clips, and habits; parses a structured `AISummary`.
- `compose.ts` — `autoCompose(summary, entries, date, dayTitle)` maps summary fields onto `ClipItem[]` + `TextOverlay[]` + `FilterOverlay[]`. `fallbackCompose` is used when no AI is configured.
- Summaries are cached in `ai_summaries` per date; regenerate is a user-triggered re-call that preserves existing clip trims/splits.

### 5.6 Media Pipeline
Full details in [docs/media-pipeline.md](./media-pipeline.md). Summary: every imported clip is transcoded to a 1080p H.264 proxy (CRF 23) via `@wokcito/ffmpeg-kit-react-native` before it's committed to the entry. The queue is parallel-transcode + in-order-commit so the user can import many clips fast without getting them out of order. Missing clips (e.g. after a reinstall) are re-imported from the camera roll via `clipMatcher.ts`.

### 5.7 Notion Sync
Two independent syncs driven from [src/services/notion/sync.ts](../src/services/notion/sync.ts):

- **`syncAll()`** — Entries DB. Pulls recent pages, merges via `last_edited_time` vs. local `updated_at`, pushes local edits (create or update), archives queued deletions, and syncs the habit vocabulary from the multi-select schema. Also runs `reimportMissingClips` as part of the sync so clips that went missing get re-sourced from the camera roll.
- **`syncAllTodos()`** — optional second DB, each `TodoItem` is a page. Pull routes new Notion todos into a bucket entry for the target date (creates one if needed); push groups dirty todos per entry so `todos_json` is rewritten once per entry per sync.

Deletions are queued in `sync_deletions` per `entity_type` so entries and todos don't clobber each other's queues. Last-sync timestamps are per-sync (`notion_last_sync`, `notion_todos_last_sync`), both resettable from the settings screen.

### 5.8 OTA Updates
`expo-updates` checks on every app open. If an update is available it's fetched in background; user is prompted to reload. Also reachable manually from Settings → App Updates.

---

## 6. Service Layer — `src/services/`

Single-line purpose per file:

- `database.ts` — SQLite schema, migrations, CRUD, sync-deletion queue, AI summary cache.
- `fileManager.ts` — pick / record / copy clip; DCIM save; ensure app dirs.
- `ffmpeg.ts`, `ffmpegCommand.ts` — FFmpeg wrapper + 1080p H.264 transcode command builder.
- `clipMigration.ts` — backfills 1080p proxies for pre-transcode clips.
- `clipMatcher.ts` — re-sources missing clips from camera roll.
- `exportPipeline.ts` — final vlog transcode & mux.
- `textBitmap.ts`, `textRenderer.tsx` — rasterizes text overlays via Skia for burn-in at export time.
- `todos/rank.ts` — ranking logic for the smart todo list.
- `todos/crud.ts` — entry-scoped todo CRUD; enqueues `sync_deletion` when a Notion-synced todo is removed.
- `ai/config.ts` — Claude/OpenAI key + provider storage.
- `ai/prompt.ts`, `ai/summarize.ts`, `ai/compose.ts`, `ai/validate.ts` — prompt construction, LLM calls, compose from summary, JSON validation.
- `notion/api.ts` — `queryDatabase`, `createPage`, `updatePage`, `archivePage`; handles rate limits.
- `notion/config.ts` — token, two DB IDs, per-sync timestamps, auto-sync flag.
- `notion/mapper.ts`, `notion/todosMapper.ts` — bidirectional property mapping.
- `notion/sync.ts` — orchestrators `syncAll` and `syncAllTodos`.

---

## 7. External Integrations

| Integration | Library / endpoint | Used for |
|---|---|---|
| Anthropic | `@anthropic-ai/sdk` (v0.90.0), `claude-sonnet-4-6` | Daily summary / editor auto-compose |
| OpenAI | `fetch` to `api.openai.com`, `gpt-4o` | Alt provider for summary |
| Notion | `fetch` to `api.notion.com/v1` | Two-way sync of entries + todos |
| FFmpeg | `@wokcito/ffmpeg-kit-react-native` (v6.1.2) | 1080p proxy transcode + final export |
| DCIM | `expo-media-library` | Save exports to `DCIM/loopd/` |
| Camera roll | `expo-image-picker` / `expo-document-picker` / `expo-media-library` | Clip import |
| Secrets | `expo-secure-store` | Notion token, AI keys |

---

## 8. Tech Stack

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

Target platform: **Android only** (the prebuilt `android/` directory is committed; iOS is not currently supported). Java 17 and Android SDK Platform-Tools required for local builds.

---

## 9. Architectural Principles

Captured here because they're load-bearing for anyone editing this codebase:

1. **DB is the single source of truth.** The UI displays exactly what's in SQLite — no frontend filtering of records, no hiding via conditional rendering. If data shouldn't be shown, delete it from the DB.
2. **Save to DB on every keystroke.** Silent, no-state-update DB writes. Refs hold pending values for focus logic only.
3. **Always read DB before deleting.** Auto-commit timers and cleanup effects must verify the latest row state before deciding anything destructive.
4. **Never clear live refs in focus cleanup.** `useFocusEffect` cleanups can race idle timers; clearing `liveTextRef` during cleanup caused past data loss.
5. **Don't auto-delete during sync.** Automatic empty-entry cleanup only runs on explicit user-initiated page loads — never inside a sync operation.

These live in full in [CLAUDE.md](../CLAUDE.md). Treat them as non-negotiable — each one traces back to a data-loss bug.
