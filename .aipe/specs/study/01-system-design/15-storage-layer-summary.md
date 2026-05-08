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

---

## Interview defense

### What an interviewer is really asking
Five storage layers sounds like over-engineering. The interviewer is checking whether you can name what each layer does that the others can't — and whether you understand that the alternative (one big bucket) would actually be worse.

### Likely questions

[mid] Q: Where do API keys live and why not in SQLite?

A: API keys live in SecureStore (Android Keystore-backed). They don't live in SQLite for two reasons: SQLite isn't encrypted at rest by default, and a future SQL query that accidentally `SELECT *`s a config table could leak them through logs or sync. SecureStore puts them behind the Keystore — even if the device's filesystem is read by another process, the keys aren't readable without OS-level auth. I read them via `getAnthropicKey()` / `getOpenAIKey()` in `ai/config.ts`, which is the only file in the codebase that touches SecureStore for AI keys.

[senior] Q: Why don't you push video clips to cloud? Most apps would back up user content.

A: Cost and complexity. A loopd user generates ~30s of video per day; that's small for one user, but pushing it through `supabase-js` would mean either base64-encoding the bytes (wasteful) or moving to Supabase Storage (a separate API surface, separate auth, separate failure modes). The current design accepts that clips are device-local — a phone loss means video loss, but the metadata (clip trims, overlays, timestamps) is in `clips_json` on the synced `entries` row, so a new device can rebuild a journal without the visuals. For a Phase B that wants durability, Supabase Storage with a content-addressed `clip_uri` (sha256 → URL) is the migration path. I deliberately chose to defer that.

[arch] Q: At ten users with multi-device usage, where does this storage strategy break first?

A: The clip layer. Single-device-per-user assumes the device is the canonical clip store; with two devices, you need either a central blob store (Supabase Storage) and a content-addressed scheme, or a peer-to-peer sync (impractical on Android). The metadata side scales — SQLite ↔ Postgres handles ten users easily because writes are bounded per user. The next bottleneck after that is SecureStore (no multi-device sync; user has to re-enter API keys per device). Then the LLM layer at scale becomes the cost ceiling, not the storage one.

### The question candidates always dodge
Q: You said clips are device-local. What's the recovery story when a user drops their phone in a lake?

A: There isn't one for clips. The metadata recovers — installing the app on a new device, logging in (when Phase B exists), and pulling from cloud restores all `entries`, `todos`, `threads`, `vlogs`, etc. The video files themselves are gone. The exported vlog `.mp4` files in `/document/loopd/exports/` are also gone. For Phase A this is acceptable because I'm the only user and my phone has cloud backups via Google. For a multi-user product the answer has to be Supabase Storage with content-addressed paths — clip URIs become hashes, hashes resolve to URLs, the cloud is the durable store. That's a Phase C feature; the architecture supports the migration (the `clip_uri` column is just a string, not a foreign key) but I haven't shipped the bytes-to-cloud path. The honest version is "loopd backs up your journal, not your videos."

### One-line anchors
- "Five storage layers because each is bad at something the others are good at."
- "Clips are filesystem because base64-in-SQLite would bloat every read; secrets are SecureStore because SQLite isn't encrypted at rest."
- "Cloud is metadata-only by design — videos are device-local, and that's a known durability cost."
- "The migration path to durable clips is Supabase Storage + content-addressed URIs; the schema already supports it."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
