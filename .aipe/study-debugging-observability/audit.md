# Pass 1 — the 8-lens audit

Eight lenses, walked against buffr's actual code. Each lens names what buffr does — with `file:line` grounding — or honestly emits `not yet exercised`. The lenses worth deep walks are cross-linked to the Pass 2 pattern files.

## 1. observability-map — the evidence map

What can be observed at each important boundary in buffr today?

| Boundary | Observable today | Where |
|---|---|---|
| UI render | red-screen on thrown error (dev only) | Expo dev menu |
| chain call → provider | thrown errors caught at `compose.ts` | `src/services/ai/compose.ts:60` (approx) |
| sync push/pull | success counts (gated) | `src/services/sync/orchestrator.ts:49,72` |
| sync push/pull errors via throw | yes — `console.warn` | `orchestrator.ts:54,77` |
| sync push/pull errors via data | ★ NOT observable ★ | the load-bearing gap (see Pass 2: `01-success-only-log-guard.md`) |
| Supabase server-side | dashboard logs (operator only) | external to repo |
| device crash in production | not reported anywhere | no crash reporter |
| user analytics | not collected | no analytics SDK |

→ See [`01-success-only-log-guard.md`](./01-success-only-log-guard.md) for the deep walk on the error-as-data hole and [`02-local-first-observability-paradox.md`](./02-local-first-observability-paradox.md) for the structural framing.

## 2. reproduction-and-evidence

How does buffr support reproduction of a reported bug today?

- **What works:** `docs/spec.md` is rich with principle-level invariants. A reader who hears "the captions are converging" can trace it to principle #11 (recency-based retrieval) and `src/services/ai/caption.ts`'s anti-repetition input. The spec documents the *why*; reproduction starts from there.
- **What's manual:** Without telemetry, reproducing a "users say sync feels broken" report means asking the user when (rough date) and curling Supabase to compare row timestamps against device state. This is the workflow the 0009 and PGRST106 incidents both used. It works once you know to do it; there's no automated signal telling you to look.
- **What's missing:** No replay tooling. No recorded inputs to feed back into chain calls. No "state snapshot at time T" mechanism. A reported "this caption was weird yesterday" cannot be reproduced from inside the app — it can only be re-attempted with the current model, which may have shifted.

→ Pattern not yet exercised: no replay infrastructure.

## 3. structured-logs-and-correlation

Are logs structured? Do they carry correlation IDs? Is anything searchable?

- **Format today:** unstructured `console.log('[buffr sync] push <table>: <ok> ok, <failed> failed')` style. Tags exist (`[buffr sync]`, `[buffr classify]` — verify via grep) but no JSON envelope, no fields the consumer can query on.
- **Correlation:** no correlation IDs anywhere. A push and a pull during the same app session share no identifier; a chain call has no trace ID; the user has no session ID in any log line.
- **Redaction:** `entries.text` is intentionally never logged — `study-security/05-data-exposure-and-privacy.md` confirms the orchestrator logs only counts + table names. Praise finding; the discipline is held.

The trade is conscious: at single-user-on-device scale, structured logs + correlation IDs are over-investment. The moment a second observer (operator, support engineer, a future Rein six months later) needs to read these logs, the lack of structure becomes the bottleneck.

→ Pattern not yet exercised: structured logging.

## 4. metrics-slis-slos-and-alerts

Are there signals, SLIs, SLOs, or alerts?

- **None.** No metrics infra; no SLI definitions; no SLO tracking; no alerts.
- **What would matter most if added** (the next-instrumentation list):
  - sync success rate per session (rolling 7-day)
  - sync error rate by error class (PGRST code; thrown vs returned-as-data)
  - chain call success rate per chain
  - chain p95 latency per chain
  - per-day cache hit rate on `ai_summaries`
- **The first alert that would have caught the 0009 incident:** "no successful push in N hours despite local writes." A heartbeat, not a threshold. The local-first paradox (Pass 2) makes the heartbeat the most useful single alert; threshold-based metrics are downstream of it.

→ Pattern not yet exercised: any metric collection; alerting.

## 5. traces-and-request-lifecycles

Are request lifecycles captured? Spans? Causal chains?

- **None.** No OTEL, no Sentry traces, no LangSmith, no manual span emission.
- **What buffr's lifecycle would look like if instrumented:**
  - a chain call: prompt-assembly → provider HTTP → validate → cache write — four spans, all in `src/services/ai/`
  - a sync cycle: dirty filter → batch loop → upsert (per batch) → stamp synced_at — N+2 spans
  - a prose-commit: scan → reconcile → write — three spans across todos/, threads/, nutrition/

  None of these emit any structured span today.
- **Single-user scale makes this lower-leverage than (4).** A trace tells you *why* a request was slow; a metric tells you *whether* requests are slow at all. Buffr doesn't have the latter, so adding the former is premature.

→ Pattern not yet exercised: tracing.

## 6. state-snapshots-and-debugging-boundaries

Is the state inspectable post-hoc? Are there before/after snapshots when failures fire?

- **Local DB is canonical and inspectable** — `buffr.db` on the device can be pulled via `adb` and opened with `sqlite3`. Manual but real.
- **`docs/spec.md` documents invariants** that constitute implicit snapshots: "after a prose commit, `entries.todos_json` and `todo_meta` are 1:1." A failure that violates this invariant is detectable by comparison; nothing fires automatically.
- **No on-disk error log** — failures throw, propagate, and disappear unless someone is watching `adb logcat`.
- **No "last failed push" record** — the sync engine has no debug table that records the most recent failed attempt with payload + response. Adding one would be ~30 lines and would make every silent-freeze instance instantly diagnosable.

→ Pattern not yet exercised: structured error journals.

## 7. incident-analysis-and-prevention

When something fires, is there a post-mortem path? A regression guard for the next time?

- **The 0009 incident:** documented in the migration file's header comment (`supabase/migrations/0009_disable_rls_phase_a.sql:1-15`). This is genuinely good — the *fix* carries the *story*. Future readers running `db-migrate` see the comment and know what happened.
- **The PGRST106 incident (schema-not-exposed after migration 0010):** less well-documented. The fix was operational (toggle exposed schemas in Supabase dashboard), not codified in a migration. A future contributor who namespaces a new schema would not learn from this incident unless they read `study-system-design-dsa/01-system-design/07-cloud-sync-mirror.md` or the changelog there.
- **Regression guard pattern**: zero today. No automated check that "if RLS is enabled on a synced table, `auth.uid()` must be non-NULL on push" — that's exactly the assertion that would have caught both incidents pre-deploy.

→ See [`02-local-first-observability-paradox.md`](./02-local-first-observability-paradox.md) for the framing on why the *user* doesn't fire an incident in this architecture.

## 8. debugging-observability-red-flags-audit

The consolidated checklist for this topic, ranked by consequence with evidence.

| Rank | Red flag | Fires? | Evidence | Fix |
|---|---|---|---|---|
| 1 | Success-only log guard hides error-as-data | ✓ HIGH | `orchestrator.ts:49,72` | `\|\| r.error` on the guard (10 LOC) |
| 2 | Local-canonical reads mask cloud-side failure | ✓ HIGH | the whole sync architecture | heartbeat alert ("no successful push in N hours") |
| 3 | No crash reporting in production | ✓ MED | no Sentry/Bugsnag in `package.json` | install Sentry RN; ~1 hour |
| 4 | Unstructured `console.log` | ✓ MED | every `console.log` site | structured JSON envelope; deferred until a second consumer exists |
| 5 | No metrics / no SLIs / no alerts | ✓ MED | repo-wide | start with sync heartbeat + chain success rate |
| 6 | No correlation IDs | ✓ LOW | every `console.log` site | low value at single-user scale; raise the bar in Phase B |
| 7 | No traces / no spans | ✓ LOW | no OTEL/Sentry SDK | lower-leverage than metrics; instrument metrics first |
| 8 | No "last failed push" debug table | ✓ MED | `database.ts` absence | ~30 LOC; makes silent-freeze instantly diagnosable |
| 9 | No replay infrastructure for chain calls | ✓ LOW | `src/services/ai/` | nice-to-have once eval harness exists |
| 10 | `docs/spec.md` invariants are well-named | ✗ — PRAISE | the spec itself | maintain pattern |
| 11 | TypeScript `tsc --noEmit` is a real correctness gate | ✗ — PRAISE | `package.json` scripts.type-check | maintain pattern |
| 12 | 0009 incident encoded in migration comment (the fix carries the story) | ✗ — PRAISE | `0009_disable_rls_phase_a.sql:1-15` | replicate this pattern for the next incident |

**The top three fixes, ranked:**

1. **`|| r.error` on the orchestrator log guard.** Ten lines. Stops the entire error-as-data bug class from being invisible. Same fix as the software-design audit's #1, the security audit's #1, and the testing audit's first-test-to-write. Four guides converge on this one finding because it *is* the load-bearing observability gap.
2. **Heartbeat alert: "no successful push in N hours despite local writes."** Catches the local-first paradox structurally — the user can't notice cloud failure (local reads are fine), so the alert has to fire on the *cloud's* silence, not the user's complaint. Implementation needs a remote logging sink first (Sentry's breadcrumbs work; or a tiny custom endpoint).
3. **Install a crash reporter (Sentry or equivalent).** Until this ships, production crashes are unreported. ~1 hour of work; ongoing payback.

The other findings are correct, just lower-leverage. Fix the top three first.

## What this audit does NOT cover

- **Per-test telemetry** belongs to `study-testing/04-determinism-isolation-and-flakiness.md` — flakiness sources, not observability gaps.
- **Performance budgets and baselines** belong to `study-performance-engineering/audit.md` — this guide is about explaining behaviour, not about budgets.
- **Trust-boundary failure semantics** belong to `study-security/02-authentication-and-authorization.md` — the 0009 incident story lives there; the *observability gap* that hid it lives here.
