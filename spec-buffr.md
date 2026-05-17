# spec-buffr

**buffr** — a solo-dev, native-Android daily-vlogging app. Combines a journal (text + habits + clips) with an AI-assisted vlog editor, a "drops" pattern that extracts typed records (todos, nutrition, thread mentions) from inline prefix markers in prose, an LLM-assisted "thinking-mode" classifier + per-type expansion for todos, a `#tag` thread system for project attribution, a daily-schedule weekday grid on the dashboard, and a Supabase Postgres cloud-sync mirror with local SQLite as the canonical source.

This document is the top-level reference. Deeper, longer-form material:

- [`README.md`](./README.md) — fresh-laptop setup, build commands, dev workflow.
- [`docs/spec.md`](./docs/spec.md) — the longer "what / how" reference (last full pass 2026-05-04; some details superseded by this doc).
- [`.aipe/specs/study/`](./.aipe/specs/study/) — concept-by-concept study material with industry-term subtitles.

---

## 1. Shape

A single Android user runs the app. Throughout the day they open the journal for today's date, jot text, check off habits, capture or import clips, and tag actionable lines with simple inline markers:

| Marker | Becomes |
|---|---|
| `[] task` / `[x] task` | a row in `entries.todos_json` + a paired `todo_meta` row (classified into a thinking-mode) |
| `** food N kcal` | a row in `nutrition` |
| `#projectname` | a row in `thread_mentions` joining the entry / todo to a `thread` (auto-created if unknown) |

At commit time the prose is scanned by three independent passes (todos, nutrition, threads). Marked lines flow into typed records *without* leaving the prose. End of day, the editor auto-composes a vlog (clip order, trims, text overlays, 4-variant tonal caption) which the user tweaks and exports to `DCIM/buffr/`. Local SQLite is canonical; Supabase Postgres backs it up via a 5s-debounced push.

---

## 2. Tech stack

| Layer | Pin |
|---|---|
| Platform | **Android only** — the prebuilt `android/` is committed; iOS not supported |
| Framework | Expo SDK 55 · React Native 0.83.2 · React 19.2.0 |
| Language | TypeScript 5.9.2 (strict; `npx tsc --noEmit` must pass before any commit) |
| Router | `expo-router` 55 (file-based; `app/` tree) |
| Local DB | `expo-sqlite` 55.0.11 (`buffr.db`, WAL journal mode) |
| Cloud | `@supabase/supabase-js` v2.105+ + `react-native-url-polyfill` |
| AI | `@anthropic-ai/sdk` ^0.90 (Claude Sonnet 4.6 / Haiku 4.5) + raw fetch to OpenAI (GPT-4o / 4o-mini) |
| Media | `@wokcito/ffmpeg-kit-react-native` 6.1.2 (transcode + export) · `react-native-video` 6.19.1 |
| Animations | `react-native-reanimated` 4.2.1 + `react-native-worklets` 0.7.1 |
| Secrets | `expo-secure-store` 55.0.9 (Android Keystore-backed) |
| Icons | `lucide-react-native` 0.475.0 |
| Fonts (bundled) | DM Serif Display, DM Mono, Instrument Sans, Nunito |

---

## 3. Navigation

Global bottom nav lives in [`src/components/nav/GlobalBottomNav.tsx`](./src/components/nav/GlobalBottomNav.tsx). Five tabs, hidden on `/editor/*` and `/settings/*`:

| Tab | Route | Icon |
|---|---|---|
| Home | `/` | `house` |
| Journal | `/journal/[date]` (today) | `penLine` |
| Todos | `/todos` (titled "drops") | `listTodo` |
| Vlogs | `/vlogs` | `film` |
| More | `/more` | `settings` |

Nutrition / habits / threads CRUD live under `/more/{nutrition,habits,threads}`. Settings is reachable via the gear icon in `HomeHeader` on every screen.

---

## 4. Screens

### `app/_layout.tsx` — root
Boot path. Initializes SQLite (runs schema + every backfill migration), bootstraps cloud sync (initial-push vs first-pull vs no-op gated by SecureStore `cloud_initial_push_done`), checks OTA updates, kicks off the classifier catch-up pass for any unclassified non-done todos, runs the proxy-transcode migration for pre-transcode clips.

### `app/index.tsx` — dashboard
- Greeting + today's date.
- **TODAY'S VLOG** card — same shape as past-vlog cards, or "Start Today's Vlog" CTA when empty. `total kcal` sub-stat sums every `kcal` regex match across today's entry text.
- **DAILY SCHEDULE** — 7-column habits-only weekday grid (Mon-anchored, current week only — week-nav was dropped 2026-05-10). Bucketed by `time_of_day` (morning → midday → evening → anytime); adaptive mini-headers once 2+ buckets are populated. Cell states: `done` / `pending` / `upcoming` / `missed` / `off-day`. Today's column gets a cream tint + a cream-pill day-of-month badge. Off-day display is toggleable (`hidden` | `faded`) — persists to SecureStore as `daily_schedule_offday_mode`. Title row is itself a Pressable to `/more` (arrow icon sits right next to the title).
- **DROPS** (was TODOS) — last 5 ranked todos via the pinned-first / createdAt-DESC sort. Each row shows a `TypeBadge` (or none, for plain `'todo'` type), the text, relative time, and a checkbox that round-trips into the source prose. Title row is a Pressable to `/todos`.

### `app/journal/[date].tsx` — daily journal
Dynamic route keyed by `YYYY-MM-DD`. Inline entries with text + habits + clips. DB-first autosave on every keystroke (silent — no scanners). Commit-time scanners run from `useEntries.editEntry`:

- `scanTodosFromText` merges `[]` matches into `todos_json` (two-pass: exact text, then line-index fallback).
- `reconcileTodoMetaForEntry` (fire-and-forget) inserts paired `todo_meta` rows; runs the heuristic; fires the LLM classifier if the heuristic returned null and the todo isn't done.
- `scanNutritionForEntry` (fire-and-forget) reconciles `** food N kcal` lines against the `nutrition` table.
- `scanThreadsForEntry` (fire-and-forget; runs *after* scanTodos because it needs final todo IDs for `[]`-line tag attribution) reconciles `#tag` mentions in entry prose AND inside each todo's text against `thread_mentions`. Unknown slugs auto-create a thread.

Title row has two action buttons next to the day title:
- **Interpret** (Sparkles icon) — appears when the day's combined entry text is ≥ 20 chars. Opens a full-screen modal with a long-form AI reflection ("mirror" tone — main interpretation, themes, emotional pattern, healthy reframe, key takeaway). Output is markdown; cached on `ai_summaries.summary_json.interpret` for the date. See [`docs/interpret-spec.md`](./docs/interpret-spec.md).
- **Vlog** (Clapperboard icon) — appears when ≥ 1 clip exists for the day. Routes to `/editor/[date]`.

Keyboard toolbar quick actions: Todo / Clip / Habit. Nutrition autocomplete on the `** ` marker; tag autocomplete on `#xyz` partials.

### `app/editor/[date].tsx` — vlog editor
Three tabs under a draggable preview pane:
- **TIMELINE** (default) — clip strip with playhead + per-clip trim / split / reorder / delete.
- **TEXT** — overlay selector with a 4-variant tonal caption chip group (`clean` / `smoother` / `reflective` / `punchy`). Older cached rows still render the legacy 3-chip group (`PRIMARY` / `ALT` / `SUMMARY`) until the next regenerate upgrades them.
- **FILTER** — single active filter preset (none / moody / cool / film / muted).

Auto-compose on mount. Export pipeline: text overlays render to a Skia canvas → FFmpeg transcode → writes to `exports/[date]/…mp4` and `DCIM/buffr/` → `Sharing.shareAsync`.

### `app/todos.tsx` — drops (flat list)
Title literal: **drops**. All todos across all entries, joined with their `todo_meta` row.

- **Status filter** — `ALL` / `OPEN` (default) / `DONE`. The legacy `todo_meta.stage` column is dead — no UI reads it.
- **Thinking-mode filter** — wraps to the next line instead of horizontal scroll. `ALL` + one chip per `TodoType` (todo / idea / knowledge / study / reflect; was 9 modes pre-2026-05-10).
- **Pinned-first sort** then `createdAt DESC`. Per-row pin button (lucide Pin, filled when active) + swipe-left-to-delete.
- TagAutocomplete fires on `#` in both the new-todo and edit-todo inputs.

### `app/todos/[id].tsx` — per-todo expansion
Full-page route for the structured AI expansion. Header (back chevron + type label), scrollable body (original-todo quote + rendered markdown), sticky footer with **change type** + **re-expand** actions.

### `app/vlogs.tsx` — past vlogs
Dedicated page (added 2026-05-08). Lists every exported `Vlog` newest-first, with a per-row title and 2-sentence preview pulled from the source day's entries.

### `app/threads/[id].tsx` — thread detail
Per-thread aggregate view: open todos (newest-first), recent 5 done todos, every prose mention with line excerpt sorted newest-first.

### `app/more/{nutrition,habits,threads,index}.tsx`
CRUD hubs. Habits editor: name + time-of-day chip picker + cadence-type selector (daily / weekdays / weekly / specific_days / n_per_week) + day-picker + count picker. Threads editor: name, slug (auto-derived unless manually edited), color, time-of-day, target cadence days, pin / archive / soft-delete.

### `app/settings/{ai,cloud-sync,index,updates}.tsx`
- AI: provider toggle (Claude / OpenAI), API-key input, Test Connection.
- Cloud Sync: Supabase status + manual PUSH/PULL + per-table sync ledger. Long-press the title for a hidden dev menu: `FORCE PUSH ALL`, `RESET CLOUD DB`, `RESET LOCAL FROM CLOUD`.
- Updates: manual OTA check via `expo-updates` (configured against EAS Update; no bundles published yet — see [`docs/backlog.md`](./docs/backlog.md)).

---

## 5. Data model

12 SQLite tables in `buffr.db`. 10 mirror to Supabase Postgres; the other 2 are local-only.

**Synced entity tables (mirrored to Supabase):**

| Table | PK | Notable columns |
|---|---|---|
| `entries` | `id` | `date`, `text`, `habits_json`, `clips_json`, `todos_json`, `clip_uri` / `clip_duration_ms` (legacy single-clip) |
| `projects` | `id` | `date` UNIQUE, `clips_json`, `text_overlays_json`, `filter_overlays_json`, `export_uri` |
| `vlogs` | `id` | `date`, `clip_count`, `habit_count`, `caption`, `duration_seconds`, `export_uri` |
| `day_meta` | `date` | `title` |
| `ai_summaries` | `date` | `summary_json` (carries the structured AISummary + 4-variant caption block + optional `interpret`), `generated_at`, `model` |
| `nutrition` | `id` | `name`, `kcal`, `entry_id`, `entry_date`, `source_line` |
| `habits` | `id` | `label`, `slug`, `icon`, `color`, `cadence_type`, `cadence_days` (JSON), `cadence_count`, `time_of_day`, `archived` |
| `todo_meta` | `todo_id` | `entry_id`, `entry_date`, `type` (5-value CHECK), `stage` (dead), `expanded_md`, `classifier_confidence`, `user_overridden_type`, `pinned`, `position` (dead) |
| `threads` | `id` | `name`, `slug` UNIQUE (case-insensitive), `target_cadence_days`, `archived`, `pinned`, `time_of_day` |
| `thread_mentions` | `id` | `thread_id`, `entry_id` (nullable), `todo_id` (nullable), `source_line`, `tag_text`. App-level invariant: at least one of `entry_id` / `todo_id` is set, EXCEPT for the manual-touch deviation (both NULL when written by `toggleThreadTouchToday`). |

Every synced table also has: `synced_at TEXT` (last push timestamp; **local-only**), `deleted_at TEXT` (soft-delete tombstone; reads filter `WHERE deleted_at IS NULL`), `created_at`, `updated_at`.

**Local-only tables:**
- `sync_meta` — per-table sync ledger (`last_pull_at`, `last_push_at`, `pending_pushes`, `last_error`).
- `sync_deletions` — **deprecated** Notion-era outbox. Not written to anymore; kept on the schema to avoid migration churn.

**Dead-but-kept columns** (round-trip through sync, no read path consults them):
- `todo_meta.stage` (replaced by the `done` flag)
- `todo_meta.position` (replaced by `pinned`)
- `notion_page_id` / `notion_last_synced` on `entries`, `nutrition`, `habits`, `threads`

**Postgres mirror migrations** (`supabase/migrations/`, applied via `node scripts/db-migrate.mjs --all-pending`):
- `0001` initial schema with composite `(user_id, id)` PKs · `0002` RLS policies (authored, disabled in Phase A) · `0003` `get_server_time()` RPC · `0004` relaxed FKs · `0005` `todo_meta.pinned` · `0006` `study` added to type CHECK · `0007` `reflect` added · `0008` dropped `bug` / `question` / `decision` / `content`.

---

## 6. Thinking-mode taxonomy

5 modes as of 2026-05-10 (was 9; `bug` / `question` / `decision` / `content` were dropped in `0008`):

| `TodoType` | When | Icon | Color |
|---|---|---|---|
| `todo` | a plain action item the writer intends to do | `checkSquare` | `textDim` |
| `idea` | a possibility, a "what if", an unproven direction | `lightbulb` | `amber` |
| `knowledge` | an observation or insight worth remembering | `bookOpen` | `teal` |
| `study` | an intention to learn ("study X", "want to learn Y") | `graduationCap` | `accent` |
| `reflect` | past-facing introspection ("reflect on X", "process Y") | `eye` | `indigo` |

The classifier is heuristic-first ([`heuristicClassify.ts`](./src/services/todos/heuristicClassify.ts) — ~50 imperative verbs / modals / deadline patterns → `'todo'` | `null`). On null and not-done, the cheap LLM (`gpt-4o-mini` or `claude-haiku-4-5`) returns `{type, confidence}` JSON. Boot-time `classifyAmbiguousMeta` walks any unclassified, not-done rows.

**Override lock:** `userOverriddenType=1` flips when the user manually picks a type. From then on, no AI re-classification can change it.

**Per-type expansion** (manual, never automatic): `ExpandableType = Exclude<TodoType, 'todo'>`. Four typed schemas (idea / knowledge / study / reflect). Primary model (Sonnet 4.6 / GPT-4o), 3-concurrent cap, malformed-JSON auto-retry once, validated per-type shape. Result rendered to compact markdown in `todo_meta.expanded_md`.

---

## 7. AI surface — 5 chains

Provider-agnostic. User picks Claude (default) or OpenAI in `app/settings/ai.tsx`. Every call reads SecureStore on entry.

| Chain | Models | Output | Persisted? |
|---|---|---|---|
| **Summarize** | Sonnet 4.6 / GPT-4o | Structured `AISummary` JSON (headline, summary, mood, clip order/trims, text overlays, filter preset) | `ai_summaries.summary_json` per date |
| **Caption** (4-variant) | Sonnet 4.6 / GPT-4o | `variants: { clean, smoother, reflective, punchy }` + `variantsTheme` — single LLM call, anti-repetition via last 5 cached captions | Same row, appended fields |
| **Classify** | Haiku 4.5 / GPT-4o-mini | `{type, confidence}` JSON | `todo_meta.type` + `classifier_confidence` + `classifier_model` |
| **Expand** | Sonnet 4.6 / GPT-4o | Per-type structured JSON → markdown | `todo_meta.expanded_md` |
| **Interpret** (added 2026-05-10) | Sonnet 4.6 / GPT-4o | Long-form **markdown** (essay style with emoji-prefixed H2s, blockquoted impact lines, bulleted thinking, "strongest line" kicker) | `ai_summaries.summary_json.interpret` per date |

The Interpret chain is the only one that emits markdown rather than JSON. It's also the only user-triggered chain — the others run on commit or compose. See [`docs/interpret-spec.md`](./docs/interpret-spec.md) for the original spec and the long-form-output deviation.

---

## 8. Service layer — `src/services/`

| Path | Purpose |
|---|---|
| `database.ts` | Single mouth to `buffr.db`. Owns schema + every backfill migration; exposes typed CRUD; every write to a synced table calls `sync/schedulePush()`. Reads always filter `WHERE deleted_at IS NULL`. |
| `ai/` | 5 chains: `summarize` · `caption` (4-variant) · `compose` (AISummary → editor types) · `validate` (clamping + round-trip) · `interpret` (long-form markdown) · `config` (SecureStore-backed keys). |
| `todos/` | `scanTodos` (extract `[]` lines) · `reconcileMeta` (keep `todo_meta` 1:1 with `todos_json`) · `heuristicClassify` · `classify` · `expand` + `expandPrompts` + `expandSerialize` · `rank` · `crud` (round-trips into prose). |
| `threads/` | `scanThreads` (extract `#tag`) · `crud` · `getThreadCards` · `getThreadDetail` · `staleness` · `touch` (manual deviation). |
| `nutrition/` | `scanNutrition` (extract `** food N kcal`) · `migrate`. |
| `habits/` | `cadence` engine (`isDueOn`, `needsMoreThisWeek`, `summarizeCadence`, ISO-week helpers). |
| `sync/` | `client` (Supabase singleton) · `schedulePush` (5s debounce) · `orchestrator` (`pushAll`, `pullAll`) · `push` (batched, 50/batch) · `pull` (paginated by `updated_at ASC`, 200/page, server-time-anchored) · `conflict` (pure LWW) · `bootstrap` (initial-push / first-pull / no-op decision) · `firstPull` (recovery path) · `devActions` · `tables/*` (10 per-table mappers). |
| `ffmpeg.ts`, `exportPipeline.ts`, `fileManager.ts`, `textRenderer.tsx` | Media pipeline. |

---

## 9. Architectural principles

Non-negotiable. Each one traces back to a data-loss bug or a deliberate-cost decision.

1. **DB is the single source of truth.** UI displays exactly what's in SQLite — no frontend filtering, no hiding via conditional rendering.
2. **Prose is canonical for drops.** `[]` lines, `** N kcal` lines, and `#tag` mentions in `entries.text` are the source. `todos_json`, `todo_meta`, the `nutrition` table, and `thread_mentions` are derived. Dashboard interactions round-trip into the source prose.
3. **Save to DB on every keystroke.** Silent, no-state-update writes. Refs hold pending values for focus logic only. **Scanners do not run on keystroke** — only at commit (focus blur, screen leave, explicit save).
4. **Always read DB before deleting.** Auto-commit timers and cleanup effects must verify the latest row state.
5. **Never clear live refs in focus cleanup.** `useFocusEffect` cleanups can race idle timers; clearing `liveTextRef` during cleanup caused past data loss.
6. **Don't auto-delete during sync.** Soft delete via `deleted_at` is the deletion mechanism. Hard delete (vacuum) is gated by 30-day age — deferred per [`docs/backlog.md`](./docs/backlog.md).
7. **Two-pass matching is the way.** Any feature that derives records from prose lines uses `(exact match, then line-index fallback)` so users can edit content in place without losing record identity.
8. **Backfills are SecureStore-gated, one-time.** Any new prose-derived feature ships with a one-time backfill flagged `<feature>_backfill_v<N>_done`.
9. **Classifier output is editable; user override is permanent.** Any AI-assigned attribute on a derived row must be overridable; the override locks the attribute from future AI mutation. `user_overridden_type` is the template.
10. **Heuristic before LLM.** Deterministic regex / rule check first; LLM fallback only when the heuristic is uncertain. Cheaper, faster, more debuggable.
11. **Mentions are derived; metadata is stored.** Relationship rows (threads ↔ entries via `#tag`) are derived from prose and rebuilt at scan time. Metadata about the relationship subject (thread name, color, target cadence) lives in its own table. **One documented deviation:** the dashboard tracker's manual "touch today" toggle writes a `thread_mentions` row with NULL entry/todo (see [`services/threads/touch.ts`](./src/services/threads/touch.ts)).
12. **Cloud is a sync mirror, never the canonical source.** Read paths always hit local SQLite. Writes commit local first; cloud lags by 5s via debounced push. Per-row LWW resolves concurrent edits.

---

## 10. Cloud sync — Phase A

Single hardcoded `user_id = '00000000-0000-0000-0000-000000000001'` in [`sync/client.ts`](./src/services/sync/client.ts). RLS policies are authored in `0002_rls_policies.sql` but disabled (no auth gate in Phase A).

- **Push** — `schedulePush()` fires a 5s-debounced `pushAll()`. Per-table batched upsert (50/batch) with `ON CONFLICT (user_id, id) DO UPDATE`; stamps local `synced_at` on success. Push order respects FK intent (parents before children).
- **Pull** — incremental, paginated by `updated_at ASC`, 200/page. `last_pull_at` is set from the `get_server_time()` RPC to avoid clock skew. Conflict resolution is pure LWW by `updated_at` via [`chooseWinner`](./src/services/sync/conflict.ts) — same-second ties go to cloud.
- **Bootstrap** — `bootstrapCloudSync()` runs once on first cold start (gated by SecureStore `cloud_initial_push_done`). Decides initial-push / first-pull / no-op / initial-push-fallback.
- **First-pull recovery** — `firstPullAll()` resets `sync_meta` and pulls every cloud row from epoch. Backs the **RESET LOCAL FROM CLOUD** hidden dev action.

**Phase B** (deferred): flip RLS on, add Supabase Auth, payment (RevenueCat or Stripe). Plan in [`docs/backlog.md`](./docs/backlog.md).

**Known gap** — clip files (`Documents/buffr/clips/<date>/*.mp4`) are NOT in Supabase Storage. Only the path references in `entries.clips_json` round-trip.

---

## 11. What's deliberately *not* here

- **No agents.** Single-purpose chains only. Each LLM call has one job; no chain-of-chains, no tool-calling.
- **No RAG.** Hand-picked retrieval (sibling todos + last 3 days of entries, capped at 1000 chars each) feeds the expand chain. Embeddings + vector store would be overkill at this scale.
- **No web build.** Native development build only; will not run in Expo Go.
- **No iOS build.** The prebuilt `android/` directory is committed; iOS support is not on the roadmap.
- **No automated test suite.** Manual end-to-end on the connected Android device after each meaningful change. `npx tsc --noEmit` must pass before every commit.
- **No tool calling / function calling.** All chains are one-shot JSON or markdown.

---

## 12. Recent shape changes (2026-05)

For context if you've been away from the repo:

- **2026-05-08** — `/vlogs` route added; bottom nav grew to 5 tabs. Dashboard locked to current week (week-nav dropped); threads removed from the daily-schedule grid; per-row `x` delete on dashboard todos removed.
- **2026-05-09** — `study` added as 8th thinking-mode (migration `0006`).
- **2026-05-10** — `reflect` added as 9th thinking-mode (migration `0007`). Then narrowed back to 5: `bug`, `question`, `decision`, `content` were dropped (migration `0008`). Existing rows with those types were remapped to `todo` and `user_overridden_type` cleared. The `/todos` page is now titled "drops"; thinking-mode filter chips wrap instead of horizontal-scrolling; threads filter row was removed. Interpret feature shipped: long-form markdown output via the 5th AI chain. Dashboard section titles bolded, bumped to 14px brand cream, arrow icons relocated next to titles.

For older history, walk `git log`.
