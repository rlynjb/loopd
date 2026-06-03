# The buffr system map — one page

## The architecture in one diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  DEVICE (React Native + Expo, Android primary)                        │
│                                                                        │
│  ┌────────────┐    ┌──────────────────────┐    ┌──────────────────┐  │
│  │   UI       │    │   service layer       │    │  SQLite          │  │
│  │            │◀──▶│                       │◀──▶│  buffr.db         │  │
│  │ today      │    │  ai/         sync/    │    │  CANONICAL       │  │
│  │ feed       │    │   summarize   pull    │    │                  │  │
│  │ entry      │    │   caption     push    │    │  entries          │  │
│  │ thread     │    │   expand      conflict│    │  todos_json       │  │
│  │ todos      │    │   classify   ──┐      │    │  todo_meta         │  │
│  │ chart      │    │   interpret   │      │    │  threads           │  │
│  │            │    │              │      │    │  thread_meta       │  │
│  │            │    │  prose/      │      │    │  nutrition         │  │
│  │            │    │   compose    │      │    │  nutrition_meta    │  │
│  │            │    │   reconcile  │      │    │  ai_summaries      │  │
│  │            │    │   Meta       │      │    │  vlogs             │  │
│  └────────────┘    └──────────────│─┬─────┘    └──────────────────┘  │
│                                   │ │                                  │
└───────────────────────────────────│─│──────────────────────────────────┘
                                    │ │
        ┌───── LLM provider HTTP ───┘ │
        │                             │
        ▼                             ▼
  ┌──────────┐               ┌──────────────────────┐
  │ Anthropic│               │  Supabase (PostgREST) │
  │   API     │               │   ┌───────────────┐  │
  │ Claude    │               │   │ Postgres 15   │  │
  │           │               │   │ schema: buffr │  │
  └──────────┘               │   │  MIRROR        │  │
       and                    │   │  RLS disabled │  │
  ┌──────────┐               │   │  (migration 9)│  │
  │ OpenAI    │               │   └───────────────┘  │
  │  API      │               │   ┌───────────────┐  │
  │ (fallback │               │   │ Auth (kept    │  │
  │  + image  │               │   │  for future)  │  │
  │  caption) │               │   └───────────────┘  │
  └──────────┘               │   ┌───────────────┐  │
                              │   │ Storage       │  │
                              │   │ (vlog clips)  │  │
                              │   └───────────────┘  │
                              └──────────────────────┘
```

## The components legend

| Component | What it is | What it owns | Who it talks to |
|---|---|---|---|
| **UI** | React Native screens | render state from SQLite | service layer |
| **service / ai** | 5 LLM chains | prompt assembly, validation, cache write/read | LLM provider, SQLite (ai_summaries) |
| **service / prose** | deterministic orchestrator | extract todos/threads/nutrition from entries.text | SQLite (multi-table txn) |
| **service / sync** | debounced batched sync | dirty filter, batch upsert, cursor pull, LWW conflict | SQLite, Supabase JS |
| **SQLite (buffr.db)** | local-canonical store | every row the user sees | UI, service layer |
| **Anthropic API** | primary LLM | Claude responses | service / ai |
| **OpenAI API** | fallback + multimodal | image captioning, Whisper transcription | service / ai |
| **Supabase Postgres** | cloud mirror | replicated copy of every synced table | service / sync |
| **Supabase Auth** | (latent, deferred) | future multi-device login | nothing today |
| **Supabase Storage** | vlog blob storage | uploaded video files | UI uploader, service / sync |

## The 5 chains (in service / ai)

| Chain | Input | Output | Frequency |
|---|---|---|---|
| **summarize** | a day's text | one-paragraph summary | once per day per entry |
| **caption** | image + day's text | image-grounded caption | once per upload (cached) |
| **expand** | user's terse note | expanded prose | on-demand (rare) |
| **classify** | candidate todo line + context | one of `todo/idea/knowledge/study/reflect` | per todo candidate (heuristic short-circuits ~70%) |
| **interpret** | a thread's accumulated entries | thread-level interpretation | once per thread per refresh |

## The 10 synced tables

`entries, todos_json, todo_meta, threads, thread_meta, nutrition, nutrition_meta, ai_summaries, vlogs, sync_state`

Every synced table has: composite PK `(user_id, id)`, `updated_at`, `synced_at`, `deleted` (soft delete).

## Findings (the audit's ranked output)

| Rank | Finding | Where | Severity |
|---|---|---|---|
| 1 | Silent-error guard hides cloud-tier failures | `src/services/sync/orchestrator.ts:49,72` | HIGH |
| 2 | No automated tests; no eval harness for chains | repo-wide | MED |
| 3 | RLS is disabled cloud-side (anon key only) | `supabase/migrations/0009_*` | MED (intentional Phase A) |
| 4 | No structured logs / metrics / heartbeat alert | repo-wide | MED |
| 5 | Schema parity SQLite ↔ Postgres is hand-maintained | `src/services/db/*` vs `supabase/migrations/*` | MED |
| 6 | Local-first design + no UI sync indicator → silent freeze (`02-local-first-observability-paradox`) | architecture | MED (structural) |
| 7 | Two-LLM-provider design hedges cost & availability | `src/services/ai/*` | PRAISE |
| 8 | Heuristic-before-LLM saves ~70% of classify calls | `src/services/ai/classify.ts` (verify path) | PRAISE |
| 9 | Local SQLite txn boundary for reconcileMeta | `src/services/prose/reconcileMeta.ts` | PRAISE |
| 10 | Deterministic LWW tiebreaker (local wins) | sync conflict module | PRAISE |

Full evidence walks lens by lens in [`audit.md`](./audit.md). The five load-bearing patterns are detailed in `01-` through `05-`.
