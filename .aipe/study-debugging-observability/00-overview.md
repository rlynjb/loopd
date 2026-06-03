# Overview — buffr's observability map

One page. The whole map plus the ranked findings.

## The observability map

```
  buffr — what's observable, layer by layer

  ┌─ UI (React Native; device) ──────────────────────────────────────┐
  │  observable: rendered output the user sees                       │
  │  observable: thrown errors → red-screen overlay (dev)             │
  │  observable: console.log in Metro / adb logcat (dev only)         │
  │                                                                   │
  │  NOT observable in production:                                    │
  │   ─ no crash reporter (no Sentry / Bugsnag / Crashlytics)         │
  │   ─ no analytics (Amplitude / PostHog / Mixpanel)                  │
  │   ─ no remote logs                                                │
  └──────────────────────────┬───────────────────────────────────────┘
                             │
  ┌─ Service layer (src/services/) ───────────────────────────────────┐
  │  observable: console.log + console.warn (~12 sites total)          │
  │  observable: thrown errors propagate to UI fallback                 │
  │                                                                   │
  │  ★ THE LOAD-BEARING GAP ★                                          │
  │   sync/orchestrator.ts:49 / :72 logs ONLY on succeeded||failed > 0 │
  │   → error returned as data (PGRST denial, schema-not-exposed)      │
  │     has succeeded=0 AND failed=0 AND r.error is set → silent        │
  └──────────────────────────┬───────────────────────────────────────┘
                             │
  ┌─ Storage layer (SQLite + Supabase) ───────────────────────────────┐
  │  observable: SQL errors throw → caught at boundary                 │
  │  observable: Supabase logs (the dashboard) — operator-visible only │
  │                                                                   │
  │  NOT observable from the app:                                      │
  │   ─ Supabase Postgres logs not piped anywhere on-device             │
  │   ─ no traces from device → cloud round-trip                        │
  │   ─ no per-sync-cycle metric (count, latency, error rate)           │
  └───────────────────────────────────────────────────────────────────┘
```

The map's load-bearing observation: every layer except the **service-layer success guard** has *some* observability. That guard is the single chokepoint where buffr's two production silent freezes hid. The rest of the gap (no remote logs, no metrics, no traces, no crash reporter) is real but lower-leverage — those are *missing instrumentation*, while the guard is *active suppression*.

## Findings — ranked by leverage

| Rank | Finding | Evidence | Severity |
|---|---|---|---|
| 1 | Success-only log guard hides error-as-data | `src/services/sync/orchestrator.ts:49`, `:72` | HIGH — fired twice in production |
| 2 | Local-canonical reads mean cloud-side failures are invisible to the user | the whole sync architecture | HIGH — structural |
| 3 | No remote crash reporting | `package.json` absence | MED — Phase B blocker |
| 4 | No structured logs / no correlation IDs | every `console.log` in the codebase | MED |
| 5 | No metrics (SLIs/SLOs/alerts) | no monitoring infra in repo | MED |
| 6 | No distributed traces (device ↔ cloud) | no OTEL / no Sentry traces | LOW — single-user scale |
| 7 | TypeScript is the only continuous-correctness gate | `package.json` `scripts.type-check` | PRAISE |
| 8 | `docs/spec.md` principles act as invariant documentation | the spec itself | PRAISE |

## The local-first paradox

```
  why local-first apps are structurally bad at observing themselves

  cloud breaks ─────► sync fails ─────► local reads keep working
                          │                        │
                          ▼                        ▼
                   silent log guard         user sees nothing wrong
                          │                        │
                          ▼                        ▼
                   nothing alerts          no signal to triage on
                          │
                          ▼
         the only signal: a curl against the cloud
         (someone has to think to check)

  the fix shape: every layer that fails differently than the user sees
  needs its own emit. Local-canonical hides cloud-side failure from the
  user; observability must reach AROUND the user to find it.
```

This is the structural diagnosis the rest of the guide walks. The audit (next file) names exactly where each lens fires; the two Pass 2 pattern files (`01-success-only-log-guard.md`, `02-local-first-observability-paradox.md`) write the deep walks.

## Cross-references

- The same finding from three other angles: `study-software-design/01-complexity-in-this-codebase.md` (the silent-error guard as unknown-unknowns), `study-security/08-security-red-flags-audit.md` (silent failure at a trust boundary), `study-testing/05-edge-cases-and-error-paths.md` (the RLS-deny-as-data test that pins it down).
- The system-altitude view of the sync engine itself: `study-system-design-dsa/01-system-design/07-cloud-sync-mirror.md` (legacy) or the v1.54.0 `study-system-design/audit.md` (when it lands).
