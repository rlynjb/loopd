# buffr — testing & correctness audit

A deterministic-correctness audit of **buffr**: what's tested, what isn't, whether the test design is sound, where the suite holds up under flakiness pressure. Findings are grounded in real files.

## The headline

> **buffr currently has zero automated tests.** Per `.aipe/project/rules.md`: "No automated test suite at present. Manual end-to-end on the connected Android device after each meaningful change. All builds must pass `npx tsc --noEmit` cleanly."

That's the honest top-line, and most of this guide's findings flow from it. The guide doesn't manufacture findings — it names the suite as empty, names what to test FIRST given the risk map, and names which boundaries are deterministically testable today (the AI chains have testable seams even though the chain output itself is probabilistic).

## The through-line

> The question: how do you KNOW the code works — and will keep working after the next change?

Tests answer the unknown-unknowns symptom — a good suite tells you what a change broke before your users do. A suite that doesn't is decoration. Buffr's suite is empty. The audit's job is to name the cheapest, highest-signal tests to add first.

## The deterministic-vs-eval seam

```
  this guide                     study-ai-engineering's evals
  ────────────                   ────────────────────────────
  DETERMINISTIC correctness       PROBABILISTIC evaluation
  given known input → known       given input → "is good
  output asserted                  enough / didn't regress"
                                  
  unit / integration / property   eval sets, LLM-as-judge,
  testing                          regression suite
                                  
  THEY MEET when you test AI features:
  a deterministic harness around a probabilistic core.
  state which half a finding belongs to.
```

The chains in `src/services/ai/` have BOTH halves — deterministic boundaries (prompt assembly, schema parsing, validation, output caching) AND a probabilistic core (the model itself). The deterministic boundaries are testable here; the model output is evaluated in `study-ai-engineering/05-evals-and-observability/`.

## Reading order

```
  the audit in seven concepts

  01 what-is-tested-and-what-isnt         ─ the coverage map (RISK, not %)
       │
       ▼
  02 test-design-and-levels               ─ unit vs integration vs e2e shape
       │
       ▼
  03 tests-as-design-pressure             ─ where buffr's design helps testing
       │                                    (and where it'd hurt)
       ▼
  04 determinism-isolation-and-flakiness  ─ what would flake when tests
                                            arrive
       │
       ▼
  05 edge-cases-and-error-paths           ─ the unhappy-path coverage
                                            target
       │
       ▼
  06 testing-ai-features                  ─ the deterministic seams around
                                            probabilistic chains
       │
       ▼
  07 testing-red-flags-audit              ─ consolidated checklist
                                            (the capstone)
```

## What this guide is, and isn't

- **What it is:** an honest "the suite is empty" audit with prioritized buildable targets — what to test first, what to test next, where the deterministic seams are around the probabilistic LLM core.
- **What it isn't:** a generic guide to testing. The findings are about buffr's specific risk map (sync engine's silent-error class, the 1:1 invariant, the override-lock contract), not "you should write more tests."

## Cross-references

The deterministic-eval seam means this guide and `.aipe/study-ai-engineering/05-evals-and-observability/` together cover the AI test surface. The system-design view of the sync layer (which carries the highest-risk-yet-untested code) lives in `.aipe/study-system-design-dsa/01-system-design/`. The software-design audit cross-links "hard to test" as a design smell — referenced, not duplicated.
