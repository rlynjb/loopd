# buffr — debugging & observability

An audit of buffr's ability to explain its own behavior — in development and (especially) in production. Two-pass shape: `audit.md` walks the 8 lenses; pattern files at the root capture what's load-bearingly *interesting* about buffr's debugging story.

## The through-line

> A local-first app hides its own failures by construction. The thing the audit cares about is how loudly buffr can fail when the cloud-side or LLM-side breaks — and right now it can't.

The bug class that motivates this whole guide is the **silent sync freeze**: errors return as data, the orchestrator's success-only log guard at `src/services/sync/orchestrator.ts:49,72` swallows them, reads stay local-canonical so the app feels fine, and the cloud quietly diverges. Twice in production. Both diagnosed by curling the endpoint after a reader noticed staleness.

## Reading order

1. **[`00-overview.md`](./00-overview.md)** — repo-grounded observability map + ranked findings + the local-first paradox in one diagram.
2. **[`audit.md`](./audit.md)** — Pass 1, the 8-lens walk: observability-map, reproduction-and-evidence, structured-logs-and-correlation, metrics/SLIs/SLOs/alerts, traces-and-request-lifecycles, state-snapshots-and-debugging-boundaries, incident-analysis-and-prevention, red-flags-audit.
3. **Pass 2 — discovered patterns** (each a full per-concept file):
   - [`01-success-only-log-guard.md`](./01-success-only-log-guard.md) — the orchestrator failure mode that's already fired twice; one line, two production incidents, the audit's load-bearing finding.
   - [`02-local-first-observability-paradox.md`](./02-local-first-observability-paradox.md) — why a local-canonical architecture is structurally bad at surfacing cloud-side failure, and what to instrument to fix it.

## What earns a pattern file here

Per `me.md`'s audit-style discipline: a pattern earns its own file when stripping it out names a *concrete diagnostic capability lost*. Buffr's two pattern files name capabilities buffr lost: (1) the ability to see error-as-data in sync logs (the success-only guard erases it), and (2) the ability to notice cloud-side failure from the user's-eye view (local-canonical reads keep the app feeling normal). Both are real. Both are anchored to file:line.

## Cross-links

- **`study-testing`** owns the deterministic test surface around the same code (the RLS-deny-as-data integration test in concept 05 is the test side of this guide's audit findings).
- **`study-performance-engineering`** owns the measurement budgets; this guide owns the *causal* explanation of behaviour, not the budget verdicts.
