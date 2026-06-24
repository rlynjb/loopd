# Eval set types

**Industry name(s):** Eval sets, golden set, adversarial set, regression set
**Type:** Industry standard

> Three eval sets every production LLM system needs: golden (baseline quality), adversarial (robustness), regression (catch fixed bugs from re-introducing). Each addresses a different failure mode; all three together gate "did the change improve things."

**See also:** → [02-eval-methods](./02-eval-methods.md) · → [03-llm-judge-bias](./03-llm-judge-bias.md) · → [04-llm-observability](./04-llm-observability.md)

---

## Why care

### Move 1 — The grounded scenario

You change buffr's summarize prompt to fix a bug where it occasionally invented places that aren't in the entry. Run it against the production data; "feels better." But "feels" isn't measurable. Some regressions hide — captions used to be punchy; the new prompt makes them flat. Without an eval set, you ship and hope. With a golden set of 30 entries with expected summaries, you can run the new prompt against all 30, score, and compare to baseline before shipping.

### Move 2 — Name the question the pattern answers

That did-the-change-help question is what eval sets answer. Not "is the prompt good" (subjective); just *what's the measurable artifact that lets me say "this is better than that with N% confidence"*.

### Move 3 — Why answering that question matters

**What breaks without eval sets:** every prompt change is a guess. "Better" is whoever shouted last. The cost compounds: every chain's quality drifts over time without a regression suite.

### Move 4 — Concrete before/after

Without eval sets:
- Prompt change → manually try 3-5 entries → "looks good" → ship
- Bug surfaces in production a week later
- Fix → ship → next bug → fix
- Quality drifts; no measurement

With eval sets:
- Prompt change → run against golden set (20-50 entries) → measure score
- Score improves: ship; score regresses: don't ship
- Drift is measurable

### Move 5 — The one-line summary

Three sets: golden (baseline), adversarial (robustness), regression (don't re-introduce fixed bugs). Together they gate change.

---

## How it works

### Move 1 — The mental model

```
   ┌─ Golden set ──────────────────────────────────┐
   │  Hand-curated, "this is the right answer".    │
   │  Used to measure baseline quality.            │
   │  Small (10–100 items), high signal.           │
   └───────────────────────────────────────────────┘

   ┌─ Adversarial set ─────────────────────────────┐
   │  Inputs designed to break the system —        │
   │  edge cases, ambiguous queries, prompt        │
   │  injection attempts, malformed inputs.        │
   │  Used to measure robustness.                  │
   └───────────────────────────────────────────────┘

   ┌─ Regression set ──────────────────────────────┐
   │  Failures you caught in production, frozen    │
   │  as test cases. Grows over time. Used to      │
   │  prevent re-introducing fixed bugs.           │
   └───────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — golden set.** 20-50 hand-curated (input, expected output) pairs covering the main use cases. Buffr's planned golden sets (curriculum Phase 3):
- Suite 1 (classifier): 50 labeled todos
- Suite 2 (caption variants): 30 entries
- Suite 3 (interpret): 20 entries
- Suite 4 (RAG retrieval — once Phase 2A is built): 20-30 (query, expected entry) pairs
- Suite 7 (form classifier — out of scope for buffr): ML side

```
   buffr's planned eval surfaces (Phase 3)
   ───────────────────────────────────────
   B3.2 — classifier (heuristic vs LLM): per-type F1 on ~50 labeled todos
   B3.3 — caption variants: rubric LLM-judge on 30 entries
   B3.4 — interpret: rubric judge on 20 entries
   B3.5 — RAG retrieval: hit@k, MRR
```

**Layer 2 — adversarial set.** Inputs crafted to expose failure modes. For buffr's classifier: ambiguous todos like `[] thing` (no verb). For summarize: entries with embedded JSON or markdown that might confuse output mode. For prompt injection (concept `06-production-serving/03`): "Ignore previous instructions" embedded in user prose.

**Layer 3 — regression set.** Every production bug becomes a test case. User reports "classifier mis-classified `[] revisit the auth design` as `study` instead of `reflect` on May 10" → add to regression set with expected = `reflect`. Next prompt change runs through the regression set; if any regress, don't ship.

```
   Regression set growth
   ─────────────────────
   day 1:    empty
   week 2:   user reports a misclassification → add to set
   week 3:   2 more bugs surface → add
   ...
   over time, set becomes the most accurate measure of
   "things that matter to this user base"
```

### Move 3 — The principle

Three sets covering three failure modes. Golden for baseline, adversarial for robustness, regression for "don't re-introduce." Without them, change is guesswork.

---

## Eval sets — diagram

```
┌─ Eval sets per chain ──────────────────────────────────────────────────┐
│                                                                        │
│   For each chain in buffr:                                             │
│                                                                        │
│   ┌─ Golden ───────────┐   ┌─ Adversarial ──────┐  ┌─ Regression ──┐  │
│   │  20-50 hand-       │   │  edge cases,        │  │  bugs caught  │  │
│   │  curated pairs     │   │  ambiguous inputs   │  │  in production │  │
│   │  baseline quality  │   │  robustness         │  │  frozen        │  │
│   └────────────────────┘   └─────────────────────┘  └────────────────┘  │
│                                                                        │
│   Each prompt change runs against all three; ship iff score improves   │
│   on golden AND no regressions on regression set.                       │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr has no eval sets.**

`validate.ts` is the closest thing — it's a parse-shape check, not a quality check. Phase 3 build (curriculum `B3.1`–`B3.10`) is the seven-suite eval harness; `B3.15` is the "document one caught regression" deliverable.

---

## Elaborate

### Where this pattern comes from

Hamel Husain's writing on LLM evals (2023-2024) is the canonical reference. Pre-LLM, the same pattern existed in classical ML as train/val/test splits + holdout sets.

### The deeper principle

You can't improve what you don't measure. The three sets are the three measurements production prompt work needs.

### Where this breaks down

For prototype phase, eval sets are over-engineered. Build them when the chain ships and starts mattering. For very rare-failure chains, the regression set never grows because there's no failure to catch.

### What to explore next

- [02-eval-methods](./02-eval-methods.md) — how to score against the sets
- [03-llm-judge-bias](./03-llm-judge-bias.md) — using an LLM as scorer

---

## Tradeoffs

The breakpoint: build eval sets the moment a chain ships to production OR is being optimised. Below that, "manual try-it" is fine.

---

## Tech reference

- **Storage:** JSON or JSONL files per suite; checked into the repo.
- **Hamel Husain blog:** canonical reference for shape and discipline.

---

## Project exercises

### B3.2 — Classifier golden set

- **Exercise ID:** `B3.2`
- **What to build:** 50 labeled todos covering all 5 thinking-mode types (`todo`, `idea`, `knowledge`, `study`, `reflect`); run heuristic-only and heuristic+LLM through; report per-type precision/recall/F1.
- **Done when:** scores are documented and reproducible.
- **Estimated effort:** 4 hours (curation + runner).

---

## Summary

- Three sets: golden, adversarial, regression.
- Golden for baseline; adversarial for robustness; regression for "don't re-introduce."
- Buffr: Case B; Phase 3 builds the harness.

---

## Interview defense

**Q [mid]:** Why three sets and not one?

**A:** Each addresses a different failure mode. Golden measures baseline quality on typical inputs. Adversarial measures robustness on inputs designed to break the system. Regression catches re-introduced bugs from production. A single set can't span all three because the inputs that test "typical quality" don't overlap with the inputs that test "robustness on edge cases."

### One-line anchors

- Golden + adversarial + regression.
- Each addresses a distinct failure mode.
- Regression set grows from production bugs.

---

## Validate

### Quick check
- What's a golden set used for?
- Where does the regression set come from?
- What's the gate to ship a prompt change?

---
