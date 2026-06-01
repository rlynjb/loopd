# Tests as design pressure

**Industry name(s):** Testability as a design property, deep modules are testable, design smell via test difficulty
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

Code that's hard to test is often code that's poorly designed — global state, side effects, deep coupling, hidden control flow. Conversely, deep modules with narrow interfaces are *naturally* testable: you feed the interface inputs and assert on outputs. The audit asks: where would adding tests be EASY for buffr (praise), and where would it be HARD (a design smell pointing back at concept 02 of software-design)?

```
  Zoom out — testability across buffr's modules

  ┌─ EASY TO TEST ────────────────────────────────────┐
  │  scanTodos / scanNutrition / scanThreadMentions    │ ★ pure
  │   ─ pure functions; prose → array                  │
  │  validate.ts                                       │ ★ pure
  │   ─ schema → parsed value or throw                 │
  │  heuristicClassify                                 │ ★ pure
  │   ─ text → 'todo' | null                           │
  │  chooseWinner                                      │ ★ pure
  │   ─ (local, cloud) → 'local' | 'cloud'             │
  └────────────────────────────────────────────────────┘

  ┌─ EASY WITH REAL SQLITE ──────────────────────────┐
  │  database.ts writers (real DB; mock network)      │
  │  reconcileTodoMetaForEntry (real DB; pure logic)  │
  │  pushTable / pullTable (real DB; mock network)    │
  └───────────────────────────────────────────────────┘

  ┌─ HARDER ─────────────────────────────────────────┐
  │  ai chains (probabilistic core; concept 06)       │
  │   ─ deterministic boundaries testable; output not │
  └───────────────────────────────────────────────────┘
```

The praise finding: buffr is mostly *easy to test* because its design is deep-modules-with-pure-cores. That's not luck — it's the design payoff from the software-design audit (concept 02).

## Structure pass

The axis is **purity** — does the unit under test compute a value from inputs, or does it touch external state?

```
  axis = "does this function compute, or does it touch state?"

  function                           purity              testable?
  ────────                           ──────              ─────────
  scanTodosFromText(prose, prior)    PURE                ✓ unit
  validate.validateAISummary(data)   PURE                ✓ unit
  heuristicClassify(text)             PURE                ✓ unit
  chooseWinner(local, cloud)         PURE                ✓ unit
  reconcileTodoMetaForEntry(...)     reads + writes DB    ✓ integration
  pushTable / pullTable               reads + writes DB    ✓ integration
                                      + network              (mock net only)
  ai chains                           network-bound +      ◐ deterministic
                                      probabilistic         boundaries only
```

Pure functions are the cheapest tests to write. Buffr has a lot of them at the core of its design — the praise finding that this concept names explicitly.

## How it works

### Move 1 — testability as design property

```
  the pattern: testability follows depth

  deep module:
   ─ narrow interface           ←  small surface to feed
   ─ pure core                  ←  no external state to mock
   ─ explicit inputs            ←  test fixtures are obvious
   ─ explicit outputs            ←  assertions are direct

  shallow / tangled module:
   ─ wide interface              ←  many params to vary in tests
   ─ global state or side fx     ←  setup is elaborate; isolation
                                     hard to maintain
   ─ implicit deps               ←  mocks proliferate
   ─ hidden control flow         ←  the test "passes" but doesn't
                                     exercise what you think
```

### Move 2 — buffr's testability scorecard

**Pure-core praise findings.** Every scanner is `prose → array` (no globals, no side effects). `heuristicClassify` is `text → 'todo' | null`. `validate.ts` is `unknown → typed result or throw`. `chooseWinner` is `(local, cloud) → 'local' | 'cloud'`. Each is a one-line interface with no hidden inputs. Tests are trivial fixtures and assertions.

```
  example testability — scanTodosFromText

  // setup: literal prose string
  const prose = `today
  [] call mom
  [] fix bug by EOD
  noticed: dashboard flickers
  `;

  // act: pure function call
  const todos = scanTodosFromText(prose);

  // assert: explicit output shape
  expect(todos).toEqual([
    { text: 'call mom', lineIndex: 1 },
    { text: 'fix bug by EOD', lineIndex: 2 },
  ]);
       │
       └─ no DB, no network, no globals. The function's design is
          the test's setup. Deepest pattern = cheapest test.
```

**Integration-shaped (still testable) findings.** `pushTable`, `pullTable`, `reconcileTodoMetaForEntry`, `database.ts` writers — these touch SQLite but are otherwise deterministic. The cost of testing them is one in-memory `expo-sqlite` instance per test; the benefit is realistic coverage of the modules most likely to silently break.

**Harder-to-test surface.** AI chain output content is probabilistic (the model isn't deterministic). Concept 06 walks the seam: the deterministic boundaries around the chain (prompt assembly, schema parse, validate, cache write) ARE testable; the chain's output content is for evals (study-ai-engineering).

### Move 3 — the principle

Testability is a design property — deep modules with pure cores are cheap to test; shallow / coupled modules are expensive. Buffr's design (mostly deep, mostly pure-cored) is a praise finding for testability that hasn't yet been redeemed (because the suite is empty). The first 30 tests will be cheap to write *because* the design was right.

## Primary diagram

```
  buffr's testability scorecard

  PURE → CHEAP UNIT TESTS
   ─ scanTodos, scanNutrition, scanThreadMentions
   ─ validate.ts (all validator functions)
   ─ heuristicClassify
   ─ chooseWinner

  DB-TOUCHING → CHEAP INTEGRATION TESTS (real expo-sqlite in-memory)
   ─ pushTable / pullTable
   ─ reconcileTodoMetaForEntry
   ─ database.ts writers

  PROBABILISTIC → DETERMINISTIC HARNESS (concept 06)
   ─ ai chains: test the boundaries, eval the model

  PRAISE: buffr's design is unusually test-friendly. The empty
  suite isn't a design problem; it's an investment problem.
```

## Implementation in codebase

### The deepest-cored pure function

```
  src/services/sync/conflict.ts (~L20–L30)

  export function chooseWinner(
    local: Row | null,
    cloud: Row | null
  ): 'local' | 'cloud' {
    if (!cloud) return 'local';
    if (!local) return 'cloud';
    return local.updated_at >= cloud.updated_at ? 'local' : 'cloud';
  }
       │
       └─ pure: two inputs, one output, no side effects. The test
          would be 4 lines per case × ~6 cases = 30 lines total.
          The function's design IS the test's outline.
```

### The integration shape — real SQLite + mocked network

```
  proposed: tests/integration/reconcileMeta.test.ts

  beforeEach(async () => {
    await openTestDb(':memory:');
    await runMigrations();
  });

  it('preserves user_overridden_type across a prose edit', async () => {
    // seed: one todo with user_overridden_type = true
    await seedTodo({ id: 't1', type: 'study', user_overridden_type: true });
    // re-scan with slightly edited prose (still matches via two-pass)
    await reconcileTodoMetaForEntry('e1', [{ id: 't1', text: 'edited' }], ...);
    // assert: the lock survived
    const meta = await getTodoMeta('t1');
    expect(meta.user_overridden_type).toBe(true);
    expect(meta.type).toBe('study');
  });
       │
       └─ real DB + pure reconcile logic. mock nothing except where
          there's no way to test without it (we don't mock anything here).
```

## Elaborate

The "testability follows design" principle goes back to Michael Feathers' *Working Effectively with Legacy Code* (2004) — Feathers' central observation is that legacy code is hard to test *because* its design accumulated coupling. Inversely, deep modules with narrow interfaces and pure cores are the easiest to test. Buffr's design has both properties largely by intent (the deep-modules pattern in `study-software-design/02-deep-vs-shallow-modules.md`).

The praise finding here is honest — it's not common for an audit to say "the design will make the tests cheap to write." For buffr it's true.

## Interview defense

**Q [mid]:** Is buffr's design testable?

**A:** Yes — the deep-modules pattern from the software-design audit shows up here as testability. Pure functions throughout the core (scanners, validate.ts, heuristicClassify, chooseWinner) are unit-testable in 5–10 lines each. DB-touching code is integration-testable with one in-memory SQLite per test. The chains have deterministic boundaries (testable) and a probabilistic core (eval territory). The empty test suite is an investment gap, not a design problem.

```
  the praise finding, one-line

  deep modules + pure cores → cheap tests + minimal mocking

  buffr's first 30 tests are cheap to write BECAUSE the design was right.

  one-line anchor: "testability follows depth"
```

**Q [senior]:** Where would adding tests be hardest?

**A:** Code that's deeply coupled to React Native's lifecycle (e.g., `useFocusEffect` interactions, debounced timers in `schedulePush`). Those need either fake timers (Jest supports), a wrapper that's mockable, or e2e on device. None are intractable; they're "moderate cost" rather than "easy." The chain output content is the other hard surface — but that's eval territory, not test territory.

**Q [arch]:** What does it cost to invest in tests now vs Phase B?

**A:** Now: one focused week to write the priority-1 and priority-2 list (~30 tests, ~700 lines, mostly integration). Phase B: same tests, plus auth + RLS test fixtures, plus multi-user state setup, plus realistic concurrent-edit scenarios. The cost roughly doubles. The argument for now: the codebase isn't going to get smaller, and the test-friendly design will start eroding under feature pressure once shipping is happening. Cheaper to lock in the harness while the design is at its cleanest.

## Validate

### Level 1 — reconstruct the diagram

Sketch the testability scorecard (pure / integration / probabilistic) with examples per row.

### Level 2 — explain it out loud

Under 90 seconds: explain the testability-follows-design principle and name one pure function in buffr that proves it.

### Level 3 — apply to a new scenario

A new contributor adds a function that reads from `Date.now()` and writes to AsyncStorage. Walk the testability implications.

Reference `chooseWinner` (the deepest-pure example) as the contrast.

### Level 4 — defend the decision

Defend or oppose: "Buffr's design is already test-friendly — write the tests later, when needed."

Reference the priority list from concept 01 and the testability scorecard.

## See also

- [`01-what-is-tested-and-what-isnt.md`](./01-what-is-tested-and-what-isnt.md) — the priority list.
- [`02-test-design-and-levels.md`](./02-test-design-and-levels.md) — the right level per testable surface.
- `.aipe/study-software-design/02-deep-vs-shallow-modules.md` — the design pattern that produces this testability.
