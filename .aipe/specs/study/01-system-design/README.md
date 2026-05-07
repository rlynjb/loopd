# 01 — System design

Architectural patterns in loopd, one file per concept. Each file opens with a diagram and ends with an Elaborate block.

## Index

| # | Concept | One-line |
|---|---|---|
| 01 | [Local-first request flow](./01-local-first-request-flow.md) | UI → SQLite is synchronous; cloud catches up via 5s debounce. |
| 02 | [Authentication boundary](./02-authentication-boundary.md) | Phase A hardcodes `user_id`; RLS scaffolded but disabled. |
| 03 | [Single-source-of-truth principle](./03-single-source-of-truth.md) | Prose is canonical; everything else is rebuilt at commit. |
| 04 | [Two-pass matching](./04-two-pass-matching.md) | Exact text first, line index second — preserves row identity across edits. |
| 05 | [Soft delete](./05-soft-delete.md) | `deleted_at` tombstones flow through sync; reads always filter. |
| 06 | [The 1:1 invariant](./06-one-to-one-invariant.md) | App reconciler enforces todos_json ↔ todo_meta because SQLite can't FK to JSON. |
| 07 | [Cloud sync as a mirror](./07-cloud-sync-mirror.md) | Local canonical, cloud mirror; push/pull share a registry. |
| 08 | [Conflict: last-write-wins](./08-conflict-last-write-wins.md) | Pure function; same-second ties go to cloud. |
| 09 | [Debounced push](./09-debounced-push.md) | 5s timer collapses typing bursts into one push. |
| 10 | [Bootstrap decision tree](./10-bootstrap-decision-tree.md) | Four-quadrant init: push, pull, no-op, or fallback. |
| 11 | [Provider abstraction (LLM)](./11-provider-abstraction.md) | Two providers, four callsites, eight code paths. No unified interface. |
| 12 | [Manual-touch deviation](./12-manual-touch-deviation.md) | Documented exception to "mentions are derived from prose." |
| 13 | [Append-only migrations](./13-append-only-migrations.md) | Schema files are immutable once committed. |
| 14 | [File-routed UI](./14-file-routed-ui.md) | `app/` tree IS the route tree. |
| 15 | [Storage layer summary](./15-storage-layer-summary.md) | 5 storage layers, each with one job. |
| 16 | [Pin replaces manual reorder](./16-pin-replaces-reorder.md) | 2026-05-05: `pinned` boolean replaced manual `position` ordering. |

## Full system map

```
                              loopd — Android-only daily-vlogging app
─────────────────────────────────────────────────────────────────────────────────────────

   ┌────────────────────────── Device (single Android phone) ───────────────────────────┐
   │                                                                                    │
   │   ┌─ UI layer (React Native + expo-router file-based) ──────────────────────────┐  │
   │   │  app/index, app/todos, app/journal/[date], app/editor/[date],               │  │
   │   │  app/threads/[id], app/more/*, app/settings/*                                │  │
   │   └──────────────────────┬──────────────────────────────────────────────────────┘  │
   │                          ▼                                                         │
   │   ┌─ Services layer (src/services/) ────────────────────────────────────────────┐  │
   │   │  database.ts (SQLite mouth) · ai/ · todos/ · threads/ · nutrition/ ·        │  │
   │   │  habits/ · sync/ · ffmpeg.ts · exportPipeline.ts · fileManager.ts           │  │
   │   └────┬─────────────────────────────────────┬──────────────────────────────────┘  │
   │        ▼                                     ▼                                     │
   │   ┌─ Local SQLite (loopd.db, WAL) ────┐  ┌─ Files (clips, exports) ────────────┐   │
   │   │ 12 tables (10 synced + 2 local)   │  │ /document/loopd/clips, exports      │   │
   │   └────┬──────────────────────────────┘  └─────────────────────────────────────┘   │
   │        │                                 ┌─ SecureStore (Keystore-backed) ─────┐   │
   │        │ debounced 5s push               │ AI keys, Supabase config, flags     │   │
   │        ▼                                 └─────────────────────────────────────┘   │
   └────────┼───────────────────────────────────────────────────────────────────────────┘
            │
            │ HTTPS (supabase-js + raw fetch)
            ▼
   ┌─ Cloud (Supabase Postgres) + External LLMs (Anthropic, OpenAI) ─────────────┐
   │  Mirror of 10 tables · composite (user_id, id) PKs · RLS scaffolded         │
   │  LLMs stateless · Sonnet 4.6 / Haiku 4.5 / GPT-4o / GPT-4o-mini             │
   └─────────────────────────────────────────────────────────────────────────────┘
```

(See [`../00-overview.md`](../00-overview.md) for the full annotated map.)
