# What's tested and what isn't — the risk map

**Industry name(s):** Risk-based coverage, test gap analysis
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

The coverage map isn't the percentage — it's the RISK map. Which critical paths have automated tests, which don't, ranked by what would break loudest in production. The audit's first job is honest accounting: enumerate what's tested vs not, then rank what's not by impact.

```
  Zoom out — buffr's automated test surface

  ┌─ buffr ──────────────────────────────────────────┐
  │  app/, src/                                      │
  │                                                  │
  │  AUTOMATED TESTS:                                 │
  │  ★ NONE ★                                         │
  │                                                  │
  │  COMPILE-TIME ASSURANCE:                          │
  │  npx tsc --noEmit  ← the one passing gate        │
  │                                                  │
  │  MANUAL QA:                                       │
  │  end-to-end on connected Android device after    │
  │  each meaningful change                           │
  └──────────────────────────────────────────────────┘
```

The headline is empty — and that's the audit. The rest of the guide names what to test FIRST given buffr's risk map.

## Structure pass

The axis is **blast radius** — for each untested code path, if it breaks silently, what's the cost?

```
  axis = "if this silently breaks, how big is the blast?"

  code path                                  blast radius
  ─────────                                  ────────────
  sync push/pull (orchestrator + per-table)  ★ HIGHEST — silent cloud drift
  1:1 invariant (reconcileMeta)              HIGH — todos lose typed expansion
  override-lock (user_overridden_type)       HIGH — user trust eroded silently
  prose scanners (todos, threads, nutrition) MED — drops mis-derived from prose
  AI chain output shape (validate.ts)        MED — caught by runtime; signal
                                                    where it fails would help
  LWW conflict (chooseWinner)                 MED — single-writer makes it
                                                    moot today; Phase B widens
  AI chain content quality                    EVAL CONCERN — see study-ai-eng
```

Tests follow blast radius. The top three rows are where buffr's first 30 tests should go.

## How it works

### Move 1 — the risk-map pattern

```
  coverage by risk, not by percentage

  ┌─ test these first ──────────────────────────────────┐
  │  highest blast radius if silent                      │
  │  most-changed paths (sync, scanners)                  │
  │  hardest-to-debug post-hoc                            │
  └─────────────────────────────────────────────────────┘
  ┌─ test these later ──────────────────────────────────┐
  │  low blast radius                                    │
  │  rarely changed                                       │
  │  obvious failures (the user notices immediately)      │
  └─────────────────────────────────────────────────────┘
```

The 80/20 of testing value: the first 30 tests, on the right code paths, cover the silent-failure surface. Adding the next 200 tests covers maybe 30% more value. Get the first 30 right.

### Move 2 — buffr's untested-and-needs-testing list

**Sync engine — top priority.** The push and pull flows have the highest blast radius (silent cloud drift is the bug class that already fired twice — the 0009 RLS incident, the PGRST106 schema-not-exposed). The tests aren't model-evaluation; they're deterministic harness around the cursor logic, the dirty-filter, and the chooseWinner. Targets:

```
  sync engine — buildable tests (deterministic)

  1. push: dirty filter selects rows where updated_at > synced_at
  2. push: successful batch stamps synced_at; failure leaves it alone
  3. pull: cursor (last_pull_at) advances by max(updated_at) in the page
  4. chooseWinner: newer updated_at wins; tie resolves to local
  5. server-time RPC: pull stamps last_pull_at from server now, not Date.now()
```

**Prose scanners — second priority.** `scanTodos`, `scanNutrition`, `scanThreadMentions` derive structured records from prose; an undetected regression there silently mis-derives drops. Two-pass matching (exact → line-index fallback) is testable end-to-end against fixture prose.

```
  scanners — buildable tests (deterministic)

  6. scanTodos: extracts ` []` lines as todos
  7. scanTodos: two-pass matching preserves identity on edit
  8. scanNutrition: extracts `** food N kcal` as nutrition rows
  9. scanThreadMentions: extracts `#tag` mentions
  10. all scanners: invalid markers are silently skipped (no exception)
```

**The 1:1 invariant — third priority.** `reconcileTodoMetaForEntry` is the enforcer of the invariant SQLite can't FK. Testing that it preserves `user_overridden_type` and `classifier_confidence` across a prose edit is high signal.

```
  reconcileMeta — buildable tests (deterministic)

  11. survival: matching todos preserve user_overridden_type
  12. survival: matching todos preserve expanded_md
  13. add: new todo → new meta row inserted with defaults
  14. remove: deleted todo → meta row soft-deleted (deleted_at stamped)
```

**AI chain boundaries — fourth priority.** This is the deterministic-half of "testing AI features" (concept 06). The chains themselves are probabilistic; the boundaries — prompt assembly, schema parsing, validate.ts schema enforcement — are deterministic and testable.

### Move 3 — the principle

Coverage isn't a percentage; it's a risk map. The first 30 tests on the right paths catch the silent-failure class that's already bitten twice; the next 200 tests cover diminishing returns. Buffr's sync engine carries the highest blast radius and the lowest coverage — that's where the first tests go.

## Primary diagram

```
  buffr's test priority list — write in this order

  PRIORITY 1 (silent-failure class; already fired in production)
   ─ sync push: dirty filter + synced_at stamping
   ─ sync pull: cursor advancement
   ─ chooseWinner: LWW decision rule

  PRIORITY 2 (drops mis-derivation; silent state drift)
   ─ scanTodos / scanNutrition / scanThreadMentions
   ─ two-pass matching across edits

  PRIORITY 3 (1:1 invariant survival)
   ─ reconcileTodoMetaForEntry across edits, adds, removes
   ─ user_overridden_type preservation
   ─ expanded_md preservation

  PRIORITY 4 (LLM deterministic boundaries — concept 06)
   ─ prompt assembly fixtures
   ─ validate.ts schema enforcement
   ─ cache shape (ai_summaries write/read)

  NOT TODAY
   ─ E2E flows (manual QA covers; expensive to automate first)
   ─ UI snapshot tests (cost > value at this stage)
   ─ LLM output quality (eval-set work; study-ai-engineering territory)
```

## Implementation in codebase

### The one passing gate today

```
  package.json scripts (the only "test")

  "scripts": {
    "type-check": "tsc --noEmit"
  }
       │
       └─ tsc verifies code correctness (do all imports resolve, do types
          line up). It does NOT verify behavior correctness. A function
          that passes tsc can still corrupt state on every call.
```

### The buildable first test — push dirty filter

```
  proposed: tests/sync/push.test.ts (does not exist yet)

  describe('pushTable dirty filter', () => {
    it('selects rows where updated_at > synced_at', async () => {
      // setup: seed local DB with 3 rows
      //   row A: updated_at = '2025-12-01', synced_at = '2025-12-01'  // clean
      //   row B: updated_at = '2025-12-02', synced_at = '2025-12-01'  // dirty
      //   row C: updated_at = '2025-12-03', synced_at = null          // dirty
      const dirty = await entriesSyncable.localQueryDirty();
      // assert: only B and C returned
      expect(dirty.map(r => r.id).sort()).toEqual(['B', 'C']);
    });
  });
       │
       └─ this test is deterministic, fast, isolated, and pins down the
          highest-blast-radius logic. Cheapest first test to ship.
```

## Elaborate

The risk-based coverage framing comes from Kent Beck's *Test-Driven Development* (2002) and is reinforced in Hamel Husain's eval-side writing for AI features: percentage coverage is a vanity metric; risk coverage is the real metric. Buffr's first 30 tests, written against the priority-1 and priority-2 list above, would cover 80% of the silent-failure surface — the cost is one focused week of work, not an ongoing campaign.

The deterministic / probabilistic seam (this guide vs `study-ai-engineering`'s evals) is the framing Hamel Husain has popularized for LLM-feature testing — write deterministic tests against everything around the model; evaluate the model output separately.

## Interview defense

**Q [mid]:** What's the test coverage of this codebase?

**A:** Zero automated tests. The only gate is `tsc --noEmit` for type safety. The audit's job isn't to pretend that's adequate — it's to name the cheapest first 30 tests that would cover 80% of the silent-failure surface, ranked by blast radius. Sync engine first (the bug class that's already fired twice), prose scanners second, the 1:1 invariant third, AI chain boundaries fourth.

```
  the priority list

   1. sync push dirty filter + synced_at stamping
   2. sync pull cursor advancement
   3. chooseWinner LWW
   4. scanTodos / scanNutrition / scanThreadMentions
   5. reconcileTodoMetaForEntry survival across edits

  one-line anchor: "coverage isn't a percentage; it's a risk map"
```

**Q [senior]:** What would you test first, and why?

**A:** The sync engine's dirty filter. It's the highest blast radius — silent cloud drift is the bug class that already cost two incidents (0009 RLS, PGRST106 schema-not-exposed). It's also deterministic: given known rows with known timestamps, the dirty filter returns a known set. The test is ~20 lines; the impact is preventing the next silent freeze from being undetectable.

**Q [arch]:** How do you defend zero tests in production?

**A:** Honestly: the suite is empty because the codebase was solo-built and the surface that justified testing — multi-user sync, multi-device handoff, regression risk from many contributors — hasn't materialized yet. The mitigations are `tsc --noEmit` for type correctness, manual e2e after each change, and the document-the-invariants discipline in `docs/spec.md`. Phase B (multi-user) is the forcing function for tests; the priority list above is the roadmap.

## Validate

### Level 1 — reconstruct the diagram

Sketch the priority list (1–4) with one example test per priority.

### Level 2 — explain it out loud

Under 90 seconds: name the top priority (sync engine), why (silent failure class with two incidents), and the first concrete test.

### Level 3 — apply to a new scenario

A new contributor proposes writing snapshot tests for the journal screen. Walk the audit: is this the right first test? What's higher priority?

Reference the priority list above and `.aipe/project/rules.md` (the current "no automated tests" state).

### Level 4 — defend the decision

Defend or oppose: "Buffr should write E2E tests first — they catch the most realistic bugs."

Reference the priority list and the sync engine as the highest-blast-radius unit.

## See also

- [`03-tests-as-design-pressure.md`](./03-tests-as-design-pressure.md) — why buffr's deep-module design is testable in the first place.
- [`06-testing-ai-features.md`](./06-testing-ai-features.md) — the deterministic seams around the chains.
- [`07-testing-red-flags-audit.md`](./07-testing-red-flags-audit.md) — the consolidated checklist.
- `.aipe/study-software-design/02-deep-vs-shallow-modules.md` — deep modules are easy to test; that's the deep-modules payoff.
