# Storage layer summary

**Industry name(s):** Storage layer, data access layer (DAL)
**Type:** Industry standard · Language-agnostic

> Five storage layers, each with one job. Clips are big and binary, so they go to the filesystem. Secrets go to Keystore. Everything else lives in SQLite, mirrored to Postgres async.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [02-authentication-boundary](./02-authentication-boundary.md)

---

## Why care

Most "the database is slow" problems are actually "we put the wrong thing in the database" problems. Stuffing a hundred-megabyte video into a row meant for kilobyte text, or putting an API key into a queryable column where any read can leak it, is a category error — the storage shape doesn't match the data's needs. A serious system has more than one place to put a byte, and a rule for which place each kind of byte goes.

A storage layer breakdown is the deliberate split of persistence across several backends, each chosen for the shape of one kind of data: structured rows in a relational engine, blobs on a filesystem or object store, secrets in an encrypted keystore, ephemeral caches in memory. It belongs to the family of "polyglot persistence" patterns. You've seen this in any production stack that pairs Postgres with S3 for uploads, Redis for sessions, and an HSM or secrets manager for credentials — each layer does one job well instead of one layer doing all jobs poorly. Here's how that actually works in this codebase.

---

## How it works

**SQLite** is canonical. Every read in the app goes here first. WAL mode for single-process concurrency. 12 tables — 10 synced + 2 local-only (`sync_meta` ledger, deprecated `sync_deletions`).

**Filesystem** holds clip URIs under `/document/loopd/clips/<date>/` and exports under `/document/loopd/exports/<date>.mp4`. The `clip_uri` column on `entries` (legacy single-clip) and the `clips_json` column point at absolute paths. `repairBareClipUris` defensively re-resolves any bare-filename leftovers from the deleted Notion sync code.

**SecureStore** is Android Keystore-backed key/value. Stores LLM API keys (`anthropic_api_key`, `openai_api_key`), provider preference (`ai_provider`), Supabase config (`supabase_url`, `supabase_anon_key`), and run-once flags (`cloud_initial_push_done`, per-feature backfill flags).

**Supabase Postgres** is the mirror — never canonical. Reads always go to local SQLite; cloud catches up async via push.

**External LLMs** are stateless — Anthropic and OpenAI never hold loopd's data beyond the request lifecycle. The full picture is below.

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

## In this codebase

**SQLite:**         `src/services/database.ts` (1455 lines) — opens `loopd.db`, runs schema migrations on first call, exposes typed CRUD for 12 tables.
**Filesystem:**     `src/services/fileManager.ts` — clip + export path helpers (`/document/loopd/clips/<date>/`, `/exports/<date>.mp4`), including `repairBareClipUris` defensive resolver.
**SecureStore:**    `src/services/ai/config.ts` (50 lines) — `getProvider`, `getAnthropicKey`, `getOpenAIKey`. Other SecureStore consumers: `src/services/sync/client.ts` (Supabase URL + anon key), `src/services/sync/bootstrap.ts` (`cloud_initial_push_done` flag).
**Postgres:**       `src/services/sync/client.ts` — Supabase JS client init. Reads from SecureStore so URL and anon key are user-supplied.
**Per-table glue:** `src/services/sync/tables/*` — one file per synced table, exporting the mapper functions between SQLite and Postgres row shapes.
**External LLMs:**  `src/services/ai/{summarize,caption,interpret}.ts` + `src/services/todos/{classify,expand}.ts` — stateless HTTP calls; no client-side persistence beyond cached responses in `ai_summaries`.

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

## Quick summary

A storage layer breakdown is the deliberate split of persistence across several backends, each chosen for the shape of one kind of data — structured rows in a relational engine, blobs on a filesystem, secrets in an encrypted keystore, mirrors on a cloud database, ephemeral calls to stateless services. In this codebase that's five layers: `src/services/database.ts` (1455 lines) opens `loopd.db` as the canonical SQLite store of 12 tables; `src/services/fileManager.ts` puts clips under `/document/loopd/clips/<date>/` and exports under `/document/loopd/exports/`; `src/services/ai/config.ts` reads SecureStore for API keys and run-once flags; `src/services/sync/client.ts` mirrors 10 tables to Supabase Postgres; and the AI services in `src/services/ai/` and `src/services/todos/` make stateless HTTP calls to Anthropic and OpenAI. The constraint was that mixing storage types would make sync hopeless — you can't push raw video bytes through `supabase-js` cleanly and you don't want secrets in a queryable table. The cost is that clips are device-local: reinstall the app and the videos are gone (cloud holds the metadata in `clips_json`, not the bytes), which is accepted for a solo product but would need Supabase Storage with content-addressed URIs for a durable multi-device product.

Key points to remember:
- The chain is canonical SQLite → filesystem for blobs → SecureStore for secrets → Postgres mirror (never read first) → stateless LLM APIs; each layer does one job.
- Reads always go to local SQLite first; Supabase is a mirror that catches up async via `schedulePush()` and pull.
- Lives in step 1 (Data model) of the system-design checklist.
- Clips are device-local by design — a phone loss is a video loss, but `clips_json` metadata survives because it rides the synced `entries` row.
- The `clip_uri` column is a plain string, not a foreign key, so the migration path to Supabase Storage with content-addressed (sha256 → URL) paths is unblocked when Phase B needs it.

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

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the storage layer summary to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/database.ts` + `src/services/fileManager.ts` + `src/services/ai/config.ts`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user records a 30-second clip on Monday and exports a vlog on Tuesday. They reinstall the app on Wednesday (no backup). What survives — what data does cloud sync restore on next launch, and what is permanently lost? For each of the 5 storage layers, name what's there before reinstall, and what's there after.

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/tables/` to see what does sync, and `src/services/fileManager.ts` to see what's device-local-only.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/fileManager.ts` (the device-local clip strategy) to support what exists
→ Point to where Supabase Storage with content-addressed `clip_uri` (sha256 → URL) would land if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet + added missing 5th chain `interpret` to External LLMs list.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram. Skipped adding outer layer labels because the diagram is itself a storage-layer enumeration — adding a wrapper would be redundant.
