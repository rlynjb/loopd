# Study — System design (applied to buffr)

This guide audits buffr's architecture: where components live, how state and data move, where boundaries fail, and what changes at 10x. It is the architecture-level companion to the foundation guides (`study-database-systems`, `study-data-modeling`, `study-distributed-systems`, `study-runtime-systems`).

## The through-line

```
  buffr is a local-first daily-vlogging journal.
  the architecture's defining choice: SQLite on the device
  is CANONICAL; Supabase Postgres is a MIRROR. every
  user-facing read goes to SQLite. every write goes to
  SQLite first. the cloud is downstream of every screen.

  every other architectural decision is downstream of that.
```

## Output shape

This is a two-pass audit, per the audit-style generator convention:

- **`00-overview.md`** — the full-system map and the components legend. The one-page version.
- **`audit.md`** — Pass 1, the 8-lens walk: system-map, data flow, state ownership, caching, storage choice, failure handling, scale, red-flags.
- **`01-` through `05-` pattern files** — Pass 2, the patterns the codebase actually exercises, each load-bearing in the sense that removing it would lose an architectural capability the app depends on.

## The five patterns named in Pass 2

```
  01  canonical-local-with-cloud-mirror
      removes:  offline-capable journaling; instant-feel writes

  02  debounced-batched-sync
      removes:  bandwidth thrift; battery economy on mobile

  03  chain-composition-with-cache-shortcircuit
      removes:  $-per-day cost ceiling; deterministic re-runs

  04  prompt-driven-prose-commit
      removes:  the "journal-is-the-source-of-truth" experience

  05  heuristic-before-llm-classifier
      removes:  ~70% of classifier LLM calls; cost+latency
```

Each pattern file follows the full per-concept template (Subtitle → Zoom out → Structure pass → How it works → Primary diagram → Implementation in codebase → Elaborate → Interview defense → Validate → See also).

## Cross-guide seams (read these neighbors when relevant)

- **`study-database-systems`** — how SQLite and Postgres actually execute the work.
- **`study-data-modeling`** — the schema both engines carry.
- **`study-distributed-systems`** — eventually-consistent sync, LWW conflict semantics.
- **`study-runtime-systems`** — how chains and sync tasks execute inside the JS runtime.
- **`study-debugging-observability`** — what's observable at each boundary (and what isn't — the silent-error guard).
- **`study-software-design`** — module-level design of the sync engine and chain layer.
- **`study-security`** — the trust boundary (auth.uid()/RLS, the 0009 incident).

## What this guide does NOT cover

- Server-side architecture (Supabase is managed).
- Marketing/onboarding flows (out of scope for buffr today).
- Multi-region failover (buffr is single-region by Supabase default).
- ML training pipelines (buffr has no on-device models; classifiers are LLM + heuristic).

## Note on the legacy folder

`.aipe/study-system-design-dsa/` still exists at the repo root from the v1.50-era combined generator. It is untouched by this run. DSA-shaped material from there now belongs to `.aipe/study-dsa-foundations/` (separate guide); system-design material from there has been consolidated and updated here against current code.
