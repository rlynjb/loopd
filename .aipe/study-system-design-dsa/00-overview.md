# 00 — System overview

## Full system map

```
                              buffr — Android-only daily-vlogging app
─────────────────────────────────────────────────────────────────────────────────────────

   ┌────────────────────────── Device (single Android phone) ───────────────────────────┐
   │                                                                                    │
   │   ┌─ UI layer (React Native + expo-router file-based) ──────────────────────────┐  │
   │   │                                                                             │  │
   │   │  app/_layout.tsx ─ boot path                                                │  │
   │   │  app/index.tsx  ── Today (HomeHeader, SmartTodoList, DailyScheduleGrid,     │  │
   │   │                          AISummaryCard) — threads + per-row x dropped       │  │
   │   │                          2026-05-08; schedule locked to current week        │  │
   │   │  app/journal/[date].tsx   editor for one day's prose + clips +              │  │
   │   │                          Interpret modal (long-form AI reflection)          │  │
   │   │  app/editor/[date].tsx    vlog composer (clip trims, overlays)              │  │
   │   │  app/todos.tsx            flat todo list (pinned-first, createdAt DESC)    │  │
   │   │  app/todos/[id].tsx       single-todo detail + AI expansion                 │  │
   │   │  app/vlogs.tsx            dedicated vlogs page + bottom-nav tab (NEW       │  │
   │   │                          2026-05-08)                                        │  │
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
   │   │              interpret (long-form markdown, NEW 2026-05-10) ·               │  │
   │   │              prompt · config (SecureStore-backed keys)                      │  │
   │   │                                                                             │  │
   │   │   todos/      scanTodos ─ extract [] lines from prose                       │  │
   │   │              reconcileMeta ─ keep todo_meta 1:1 with todos_json             │  │
   │   │              heuristicClassify ─ regex-first, free                          │  │
   │   │              classify ─ Haiku/4o-mini fallback (5 modes: todo/idea/         │  │
   │   │                         knowledge/study/reflect; was 7 pre-2026-05-10)     │  │
   │   │              expand ─ Sonnet/4o per-type expansion (4 typed schemas)        │  │
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
   │   ┌─ Local SQLite (buffr.db, WAL) ────┐  ┌─ Files (expo-file-system) ──────────┐   │
   │   │ entries, projects, vlogs,         │  │ /document/buffr/clips/<date>/*.mp4  │   │
   │   │ day_meta, ai_summaries,           │  │ /document/buffr/exports/<date>.mp4  │   │
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
   │  All tables + RPC live in the `buffr` schema (migration 0010) so this       │
   │  project can host two other apps' tables in their own schemas later.        │
   │  RLS scaffolded but disabled in Phase A (single hardcoded user_id).         │
   │                                                                             │
   │  RPC: get_server_time() — used by pull to avoid clock-skew bugs.            │
   └─────────────────────────────────────────────────────────────────────────────┘
            ▲                                                ▲
            │ HTTPS                                          │ pg (server-side)
            │                                                │
            │                              ┌─ scripts/db-migrate.mjs (Node) ──────┐
            │                              │                                      │
            │                              │  Migration runner. Walks             │
            │                              │  supabase/migrations/0001..0010      │
            │                              │  in order against the Postgres       │
            │                              │  mirror. Driven manually by the      │
            │                              │  developer:                          │
            │                              │     node scripts/db-migrate.mjs      │
            │                              │       --all-pending                  │
            │                              │                                      │
            │                              │  Uses `pg` + `dotenv`. Not part of   │
            │                              │  the device runtime.                 │
            │                              └──────────────────────────────────────┘
            ▼
   ┌─ External LLM providers ────────────────────────────────────────────────────┐
   │                                                                             │
   │  Anthropic SDK ── claude-sonnet-4-6 (summarize, caption, expand, interpret) │
   │                   claude-haiku-4-5 (classify)                               │
   │  raw fetch     ── gpt-4o (summarize, caption, expand, interpret)            │
   │                   gpt-4o-mini (classify)                                    │
   │                                                                             │
   │  5 chains total. interpret (added 2026-05-10) is markdown-out, not JSON.    │
   └─────────────────────────────────────────────────────────────────────────────┘
```

## Component legend

- **app/** — file-routed expo-router screens. `_layout.tsx` is the boot path; dynamic segments use `[param]`. Talks to: hooks + services.
- **src/hooks/** — thin React state wrappers around services. Each one owns a query (`useEntries.getAllEntries`) and exposes mutators that delegate to services. Talks to: services/.
- **services/database.ts** — the only file that opens `buffr.db`. Owns the SQLite schema migration on first call, exposes typed CRUD functions, and calls `schedulePush()` on every write to a synced table. Talks to: SQLite, sync/schedulePush.
- **services/ai/** — provider-agnostic LLM service layer. Every call reads a SecureStore-stored key (Claude default, OpenAI alternate). Five single-purpose chains: structured summary, 4-variant caption, per-todo expansion, classifier, and the long-form `interpret` chain (added 2026-05-10). Interpret is the only one that emits markdown rather than JSON, and the only one whose output is not persisted (rendered in a modal, gone on close). Talks to: external LLM APIs.
- **services/todos/** — drop-extraction pipeline. `scanTodos.scanTodosFromText` reads prose and produces a TodoItem[]; `reconcileMeta.reconcileTodoMetaForEntry` then patches the 1:1 todo_meta side. The classifier runs heuristic-first (free) and falls back to Haiku/4o-mini on ambiguous lines. As of 2026-05-10 the classifier picks one of 5 thinking modes (`todo`, `idea`, `knowledge`, `study`, `reflect`) — was 7 pre-reduction; `bug`/`question`/`decision`/`content` were dropped in migration 0008. `expand.expandTodo` runs Sonnet/4o for typed expansion (4 schemas: `idea`, `knowledge`, `study`, `reflect` — `'todo'` is the non-expandable default).
- **services/threads/** — `#tag` extraction (`scanThreads.parseTags`), thread CRUD, and the `getThreadCards` aggregate that powers the Today view. `staleness.computeStaleness` is the pure cadence math. `touch.toggleThreadTouchToday` is the documented spec deviation — writes a `thread_mentions` row with NULL entry_id AND NULL todo_id.
- **services/nutrition/** + **services/habits/** — `nutrition/scanNutrition.ts` extracts `** food N kcal` lines; `habits/cadence.ts` is pure (`isDueOn`, `needsMoreThisWeek`, `isoWeekDates`).
- **services/sync/** — cloud mirror layer. `schedulePush()` is a debounced 5s timer fired by every database write. `orchestrator.pushAll`/`pullAll` walk a 10-table registry. `push.ts` queries `WHERE updated_at > synced_at` and upserts. `pull.ts` queries `WHERE updated_at > last_pull_at` and resolves conflict via `chooseWinner` (last-write-wins by `updated_at`). `bootstrap.ts` decides between initial-push, first-pull, no-op on first cold start.
- **services/ffmpeg.ts + textRenderer.tsx + exportPipeline.ts** — vlog export pipeline. `@wokcito/ffmpeg-kit-react-native` runs the transcode; `textRenderer` renders text overlays to a bitmap that ffmpeg overlays as a PNG. Talks to: filesystem, native ffmpeg.
- **react-native-video** — playback half of the media pipeline (v6.19.1). Renders `.mp4` clips trimmed from the day's recording inside the editor + journal screens. Pairs with the ffmpeg/export side: ffmpeg writes clips, `react-native-video` plays them back. Talks to: filesystem (reads `clip_uri` paths).
- **SQLite (buffr.db)** — the single source of truth. WAL journal mode. 12 tables: 10 synced + 2 local-only (`sync_meta` ledger, deprecated `sync_deletions`). Reads always filter `WHERE deleted_at IS NULL`.
- **Filesystem** — clip URIs are device-local under `/document/buffr/clips/<date>/`. `clip_uri` columns hold absolute paths; `repairBareClipUris` defensively re-resolves any bare-filename leftovers from the deleted Notion sync code.
- **SecureStore** — Android Keystore-backed key/value. Stores LLM API keys, Supabase URL/anon key, the `cloud_initial_push_done` bootstrap flag, and per-feature backfill flags.
- **Supabase Postgres** — the cloud mirror, never canonical. Reads always go to local SQLite; cloud catches up asynchronously. Migrations are append-only files in `supabase/migrations/`. As of `0010_namespace_to_buffr_schema.sql`, the 10 mirrored tables and the `get_server_time()` RPC live in a dedicated `buffr` schema; the JS client at `src/services/sync/client.ts` sets `db: { schema: 'buffr' }` so every `.from()` / `.rpc()` default-resolves there. Reason: the same Supabase project will eventually host two other apps' tables in their own schemas, so prefixing in `public` would collide.
- **scripts/db-migrate.mjs** — the migration runner. A Node script (uses `pg` + `dotenv`) that applies `supabase/migrations/0001..0010` against the Supabase Postgres mirror in order. Lives outside the device runtime — driven manually by the developer running `node scripts/db-migrate.mjs --all-pending`. Migration files in order: `0001` schema, `0002` RLS policies created + RLS disabled (Phase A by design), `0003` server-time RPC, `0004` relax FKs, `0005` `todo_meta.pinned`, `0006`/`0007` widen `todo_meta.type` CHECK (+`study`, +`reflect`), `0008` reduce the type set (drop `bug`/`question`/`decision`/`content`), `0009` re-disable RLS after it drifted on and silently froze sync, `0010` namespace cloud tables + `get_server_time()` into the `buffr` schema. Talks to: Supabase Postgres.
- **External LLMs** — Anthropic + OpenAI. Provider switch lives in `src/services/ai/config.ts` and is read on every call. 5 callsites × 2 providers = 10 explicit branches; OpenAI's JSON chains pass `response_format: json_object` while interpret's OpenAI branch omits it (it wants markdown, not JSON).

---

## Five guiding principles

The whole codebase enforces these five. Every pattern in `01-system-design/` traces back to one of them.

1. **DB is single source of truth.** UI displays exactly what's in SQLite — no derived UI-only state, no in-memory shadow copies.
2. **Prose is canonical for drops.** `[]`, `** food N kcal`, and `#tag` mentions inside `entries.text` are the source. Every derived row (todos_json, nutrition, thread_mentions) is rebuilt at commit time by scanning prose.
3. **Two-pass matching.** Every prose-derived feature first tries exact text match, then falls back to line-index. Preserves row identity across edits without surfacing IDs in prose.
4. **Soft delete only.** Writes set `deleted_at`; reads filter `WHERE deleted_at IS NULL`. Hard delete is a deferred 30-day vacuum — never inline.
5. **Cloud is a sync mirror, never canonical.** Reads always hit SQLite. Writes commit locally first, then cloud lags ~5s via debounced `schedulePush()`.

---

## Where to go next

- [`01-system-design/`](./01-system-design/) — every architectural pattern, one file per concept.
- [`02-dsa/`](./02-dsa/) — every meaningful algorithm in the codebase, with execution traces and complexity.
- [`../study-ai-engineering/`](../study-ai-engineering/) — how buffr uses LLMs. Cleared 2026-05-24 so the new `/aipe:study-ai-engineering` command can regenerate it under the v1.38.0 9-sub-section structure (`01-llm-foundations/`, `02-context-and-prompts/`, …, `09-machine-learning/`).
- [`../study-prompt-engineering/`](../study-prompt-engineering/) — the portfolio-wide prompt-engineering guide.

---
Updated: 2026-05-07 — fixed `app/todos.tsx` description (sort is now pinned-first then createdAt DESC, no longer "ranked"); added section index links.
Updated: 2026-05-10 — added `app/vlogs.tsx` route; added Interpret modal mention on `app/journal/[date]`; bumped AI chain count from 4 to 5 (interpret); reduced thinking-mode taxonomy from 7 to 5 (`bug`/`question`/`decision`/`content` dropped, `study`/`reflect` added); reduced expand schemas from 6 to 4; updated dashboard description (threads + per-row x dropped 2026-05-08, schedule locked to current week).

---
Updated: 2026-05-10 — added migration runner + react-native-video to legend; added explicit five-guiding-principles block.

---
Updated: 2026-05-10 — fixed stale nutrition path reference (`nutrition/scan.ts` → `nutrition/scanNutrition.ts`); aligns with the DSA file 12 path.

---
Updated: 2026-05-19 — labelled the cloud-side block in the system map and the Supabase Postgres legend bullet with the `buffr` schema (per migration 0010); noted the client's `db.schema = 'buffr'` setting so the reader knows where `.from(table)` calls resolve.

---
Updated: 2026-05-24 — directory split per v1.38.0 plugin: `.aipe/study-ai-journal/` → `.aipe/study-system-design-dsa/` (renamed; system design + DSA only) and `.aipe/study-ai-journal/03-ai-engineering/` → `.aipe/study-ai-engineering/` (extracted as sibling top-level dir). Updated cross-section "See also" links across both guides to the new paths.

---
Updated: 2026-05-24 — cleared `.aipe/study-ai-engineering/` (47 files). The new `/aipe:study-ai-engineering` command (v1.38.0) regenerates the AI guide under a per-scope structure (9 sub-section subdirectories instead of the flat layout the migrated content had). Cross-section "See also" links from sd/dsa files now point at the directory rather than specific files so they re-resolve once the new command runs.

---
Updated: 2026-05-29 — codebase-drift pass: bumped migration range `0001..0005` → `0001..0010` in the system map and the db-migrate legend; enumerated 0006-0010 (type-set widen/reduce, RLS re-disable, `buffr` schema namespace) and corrected the 0002 RLS phrasing to "policies created + RLS disabled by design."
