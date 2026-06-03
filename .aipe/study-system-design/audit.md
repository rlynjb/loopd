# Pass 1 — the 8-lens system-design audit

## 1. system-map-and-boundaries

The system has three top-level boundaries: **the device** (RN/Expo runtime, owning UI + service layer + SQLite), **Supabase** (managed Postgres + PostgREST + Auth + Storage, owning the cloud mirror), and **two LLM providers** (Anthropic primary, OpenAI fallback + multimodal).

Inside the device, the service layer decomposes into three clean modules: `ai/` (5 chains; deterministic prompt assembly + provider HTTP + validation + cache write), `prose/` (deterministic orchestrators: `compose.ts` for chain composition with cache short-circuit; `reconcileMeta.ts` for entry→multi-table reconcile across local SQLite txn), and `sync/` (the orchestrator + per-table push/pull + LWW conflict). Modules cross-reference cleanly; no cycles.

Trust boundaries: (a) device ↔ LLM provider over HTTPS — secret in env, no user data exfiltration beyond the prompt; (b) device ↔ Supabase over HTTPS — anon key today, RLS disabled (migration 0009); (c) device ↔ filesystem — SQLite file owned by the app's sandbox.

→ See [`01-canonical-local-with-cloud-mirror.md`](./01-canonical-local-with-cloud-mirror.md) for the canonical/mirror pattern.

## 2. request-response-and-data-flow

Three load-bearing flows:

**A. The write flow (user types into today's entry):** UI → service/entries → SQLite (synchronous write, single-row UPDATE) → returns. Sync is scheduled (debounced 5s) but not awaited. Total: <10ms cold; sub-ms warm. User feels instant.

**B. The prose-commit flow (user finishes today's entry; system extracts structure):** `compose.ts` orchestrates: summarize → classify (per candidate todo) → interpret (per impacted thread). Each call goes through cache (`ai_summaries` table) — short-circuits on hit. `reconcileMeta.ts` then writes the extracted shapes into todos_json + todo_meta + threads + thread_meta + nutrition + nutrition_meta within a single SQLite transaction.

**C. The sync flow (background):** orchestrator wakes (debounce timer or app-event), reads dirty rows per table (`WHERE updated_at > synced_at`), batches them, upserts to Supabase via PostgREST, stamps `synced_at`. Pull half: read cursor, query `WHERE updated_at > cursor LIMIT N`, apply locally.

→ See [`02-debounced-batched-sync.md`](./02-debounced-batched-sync.md), [`03-chain-composition-with-cache-shortcircuit.md`](./03-chain-composition-with-cache-shortcircuit.md), and [`04-prompt-driven-prose-commit.md`](./04-prompt-driven-prose-commit.md).

## 3. state-ownership-and-source-of-truth

| State | Source of truth | Owns transitions |
|---|---|---|
| Today's entry text | SQLite `entries.text` | UI input handlers → service/entries |
| Derived todos | SQLite `todo_meta` + `todos_json` | service/prose/reconcileMeta |
| Threads | SQLite `threads` + `thread_meta` | service/prose/reconcileMeta |
| Nutrition rows | SQLite `nutrition*` | service/prose/reconcileMeta |
| AI cache | SQLite `ai_summaries` | service/ai/* chain results |
| Cloud copy | Supabase `buffr.entries` etc. | service/sync (mirror, never authoritative) |
| Auth identity | (latent) Supabase Auth | not used today; anon key only |

The rule: **the prose `entries.text` is the source of truth for every derived shape.** Re-running reconcile from `entries.text` should always reproduce the meta rows. This invariant is documented in `docs/spec.md`.

## 4. caching-and-invalidation

The only application-level cache is `ai_summaries` — keyed by `(chain, input_hash)`. Hit: short-circuit, no LLM call. Miss: LLM call → write result → return. **Invalidation strategy is `none`**: chain inputs include enough context that a behavioral change (new prompt, new model) produces a new hash, generating a fresh cache entry. Old entries are kept; rows are append-mostly.

This works because chain inputs are *small enough* to hash cheaply and *deterministic enough* that the same input must produce the same output. Anti-pattern: caching by user_id+date only — would miss user edits to the entry mid-day. Buffr's hash includes the input prose, so edits invalidate naturally.

→ See [`03-chain-composition-with-cache-shortcircuit.md`](./03-chain-composition-with-cache-shortcircuit.md).

No HTTP cache, no edge cache, no CDN — everything client-side and tiny.

## 5. storage-choice-and-durability-boundaries

Two engines: SQLite (canonical, microsecond durability) and Postgres (mirror, second durability). Defended in `study-database-systems/00-overview.md`.

Why these two specifically: SQLite ships embedded with Expo; no infra. Postgres on Supabase gives multi-device + backups for free. **Vector DBs explicitly excluded** by principle #11 (no RAG until provably needed) — recency-based context selection works for buffr's single-user-single-stream model.

Vlog blobs go to Supabase Storage (object store), not Postgres BYTEA — standard split.

→ Engine mechanisms in `study-database-systems`. Schema in `study-data-modeling`.

## 6. failure-handling-and-reliability

**Slow LLM call:** every chain has a hard timeout (typically 30s). Throws to caller; caller (`compose.ts`) catches and falls back to "no derived output this round; try again next prose-commit." User sees their text rendered regardless.

**LLM API outage:** primary (Anthropic) fails → fallback to OpenAI (image captioning always uses OpenAI). If both fail: chain throws; prose-commit skips derivation; user can re-trigger.

**Sync failure (network out):** queue persists in SQLite. Next sync cycle retries. **Sync failure (RLS deny / error-as-data):** silently swallowed by the orchestrator's success-only log guard. This is the load-bearing reliability hole. → See `../study-debugging-observability/01-success-only-log-guard.md` and `../study-debugging-observability/02-local-first-observability-paradox.md`.

**Device offline:** local writes continue; sync resumes on reconnect. **Cloud-only outage (Supabase down):** UI unaffected; sync queues and resumes. The local-first design is what buys this.

**Schema migration failure:** Supabase migrations are ordered + idempotent; the migration chain replays cleanly. SQLite migrations are hand-maintained; a missing column on a new SQLite schema is the structural risk.

→ See `study-distributed-systems` for the consistency framing.

## 7. scale-bottlenecks-and-evolution

| Scale tier | Today's bottleneck | First thing that breaks |
|---|---|---|
| 1 user (today) | none | nothing |
| 10 users | none | nothing material |
| 100 users | LLM cost (per-day per-user per-chain) | budget |
| 1k users | sync push throughput on shared Postgres connection | PostgREST connection pool |
| 10k users | per-user pull latency from in-memory sort on `updated_at` | the `(user_id, updated_at)` index gap (database-systems #2) |
| 100k users | Anthropic rate limit; per-day cost ceiling | provider-side rate-limiting; budget |

**The single architectural decision that would force rearchitecture:** real-time collaborative editing (two users on one entry). Today's LWW sync resolves divergences by clobbering; collaborative editing requires CRDTs or OT. Buffr's spec explicitly does not target this.

**The single decision that scales for free:** adding a chain. The compose pattern is shaped so new chains plug into the same cache, the same provider abstraction, and the same prose-commit orchestrator. Cost: prompt + tests + a new row in `ai_summaries`.

→ See [`05-heuristic-before-llm-classifier.md`](./05-heuristic-before-llm-classifier.md) for the cost-scaling pattern.

## 8. system-design-red-flags-audit

Consolidated ranked checklist for this guide's lens. (For DB-engine red flags, see `study-database-systems/09-*`; for testing, `study-testing/07-*`; for observability, `study-debugging-observability/audit.md`.)

| Rank | Flag | Severity | Fix |
|---|---|---|---|
| 1 | Silent-error guard on sync orchestrator | HIGH | `\|\| r.error` (10 LOC); cross-link debug-obs/01 |
| 2 | No heartbeat alert on cloud silence | HIGH (structural) | requires a sink + an external alert; design lives in debug-obs/02 |
| 3 | SQLite ↔ Postgres schema parity is hand-maintained | MED | generate one from the other, or assert row-trip equality in a test |
| 4 | No tests / no eval harness | MED | priority list in `study-testing` |
| 5 | RLS disabled (Phase A) | MED (intentional) | re-enable when Phase B (multi-device auth) ships |
| 6 | No crash reporting | MED | install Sentry RN |
| 7 | No EXPLAIN ANALYZE captured for sync queries | LOW | one afternoon |
| 8 | Chain prompts not version-controlled with eval pinning | LOW | tighten when a chain regresses |
| 9 | Provider abstraction (Anthropic + OpenAI both behind one interface) | PRAISE | maintain |
| 10 | Heuristic-before-LLM short-circuit for classify | PRAISE | maintain; extend to other chains where shape-detectable |
| 11 | Local-first canonical with debounced sync | PRAISE | maintain |
| 12 | Local SQLite txn for reconcile (multi-table atomic) | PRAISE | maintain |
| 13 | Cache by content hash (prose, not date) | PRAISE | maintain |

**The top three fixes ranked:**

1. **Fix the silent-error guard** (`|| r.error`) — 10 LOC, blast-radius collapse on the entire silent-failure class.
2. **Add a heartbeat-alert design** — needs a remote sink (Sentry breadcrumb or tiny custom endpoint); the *alert*'s audience must not be the affected user.
3. **Add a schema-parity assertion** — one test that creates a fresh row, pushes, pulls, and asserts SQLite ↔ Postgres equality across every column. Pins schema drift forever.

## What this audit does NOT cover

- Code-level design within modules (composition, naming, layering) — `study-software-design`.
- Internal mechanism of the LLM chains (single-call structure, retry, observability) — `study-ai-engineering`.
- Multi-agent / above-one-agent topologies — buffr has none; see `study-agent-architecture`.
- Network protocol detail (HTTP/2, TLS, connection reuse) — `study-networking`.
