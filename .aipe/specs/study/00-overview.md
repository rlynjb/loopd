# 00 — System overview

## Full system map

```
                              loopd — Android-only daily-vlogging app
─────────────────────────────────────────────────────────────────────────────────────────

   ┌────────────────────────── Device (single Android phone) ───────────────────────────┐
   │                                                                                    │
   │   ┌─ UI layer (React Native + expo-router file-based) ──────────────────────────┐  │
   │   │                                                                             │  │
   │   │  app/_layout.tsx ─ boot path                                                │  │
   │   │  app/index.tsx  ── Today (HomeHeader, SmartTodoList, DailyScheduleGrid,     │  │
   │   │                          AISummaryCard, PastVlogCard)                       │  │
   │   │  app/journal/[date].tsx   editor for one day's prose + clips                │  │
   │   │  app/editor/[date].tsx    vlog composer (clip trims, overlays)              │  │
   │   │  app/todos.tsx            flat ranked todo list                             │  │
   │   │  app/todos/[id].tsx       single-todo detail + AI expansion                 │  │
   │   │  app/threads/[id].tsx     thread (#tag) detail                              │  │
   │   │  app/more/{habits,threads,nutrition}.tsx                                    │  │
   │   │  app/settings/{ai,cloud-sync,index,updates}.tsx                             │  │
   │   │                                                                             │  │
   │   └──────────────────────┬──────────────────────────────────────────────────────┘  │
   │                          │ React state via hooks (useEntries, useDatabase,         │
   │                          │ useDayTitle, useHabits, useExport, useProject)          │
   │                          ▼                                                         │
   │   ┌─ Services layer (src/services/) ────────────────────────────────────────────┐  │
   │   │                                                                             │  │
   │   │   database.ts ── single mouth to SQLite. Every write also calls             │  │
   │   │                  schedulePush() so cloud catches up later.                  │  │
   │   │                                                                             │  │
   │   │   ai/         summarize · caption (4-variant) · compose · validate          │  │
   │   │              prompt · config (SecureStore-backed keys)                      │  │
   │   │                                                                             │  │
   │   │   todos/      scanTodos ─ extract [] lines from prose                       │  │
   │   │              reconcileMeta ─ keep todo_meta 1:1 with todos_json             │  │
   │   │              heuristicClassify ─ regex-first, free                          │  │
   │   │              classify ─ Haiku/4o-mini fallback                              │  │
   │   │              expand ─ Sonnet/4o per-type expansion                          │  │
   │   │              rank, crud                                                     │  │
   │   │                                                                             │  │
   │   │   threads/    scanThreads ─ extract #tag from prose                         │  │
   │   │              getThreadCards ─ aggregate for Today                           │  │
   │   │              touch ─ manual "done today" tap on the grid                    │  │
   │   │              staleness ─ pure cadence math                                  │  │
   │   │                                                                             │  │
   │   │   nutrition/  scan ─ extract "** food N kcal" lines                         │  │
   │   │   habits/     cadence engine (isDueOn, needsMoreThisWeek)                   │  │
   │   │                                                                             │  │
   │   │   sync/       schedulePush ─ debounced 5s timer                             │  │
   │   │              orchestrator ─ pushAll / pullAll over registry                 │  │
   │   │              push, pull, conflict (LWW), bootstrap, firstPull               │  │
   │   │              tables/* ─ per-table mappers                                   │  │
   │   │                                                                             │  │
   │   │   ffmpeg.ts, exportPipeline.ts, fileManager.ts, textRenderer.tsx            │  │
   │   │                                                                             │  │
   │   └────┬─────────────────────────────────────┬──────────────────────────────────┘  │
   │        │ writes (SQL)                        │ media (filesystem)                  │
   │        ▼                                     ▼                                     │
   │   ┌─ Local SQLite (loopd.db, WAL) ────┐  ┌─ Files (expo-file-system) ──────────┐   │
   │   │ entries, projects, vlogs,         │  │ /document/loopd/clips/<date>/*.mp4  │   │
   │   │ day_meta, ai_summaries,           │  │ /document/loopd/exports/<date>.mp4  │   │
   │   │ nutrition, habits, todo_meta,     │  └─────────────────────────────────────┘   │
   │   │ threads, thread_mentions          │                                            │
   │   │ + sync_meta, sync_deletions       │  ┌─ SecureStore (Android Keystore) ────┐   │
   │   └────┬──────────────────────────────┘  │ anthropic_api_key, openai_api_key,  │   │
   │        │                                 │ ai_provider, supabase_*,            │   │
   │        │ debounced 5s push               │ cloud_initial_push_done, …backfills │   │
   │        ▼                                 └─────────────────────────────────────┘   │
   └────────┼───────────────────────────────────────────────────────────────────────────┘
            │
            │ HTTPS (supabase-js)
            ▼
   ┌─ Cloud (Supabase Postgres) ─────────────────────────────────────────────────┐
   │                                                                             │
   │  Mirror of 10 synced tables, composite (user_id, id) PKs.                   │
   │  RLS scaffolded but disabled in Phase A (single hardcoded user_id).         │
   │  Migrations applied via scripts/db-migrate.mjs (server-side `pg`).          │
   │                                                                             │
   │  RPC: get_server_time() — used by pull to avoid clock-skew bugs.            │
   └─────────────────────────────────────────────────────────────────────────────┘
            ▲
            │ HTTPS
            ▼
   ┌─ External LLM providers ────────────────────────────────────────────────────┐
   │                                                                             │
   │  Anthropic SDK ── claude-sonnet-4-6 (summarize, caption, expand)            │
   │                   claude-haiku-4-5 (classify)                               │
   │  raw fetch     ── gpt-4o (summarize, caption, expand)                       │
   │                   gpt-4o-mini (classify)                                    │
   └─────────────────────────────────────────────────────────────────────────────┘
```

## Component legend

- **app/** — file-routed expo-router screens. `_layout.tsx` is the boot path; dynamic segments use `[param]`. Talks to: hooks + services.
- **src/hooks/** — thin React state wrappers around services. Each one owns a query (`useEntries.getAllEntries`) and exposes mutators that delegate to services. Talks to: services/.
- **services/database.ts** — the only file that opens `loopd.db`. Owns the SQLite schema migration on first call, exposes typed CRUD functions, and calls `schedulePush()` on every write to a synced table. Talks to: SQLite, sync/schedulePush.
- **services/ai/** — provider-agnostic LLM service layer. Every call reads a SecureStore-stored key (Claude default, OpenAI alternate). Single-purpose chains: one for the structured summary, one for the 4-variant caption, one per todo expansion, one for the classifier. Talks to: external LLM APIs.
- **services/todos/** — drop-extraction pipeline. `scanTodos.scanTodosFromText` reads prose and produces a TodoItem[]; `reconcileMeta.reconcileTodoMetaForEntry` then patches the 1:1 todo_meta side. The classifier runs heuristic-first (free) and falls back to Haiku/4o-mini on ambiguous lines. `expand.expandTodo` runs Sonnet/4o for typed expansion (`idea`, `bug`, `question`, `decision`, `knowledge`, `content`).
- **services/threads/** — `#tag` extraction (`scanThreads.parseTags`), thread CRUD, and the `getThreadCards` aggregate that powers the Today view. `staleness.computeStaleness` is the pure cadence math. `touch.toggleThreadTouchToday` is the documented spec deviation — writes a `thread_mentions` row with NULL entry_id AND NULL todo_id.
- **services/nutrition/** + **services/habits/** — `nutrition/scan.ts` extracts `** food N kcal` lines; `habits/cadence.ts` is pure (`isDueOn`, `needsMoreThisWeek`, `isoWeekDates`).
- **services/sync/** — cloud mirror layer. `schedulePush()` is a debounced 5s timer fired by every database write. `orchestrator.pushAll`/`pullAll` walk a 10-table registry. `push.ts` queries `WHERE updated_at > synced_at` and upserts. `pull.ts` queries `WHERE updated_at > last_pull_at` and resolves conflict via `chooseWinner` (last-write-wins by `updated_at`). `bootstrap.ts` decides between initial-push, first-pull, no-op on first cold start.
- **services/ffmpeg.ts + textRenderer.tsx + exportPipeline.ts** — vlog export pipeline. `@wokcito/ffmpeg-kit-react-native` runs the transcode; `textRenderer` renders text overlays to a bitmap that ffmpeg overlays as a PNG. Talks to: filesystem, native ffmpeg.
- **SQLite (loopd.db)** — the single source of truth. WAL journal mode. 12 tables: 10 synced + 2 local-only (`sync_meta` ledger, deprecated `sync_deletions`). Reads always filter `WHERE deleted_at IS NULL`.
- **Filesystem** — clip URIs are device-local under `/document/loopd/clips/<date>/`. `clip_uri` columns hold absolute paths; `repairBareClipUris` defensively re-resolves any bare-filename leftovers from the deleted Notion sync code.
- **SecureStore** — Android Keystore-backed key/value. Stores LLM API keys, Supabase URL/anon key, the `cloud_initial_push_done` bootstrap flag, and per-feature backfill flags.
- **Supabase Postgres** — the cloud mirror, never canonical. Reads always go to local SQLite; cloud catches up asynchronously. Migrations are append-only files in `supabase/migrations/`.
- **External LLMs** — Anthropic + OpenAI. Provider switch lives in `src/services/ai/config.ts` and is read on every call.
