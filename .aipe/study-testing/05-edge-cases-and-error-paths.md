# Edge cases and error paths

**Industry name(s):** Boundary value testing, property-based tests, error-path coverage
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

The happy path gets tested first; the unhappy paths almost never. Production failures live disproportionately at boundaries (empty input, null, max length, off-by-one) and on error branches (network down, schema mismatch, partial writes). The audit names buffr's high-value edge cases and error paths — the ones where a silent failure would matter most.

```
  Zoom out — where unhappy paths live in buffr

  ┌─ scanners ─────────────────────────────────────────┐
  │  empty prose, prose with only whitespace,           │
  │  unicode in markers, very long lines, mid-edit       │
  │  partial markers                                     │
  └────────────────────────────────────────────────────┘
  ┌─ sync ─────────────────────────────────────────────┐
  │  empty dirty set, mid-batch failure, network        │
  │  drop mid-pull, server-time skew, RLS-deny           │
  │  (PostgREST error as data)                           │
  └────────────────────────────────────────────────────┘
  ┌─ reconcile ────────────────────────────────────────┐
  │  empty existing meta, fully replaced todos, large   │
  │  todo list (>100), override-lock preservation        │
  └────────────────────────────────────────────────────┘
  ┌─ AI chains ────────────────────────────────────────┐
  │  empty entry, max-tokens output, schema violation,   │
  │  network timeout, provider 429                       │
  └────────────────────────────────────────────────────┘
```

## Structure pass

The axis is **failure** — where can each function fail, and what does the failure look like?

```
  axis = "what are the failure modes for this function?"

  function                  failure modes               currently tested?
  ────────                  ──────────────              ─────────────────
  scanTodosFromText         empty prose, malformed       NO
                            marker, unicode
  pushTable                 mid-batch failure,           NO
                            network drop, RLS deny
  pullTable                 empty page, schema           NO
                            mismatch, clock skew
  chooseWinner              null local, null cloud,      NO
                            tie
  validate.*               schema violation, partial      NO (but throws are
                            data, undefined input          covered by runtime)
```

Each row maps to a few tests; together they cover the silent-failure surface that matters most.

## How it works

### Move 1 — the unhappy-path pattern

```
  every function has at least three test classes:

  ┌─ happy path ──────┐  ┌─ boundary value ──┐  ┌─ error branch ──┐
  │  the typical case  │  │  empty, null,      │  │  the function    │
  │  the design was    │  │  max length,        │  │  throws, returns │
  │  built for         │  │  off-by-one         │  │  null, errors    │
  └────────────────────┘  └────────────────────┘  └──────────────────┘

  most suites have only the first; the bugs live in the other two.
```

### Move 2 — buffr's high-value edge case sets

**Scanners — empty + malformed + unicode + edit.** For each scanner, six edges: empty prose; whitespace-only; valid marker; malformed marker (`[`); unicode in content; mid-edit partial state. The two-pass-matching test (edit preserves identity) is high value.

```
  scanTodos edge tests

  it('returns [] for empty prose')
  it('returns [] for whitespace-only prose')
  it('returns one todo for "[]"')
  it('silently skips a malformed marker "[abc"')
  it('handles unicode in todo text')
  it('two-pass: edit preserves todo identity via line-index match')
```

**Sync — mid-batch failure + cursor anchoring + RLS-deny-as-data.** The mid-batch failure test is critical: `pushTable` must leave `synced_at` alone on rows in the failed batch so the next push retries. The PGRST106 / RLS-deny case (concept 01 silent-error finding) is the highest-impact error-path test.

```
  pushTable error tests

  it('mid-batch failure: only the succeeded-batch rows get synced_at stamped')
  it('network drop: no rows get synced_at; next push retries them')
  it('RLS-deny returned as data (zero counts, error in body): r.error is set')
       │
       └─ the third test is the one that catches the silent-error class
          before it fires in production. critical.
```

**Reconcile — empty existing, full replacement, override survival.** The override-lock survival test is especially load-bearing because forgetting the preserve step silently erases user corrections.

**AI chains — schema violation handling.** A test that feeds `validate.validateAISummary({})` and asserts `throws ChainValidationError`. Cheap; catches future schema-evolution mistakes.

### Move 3 — the principle

Edge cases and error paths are where bugs live. The bias toward happy-path testing is universal; the corrective discipline is naming the three failure modes (boundary, null, schema-violation) for every function and ensuring each has at least one test. Buffr's empty suite means the discipline can be baked in from the first test.

## Primary diagram

```
  buffr's edge-case and error-path priority list

  HIGHEST IMPACT
   1. pushTable: RLS-deny returned as data → r.error path
      (this IS the silent-failure bug class; one test = signal forever)
   2. pushTable: mid-batch failure → only successful rows stamped
   3. reconcileMeta: user_overridden_type preserved across prose edits

  MEDIUM IMPACT
   4. scanners: malformed markers silently skip (no exception)
   5. scanners: two-pass match preserves identity on edits
   6. pullTable: server-time RPC anchors the cursor (concept 04 flake risk)

  LOWER IMPACT
   7. chooseWinner: tie resolves to local
   8. validate.*: schema violation throws ChainValidationError
   9. scanners: empty/unicode/whitespace prose
```

## Implementation in codebase

### The highest-impact test — RLS-deny as data

```
  proposed: tests/integration/sync-push-rls-deny.test.ts

  it('PGRST RLS-deny returned as data → r.error set; counts zero', async () => {
    await seedDirtyEntries(['A', 'B']);
    mockSupabase.from('entries').upsert.mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'permission denied' }   ← error AS DATA
    });

    const result = await pushTable(entriesSyncable);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.error).toBe('permission denied');               ← ★ catches the
    // and crucially: no row got synced_at stamped                 ── silent class
  });
       │
       └─ this single test pins down the bug class that hid two production
          freezes. If the orchestrator's log guard is later fixed to log on
          r.error (concept 01 of software-design), THIS test exercises the
          path that would have caught both incidents.
```

## Elaborate

The "edge cases live where bugs live" framing comes from boundary-value testing in the 1970s (Myers' *The Art of Software Testing*, 1979) and has held up. The modern reinforcement: property-based testing tools (QuickCheck, fast-check) automate edge-case generation for predicates the developer asserts. Buffr's scanners are particularly amenable to property tests ("for any prose, scanning is idempotent").

## Interview defense

**Q [mid]:** What edge case would you test first?

**A:** The RLS-deny-returned-as-data case for pushTable. It's the exact bug class that hid two production sync freezes (the 0009 RLS incident, the PGRST106 schema-not-exposed). The test seeds two dirty rows, mocks the Supabase response to return an error in the data position, and asserts `result.error` is set even when `succeeded === 0`. A single test that, paired with the orchestrator's log-on-error fix, makes the silent-freeze bug class detectable forever.

```
  the highest-impact test, drawn

  test seeds dirty rows
       │
       ▼
  mock supabase returns { data: null, error: 'denied' }
       │
       ▼
  pushTable returns { succeeded: 0, failed: 0, error: 'denied' }
       │
       ▼
  assert: result.error is set
       │
       └─ silent-failure bug class detectable. forever.

  one-line anchor: "test the failure class that already fired"
```

**Q [senior]:** Walk through the property-based-test angle for buffr.

**A:** Two natural property targets: (1) scanner idempotence — `scanTodos(prose)` produces a result that, re-fed through `serialize → scanTodos`, produces the same result. (2) Two-pass identity preservation — for any prose edit where exact match fails but line index matches, the derived todo's id stays the same. Property tests with `fast-check` generate prose variations automatically; the developer asserts the invariant. Cheap to add once the harness exists.

**Q [arch]:** How do you make sure new code includes its edge-case tests?

**A:** PR template lists three classes (happy path, boundary value, error branch) and asks "for each new function, which tests cover each?" Code review enforces it. It's not a tool; it's a culture artifact. The deeper move is making error-path tests cheap to write (the harness from concept 04) so the cost of including them is low.

## Validate

### Level 1 — reconstruct the diagram

Sketch the three test classes per function (happy / boundary / error) with one buffr example per class.

### Level 2 — explain it out loud

Under 90 seconds: explain the RLS-deny-as-data test and why it's the highest-impact single test.

### Level 3 — apply to a new scenario

A new feature: `setTodoType(id, type)` lets the user pick a thinking-mode type. Enumerate the edge cases and error paths the audit would expect.

Reference `src/services/database.ts setTodoType` and the override-lock preservation requirement.

### Level 4 — defend the decision

Defend or oppose: "Edge-case tests are over-engineering for a single-user app."

Reference the RLS-deny case (already fired twice) and the silent-class blast radius.

## See also

- [`01-what-is-tested-and-what-isnt.md`](./01-what-is-tested-and-what-isnt.md) — the priority list these tests slot into.
- [`07-testing-red-flags-audit.md`](./07-testing-red-flags-audit.md) — zero-tests-on-error-branches as a checklist item.
- `.aipe/study-software-design/01-complexity-in-this-codebase.md` — the silent-error guard is the bug class this concept's top test catches.
