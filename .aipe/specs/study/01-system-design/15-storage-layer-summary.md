# Storage layer summary

> Five storage layers, each with one job. Clips are big and binary, so they go to the filesystem. Secrets go to Keystore. Everything else lives in SQLite, mirrored to Postgres async.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [02-authentication-boundary](./02-authentication-boundary.md)

---

## Quick summary
- **What:** SQLite (canonical), filesystem (clips/exports), SecureStore (keys + flags), Supabase Postgres (mirror), external LLM APIs (stateless).
- **Why here:** mixing them would make sync hopeless — you can't push raw video bytes through `supabase-js` cleanly, and you don't want secrets in a queryable table.
- **Tradeoff:** clips are device-local. If you reinstall the app, your videos are gone (cloud holds the metadata, not the bytes). Solo product, accepted.

---

## Storage layers — diagram

```
  ┌──────────────────────────────┬────────────────────────────────────────┐
  │ Where the data lives         │ What's there                           │
  ├──────────────────────────────┼────────────────────────────────────────┤
  │ loopd.db (SQLite)            │ 12 tables; canonical state             │
  │ /document/loopd/clips/       │ raw video clips, per-day folders       │
  │ /document/loopd/exports/     │ exported vlog .mp4 files               │
  │ SecureStore                  │ API keys, provider, bootstrap flags    │
  │ Supabase Postgres            │ mirror of 10 tables, NEVER read first  │
  │ Anthropic / OpenAI           │ stateless — never persists user data   │
  └──────────────────────────────┴────────────────────────────────────────┘
```

---

## How it works

**SQLite** is canonical. Every read in the app goes here first. WAL mode for single-process concurrency. 12 tables — 10 synced + 2 local-only (`sync_meta` ledger, deprecated `sync_deletions`).

**Filesystem** holds clip URIs under `/document/loopd/clips/<date>/` and exports under `/document/loopd/exports/<date>.mp4`. The `clip_uri` column on `entries` (legacy single-clip) and the `clips_json` column point at absolute paths. `repairBareClipUris` defensively re-resolves any bare-filename leftovers from the deleted Notion sync code.

**SecureStore** is Android Keystore-backed key/value. Stores LLM API keys (`anthropic_api_key`, `openai_api_key`), provider preference (`ai_provider`), Supabase config (`supabase_url`, `supabase_anon_key`), and run-once flags (`cloud_initial_push_done`, per-feature backfill flags).

**Supabase Postgres** is the mirror — never canonical. Reads always go to local SQLite; cloud catches up async via push.

**External LLMs** are stateless — Anthropic and OpenAI never hold loopd's data beyond the request lifecycle.

---

## In this codebase

- `src/services/database.ts` — SQLite open + schema migration.
- `src/services/fileManager.ts` — filesystem helpers, including `repairBareClipUris`.
- `src/services/ai/config.ts` — SecureStore reads/writes for AI config.
- `src/services/sync/client.ts` — Supabase client init from SecureStore.
- `src/services/sync/tables/*` — per-table mappers between SQLite and Postgres shapes.

---

## Elaborate

### Where this pattern comes from
The "different storage for different data shapes" idea is older than the cloud — operating systems have been doing it forever (registry vs filesystem vs swap). Mobile apps inherited it directly: SecureStore for secrets is Apple's Keychain pattern, filesystem for blobs is universal, SQLite for structured local state has been the React Native default since 2018-ish.

### The deeper principle
**Don't make a storage layer carry data it's bad at.** SQLite can technically hold a video as a BLOB, and Supabase technically supports row-level secrets. Both would be miserable in practice. The layered design assigns each storage to its strength.

### Where this breaks down
- Clips not in cloud means a phone loss is a video loss. A user who needs durability would want object storage (Supabase Storage, S3) and a uri-rewrite layer.
- Cross-device sync of clips would require a content-addressed scheme (hash → URL); the current `clip_uri` is device-local and assumes single-device usage.

### What to explore next
- [Cloud sync as a mirror](./07-cloud-sync-mirror.md) → how the SQLite ↔ Postgres flow works.
- Supabase Storage → the path forward for clip backup if Phase B includes it.

---

## Tradeoffs

- **5 layers** — gives: each one is small and well-suited. Costs: the app has to know which layer to ask.
- **Clips device-local** — gives: zero upload cost, instant playback. Costs: reinstall = video loss.
- **Cloud is mirror only** — gives: predictable read path (always SQLite). Costs: a power user expecting "log into cloud, pull state on a new device" gets metadata only, not videos.
