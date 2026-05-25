# 01 — System design

Architectural patterns in buffr, one file per concept. Each file opens with a diagram and ends with an Elaborate block.

## Index

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 01 | [Local-first request flow](./01-local-first-request-flow.md) | **Local-first software** *(industry standard)* | UI → SQLite is synchronous; cloud catches up via 5s debounce. |
| 02 | [Authentication boundary](./02-authentication-boundary.md) | **Trust boundary** *(industry standard)* | Phase A hardcodes `user_id`; RLS scaffolded but disabled. |
| 03 | [Single-source-of-truth principle](./03-single-source-of-truth.md) | **Single source of truth (SSOT)** *(industry standard)* | Prose is canonical; everything else is rebuilt at commit. |
| 04 | [Two-pass matching](./04-two-pass-matching.md) | **Two-phase matching** *(language agnostic)* | Exact text first, line index second — preserves row identity across edits. |
| 05 | [Soft delete](./05-soft-delete.md) | **Soft delete / tombstone pattern** *(industry standard)* | `deleted_at` tombstones flow through sync; reads always filter. |
| 06 | [The 1:1 invariant](./06-one-to-one-invariant.md) | **Application-level referential integrity** *(language agnostic)* | App reconciler enforces todos_json ↔ todo_meta because SQLite can't FK to JSON. |
| 07 | [Cloud sync as a mirror](./07-cloud-sync-mirror.md) | **Eventually consistent replica / async replication** *(industry standard)* | Local canonical, cloud mirror; push/pull share a registry. |
| 08 | [Conflict: last-write-wins](./08-conflict-last-write-wins.md) | **Last-write-wins (LWW)** *(industry standard)* | Pure function; same-second ties go to cloud. |
| 09 | [Debounced push](./09-debounced-push.md) | **Write-behind / coalesced writes** *(industry standard)* | 5s timer collapses typing bursts into one push. |
| 10 | [Bootstrap decision tree](./10-bootstrap-decision-tree.md) | **Cold-start bootstrap** *(language agnostic)* | Four-quadrant init: push, pull, no-op, or fallback. |
| 11 | [Provider abstraction (LLM)](./11-provider-abstraction.md) | **Adapter / Strategy pattern** *(industry standard)* | Two providers, five chains, ten code paths. No unified interface. |
| 12 | [Manual-touch deviation](./12-manual-touch-deviation.md) | *(no widely-used equivalent — buffr-internal)* | Documented exception to "mentions are derived from prose." |
| 13 | [Append-only migrations](./13-append-only-migrations.md) | **Append-only schema migrations** *(industry standard)* | Schema files are immutable once committed. |
| 14 | [File-routed UI](./14-file-routed-ui.md) | **File-based routing** *(industry standard)* | `app/` tree IS the route tree. |
| 15 | [Storage layer summary](./15-storage-layer-summary.md) | **Persistence layer / storage tier** *(industry standard)* | 5 storage layers, each with one job. |
| 16 | [Pin replaces manual reorder](./16-pin-replaces-reorder.md) | *(no industry equivalent — feature-specific)* | 2026-05-05: `pinned` boolean replaced manual `position` ordering. |

## Full system map

```
                              buffr — Android-only daily-vlogging app
─────────────────────────────────────────────────────────────────────────────────────────

   ┌────────────────────────── Device (single Android phone) ───────────────────────────┐
   │                                                                                    │
   │   ┌─ UI layer (React Native + expo-router file-based) ──────────────────────────┐  │
   │   │  app/index, app/todos, app/vlogs (NEW 2026-05-08),                          │  │
   │   │  app/journal/[date] (with Interpret modal), app/editor/[date],              │  │
   │   │  app/threads/[id], app/more/*, app/settings/*                                │  │
   │   └──────────────────────┬──────────────────────────────────────────────────────┘  │
   │                          ▼                                                         │
   │   ┌─ Services layer (src/services/) ────────────────────────────────────────────┐  │
   │   │  database.ts (SQLite mouth) · ai/ · todos/ · threads/ · nutrition/ ·        │  │
   │   │  habits/ · sync/ · ffmpeg.ts · exportPipeline.ts · fileManager.ts           │  │
   │   └────┬─────────────────────────────────────┬──────────────────────────────────┘  │
   │        ▼                                     ▼                                     │
   │   ┌─ Local SQLite (buffr.db, WAL) ────┐  ┌─ Files (clips, exports) ────────────┐   │
   │   │ 12 tables (10 synced + 2 local)   │  │ /document/buffr/clips, exports      │   │
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
   │  8 migration files (was 5; 0006/0007/0008 narrowed thinking-modes 7→5)      │
   │  LLMs stateless · 5 chains (summarize/caption/classify/expand/interpret)    │
   │  Sonnet 4.6 / Haiku 4.5 / GPT-4o / GPT-4o-mini                              │
   └─────────────────────────────────────────────────────────────────────────────┘
```

(See [`../00-overview.md`](../00-overview.md) for the full annotated map.)

## The 6-step mental checklist

Use this lens to walk any system — your own codebase, an interview prompt, a new repo. Walk it in order. Each step constrains the next. Every pattern below lives in one or more steps; the section is a unified framework, not a bag of tricks.

```
┌──────────────────────────────────────────────────────┐
│  1. Data model                                       │
│     What entities exist. What fields. What           │
│     relationships. What's the source of truth.       │
│                                                      │
│  2. Request / response flow                          │
│     Client → edge → origin → DB and back.            │
│     Where auth sits. Where rate limiting sits.       │
│     What's parallel, what's a waterfall.             │
│                                                      │
│  3. Caching layers                                   │
│     HTTP cache · CDN · service worker · client       │
│     memory cache · local DB. How each invalidates.   │
│                                                      │
│  4. State ownership                                  │
│     Server state · URL state · client state ·        │
│     form state. Which lives where, and why.          │
│                                                      │
│  5. Failure handling                                 │
│     Slow network · offline · partial failure ·       │
│     race conditions on concurrent edits.             │
│                                                      │
│  6. Scale concerns                                   │
│     What breaks first at 10x. At 100x. What stays    │
│     the same. What needs to be rearchitected.        │
└──────────────────────────────────────────────────────┘
```

### Pattern → step mapping

| # | Pattern                          | Checklist step(s)                          |
|---|----------------------------------|--------------------------------------------|
| 01 | Local-first request flow         | 2 (Request flow)                           |
| 02 | Authentication boundary          | 4 (State ownership) + 6 (Scale concerns)   |
| 03 | Single source of truth           | 1 (Data model)                             |
| 04 | Two-pass matching                | 1 (Data model) + 4 (State ownership)       |
| 05 | Soft delete                      | 1 (Data model) + 5 (Failure handling)      |
| 06 | One-to-one invariant             | 1 (Data model) + 5 (Failure handling)      |
| 07 | Cloud sync mirror                | 2 (Request flow) + 4 (State ownership)     |
| 08 | Conflict last-write-wins         | 5 (Failure handling)                       |
| 09 | Debounced push                   | 2 (Request flow) + 3 (Caching)             |
| 10 | Bootstrap decision tree          | 5 (Failure handling)                       |
| 11 | Provider abstraction             | 2 (Request flow)                           |
| 12 | Manual-touch deviation           | 1 (Data model)                             |
| 13 | Append-only migrations           | 1 (Data model)                             |
| 14 | File-routed UI                   | 2 (Request flow)                           |
| 15 | Storage layer summary            | 1 (Data model)                             |
| 16 | Pin replaces reorder             | 1 (Data model)                             |

Read this table as a 30-second orientation: any pattern's job in the bigger system is whichever step(s) it lives in. If you're trying to understand a single screen end-to-end, follow the chain of steps each pattern touches.

---
Updated: 2026-05-10 — refreshed system-map snippet to reflect /vlogs route, Interpret modal, 8 migrations (was 5), and 5 AI chains (was 4).

---
Updated: 2026-05-10 — added the 6-step mental checklist + per-pattern step tagging.
