# Storage layer summary

**Industry name(s):** Storage layer, data access layer (DAL)
**Type:** Industry standard · Language-agnostic

> Five storage layers, each with one job. Clips are big and binary, so they go to the filesystem. Secrets go to Keystore. Everything else lives in SQLite, mirrored to Postgres async.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [02-authentication-boundary](./02-authentication-boundary.md)

---

## Why care

Open the AWS console for any non-trivial web app and count the storage services in use: DynamoDB for hot transactional rows, S3 for blobs and backups, Secrets Manager for API keys, RDS for relational queries the app runs on every request, Lambda for stateless compute that doesn't store state at all. Five services, five jobs, no overlap. Stuff everything into DynamoDB and the large blobs blow your row-size limit; stuff everything into S3 and your hot queries take seconds; stuff secrets into RDS and audit gets ugly. Each storage layer earns its place by having a job nothing else does well — the discipline is matching the access pattern to the engine.

The question polyglot persistence answers is one any system with diverse data has to answer: do you stuff every byte into one store — leading to "the database is slow" problems that are really "we put a hundred-megabyte video into a row meant for kilobyte text" problems — or do you split persistence across stores chosen by the shape of the data? Not one store for everything. The answer is *polyglot persistence*: structured rows in a relational engine, blobs on a filesystem, secrets in an encrypted keystore, with each layer having one job and a single direction of trust.

**What depends on getting this right:** whether each piece of data lives where its access pattern wants it to live, and whether one layer's failure mode doesn't compromise another. In this codebase there are five storage layers, each with one job: `loopd.db` (SQLite) holds the 12 canonical tables — every read goes here. `/document/loopd/clips/<date>/<id>.mp4` and `/document/loopd/exports/<date>.mp4` hold the video bytes, with SQLite rows pointing at absolute paths via `clip_uri` or `clips_json`. `expo-secure-store` (Android Keystore-backed) holds the API keys, provider preference, Supabase config, and run-once flags — never the JS bundle, never plain disk. Supabase Postgres is the cloud mirror — written via `pushAll()`, never read directly by the app. Anthropic and OpenAI hold loopd's data only for the duration of one API request — no fine-tunes, no embedding stores, no server-side state the codebase depends on. Each layer's direction of trust is documented; nothing reads from anywhere except SQLite.

Without polyglot persistence (everything in SQLite):
- A 12-second clip is encoded as base64 and stored in `entries.clip_blob` (≈12MB row)
- Every dashboard query that selects `entries.*` pulls 12MB into memory per row
- The Anthropic API key is stored in `app_config.api_keys` — readable by any SELECT
- A backup of `loopd.db` to an unencrypted cloud sync drags every secret out
- The "database is slow" complaint is really "the database is doing five jobs and none of them well"

With polyglot persistence (five layers, one job each):
- Clip lives at `/document/loopd/clips/2026-05-10/abc123.mp4`; SQLite holds 200 bytes of path metadata
- Dashboard query reads kilobytes, not megabytes
- API key lives in Keystore; uninstall protection differs from the SQLite file's; a stolen `.db` file leaks nothing AI-related
- Each layer's failure mode is bounded: Supabase down doesn't break the app, Keystore corruption doesn't lose journal entries, clip-file move doesn't take the database with it

Five storage layers, each with one job — same shape as the AWS DynamoDB / S3 / Secrets Manager / RDS / Lambda split.

---

## How it works

An AWS app's typical storage stack: DynamoDB for hot rows, S3 for blobs, Secrets Manager for credentials, RDS for relational queries, Lambda for stateless compute. Five services, five jobs, no overlap. loopd ships the same shape: SQLite for hot rows (every UI read), filesystem for video clips (too large for SQLite rows), SecureStore for API keys (Android Keystore-backed), Supabase Postgres for the cloud mirror (cross-device durability), LLM provider APIs for stateless compute the app doesn't store. Each layer has its own access pattern and its own role; the architecture's discipline is keeping them straight.

The five layers and the trust directions between them:

```
              ┌─── every read goes here ───┐
              │                             │
              ▼                             │
   ┌────────────────────────┐               │
   │ SQLite (loopd.db)      │  ◄── 12 tables, canonical
   │ WAL mode               │     reads + writes
   └──────────┬─────────────┘
              │
              │  SQLite rows hold path strings / dirty flags
              │  pointing at:
              │
              ├──▶ Filesystem        (clip / export .mp4)
              │
              ├──▶ SecureStore       (API keys, run-once flags)
              │
              ├─ ─ ─▶ Supabase Postgres   (mirror; async push;
              │                            NEVER read first)
              │
              └─ ─ ─▶ Anthropic / OpenAI  (stateless compute;
                                          no persistent state
                                          on their side)
```

Five layers, one job each, one read direction. The five sub-sections below trace each layer.

### SQLite — the canonical drawer

`loopd.db` is the only store the app *reads from*. Every screen, every hook, every scanner, every reconciler asks SQLite for its data. WAL mode (`PRAGMA journal_mode=WAL`) makes single-process concurrent reads + writes safe; the codebase opens one DB handle from `database.ts` and routes every mutator through it. If you're coming from frontend, this is the same shape as a Redux store: one place that holds everything, every component reads via selectors, every action goes through reducers. Concrete consequence: 12 tables live here — 10 synced (entries, projects, vlogs, day_meta, ai_summaries, nutrition, habits, todo_meta, threads, thread_mentions) plus 2 local-only (`sync_meta` ledger and the deprecated `sync_deletions` outbox). The dashboard reads via `useEntries`, the editor reads via `useProject`, the habits screen reads via `useHabits`. Nothing reads from anywhere else. Boundary: this discipline holds because there's exactly one file (`database.ts`) that opens `loopd.db`; if a future contributor opens a second handle, the WAL guarantees still apply at the SQLite level but the application invariants (one place to enforce `updated_at` and `schedulePush`) start to leak.

The table inventory in one view:

```
   loopd.db (SQLite, WAL mode, single-process)
   ──────────────────────────────────────────────────────────────
   ┌──────────────────┬─────────────────────────────────────────┐
   │ synced (10)      │ entries, projects, vlogs, day_meta,     │
   │ → mirror to       │ ai_summaries, nutrition, habits,         │
   │   Supabase        │ todo_meta, threads, thread_mentions     │
   ├──────────────────┼─────────────────────────────────────────┤
   │ local-only (2)   │ sync_meta (per-table sync ledger),      │
   │                  │ sync_deletions (deprecated, Notion era) │
   └──────────────────┴─────────────────────────────────────────┘

   single mouth: src/services/database.ts is the ONLY file
   that opens the DB handle. Every read goes through helpers
   exposed by that file.
```

The single-opener invariant is what makes `updated_at` + `schedulePush()` enforceable in one place.

### Filesystem — the bulky-items drawer

Video clips and exports are too large for SQLite. They live as files under `/document/loopd/clips/<date>/<id>.mp4` and `/document/loopd/exports/<date>.mp4`. The SQLite row holds the absolute path string in `clip_uri` (legacy single-clip column on `entries`) or in `clips_json` (the array-of-clips column). When a screen plays a clip, `react-native-video` opens the file directly; SQLite is not in the read path for the bytes. Think of it like a database row pointing at an S3 URL — the row carries the metadata, the blob lives somewhere else. Concrete consequence: a user records a 12-second clip. ffmpeg writes the .mp4 to `/document/loopd/clips/2026-05-10/abc123.mp4`. `database.ts` upserts the entries row with `clips_json = [{uri: '/document/loopd/clips/2026-05-10/abc123.mp4', start: 0, end: 12, ...}]`. The home feed renders the clip thumbnail by passing the URI to `react-native-video`'s `<Video source={{uri}}/>`. Boundary: this works as long as the absolute path stays valid — `repairBareClipUris` is a defensive sweep that re-resolves any bare-filename leftovers from the deleted Notion-sync code, but a moved-app-data directory would invalidate every clip URI at once.

The row-with-path-pointer-to-bytes shape:

```
   Filesystem (clip bytes):
     /document/loopd/clips/2026-05-10/abc123.mp4    ◄── raw video
     /document/loopd/exports/2026-05-10.mp4         ◄── exported vlog

                          ▲
                          │  path stored here
                          │
   SQLite row (200 bytes of metadata):
   ┌──────────────────────────────────────────────────────────────┐
   │ entries.clips_json = [                                        │
   │   {                                                            │
   │     uri: '/document/loopd/clips/2026-05-10/abc123.mp4',         │
   │     start: 0,                                                  │
   │     end: 12                                                    │
   │   }                                                            │
   │ ]                                                              │
   └──────────────────────────────────────────────────────────────┘

   playback:
     <Video source={{uri}}/>  reads bytes directly from the file
     SQLite is NOT in the byte-read path
```

The row is kilobytes; the file is megabytes. Reading the dashboard pulls 200-byte rows, not 12MB blobs.

### SecureStore — the locked drawer for keys

`expo-secure-store` is the Android Keystore-backed key/value store; it survives uninstall protection differently depending on Android version. It holds: LLM API keys (`anthropic_api_key`, `openai_api_key`), provider preference (`ai_provider`), Supabase config (`supabase_url`, `supabase_anon_key`), and run-once flags (`cloud_initial_push_done`, per-feature backfill flags). If you're coming from frontend, this is the same shape as `localStorage` for user-config plus the OS keychain for secrets — except both live behind the same `expo-secure-store` API on Android. Concrete consequence: the user opens AI settings and pastes their Anthropic key. `setItemAsync('anthropic_api_key', key)` writes to Keystore. The next `summarize()` call reads via `getApiKey('claude')`, builds the request, sends to api.anthropic.com. The key never appears in the JS bundle, never lives in plain disk, never gets logged. Boundary: a corrupted Keystore (rare; OS-level issue) would clear the keys; the user would re-paste them on next boot. The cloud sync flags getting cleared would re-trigger bootstrap, which is recoverable.

The key-value inventory:

```
   expo-secure-store (Android Keystore-backed key/value)
   ─────────────────────────────────────────────────────────
   key                              value
   ───────────────────────────      ──────────────────────────
   anthropic_api_key                'sk-ant-...'
   openai_api_key                   'sk-...'
   ai_provider                      'claude' | 'openai'
   supabase_url                     'https://….supabase.co'
   supabase_anon_key                'eyJ...'
   cloud_initial_push_done          'true' | 'false'
   <per-feature backfill flags>     'true' | 'false'

   never in JS bundle, never on plain disk
   accessed via getApiKey() / isCloudConfigured() helpers in
   src/services/ai/config.ts + src/services/sync/client.ts
```

A leaked `loopd.db` file gives an attacker journal text; it doesn't give them the Anthropic key, because the key isn't in the file.

### Supabase Postgres — the mirror across the wall

Supabase is the cloud copy. It never gets read by the app — reads always hit SQLite. Writes commit locally first, then `schedulePush()` mirrors them up via `pushAll()` 5 seconds later ([07-cloud-sync-mirror](./07-cloud-sync-mirror.md)). On a new device, `firstPull()` populates SQLite from Supabase one time; from that point on, sync runs in both directions on the normal cadence. Think of it like a Git remote — the local working tree is what you read; `git push` mirrors your commits; `git pull` fetches commits from other clones. Concrete consequence: user writes a journal entry. The row lands in `loopd.db` in 1ms (the dashboard re-renders from local). Five seconds later, Supabase receives the upsert. If the user then opens the same Supabase project from a different device, that device's first pull brings the entry down. The cloud is durable; the device is canonical. Boundary: the cloud is also the dependency-of-last-resort — if both local and cloud are wiped, the data is gone. The user is responsible for not wiping both at once.

Read path vs write path — only writes touch Supabase:

```
       write path                              read path
   ─────────────────────                  ─────────────────────
   user write                              user opens app
        │                                       │
        ▼  ~1ms                                 ▼  ~1ms
   SQLite (canonical)                      SQLite (canonical)
        │                                       │
        ▼  schedulePush() arms 5s timer         ▼
        ▼                                       │
        ▼  fire() after 5s of quiet       UI re-renders
        ▼                                       │
   pushAll() → Supabase                         │
   (eventual)                                   │
                                                
                                                ▲
   first-pull on a new device is the   ────────┘
   one-time exception that reads from
   Supabase, triggered explicitly via
   bootstrap()
```

The cloud is durable; the device is canonical; the steady-state read path never touches the network.

### External LLMs — the passthrough drawer

Anthropic and OpenAI hold loopd's data only for the duration of one API request. There's no fine-tune, no embedding store, no session memory the server keeps. The codebase sends a prompt, gets a response, persists the response to SQLite, and forgets the call ever happened. If you're coming from frontend, this is the same shape as calling Stripe to charge a card — the call is stateless from your side; whatever state the vendor keeps is for their own purposes (rate limits, billing), not yours. Concrete consequence: `generateCaption(date)` builds a prompt from local journal text, POSTs to api.anthropic.com, gets a JSON response with four caption variants, persists to `ai_summaries.summary_json.variants`. The next page render reads from SQLite, not from Anthropic. Boundary: the stateless contract holds only if you don't enrol in any vendor feature that creates server-side state (Anthropic Files API, vector stores, fine-tunes). The codebase deliberately avoids those — every call is a one-shot.

The stateless API-call shape:

```
   ┌─ App ───────────────────────────────────────────────┐
   │ summarize(date) / generateCaption(date) / ...       │
   └──────────────────────┬──────────────────────────────┘
                          │
                          ▼  HTTPS POST (prompt + API key)
   ┌─ api.anthropic.com / api.openai.com ────────────────┐
   │ stateless on loopd's side:                          │
   │   no fine-tunes                                      │
   │   no vector stores                                   │
   │   no session memory across calls                     │
   │                                                       │
   │ returns: completion text                              │
   └──────────────────────┬──────────────────────────────┘
                          │
                          ▼  parse + validate
                          ▼
   persist to ai_summaries.summary_json in SQLite
                          │
                          ▼  subsequent reads come from SQLite;
                             no return calls to the LLM for
                             the same data
```

The stateless contract holds only because the codebase deliberately avoids vendor features that create server-side state.

This is what people mean by "give every storage layer a job and a single direction of trust." SQLite reads, filesystem holds blobs, SecureStore holds secrets, Supabase mirrors, LLMs compute. Once each layer has exactly one job and the trust directions are documented, the architecture stops accumulating weird back-channels. Every database course teaches "right tool for the job"; the harder discipline is naming the tools and not letting one quietly take over another's role. The full picture is below.

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

## Tech reference (industry pairing)

### expo-sqlite (WAL)

- **Codebase uses:** `expo-sqlite` with WAL mode (`loopd.db`, 12 tables).
- **Why it's here:** canonical local store for all structured data; every read in the app goes here first.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** ships with the Expo SDK; battle-tested; mirrors the SQLite C API directly.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding (perf-tier, no bridge overhead).

### @supabase/supabase-js

- **Codebase uses:** `@supabase/supabase-js` (Supabase JS client).
- **Why it's here:** async mirror of 10 SQLite tables to Postgres; never the canonical read source.
- **Leading today:** Supabase — `adoption-leading`, 2026.
- **Why it leads:** managed Postgres + auth + RLS + Storage in one console; SDK mirrors PostgREST directly.
- **Runner-up:** Neon + Drizzle — `innovation-leading` typed SQL with branch-per-PR; Convex is the reactive-first alternative.

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

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for expo-sqlite, @supabase/supabase-js.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (five-kitchen-drawers metaphor opening / 5 layered sub-sections — SQLite canonical, filesystem blobs, SecureStore keys, Supabase mirror, stateless LLMs — each with frontend bridges and concrete consequences / principle paragraph on one-job-per-layer with explicit trust directions).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (one-giant-drawer-vs-five-labelled-drawers kitchen scenario → polyglot persistence named as the answer → bolded "what depends on getting this right" with five-layer (SQLite/FS/SecureStore/Supabase/LLM) stakes → before/after walking everything-in-SQLite vs split storage → one-line "five drawers, each with one job").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced kitchen-with-five-drawers analogies with AWS storage stack — DynamoDB hot rows + S3 blobs + Secrets Manager keys + RDS relational + Lambda stateless compute). Both Move 1s were missed by the original triage agent.

---
Updated: 2026-05-14 — v1.32.0 pass: R1 no-op (anchors already at level-4 — AWS storage services as polyglot-persistence primitives; no level-1 frontend primitive captures "five layers, one job each" at the same fidelity). Added Move 1 mnemonic diagram (five-layers-with-trust-directions shape) + 5 Move 2 sub-section diagrams: SQLite table inventory, row-points-at-bytes filesystem shape, SecureStore key-value inventory, Supabase write-vs-read paths, stateless-LLM API flow. Total: 6 new diagrams.
