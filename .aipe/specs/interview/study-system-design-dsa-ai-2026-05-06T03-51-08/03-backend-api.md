# Chapter 3 — Backend and API design

loopd has no traditional backend. There is no API gateway, no Node service, no Express, no Lambda. There are exactly two servers that the app talks to over the wire: **Anthropic / OpenAI** for AI calls, and **Supabase Postgres** for the cloud sync mirror. Everything else lives on-device. This chapter is about the contract layer between the device and those two servers, and the in-process "API" — `src/services/database.ts` — that every screen calls instead of `fetch`.

The reason there is no backend: the app's threat model and use case make one unnecessary. There is one user (Phase A is hardcoded `PHASE_A_USER_ID` in `src/services/sync/client.ts`), the data is private, the AI calls are pre-paid through the user's own keys (`expo-secure-store` holds them), and the sync target is Supabase's hosted Postgres which already provides auth + RLS + realtime + connection pooling. Building an Express layer in front of Supabase would add latency, an attack surface, and an operational burden that buys nothing. The interview question that exposes whether someone understands this is "why no backend?" — answered honestly, the answer is "because Supabase is the backend."

```
                  Device (React Native runtime)
  ┌──────────────────────────────────────────────────────────┐
  │   Screens (app/*.tsx)                                    │
  │       │                                                  │
  │       ▼                                                  │
  │   Services (src/services/*) ◄── the in-process "API"     │
  │       ├── database.ts        (every SQL write site)      │
  │       ├── ai/                (Claude + OpenAI dispatch)  │
  │       ├── sync/              (push / pull / orchestrate) │
  │       └── todos/, nutrition/, threads/, habits/          │
  │       │                                                  │
  │       ▼                                                  │
  │   expo-sqlite (loopd.db, WAL mode)                       │
  └──────────────────────────────────────────────────────────┘
                       │              │
                       │              │ on schedulePush() fire,
                       │              │ 5s debounced
            ┌──────────▼─────┐  ┌─────▼─────────────────┐
            │ Anthropic API  │  │ Supabase Postgres     │
            │  Sonnet 4.6    │  │  REST via PostgREST   │
            │  Haiku  4.5    │  │  RPC: get_server_time │
            │ OpenAI GPT-4o  │  │  upsert + select +    │
            │                │  │   gt(updated_at)      │
            └────────────────┘  └───────────────────────┘
```

The "API" the screens call is `database.ts`. Every function there is the contract — `addEntry`, `updateEntry`, `getEntriesByDate`, `upsertAISummary`, `insertTodoMeta`, etc. There are no raw SQL strings outside that file. There are no exceptions to that rule. Adding a new screen that needs to read the `entries` table means adding a function to `database.ts`, not running `db.getAllAsync` inline. The reason: `WHERE deleted_at IS NULL` is a soft-delete invariant that's easy to forget at a callsite and impossible to forget when every read goes through the same module.

## Concept 1 — `database.ts` as the in-process API surface

**Shape.** Three pieces: the `getDatabase()` accessor (lazily opens the SQLite connection), the typed CRUD functions (one per (table, operation) pair — `getEntryById`, `updateEntry`, `softDeleteEntry`, `insertTodoMeta`, etc.), and the `schedulePush()` import that every write site calls before returning.

**Rule.** Every read filters `WHERE deleted_at IS NULL`. Every write that touches a synced table bumps `updated_at`, clears `synced_at` (so the row is dirty), and calls `schedulePush()`. There are no exceptions and no raw SQL outside this module.

**Failure mode.** A new feature ships with `db.getAllAsync('SELECT * FROM entries')` inline in a screen. The query returns soft-deleted rows. The screen renders deleted entries because nothing filtered them. Worse: the screen *modifies* a soft-deleted row, the modification looks successful, the row syncs, and now the cloud has a "live" row that the local DB still considers deleted. The single-write-site rule prevents both halves of that bug class.

**Contrast.** The sync layer at `src/services/sync/tables/*.ts` does have its own raw SQL — it intentionally selects soft-deleted rows so it can push their tombstones to the cloud. The constraint that distinguishes them is *who is the audience*. The screens are user-facing and must never see deleted rows; the sync engine is engine-facing and must see them. So the tables in `sync/tables/` are an explicit second layer that bypasses `database.ts`'s soft-delete filter, and the bypass is local to a directory the rest of the app doesn't import from.

## Concept 2 — Generic push: dirty-row detection

**Shape.** Three pieces in `src/services/sync/push.ts`: `localQueryDirty()` (per-table SQL that returns rows where `updated_at > synced_at OR synced_at IS NULL`), `localToCloud(row, userId)` (per-table mapper that produces a Postgres-shaped row including the `user_id`), `localMarkSynced(id, timestamp)` (per-table SQL that stamps `synced_at`).

**Rule.** A row is "dirty" iff it has been edited (locally) since its last successful cloud upsert. The cloud upsert is performed in batches of 50 with `onConflict: cloudConflictColumns`, and `synced_at` is stamped only on rows in a successful batch — failed rows stay dirty for the next push.

**Failure mode.** The naive version stamps `synced_at` *before* the upsert returns. A network failure mid-batch leaves the local DB thinking those rows synced, and they never get re-pushed because `dirty` returns empty for them. The rule "stamp only on success" plus the per-batch retry is what makes the engine correct under partial failure. Concretely: I unplug the wifi mid-push, push reports `failed: 30, succeeded: 20`, the next push retries the 30 — verified via the dev menu's "force push" + diff inspector.

**Contrast.** The pull path stamps `synced_at` on every applied cloud row (`pull.ts:99`), even though the pull "succeeded" doesn't mean "the row was edited and saved." That's deliberate: stamping synced on pull-applied rows prevents them from immediately re-pushing as dirty (they aren't — the cloud already has them). The constraint that distinguishes push and pull: push is "send my local change to the cloud," so synced means "the cloud accepted it"; pull is "apply the cloud's truth locally," so synced means "this is what the cloud knows, no need to push back."

## Concept 3 — Server time RPC for clock-skew avoidance

**Shape.** Three pieces: a Postgres function `get_server_time` defined in `supabase/migrations/0003_server_time_rpc.sql`, a `getServerTime()` wrapper in `src/services/sync/pull.ts:25` that calls `supabase.rpc('get_server_time')`, and `recordPullSuccess(table, serverTime)` which stores it as `last_pull_at`.

**Rule.** The pull's "since" cursor is *the server's clock*, not the device's. `last_pull_at` records the server-time at the moment the pull ran. The next pull uses that server-time as the lower bound, paginating by `updated_at > since` ASC.

**Failure mode.** The naive version uses `new Date().toISOString()` on the device when stamping `last_pull_at`. The user's device clock is 30 seconds slow. The next pull runs `WHERE updated_at > <stale device time>` and re-fetches every cloud row that came in during that 30-second window — wasted bandwidth at best, redundant work at worst. The opposite skew is worse: the device clock is *fast* by 5 minutes, the next pull's `since` is 5 minutes in the future, and any row whose cloud-side `updated_at` falls in that 5-minute gap is *missed* (`updated_at > since` is false). The user thinks they pulled; the cloud has rows they never saw. The RPC bypasses both by always reading the database's clock.

**Contrast.** The push path does *not* use a server-time RPC for `synced_at`. It stamps `synced_at` with the device's local clock at the moment the upsert succeeds. Why? Because `synced_at` is a *local-only* column (not mirrored to cloud), and its only consumer is the `localQueryDirty` SQL that compares `synced_at` to `updated_at` — both written by the same device, both subject to the same clock. Same-device timestamps don't need server-time correction. Cross-device timestamps do.

## Concept 4 — Provider switching at the AI service layer

**Shape.** Three pieces in `src/services/ai/`: `config.ts` (reads `expo-secure-store` for `getProvider()` returning `'anthropic' | 'openai'`, `getAnthropicKey()`, `getOpenAIKey()`), `summarize.ts` (calls `callClaude` or `callOpenAI` based on provider), `caption.ts` (same dispatch pattern, separate prompt). Both files have a `callClaude` and `callOpenAI` pair.

**Rule.** The provider choice is read once per top-level call (`summarize(date)`, `generateCaption(input)`). Within a call, both the structured-summary prompt and the caption prompt go to the same provider. The two prompts can fail independently — caption failure doesn't fail summarize.

**Failure mode.** If provider were resolved at module-load time (a singleton), a user switching providers in `settings/ai` wouldn't take effect until app restart. By resolving in each call, the latest secure-store value is always used. Conversely, if provider were resolved separately for `summarize` vs `caption` within the *same* compose pass, a switch mid-pass would mix structured summary from Claude with caption from GPT-4o — the mood-label translation in `summarize.ts:144` exists precisely to keep the two LLMs aligned on tone, and it'd be undermined by mid-pass provider drift.

**Contrast.** The Haiku 4.5 todo classifier in `src/services/todos/classify.ts` is *hardcoded* to Anthropic — it doesn't go through the provider switch. The constraint that distinguishes: structured summary and caption are both creative-quality text generation where the user might prefer one provider over another; the classifier is a deterministic 7-way categorical output where Haiku's price/quality is dominant and there's no creative judgment for the user to redirect.

## Three interview questions

### `[mid]` — "Walk me through what happens when a user finishes typing in the journal and the autosave fires."

The user is in `app/journal/[date].tsx` typing prose. On every `onChangeText`, the screen calls `updateEntry(entry.id, { text: nextText })` from `src/services/database.ts`. That function runs `UPDATE entries SET text = ?, updated_at = ?, synced_at = NULL WHERE id = ?` — three things in one statement: the new text, a fresh `updated_at` ISO timestamp, and `synced_at` cleared (which marks the row dirty for the next cloud push). Then it returns and the function calls `schedulePush()`, which resets a 5-second debounce timer. Each subsequent keystroke resets the timer, so the actual push fires 5 seconds after the user *stops* typing.

Five seconds later, the timer fires and dynamically imports `pushAll()` from `src/services/sync/orchestrator.ts` — dynamic import because there's a module circularity (`database.ts` → `schedulePush` → `orchestrator` → per-table modules → `database.ts`) that resolves cleanly only at fire time. `pushAll` walks the `REGISTRY[]` of `SyncableTable` definitions in `pushOrder`. For the `entries` table, `localQueryDirty` runs `SELECT * FROM entries WHERE updated_at > synced_at OR synced_at IS NULL`, which returns the row the user just edited. The row goes through `localToCloud` (which maps the snake_case local row to the cloud's snake_case row, adds the user_id, drops the local-only `synced_at`), and is upserted to Supabase in a batch with `onConflict: 'user_id,id'`. On success, `localMarkSynced` stamps `synced_at = <now>` so the next push won't re-send it.

Crucially, the *scanners* — todos, nutrition, threads — don't run on the keystroke. They run when the user navigates away from the journal (focus blur or unmount). That's deliberate: a half-typed `[ ]` shouldn't materialize a todo. So the push that fires 5s after the last keystroke pushes the prose change but not the derived-state changes; those land at commit time and trigger their own `schedulePush()` cascade.

### `[senior]` — "Why is there no Express layer between the device and Supabase, and what would force you to add one?"

There's no Express layer because Supabase already provides what an Express layer would do: auth via JWTs, RLS for per-user data isolation, REST API via PostgREST, and connection pooling. Building Express in front of it would add cold-start latency (Lambda) or a stateful server I'd have to operate (EC2), an additional attack surface, and a ~50ms hop on every cloud read. The threat model also doesn't justify it: this is a single-user app where the user holds their own AI keys and their own data. There's no shared state between users, no rate-limiting need, no batched analytics ingestion. Supabase does the job.

What would force me to add one: three concrete cases. First, **server-side AI** — if I wanted the AI compose pass to run server-side (so user keys live there, not on the device, and rate limits are global), I'd need a backend that holds the Anthropic key and proxies prompts. The simplest version is a Supabase Edge Function, which is what I'd reach for first. Second, **payment / subscriptions** — Stripe webhooks have to land somewhere, and that somewhere is a server with a verified-webhook handler. Edge Functions again. Third, **multi-user collaboration** — the moment two users share a journal, I need server-side merge logic (CRDT or OT) that can resolve conflicts authoritatively, plus a presence channel. That's where Express or a proper backend service starts being load-bearing rather than ceremonial.

The pattern I'd resist is *adding a backend just because it feels architecturally proper*. Every backend I've seen added prematurely became a bottleneck — every new feature means a backend change too, which doubles the velocity cost. Supabase + on-device services is genuinely fewer moving parts than React + Express + Postgres, and for the workload I have, fewer parts is the right answer.

### `[arch]` — "How does loopd's API model break at 100K concurrent users?"

It breaks in three places. First, **Supabase's rate limits become the bottleneck.** The free tier is 60 requests per second per project; the pro tier is higher but still capped. With 100K users and a 5-second debounced push, the steady-state push rate is ~20K per second average — three orders of magnitude above the cap. Pull is even worse because the boot pull paginates at 200 rows per request and could fire 5+ requests on cold start. Sharding by Supabase project (one per N users) is one path; moving the sync layer to a custom service that batches and rate-limits is the other.

Second, **the device-clock-vs-server-clock asymmetry I solved with `get_server_time` becomes a write-side problem too.** Right now the cloud `updated_at` is whatever the device wrote — set by the device on each `updateEntry`. With 100K users, two devices submitting `updated_at = "2026-05-05T12:00:00.000"` for the same logical row creates a pathological tie that `chooseWinner` resolves by biasing toward cloud — *which is wrong* because both devices have valid edits. The fix is to let the cloud rewrite `updated_at = now()` server-side via a trigger or RLS-evaluated default, then return the server's timestamp in the upsert response. That requires migrating from the current "local writes the timestamp" model to a "cloud authoritatively writes the timestamp" model, which is a sync protocol change.

Third, **`pullAll` doesn't scale to 100K-user shared data.** It currently pulls *all* rows since the last `last_pull_at`, paginating through. For a single user that's bounded — maybe 10 rows per day. For a shared resource (say, a public thread with 10K mentions a day), the pull is unbounded and dominates startup. The solution is per-table partitioning: pulls happen by user_id range, partitioned data lives in different physical tables, and the orchestrator's `REGISTRY` becomes parameterized by partition. Adjacent: I'd add subscription-based realtime for hot tables instead of polling, so the boot pull only fetches the cold tail.

Two things hold up at 100K. The composite `(user_id, id)` PK on every cloud table is a *schema-level* tenant isolation guarantee — that doesn't change. And the local-first read model means the device is never stalled by the cloud — that doesn't change either. The cloud bottleneck is in the write path; reads are always SQLite.

## The hard question — "What's the recovery story when a sync push fails repeatedly?"

The current story is: it retries, and the user might not notice it failed. That's an honest gap.

Concretely, the push pipeline records the last error in `sync_meta.last_error` (per-table) via `recordSyncError` in `src/services/sync/syncMeta.ts`. The next `schedulePush()` triggers a new push attempt; if the network's still down, the same error is recorded. There is no exponential backoff, no maximum retry count, no user-visible "your data isn't syncing" banner. The `settings/cloud-sync` screen has a dev menu that exposes `last_error` per table, but a normal user wouldn't know to look there.

The reason it's not worse than that: the canonical store is local SQLite, so a failed push doesn't lose user data. The user keeps writing; SQLite keeps recording; on the next successful network connection, `pushAll` walks the dirty rows and ships them. The "recovery" is automatic in the sense that it's the same code path as the happy case. From the user's perspective, the data is always safe — it's just that the cloud might be hours behind reality after a long offline stretch.

What I'd add for production: (1) a user-visible sync status indicator on the dashboard — small dot, green for "up to date," yellow for "X minutes behind," red for "X hours behind, errors logged." Click to see details. (2) Exponential backoff on consecutive failures, capped at maybe 5 minutes between attempts so a server outage doesn't burn battery. (3) A push queue with a max age — if a row has been dirty for more than 7 days and every push has failed, surface a one-time alert ("loopd hasn't been able to sync for a week — open settings to check") rather than silently failing forever. (4) Telemetry that emits sync errors to an observability platform so I'd know about a regression that's only happening in the field.

What I deliberately wouldn't add: an aggressive "retry now" button. The whole point of the 5-second debounce + auto-retry-on-next-write model is that the user doesn't have to think about sync. A "retry now" button trains them to think about it, which is the failure mode of a system that doesn't recover automatically. The status indicator is informational, not actionable; the actual recovery is hands-off.
