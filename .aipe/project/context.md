# Project context

buffr — a solo-dev, native Android daily-vlogging app. Combines a journal (text + habits + clips) with an AI-assisted vlog editor, a "drops" pattern that extracts typed records (todos, nutrition, thread mentions) from inline prefix markers in prose, an LLM-assisted "thinking modes" classifier + per-type expansion for todos, a `#tag` thread system for project attribution, a daily-schedule weekly grid on the dashboard, and a Supabase Postgres cloud-sync mirror with local SQLite as canonical.

Operational details in [`README.md`](../../README.md). Full architecture reference in [`docs/spec.md`](../../docs/spec.md). Companion design docs in [`docs/`](../../docs/) (cloud sync, daily schedule grid, caption variants, thinking modes, today-habits-threads, media pipeline, relatable caption).

## Stack

- **Runtime / framework:** React Native 0.83.2 + Expo SDK 55, TypeScript 5.9 strict.
- **Routing:** `expo-router` 55 (file-based, `app/` directory).
- **Local DB:** `expo-sqlite` 55 (WAL journal mode), file `buffr.db`.
- **Cloud sync:** `@supabase/supabase-js` v2 + `react-native-url-polyfill`. Postgres mirror at Supabase, RLS scaffolded but disabled in Phase A (single hardcoded user_id).
- **AI:** `@anthropic-ai/sdk` (Claude Sonnet 4.6 primary / Haiku 4.5 classifier) + raw `fetch` to OpenAI (GPT-4o / GPT-4o-mini). Provider-agnostic at the service layer.
- **Media:** `@wokcito/ffmpeg-kit-react-native` 6.1.2 for transcode + export, `react-native-video` 6.19.1 for playback.
- **Animations / gestures:** `react-native-reanimated` 4.2.1 + `react-native-worklets` 0.7.1, `react-native-gesture-handler` 2.30.0.
- **Secrets:** `expo-secure-store` 55 (Android Keystore-backed).
- **Platform:** Android only. Prebuilt `android/` directory committed; iOS not supported.

## Data model

12 SQLite tables in `buffr.db`. 10 of those mirror to Supabase Postgres; the other 2 are local-only.

**Synced entity tables (mirrored to Supabase):**

- `entries` — daily journal rows. Prose is canonical for drops. Columns include `text`, `habits_json`, `todos_json`, `clips_json`, `clip_uri` (legacy single-clip), `created_at`, `updated_at`, `synced_at`, `deleted_at`.
- `projects` — editor scratch state per date (clip trims, text overlays, filter overlays). UNIQUE on `(user_id, date)`.
- `vlogs` — archive of exported vlogs. `export_uri` is device-local.
- `day_meta` — per-day user-renameable title (`(user_id, date)` PK).
- `ai_summaries` — cached AI composition per date. `summary_json` carries the structured AISummary + the new 4-variant tonal captions (`variants` keyed by clean / smoother / reflective / punchy + `variantsTheme`). PK `(user_id, date)`.
- `nutrition` — one row per `** food N kcal` line in prose.
- `habits` — user's repeatable disciplines + cadence (`cadence_type`, `cadence_days`, `cadence_count`) + `time_of_day` bucket.
- `todo_meta` — 1:1 with each TodoItem in `entries.todos_json`. Holds `type`, `expanded_md`, `classifier_confidence`, `user_overridden_type`, `pinned`. CHECK constraints on `type` (7 values) + `stage` (3 values, deprecated).
- `threads` — `#tag` project metadata. `slug` UNIQUE per user (case-insensitive).
- `thread_mentions` — junction. App-level invariant: at least one of `entry_id` / `todo_id` is set, **except** for the manual-touch deviation (both NULL when written by `toggleThreadTouchToday`).

**Cloud-sync columns added to every synced table:** `synced_at TEXT` (last successful push timestamp; LOCAL ONLY), `deleted_at TEXT` (soft-delete timestamp; reads filter `WHERE deleted_at IS NULL`).

**Local-only:**

- `sync_meta` — per-table sync ledger (`last_pull_at`, `last_push_at`, `pending_pushes`, `last_error`).
- `sync_deletions` — **deprecated** Notion-era outbox; not written to anymore but kept on the schema.

**Dead-but-kept columns on `todo_meta`:** `stage` (TEXT NOT NULL DEFAULT 'todo'; no UI reads it), `position` (INTEGER nullable; replaced by `pinned`). On entity tables: `notion_page_id`, `notion_last_synced` from the deleted Notion sync layer.

## File structure

- `app/` — file-routed screens. `_layout.tsx` is the boot path. Dynamic segments via `[param]`. `editor/[date].tsx`, `journal/[date].tsx`, `todos.tsx`, `todos/[id].tsx`, `threads/[id].tsx`, `more/{habits,threads,nutrition,index}.tsx`, `settings/{ai,cloud-sync,index,updates}.tsx`.
- `src/services/` — domain logic. Subdirs: `ai/` (summarize / caption / compose / validate / config / prompt), `todos/` (scan, classify, reconcile, expand, crud), `nutrition/` (scan + migrate), `habits/` (cadence + migrate), `threads/` (scan, crud, staleness, touch, getThreadCards, getThreadDetail, migrate), `sync/` (client, push, pull, firstPull, conflict, orchestrator, bootstrap, schedulePush, syncMeta, devActions, types, tables/*). Plus `database.ts`, `fileManager.ts`, `ffmpeg.ts`, `ffmpegCommand.ts`, `clipMigration.ts`, `exportPipeline.ts`, `textBitmap.ts`, `textRenderer.tsx`.
- `src/components/` — UI. Subdirs: `home/` (HomeHeader, SmartTodoList, DailyScheduleGrid, DailyScheduleHeader, OffDayToggle, DailyScheduleLegend, AISummaryCard, PastVlogCard, cellState), `journal/`, `editor/`, `todos/`, `threads/`, `nav/`, `timeline/`, `ui/` (Icon, etc.).
- `src/hooks/` — `useDatabase`, `useEntries`, `useDayTitle`, `useHabits`, `useExport`, `useProject`.
- `src/types/` — `entry.ts`, `ai.ts`, `todoMeta.ts`, `thread.ts`, `nutrition.ts`, `project.ts`, `common.ts`. `notion.ts` is orphan (no importers; safe to delete).
- `src/constants/` — theme tokens, app constants.
- `src/utils/` — generators (`generateId`), time helpers.
- `supabase/migrations/` — Postgres DDL. 0001 schema, 0002 RLS (disabled), 0003 server-time RPC, 0004 relax FKs, 0005 todo_meta.pinned. Applied via `node scripts/db-migrate.mjs --all-pending`.
- `scripts/` — `db-migrate.mjs` (Supabase migration runner using `pg` + `dotenv`).
- `docs/` — design specs + plans + the canonical reference at `spec.md`. Interview-prep chapters are at `.aipe/specs/interview/`.
- `android/` — committed prebuilt native project. Build via `gradlew :app:assembleRelease` then `adb install -r`.

## What must not change

- **The 12 architectural principles** in [`docs/spec.md`](../../docs/spec.md) §10 — most importantly:
  - **DB is single source of truth.** UI displays exactly what's in SQLite.
  - **Prose is canonical for drops.** `[]`, `** food N kcal`, `#tag` mentions in `entries.text` are the source; derived state (`todos_json`, `todo_meta`, `nutrition`, `thread_mentions`) is rebuilt from prose at commit time.
  - **DB-first autosave on every keystroke.** Scanners run only at commit (focus blur, screen leave).
  - **Two-pass matching** (exact match → line-index fallback) for every prose-derived feature.
  - **Soft delete only.** Every CRUD delete stamps `deleted_at` + bumps `updated_at`. Reads filter `WHERE deleted_at IS NULL`. Hard delete is reserved for the future 30-day vacuum (deferred).
  - **Cloud is a sync mirror, never the canonical source.** Reads always hit local SQLite. Writes commit local first; cloud lags by 5s via debounced push.
- **The 1:1 invariant** between each TodoItem in `entries.todos_json` and a `todo_meta` row, enforced by `reconcileMeta.ts`. Don't add a real foreign key (SQLite can't FK to a JSON-array element; the application reconciler is the enforcement mechanism).
- **`user_overridden_type` lock** — once a user manually picks a thinking-mode type, AI-driven re-classification must not change it. The flag is the canonical pattern for any AI-assigned attribute that should be user-overridable.
- **Slug-as-local-canonical** for `threads` — slug renames are local-only and would invalidate existing `thread_mentions` reconciliation, so they're handled carefully through the threads CRUD only.
- **The manual-touch deviation** in `services/threads/touch.ts` (Principle 11) — writes a `thread_mentions` row with NULL `entry_id` AND NULL `todo_id` to mark a thread "done today" from the dashboard. The schema permits it; the staleness math composes uniformly.
- **Composite `(user_id, id)` PKs in Postgres** — every synced cloud table uses this pattern so cross-user isolation holds at the schema level (RLS is the runtime gate; this is the schema gate).
- **Supabase migrations are append-only.** Never edit a committed migration file; add a new one.
- **`schedulePush()` from every database.ts write.** New write paths must call it (or go through a function that does) so edits propagate to cloud.

## Common pitfalls

- **Adding a new column to `todo_meta`?** Update mapper in `database.ts`, `insertTodoMeta`, `updateTodoMeta`, `TodoMetaRow` in `sync/tables/todoMeta.ts`, and write a Supabase migration. Defaults must round-trip on legacy rows.
- **Adding a new write site outside `database.ts`?** It still needs to bump `updated_at` and trigger `schedulePush()` (or call a database.ts function that does both). Otherwise the write won't sync to cloud.
- **Adding a new screen that reads a synced table directly via raw SQL?** Add `WHERE deleted_at IS NULL` to the query — no exception. The sync layer is the only place that intentionally sees soft-deleted rows.
- **Modifying the editor's auto-compose flow?** It reads from cached `ai_summaries.summary_json`. New fields go in `validate.ts` for round-trip and `compose.ts` for consumption.
