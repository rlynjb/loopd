# Testing red flags audit — the consolidated checklist

**Industry name(s):** Testing review checklist, suite-health audit
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

The consolidated testing checklist for buffr. Since the suite is empty, almost every flag is "will fire if not addressed in the first test." The audit's job is to surface the prevention pattern for each red flag BEFORE the first test is written — so the suite ships with the right shape, not a retrofit later.

```
  Zoom out — buffr's testing posture, one line

  ┌─ today ─────────────────────────────────────────────┐
  │  zero automated tests                                │
  │  tsc --noEmit passes                                  │
  │  manual e2e on Android after each meaningful change   │
  └──────────────────────────────────────────────────────┘

  ┌─ the TOP THREE moves (ranked) ──────────────────────┐
  │  1. write the RLS-deny-as-data test (concept 05)    │
  │     ★ covers the silent-failure bug class that fired │
  │     twice in production. one test. forever signal.    │
  │  2. build the test harness (concept 04 four moves)   │
  │     ★ fake timers + :memory: SQLite + boundary mocks  │
  │  3. write the priority-1 sync engine integration     │
  │     tests (concept 01)                                │
  └──────────────────────────────────────────────────────┘
```

## Structure pass

The axis is **severity** — for each red flag that will fire when the first test is written without prevention, what's the cost?

```
  axis = "if this flag fires, who is positioned to catch it?"

  HIGH    — bug class already fired in production
  MED     — flaky / unmaintainable suite shape; degrades trust
  LOW     — easily corrected in code review
  PRAISE  — the design currently prevents the flag from firing
```

## How it works

### Move 1 — the checklist (one row per flag)

```
  every row: flag, fires?, location, severity, fix
```

### Move 2 — buffr's testing red-flag scorecard

**Coverage / design**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| The most important / most complex code is the least tested | ✓ AUDIT | HIGH | priority list in concept 01: sync engine first |
| Zero tests on error / exception branches | ✓ AUDIT | HIGH | concept 05's priority list (RLS-deny as data, mid-batch failure) |
| Hard-to-test code is a design smell | ✗ PRAISE | — | buffr is deep-modules + pure-cored; cheap to test (concept 03) |

**Test design / levels**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Inverted pyramid (all e2e, slow, flaky) | ✗ N/A (suite empty) | — | concept 02's order: integration first, then unit, then e2e |
| Heavy mocking — tests the mock, not the code | ✗ AT RISK | MED | mock at SDK boundary, not at fetch; real SQLite in-memory |
| Tests need elaborate setup to reach the code | ✗ PRAISE | — | deep-modules design keeps setup small (concept 03) |

**Determinism / flakiness**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| A test that passes / fails on rerun with no code change | ✗ AT RISK | MED | the four moves in concept 04: fake timers + :memory: DB + boundary mocks + module reset |
| Tests must run in a specific order | ✗ AT RISK | MED | per-test setup/teardown enforces isolation |
| Network / time / random / shared state leaks into tests | ✗ AT RISK | MED | same four moves |

**Error paths**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| No tests on the error / exception branches | ✓ AUDIT | HIGH | concept 05's priority list (RLS-deny, mid-batch fail, schema violation) |
| Happy path is tested; the rest isn't | ✓ AUDIT | HIGH | three test classes per function (happy / boundary / error) |

**AI feature seam (concept 06)**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| An LLM feature with no test at the boundary | ✓ AUDIT | MED | test buildPrompt, validate, cache write, dispatch — all deterministic |
| Test and eval conflated into one fuzzy concept | ✗ AT RISK | LOW | state which half each finding belongs to |

### Move 3 — the principle

A red-flag checklist for a codebase with zero tests is mostly about prevention — naming the patterns the first tests should follow so the suite isn't broken from day one. Buffr's testing audit's value isn't critique of an existing suite; it's prescription for the one to come.

## Primary diagram

```
  buffr's testing scorecard

  HIGH SEVERITY (the silent-failure class)
   ─ sync engine has zero tests
   ─ RLS-deny-as-data path has zero tests
   ─ error branches have zero tests

  MED SEVERITY (would degrade the suite if not addressed)
   ─ no test harness yet (fake timers, :memory: DB, boundary mocks)
   ─ no determinism discipline established
   ─ no integration test pattern (real SQLite + mocked network)

  LOW SEVERITY (style; fix in code review)
   ─ test-eval seam discipline (which half is a finding?)

  PRAISE FINDINGS
   ─ deep modules + pure cores make testing cheap
   ─ tsc --noEmit catches type errors before runtime
   ─ design naturally separates deterministic boundaries from
     probabilistic core (AI chains)

  THE TOP 3 MOVES (in this order)
   1. write the RLS-deny-as-data test (concept 05)
   2. build the harness (concept 04)
   3. ship the priority-1 sync engine integration tests (concept 01)
```

## Implementation in codebase

### Move 1 — the highest-impact single test

```
  proposed: tests/integration/sync-push-rls-deny.test.ts

  the same test from concept 05 — pins down the silent-failure bug
  class that hid two production incidents. one test; permanent signal.

  pair with the orchestrator.ts:49,72 fix (software-design concept 01):
  `if (succeeded || failed || r.error) log(...)`

  together: silent freezes become loud.
```

### Move 2 — the harness

```
  proposed: tests/helpers/setup.ts (concept 04 four moves)

  ─ in-memory SQLite per test
  ─ fake timers anchored to fixed date
  ─ Anthropic + Supabase SDK mocks (boundary, not fetch)
  ─ reset module-level config in afterEach

  every test file uses this. consistent isolation; no flakiness.
```

### Move 3 — the priority-1 list

```
  the concept 01 list — sync engine first

   1. push: dirty filter selects WHERE updated_at > synced_at
   2. push: successful batch stamps synced_at; failure leaves alone
   3. pull: cursor advances to max(updated_at) in the page
   4. chooseWinner: newer updated_at wins; tie resolves to local
   5. server-time RPC anchors pull cursor (not Date.now)

   estimated effort: one focused week.
   estimated impact: 80% of silent-failure surface covered.
```

## Elaborate

The "checklist for a codebase with no tests" framing is unusual — most testing audits land on existing suites and identify gaps in coverage. Buffr's audit is the inverse: there are no tests, so the audit is a *prescription* for the first ones. The cost of getting this wrong is a suite that ships with bad shape (heavy mocking, no isolation, flakiness) and is more expensive to fix than to redo. The cost of getting it right is one focused week and a permanent floor under regression risk.

For each finding's deeper context, see the originating concept file. This page is the index; the depth lives in concepts 01–06.

## Interview defense

**Q [mid]:** What's the worst red flag right now?

**A:** Zero tests on the silent-failure bug class — the sync engine error-as-data path. The class already fired twice (0009 RLS incident, PGRST106 schema-not-exposed). A single test, paired with the orchestrator's log-on-error fix, makes the class detectable forever. The audit's highest-impact-per-line-of-test recommendation.

```
  the top finding, one diagram

  pushTable returns { succeeded: 0, failed: 0, error: 'denied' }
       │
       ▼  test asserts result.error is set
       │
       ▼  fix: orchestrator.ts:49 logs on r.error too

  silent-failure class detectable.
  one test. permanent.

  one-line anchor: "the test that catches the bug class already in your post-mortems"
```

**Q [senior]:** What three things ship before the first 30 tests?

**A:** (1) Test harness with fake timers + in-memory SQLite + SDK-boundary mocks (concept 04). (2) Priority list ordered by blast radius (concept 01). (3) Convention for which test level applies per surface (concept 02 — integration first for sync + scanners, unit for the pure cores). With those three, writing 30 tests is mechanical and consistent.

**Q [arch]:** What's the broadest testing red flag this codebase MIGHT exhibit that you can't predict yet?

**A:** Tests that assert on snapshot output (UI snapshots, structured-data snapshots). They look comprehensive but tend to ratchet up "what changed" without the developer understanding why; they're a maintenance tax. The audit's preempt: avoid snapshot tests for anything beyond stable, well-defined contracts. If the contract isn't stable, the snapshot just chases drift.

## Validate

### Level 1 — reconstruct the diagram

Sketch the severity ladder with buffr's high-severity items (the silent-failure class) and praise findings (deep design).

### Level 2 — explain it out loud

Under 90 seconds: name the top three moves (RLS-deny test, harness, priority-1 sync tests) and the order.

### Level 3 — apply to a new scenario

A new contributor proposes starting with E2E tests "for realism." Walk the audit's response.

Reference concept 02's order recommendation (integration first, then unit, then e2e).

### Level 4 — defend the decision

Defend or oppose: "Snapshot tests are the cheapest way to start testing UI changes."

Reference the snapshot-test anti-pattern named above.

## See also

- [`01-what-is-tested-and-what-isnt.md`](./01-what-is-tested-and-what-isnt.md) — the priority list.
- [`02-test-design-and-levels.md`](./02-test-design-and-levels.md) — the level allocation.
- [`03-tests-as-design-pressure.md`](./03-tests-as-design-pressure.md) — the praise finding for buffr's design.
- [`04-determinism-isolation-and-flakiness.md`](./04-determinism-isolation-and-flakiness.md) — the four moves.
- [`05-edge-cases-and-error-paths.md`](./05-edge-cases-and-error-paths.md) — the RLS-deny test.
- [`06-testing-ai-features.md`](./06-testing-ai-features.md) — the test-vs-eval seam.
