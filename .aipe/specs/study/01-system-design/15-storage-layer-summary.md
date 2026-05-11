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

We traded one-bucket simplicity for five specialised layers: each one is small and well-suited to one data shape, and the cost is that the app has to know which layer to ask for what.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (5 layers)        │ Alternative (one big bucket: │
│                  │                              │  everything in Postgres)     │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Read latency     │ SQLite ~1 ms; filesystem ~5 ms│ all reads network rtt        │
│                  │ for clips; SecureStore ~3 ms │ (~80–250 ms)                 │
│ Write latency    │ same — all sync local        │ network rtt per write        │
│ Clip storage     │ filesystem — native player    │ Postgres BLOB or base64 in   │
│                  │ reads files directly          │ TEXT — playback through API  │
│ Secret storage   │ SecureStore (Keystore)        │ row in a config table —      │
│                  │ encrypted at rest              │ leakable via SELECT *        │
│ Cloud bytes used │ ~1 KB/day metadata only       │ ~30 MB/day video included   │
│ Device disk      │ video files visible in        │ all on cloud — local nearly  │
│                  │ filesystem (~30 MB/day)       │ empty                        │
│ Offline read     │ works fully — SQLite local    │ degraded → fully broken      │
│ Recovery story   │ metadata via cloud; videos    │ everything via cloud         │
│                  │ device-local only             │                              │
│ Code surface     │ ~5 services touching different│ 1 service, all calls to      │
│                  │ APIs                          │ supabase-js                  │
│ Failure blast    │ each layer fails independently│ single point of failure      │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

Clips are device-local. A phone loss is a video loss — `clips_json` metadata survives because it rides the synced `entries` row, but the .mp4 bytes are gone. For a single-user app I accept this; for a multi-user product it would be a known-bad recovery story.

The codebase has to know which layer to ask. `database.ts` writes to SQLite, `fileManager.ts` writes to the filesystem, `ai/config.ts` reads from SecureStore, `sync/client.ts` pushes to Postgres. A new contributor must learn which is which before adding a feature that touches storage; there's no unified "save this" call. The mental model is "5 buckets, 1 rule each" rather than "1 bucket, learn its quirks."

Cross-device sync of clips is impossible without a content-addressed scheme. The current `clip_uri` is an absolute device-local path; two devices on the same account see two different paths for what should be the same file. Migration to Supabase Storage with sha256 → URL paths is the unblock — the schema supports it because `clip_uri` is a string, not a foreign key — but I haven't shipped it.

SecureStore has no multi-device sync. A user installing on a second device has to re-enter API keys, re-configure cloud, re-enter the Supabase URL. That's expected for keys-by-design but it does mean "log into cloud, pull state" doesn't restore the AI provider config.

### What the alternative would have cost

Putting everything in Postgres — videos as BLOBs or base64, secrets as rows, all reads going through `supabase-js` — would have meant ~80–250 ms latency on every read, an unusable offline experience, and a 30 MB/day cloud-bytes cost per user. Videos especially would have been a disaster: base64 bloats by 33%, the playback path would have to download bytes before the native player can render, and `supabase-js` was never designed to stream binary content.

The codebase would shrink (~5 storage-touching files become 1), but every read would pay the network tax, and the app would refuse to work in the subway. For a journaling app where 80% of usage is offline-tolerant, this is a worse design at every dimension.

Stuffing secrets into Postgres rows is its own category of failure. SecureStore is encrypted-at-rest by the OS; a Postgres row is queryable, visible in `pg_dump`, exposed by any future analytics path that does `SELECT *` on the config table. The Keystore vs row decision isn't about latency, it's about which surface can leak credentials and how loudly.

### The breakpoint

Fine until multi-device usage becomes a real flow. The day a user expects "log into cloud on a new device, get my videos back," the device-local clip layer is wrong and the migration to Supabase Storage with content-addressed URIs becomes a Phase B or C feature. The schema already supports it (clip_uri is a plain string column); the work is in `fileManager.ts` plus a sync path that uploads on save and downloads on first-pull.

### What wasn't actually a tradeoff

Replacing SQLite with WatermelonDB or another higher-level local store wasn't on the table. WatermelonDB layers on top of SQLite anyway; the gain is reactive query observation, which the codebase doesn't need (React state derives from query results synchronously). Adding the dependency would mean ~5 MB of code, a new query language to learn, and no improvement on the actual problem the storage layer solves.

---

## Summary

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

```
[secret read path]

  AI service call (e.g. summarize.ts)
        │
        ▼  getAnthropicKey()
  src/services/ai/config.ts
        │
        ▼  SecureStore.getItemAsync('anthropic_api_key')
  Android Keystore (encrypted at rest by OS)
        │
        ▼  returns key
  service uses key in Authorization: Bearer header
        │
        └── never written to SQLite, never logged, never synced
```

[senior] Q: Why don't you push video clips to cloud? Most apps would back up user content.

A: Cost and complexity. A loopd user generates ~30s of video per day; that's small for one user, but pushing it through `supabase-js` would mean either base64-encoding the bytes (wasteful) or moving to Supabase Storage (a separate API surface, separate auth, separate failure modes). The current design accepts that clips are device-local — a phone loss means video loss, but the metadata (clip trims, overlays, timestamps) is in `clips_json` on the synced `entries` row, so a new device can rebuild a journal without the visuals. For a Phase B that wants durability, Supabase Storage with a content-addressed `clip_uri` (sha256 → URL) is the migration path. I deliberately chose to defer that.

```
                  Path taken (device-local clips)       Alternative (Supabase Storage,
                                                          content-addressed URIs)
                  ──────────────────────────────        ──────────────────────────────
clip bytes        filesystem only — local               cloud + local cache
metadata          synced via clips_json on entries      synced same way
recovery on phone metadata recovers, videos gone        full recovery, videos + metadata
 loss
upload cost       0                                     ~30 MB/day × N users
cross-device sync impossible (paths are absolute,       works — sha256 → URL is portable
 of clips         device-local)
playback latency  ~ms — native player reads file        first play: download (~5–30 s
                                                          on LTE); subsequent: local cache
code surface      fileManager.ts handles paths          + storage client + sha256 hashing
                                                          + upload-on-save + download-on-pull
auth surface      none — local files                    Supabase Storage policies (RLS)
right today?      yes — solo, Phase A                   yes for Phase B/C with multi-device
ship trigger      multi-device usage becomes real OR    same
                  a non-me user complains about         
                  video loss
```

[arch] Q: At ten users with multi-device usage, where does this storage strategy break first?

A: The clip layer. Single-device-per-user assumes the device is the canonical clip store; with two devices, you need either a central blob store (Supabase Storage) and a content-addressed scheme, or a peer-to-peer sync (impractical on Android). The metadata side scales — SQLite ↔ Postgres handles ten users easily because writes are bounded per user. The next bottleneck after that is SecureStore (no multi-device sync; user has to re-enter API keys per device). Then the LLM layer at scale becomes the cost ceiling, not the storage one.

```
At 10 users × multi-device:

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged                                    │
  └─────────────────────────────────────────────┘
              │
  ┌─ Clip layer (filesystem, device-local) ─────┐
  │ assumes single-device-per-user               │  ◀── BREAKS FIRST
  │ paths are absolute device-local; impossible │     (need Supabase Storage +
  │ to share across devices                      │      content-addressed URIs)
  └─────────────────────────────────────────────┘
              │
  ┌─ SecureStore (per-device secrets) ──────────┐
  │ no multi-device sync; user re-enters keys    │
  │ on every new device                          │
  └─────────────────────────────────────────────┘
              │
  ┌─ Metadata layer (SQLite ↔ Postgres) ────────┐
  │ scales fine — writes bounded per user        │
  │ 10 users × ~100 KB/day = 1 MB/day total      │
  └─────────────────────────────────────────────┘
              │
  ┌─ LLM layer (cost ceiling) ──────────────────┐
  │ ~$0.10/user/day at heavy use → $30/mo @10    │
  │ becomes the cost line, not storage           │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You said clips are device-local. What's the recovery story when a user drops their phone in a lake?

A: There isn't one for clips. The metadata recovers — installing the app on a new device, logging in (when Phase B exists), and pulling from cloud restores all `entries`, `todos`, `threads`, `vlogs`, etc. The video files themselves are gone. The exported vlog `.mp4` files in `/document/loopd/exports/` are also gone. For Phase A this is acceptable because I'm the only user and my phone has cloud backups via Google. For a multi-user product the answer has to be Supabase Storage with content-addressed paths — clip URIs become hashes, hashes resolve to URLs, the cloud is the durable store. That's a Phase C feature; the architecture supports the migration (the `clip_uri` column is just a string, not a foreign key) but I haven't shipped the bytes-to-cloud path. The honest version is "loopd backs up your journal, not your videos."

```
                  Path taken (metadata-only backup)     Suggested (full backup with clips)
                  ──────────────────────────────        ──────────────────────────────
phone dropped     journal recovers via cloud pull       journal + videos recover
 in lake          videos PERMANENTLY LOST                everything restorable
recovery shape    user sees text + empty clip slots     user sees full vlogs
upload cost       0                                     ~30 MB/day per user
storage cost      0                                     Supabase Storage tier ($/GB)
implementation    fileManager.ts unchanged              +Supabase Storage client +
                                                          sha256 content-addressing +
                                                          upload-on-save + download-on-pull
schema impact     none — clip_uri stays a string        none — clip_uri becomes a hash URL
honest framing    "loopd backs up your journal,        "loopd backs up everything"
                  not your videos"
phase-A user fit  fine — I have Google phone backup     ceremony for use case I don't have
phase-B user fit  insufficient — non-me users expect    correct shape
                  videos to survive phone loss
build effort      0 (already shipped)                   ~1 week (Storage + content-addr)
```

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

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
