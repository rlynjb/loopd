# loopd — Product & Technical Spec

Last updated: 2026-04-26

A solo-dev, native Android daily-vlogging app. Combines a journal (text + habits + clips) with a lightweight AI-assisted video editor, a "drops" system that extracts structured records (todos, nutrition) from inline prefix markers in prose, an LLM-assisted "thinking modes" layer that categorizes todos and produces structured expansions, and on-device SQLite as the source of truth, with optional bidirectional Notion sync.

Operational setup, build, and deploy instructions live in [`README.md`](../README.md). This doc is the "what the app does and how it's put together" reference for new contributors and future-me.

---

## 1. Purpose & Shape

loopd turns everyday captures (short clips, text jots, habit checkmarks, marked-up todos and nutrition lines) into a per-day archive with a one-tap vlog render. Core loop:

1. Throughout the day: open the journal for today's date, jot text, check off habits, capture/import clips, and tag actionable lines with simple inline markers (`[] task`, `** food 320 kcal`).
2. At commit time the prose is scanned: marked lines flow into typed records (todos in `todos_json` + `todo_meta`, nutrition in its own table) without leaving the prose itself.
3. Todos get a thinking-mode classification (heuristic-first, LLM fallback). Non-todo modes (idea / bug / question / decision / knowledge / content) gain a tap-to-expand affordance that produces structured AI output via per-type prompts.
4. End of day: tap into the editor — AI auto-composes clip order, trims, and text overlays from the day's entries.
5. Tweak in the editor (timeline / text / filter tabs), export to MP4 (saved to DCIM/loopd and sharable).
6. Optional: Notion syncs entries + todos (with all thinking-mode fields) bidirectionally.

Native-only (React Native / Expo), runs on a development build — not Expo Go, not web.

---

## 2. Drops — the inline-marker idiom

A core architectural pattern. **Drops are inline prefix markers in journal prose that the app scans on entry commit and extracts as typed records.** The prose stays the canonical source — drops are derived state, kept in sync via a two-pass scanner.

Currently shipped:

| Marker | Trigger | Destination | Extracted fields |
|---|---|---|---|
| `[]` / `[ ]` / `[x]` | line start (optional `- ` bullet, optional whitespace) | `entries.todos_json` + `todo_meta` row | `text`, `done`, plus thinking-mode metadata (see §6.4) |
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
- **Backfill migrations**, all SecureStore-gated:
  - `drops_backfill_v1_done` — todos `[]` markers in pre-existing entries
  - `nutrition_backfill_v1_done` — `** food N kcal` markers
  - `todo_meta_backfill_v1_done` — `todo_meta` rows for every existing todo (heuristic-only; no LLM in backfill)
- **Classifier catch-up** (Phase B): boot-time pass that walks every meta row whose `classifier_confidence IS NULL`, skips done-or-overridden rows, and runs the cheap LLM classifier. Self-quiet when no AI is configured.

### `app/index.tsx` — Home / Dashboard
- Greeting (time-of-day).
- "Today's Vlog" card — same shape as past-vlog cards; or a "Start Today's Vlog" CTA if empty.
- `total kcal` stat under the vlog card — regex `/(\d+(?:[.,]\d+)?)\s*kcal\b/gi` sums every kcal mention across today's entry text. Catches both bare `N kcal` and `** food N kcal` lines.
- 14-day Habits heatmap.
- `SmartTodoList` — last 5 ranked todos via [rankTodos](../src/services/todos/rank.ts) (carryover-from-yesterday → AI → journal priority). Each row gets the type badge (when non-todo) so the dashboard answers "what should I attend to?" with category context. Toggle/edit round-trips into source prose.
- Previous Vlogs — archive section.

### `app/journal/[date].tsx` — daily journal
Dynamic route keyed by `YYYY-MM-DD`. Inline entries with text + habits + clips. Key behaviors:

- **DB-first autosave** on every keystroke (`liveTextRef`, `handleSilentNewText`) — see [CLAUDE.md § Autosave Rules](../CLAUDE.md). Silent saves bypass scanners (no churn mid-word).
- **Commit-time scanners** run from [useEntries.editEntry](../src/hooks/useEntries.ts) when text changes:
  - `scanTodosFromText` merges `[]` matches into `todos_json`.
  - `reconcileTodoMetaForEntry` (fire-and-forget) inserts paired `todo_meta` rows for new todos, runs heuristic, fires LLM classifier if heuristic returned null and the todo isn't done.
  - `scanNutritionForEntry` (fire-and-forget) reconciles `** … kcal` lines against the `nutrition` table.
- **Keyboard toolbar** quick actions: Todo (inserts `[] ` at cursor), Clip (pick/record video), Habit.
- **Nutrition autocomplete** — when the cursor sits after a `** ` marker on the active line (line-start OR inline preceded by whitespace), [NutritionAutocomplete](../src/components/journal/NutritionAutocomplete.tsx) renders a horizontal chip bar above the keyboard toolbar.
- Clip import → parallel 1080p H.264 proxy transcode (in-order commit).
- "Vlog" button appears once any clips exist → routes to `/editor/[date]`.

### `app/editor/[date].tsx` — vlog editor
Three tabs under a resizable preview (`windowHeight * 0.45` default, draggable 100–1000):
- **TIMELINE** (default on load): clip strip with playhead + per-clip trim/split/reorder/delete controls.
- **TEXT**: selects an overlay → `TextOverlaySheet`. Header button: **REGENERATE WITH AI**.
- **FILTER**: single active filter (brightness / contrast / saturate preset).

Auto-compose on mount; export pipeline renders text overlays to a Skia canvas → FFmpeg transcode → writes to `exports/[date]/…mp4` and DCIM/loopd → offers `Sharing.shareAsync`.

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
- **Flat list, newest first** by `createdAt` DESC. Done items strikethrough in chronological place.
- Per-row affordances (in `metaRow`):
  - `TypeBadge` — colored pill with type icon + label. **No badge for plain `'todo'` rows** — the absence is the signal. Confidence "?" appears on medium/low rows. Tap → `TypeChangePicker`.
  - `StageBadge` — always visible; shows "Open" / "In Progress" / "Backlog". Tap → `StageChangePicker`.
  - `[expand]` (accent) on non-todo rows without an expansion → routes to `/todos/[id]`.
  - `● expanded` (green) on non-todo rows that already have one → same route, view-mode.
  - Relative time + linkable source date.
- Long-press the text → opens `TypeChangePicker` (alternate path).
- **Classifier toast** — absolutely-positioned, debounced; shows `classifying N todos…` while the LLM is in flight. Doesn't shift list layout.
- **AI-not-configured banner** — persistent inline prompt when ambiguous rows exist and no AI key is set. Tap → `/settings/ai`.

### `app/todos/[id].tsx` — full-page expansion view
Full-screen route for the structured AI output. Header (back chevron + type label), scrollable body (original-todo quote + rendered markdown), sticky footer (above the bottom nav, doesn't fight Android's gesture bar):
- **`change type`** → opens the `TypeChangePicker` sheet
- **`re-expand`** (when an expansion already exists) → Alert confirm → overwrites `expanded_md`/`expanded_at`/`model`

Auto-triggers expansion on mount when the row has no `expanded_md` and a non-todo type. Subscribes to `EXPAND_PROGRESS_EVENT` so cross-screen completions surface here too.

### `app/nutrition.tsx` — nutrition log
Flat list of every nutrition row from the local table, newest first. Each row shows food name, source date, and kcal. Tap to jump to the source journal day.

### `app/settings/`
- [`index.tsx`](../app/settings/index.tsx) — menu.
- [`ai.tsx`](../app/settings/ai.tsx) — provider toggle (Claude Sonnet 4.6 or GPT-4o), API-key input, Test Connection.
- [`notion-sync.tsx`](../app/settings/notion-sync.tsx) — manual full-sync, entries DB ID, todos DB ID, auto-sync toggle, reset-sync-timestamp.
- [`notion-guide.tsx`](../app/settings/notion-guide.tsx) — seven-step setup guide. Todos DB section now lists ten properties including the five thinking-mode fields (Type / Expanded / Model / Confidence / User Overridden) plus a "don't edit Name in Notion" hint.
- [`updates.tsx`](../app/settings/updates.tsx) — manual OTA check.

---

## 5. Data Model

### SQLite (expo-sqlite) — [src/services/database.ts](../src/services/database.ts)

Nine tables.

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
| `todo_meta` | `todo_id` | `entry_id`, `entry_date`, `type`, `stage`, `expanded_md`, `expanded_at`, `model`, `classifier_confidence`, `classifier_model`, `user_overridden_type`, `created_at`, `updated_at` | 1:1 with each `TodoItem` in `todos_json`. CHECK enforces enums on `type` (7 values), `stage` (3 values), `classifier_confidence` (4 values + null) |

Indexes on `entries(date)`, `entries(notion_page_id)`, `entries(updated_at)`, `projects(date)`, `habits(notion_page_id)`, `nutrition(entry_id)`, `nutrition(entry_date)`, `nutrition(name COLLATE NOCASE)`, `nutrition(notion_page_id)`, `todo_meta(entry_id)`, `todo_meta(entry_date)`, `todo_meta(type)`, `todo_meta(updated_at)`, `todo_meta(created_at)`.

### Key TypeScript types — [src/types/](../src/types/)

- **`Entry`** ([entry.ts](../src/types/entry.ts)) — `{ id, date, text, habits[], todos[], clipUri?, clipDurationMs?, clips[], createdAt, notionPageId?, updatedAt? }`
- **`TodoItem`** — `{ id, text, done, completedAt?, createdAt?, sourceLine?, notionPageId? }`. `notionPageId` is the canonical Notion-row reference (no duplicate field on `TodoMeta`).
- **`Habit`** — `{ id, label, sortOrder, notionPageId?, updatedAt? }`
- **`Vlog`** — `{ id, date, clipCount, habitCount, caption?, durationSeconds, exportUri?, createdAt }`
- **`NutritionEntry`** ([nutrition.ts](../src/types/nutrition.ts)) — `{ id, name, kcal, entryId, entryDate, sourceLine?, notionPageId?, createdAt, updatedAt? }`
- **`NutritionSuggestion`** — autocomplete row shape.
- **`ClipItem`** ([project.ts](../src/types/project.ts)) — `{ id, entryId, clipUri, caption?, durationMs, trimStartPct, trimEndPct, order, color }`
- **`TextOverlay`** / **`FilterOverlay`** / **`EditorProject`** — editor types.
- **`AISummary`** ([ai.ts](../src/types/ai.ts)).
- **`TodoType`** ([todoMeta.ts](../src/types/todoMeta.ts)) — `'todo' | 'idea' | 'bug' | 'question' | 'decision' | 'knowledge' | 'content'`.
- **`TodoStage`** — `'todo' | 'in_progress' | 'backlog'`. Internal value `'todo'` surfaces as **"Open"** in the UI.
- **`ClassifierConfidence`** — `'high' | 'medium' | 'low' | 'heuristic'`.
- **`TodoMeta`** — `{ todoId, entryId, entryDate, type, stage, expandedMd?, expandedAt?, model?, classifierConfidence?, classifierModel?, userOverriddenType, createdAt, updatedAt }`. **No `notionPageId`** — sync code joins `TodoItem ↔ TodoMeta` and uses the single id from `TodoItem`.
- **Six per-type expansion shapes** — `IdeaExpansion`, `BugExpansion`, `QuestionExpansion`, `DecisionExpansion`, `KnowledgeExpansion`, `ContentExpansion`, plus a discriminated `TodoExpansion` union and `ExpandableType = Exclude<TodoType, 'todo'>`.

---

## 6. Core Features

### 6.1 Journal & Entries
DB-first autosave (every keystroke → SQLite, no React state churn). Drops (todos, nutrition) extract from prose at commit time only — never on keystroke. Empty-entry cleanup runs on focus blur, never inside sync.

### 6.2 Habits & Heatmap
Globally-defined habits; per-entry logging via `habits_json`. Dashboard renders a 14-day Sunday-anchored heatmap per habit.

### 6.3 Todos (checkbox drop)
Todos live as `[]` / `[x]` lines in entry prose. The scanner ([scanTodos.ts](../src/services/todos/scanTodos.ts)) merges them into `entries.todos_json` at commit time. Two-pass matching (text + line-index via `sourceLine`) keeps row identity through edits.

[`src/services/todos/rank.ts`](../src/services/todos/rank.ts) ranks the dashboard's `SmartTodoList` (carryover-from-yesterday → AI → journal). [updateTodo](../src/services/todos/crud.ts) round-trips dashboard interactions back into source prose via `rewriteTodoLine`.

### 6.4 Thinking Modes (per-todo classification + structured expansion)
Every `TodoItem` has a paired `todo_meta` row. The 1:1 invariant is enforced by [reconcileMeta.ts](../src/services/todos/reconcileMeta.ts), which runs fire-and-forget after every entry commit.

**Two-stage classification** (heuristic first, LLM fallback):
1. **[heuristicClassify.ts](../src/services/todos/heuristicClassify.ts)** — free, fast. ~50 imperative verbs, modal phrases (`gotta X`, `need to X`), and deadline patterns (`by today`, `eod`, etc.) return `'todo'`. Question-shape lines and speculative starts return `null`. Heuristic intentionally over-fires on null (false negatives cost a cheap LLM call; false positives cost a manual override).
2. **[classify.ts](../src/services/todos/classify.ts)** — when heuristic returns null AND the todo isn't done, fires the cheapest configured model (`gpt-4o-mini` or `claude-haiku-4-5-20251001`) for a single-pass `{type, confidence}` JSON. Module-level in-flight counter exposed via `CLASSIFY_PROGRESS_EVENT` for the toast UI. Boot-time catch-up via `classifyAmbiguousMeta()` walks unclassified, not-done rows.

**`user_overridden_type` lock** — once the user manually picks a type via the picker, `userOverriddenType=1` and the row is locked from future re-classification (per spec §5.5).

**Stage** (orthogonal to type and done): `'todo'` (default; surfaces as "Open"), `'in_progress'`, `'backlog'`. Per-row `StageBadge` always visible; `StageChangePicker` for changes.

**Expansion** (Phase C — manual, never automatic):
- Six per-type prompts in [expandPrompts.ts](../src/services/todos/expandPrompts.ts) with chain-of-thought reasoning preambles.
- [expand.ts](../src/services/todos/expand.ts) orchestrator uses the **primary** model (Sonnet 4.6 / GPT-4o), 3-concurrent cap, malformed-JSON auto-retry once with stricter instruction, validates per-type shape.
- [expandSerialize.ts](../src/services/todos/expandSerialize.ts) renders the JSON to compact markdown stored in `expanded_md`.
- Context block (sibling todos + last 3 days of entries with cached AI summaries) is capped at 1000 chars per recent entry to keep tokens bounded.
- View at [`app/todos/[id].tsx`](../app/todos/[id].tsx) — full-page route, not a modal; sticky footer above the bottom nav.

### 6.5 Nutrition (suffix-style drop)
Each `** <food> <N> kcal` line in prose becomes a row in the `nutrition` table, tagged to its source entry and date. Two rows for the same food on the same day = two intake events.

Scanner: [scanNutrition.ts](../src/services/nutrition/scanNutrition.ts). Two-pass matching: exact `(name, kcal)` then line-index. Unmatched existing rows are **deleted** (unlike todos, nutrition rows correspond 1:1 to prose lines).

Autocomplete: [NutritionAutocomplete](../src/components/journal/NutritionAutocomplete.tsx) detects the `** ` marker and renders chips with most-recent kcal values. Tap inserts `<name> <kcal> kcal `.

### 6.6 Vlog Editor
Implementation details:
- `ClipTimeline` uses reanimated shared values so the playhead extrapolates between `onProgress` callbacks without re-renders.
- `PreviewPlayer` uses two video slots; the next clip is preloaded into the inactive slot for seamless transitions.
- Stale `currentTime=0` progress events after scrub→play are suppressed.

### 6.7 AI composition (vlog summary)
[src/services/ai/](../src/services/ai/) — provider-agnostic (Sonnet 4.6 or GPT-4o). `summarize.ts` produces a structured `AISummary`; `compose.ts` maps it onto `ClipItem[]` + `TextOverlay[]` + `FilterOverlay[]`. Cached in `ai_summaries` per date.

### 6.8 Media Pipeline
Full details in [docs/media-pipeline.md](./media-pipeline.md). 1080p H.264 proxy transcode on import (CRF 23) via `@wokcito/ffmpeg-kit-react-native`. Parallel-transcode + in-order-commit. Missing clips re-imported via `clipMatcher.ts`.

### 6.9 Notion Sync
[src/services/notion/sync.ts](../src/services/notion/sync.ts):

- **`syncAll()`** — Entries DB. Pulls + pushes entries, merges habits vocabulary, archives queued deletions, runs `reimportMissingClips`.
- **`syncAllTodos()`** — Optional second DB. Single schema fetch at start; thread title-column + missing-property set through pull + push. Per spec §11.2:
  - **`text`** — prose-canonical; Notion edits to Title are dropped.
  - **`done`** — bidirectional (last-edited-time merge).
  - **`type`** — Notion change → flip `userOverriddenType=1` (treated as manual override).
  - **`expanded_md`** — pull-down on diff (Notion is read-canonical when local is empty).
  - **`model` / `classifier_confidence` / `user_overridden_type`** — pull-down on diff.
  - **New-from-Notion** — appends `[]` / `[x]` line to today's most recent entry's prose, mints `TodoItem` with Notion's loopdId so the next scan text-pairs cleanly. Paired `TodoMeta` inserted with `userOverriddenType=true`.
- Schema-gap detection via `detectMissingTodoProperties`; missing properties listed in `result.debug` (existing DBs without Phase-D properties continue to sync, just without the new fields).
- `expanded_md` is split across multiple rich-text blocks for Notion's 2000-char-per-block cap.

Deletions queued in `sync_deletions` per `entity_type` (`entry`, `todo`, `habit`, `nutrition`).

### 6.10 OTA Updates
`expo-updates` checks on every app open. Background fetch + restart prompt.

---

## 7. Service Layer — `src/services/`

| Path | Purpose |
|---|---|
| `database.ts` | SQLite schema, migrations, CRUD for entries / habits / projects / vlogs / nutrition / todo_meta; sync-deletion queue; AI summary cache |
| `fileManager.ts` | Pick / record / copy clip; DCIM save; ensure app dirs |
| `ffmpeg.ts`, `ffmpegCommand.ts` | FFmpeg wrapper + 1080p H.264 transcode command builder |
| `clipMigration.ts` | Backfills 1080p proxies for pre-transcode clips |
| `clipMatcher.ts` | Re-sources missing clips from camera roll |
| `exportPipeline.ts` | Final vlog transcode & mux |
| `textBitmap.ts`, `textRenderer.tsx` | Rasterizes text overlays via Skia |
| `todos/scanTodos.ts` | `[]`/`[x]` parser; two-pass merge against `todos_json`; `rewriteTodoLine` for dashboard round-trip |
| `todos/migrate.ts` | One-time backfill of `[]` markers in pre-existing entries (SecureStore-gated) |
| `todos/rank.ts` | Ranking + relative-time formatting for the dashboard `SmartTodoList` |
| `todos/crud.ts` | Entry-scoped todo CRUD; round-trips done/text into prose; enqueues `sync_deletion` |
| `todos/typeMeta.ts` | Single source for type icon/label/color/order |
| `todos/heuristicClassify.ts` | Free heuristic — text → `'todo'` \| null |
| `todos/classify.ts` | Cheapest-model LLM classifier; module in-flight counter |
| `todos/reconcileMeta.ts` | Inserts/deletes paired `todo_meta` rows on every entry commit; fires classifier for ambiguous, not-done todos |
| `todos/migrateMeta.ts` | One-time `todo_meta` backfill (heuristic only) + `classifyAmbiguousMeta` boot catch-up + `countAmbiguousNotDone` |
| `todos/stageMeta.ts` | Stage icon/label/color (default `'todo'` surfaces as "Open") |
| `todos/expandPrompts.ts` | Six system prompts with reasoning preambles + JSON schemas + context-block builder |
| `todos/expandSerialize.ts` | Per-type JSON → markdown templates |
| `todos/expand.ts` | Expansion orchestrator (primary model, 3-concurrent cap, malformed-JSON auto-retry) |
| `nutrition/scanNutrition.ts` | `** food N kcal` parser; two-pass reconcile against the nutrition table |
| `nutrition/migrate.ts` | One-time nutrition backfill (SecureStore-gated) |
| `ai/config.ts` | Claude/OpenAI key + provider storage |
| `ai/prompt.ts`, `ai/summarize.ts`, `ai/compose.ts`, `ai/validate.ts` | Vlog summary prompts, LLM calls, compose, validation |
| `notion/api.ts` | `queryDatabase`, `createPage`, `updatePage`, `archivePage`; module-singleton 350ms rate-limiter + 429 retry |
| `notion/config.ts` | Token, DB IDs, per-sync timestamps, auto-sync flag |
| `notion/mapper.ts` | Entries DB bidirectional property mapping |
| `notion/todosMapper.ts` | Todos DB mapping; reads/writes thinking-mode fields with missing-property tolerance via `availableProperties` set; `detectMissingTodoProperties` for schema-gap detection |
| `notion/sync.ts` | Orchestrators `syncAll` and `syncAllTodos` |

---

## 8. External Integrations

| Integration | Library / endpoint | Used for |
|---|---|---|
| Anthropic | `@anthropic-ai/sdk` (v0.90.0), `claude-sonnet-4-6` (primary) / `claude-haiku-4-5-20251001` (classifier) | Vlog summary, expansion, classifier |
| OpenAI | `fetch` to `api.openai.com`, `gpt-4o` (primary) / `gpt-4o-mini` (classifier) | Alt provider |
| Notion | `fetch` to `api.notion.com/v1` | Two-way sync of entries + todos (with thinking-mode fields) |
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

1. **DB is the single source of truth.** UI displays exactly what's in SQLite — no frontend filtering, no hiding via conditional rendering.
2. **Prose is canonical for drops.** `[]` lines and `** … kcal` lines in `entries.text` are the source; `todos_json`, `todo_meta`, and the `nutrition` table are derived. Round-trips (e.g. dashboard toggle → prose rewrite) keep prose authoritative. Notion never edits source prose — Title-field edits in the Todos DB are dropped on next push.
3. **Save to DB on every keystroke.** Silent, no-state-update DB writes. Refs hold pending values for focus logic only. **Scanners do not run on keystroke** — only at commit (focus blur, screen leave, explicit save).
4. **Always read DB before deleting.** Auto-commit timers and cleanup effects must verify the latest row state before deciding anything destructive.
5. **Never clear live refs in focus cleanup.** `useFocusEffect` cleanups can race idle timers; clearing `liveTextRef` during cleanup caused past data loss.
6. **Don't auto-delete during sync.** Automatic empty-entry cleanup only runs on explicit user-initiated page loads.
7. **Two-pass matching is the way.** Any feature that derives records from prose lines uses `(exact match, then line-index fallback)` so users can edit content in place without losing record identity.
8. **Backfills are SecureStore-gated, one-time.** Any new prose-derived feature ships with a one-time backfill so existing entries pick up the new markers; gate it with a flag (`<feature>_backfill_v<N>_done`) so it never runs twice.
9. **Classifier output is editable; user override is permanent.** Any AI-assigned attribute on a derived row must be overridable by the user, and the override must lock that attribute from future AI mutation. The `user_overridden_type` flag pattern is the template.
10. **Heuristic before LLM.** When a feature needs classification, scoring, or routing, try a deterministic heuristic first. Only fall through to an LLM call when the heuristic is uncertain. Cheaper, faster, and more debuggable.

These live in full in [CLAUDE.md](../CLAUDE.md). Treat them as non-negotiable — each one traces back to a data-loss bug or a deliberate-cost decision.
