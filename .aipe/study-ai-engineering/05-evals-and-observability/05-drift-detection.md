# Drift detection

**Industry name(s):** Drift detection, prediction drift, population shift
**Type:** Industry standard

> Track the distribution of inputs and outputs over time; alert when distribution shifts beyond a threshold. The signal that a model — or a heuristic — has fallen behind reality.

**See also:** → [04-llm-observability](./04-llm-observability.md) · → [`01-llm-foundations/07-heuristic-before-llm`](../01-llm-foundations/07-heuristic-before-llm.md) · → [01-eval-set-types](./01-eval-set-types.md)

---

## Why care

### Move 1 — The grounded scenario

Buffr's classifier worked great six months ago. Today users complain it mis-classifies more often. You suspect drift — either user input phrasings evolved (heuristic-coverage drift) or the LLM model rev shifted its behaviour (model drift). Without drift detection, you only notice when users complain.

### Move 2 — Name the question the pattern answers

That has-anything-changed question is what drift detection answers. Not "is the model good" (point-in-time eval); just *has the distribution shifted enough that the current setup is now wrong*.

### Move 3 — Why answering that question matters

**What breaks without drift detection:** quality silently degrades. The user-reported complaint is the alert. By the time you notice, the regression set has grown.

### Move 4 — Concrete before/after

Without drift detection:
- Classifier quality drifts; nobody notices for weeks
- Reports trickle in; "the AI is wrong"

With drift detection:
- Per-type prediction distribution tracked; alert when distribution shifts >threshold
- "Errand classifications are up 20% this month compared to last 3 months"
- Investigation reveals: users typing more shopping-flavoured todos; classifier rules need updating

### Move 5 — The one-line summary

Track input and output distributions; alert on shifts; drift detection beats user-complaint detection.

---

## How it works

### Move 1 — The mental model

```
   Distribution this period vs prior periods
   ──────────────────────────────────────────

   Last 3 months (baseline):
     todo: 55%   idea: 18%   knowledge: 12%
     study: 9%   reflect: 6%

   This month (current):
     todo: 50%   idea: 17%   knowledge: 11%
     study: 16%  reflect: 6%      ← study up 7pp

   Shift: study +7pp → alert (above 5pp threshold)
   Investigation triggered.
```

### Move 2 — The layered walkthrough

**Layer 1 — what to track.** Prediction distribution (per-class output counts), latency, error rate, override rate (curriculum `B3.13` for the form classifier; same shape applies to buffr's todo classifier). Stored aggregates over rolling windows (24h, 7d, 30d).

**Layer 2 — how to detect.** Compare current window to baseline. Threshold-based alert ("study rate up >5pp from baseline"). For continuous distributions: KS test or Population Stability Index (PSI). Buffr's classifier is enum-output → simple per-class delta is fine.

```
   buffr's planned drift checks
   ────────────────────────────
   classifier:    per-type rate shift (>5pp = alert)
   override rate: user_overridden_type counts (rising = misclassification)
   latency p95:   chain timing (rising = provider issue)
   error rate:    chain failures (rising = something broke)
```

**Layer 3 — alerts and action.** Alert surfaces in `app/settings/ai.tsx` or an admin view. Investigation: what changed? Input distribution shift (users phrasing things differently — update heuristics); model rev (provider pushed a new minor version — re-eval); rule drift (heuristic-routed-then-LLM divergence).

### Move 3 — The principle

Distributions shift silently; tracking them lets you catch it before users do. The baseline + threshold pattern works for any output you can count.

---

## Drift detection — diagram

```
┌─ Drift detection flow ─────────────────────────────────────────────────┐
│                                                                        │
│   ai_trace table (per-call data, B3.11)                                │
│         │                                                              │
│         ▼                                                              │
│   aggregate query per day:                                             │
│     count by chain, output_type, model                                 │
│         │                                                              │
│         ▼                                                              │
│   compare current window vs baseline window                            │
│         │                                                              │
│    ┌────┴────┐                                                         │
│    │ drift?  │                                                         │
│    └────┬────┘                                                         │
│         │                                                              │
│    ┌────┴─────┐                                                        │
│    │          │                                                        │
│    ▼ no       ▼ yes                                                    │
│  carry on    alert in app/settings/ai.tsx                              │
│              investigate cause                                          │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not detect drift today.**

Phase 3 `B3.13` defines drift detection for the form classifier (out of scope for buffr — that's contrl-mo). The same pattern would apply to buffr's todo classifier: track override rate and per-type distribution; alert on shift.

---

## Elaborate

### Where this pattern comes from

Classical ML monitoring (PSI from credit risk modeling). LLM-specific drift detection became canonical post-2023 as model providers started pushing silent minor revs.

### The deeper principle

Production systems drift silently; explicit measurement catches it.

### Where this breaks down

For low-volume systems (buffr is single-user), distribution drift takes longer to detect statistically. The threshold needs to account for sample size.

### What to explore next

- [04-llm-observability](./04-llm-observability.md) — the trace data drift queries depend on
- [`01-llm-foundations/07-heuristic-before-llm`](../01-llm-foundations/07-heuristic-before-llm.md) — heuristic drift is a special case of drift

---

## Tradeoffs

The breakpoint: detect drift once you have the trace data (`B3.11`) AND meaningful volume (likely beyond solo-dev for buffr).

---

## Tech reference

- **Statistical methods:** KS test, PSI for continuous; per-class delta for categorical.
- **Implementation:** SQL aggregate over `ai_trace` rolling window.

---

## Project exercises

### B-buffr-drift — Override-rate drift for classifier

- **What to build:** track `todo_meta.user_overridden_type` rate per week; alert when 7-day rate exceeds baseline + 5pp.
- **Done when:** the alert fires when override rate climbs.
- **Estimated effort:** 3 hours.

---

## Summary

- Drift = distribution shift over time.
- Track inputs and outputs; alert on threshold.
- Beats user-complaint detection.
- Buffr: Case B; build target if volume justifies.

---

## Interview defense

**Q [mid]:** What's a useful drift signal for an LLM application?

**A:** Output distribution shift. For a classifier, per-class rate vs baseline. For a generation chain, output length distribution, refusal rate, or any structured-output statistic. The signal that something changed; the cause is investigation. For buffr specifically, user-override rate on the classifier is the cheapest drift signal — rising override rate means classifier is getting it wrong more often.

### One-line anchors

- Distribution shift = drift signal.
- Threshold-based alert.
- User-complaint detection is the wrong layer.

---

## Validate

### Quick check
- What's a cheap drift signal for buffr's classifier?
- What's the data dependency for drift detection?
- What does the alert trigger?

---
Updated: 2026-05-29 — corrected the classifier type set in the drift-distribution example: the per-class distribution used 7 invented task-management types (task/errand/decision/learning/creative/social/admin); rebuilt it with the 5 real thinking-mode types (`todo, idea, knowledge, study, reflect`, todo-dominant) summing to 100%, with `study` as the drifting class. Set per migrations 0006-0008.
