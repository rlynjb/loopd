# Test design and levels

**Industry name(s):** Test pyramid, unit vs integration vs e2e, mock vs real
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

The test pyramid: many fast unit tests at the base, fewer slower integration tests in the middle, a few end-to-end tests at the top. Buffr has none of these today. The concept walks what the right shape would be when the suite is built — and the related anti-patterns (heavy mocking that tests the mock, inverted pyramid all-e2e suites).

```
  Zoom out — the pyramid shape buffr's suite SHOULD take

  ┌─ E2E (Detox / Maestro on device) ──────────────────┐
  │  few; expensive; slow; high-realism                 │  ◐ 0 today;
  │  cover: critical user flow (write entry → see       │     fund LATER
  │  derived todos → see AI summary)                    │
  └─────────────────────────────────────────────────────┘
  ┌─ Integration (Jest + real SQLite) ─────────────────┐
  │  moderate; mid-speed; mid-realism                    │  ★ 0 today;
  │  cover: scanners + reconcile + DB writers           │     fund FIRST
  │  cover: sync push/pull against test SQLite           │
  └─────────────────────────────────────────────────────┘
  ┌─ Unit (Jest, pure functions) ──────────────────────┐
  │  many; fast; isolated                                │  ◐ 0 today;
  │  cover: validate.ts, chooseWinner, heuristic regex   │     fund THIRD
  │  rules                                               │
  └─────────────────────────────────────────────────────┘
```

The recommended order is unusual — integration first, not unit first — and that's because buffr's highest-blast-radius code (sync + scanners + reconcile) is integration-shaped, not pure-function-shaped.

## Structure pass

The axis is **isolation level** — how much of the system does each test exercise, and how realistic is its environment?

```
  axis = "how much system does this test cover, and how realistic is it?"

  level         scope                    cost      realism   value here
  ─────         ─────                    ────      ───────   ──────────
  unit          one function             fast      low       MED
  integration   service + real SQLite    medium    medium    HIGH (sync, scan)
  e2e (device)  full app on Android      slow      high      LOW first; HIGH eventually
```

For buffr, integration tests dominate the value curve early because the failure modes (silent sync drift, scanner mis-derivation) cross multiple modules.

## How it works

### Move 1 — the pyramid pattern (the shape)

```
  the pyramid, AS BUILT correctly

         /\
        /e2e\           ← few, slow, real device
       /────\
      /      \
     /  intg  \         ← moderate, real SQLite
    /────────\
   /   unit   \         ← many, fast, isolated
  /───────────\

  the inversion (anti-pattern):

   ────────────
   \   e2e    /          ← all e2e; slow; flaky; expensive to maintain
    \        /
     \  intg /
      \─────/
       \unit/
        \──/
```

### Move 2 — the right levels for buffr's high-priority targets

**Sync engine — integration first.** The dirty filter, the cursor, chooseWinner — these touch SQLite and the sync_meta table. A pure-unit test of `pushTable()` would need to mock the SQLite client AND the Supabase client; the mocks would carry as much logic as the function. Bad shape. The right test seeds a real `expo-sqlite` in-memory DB, runs `pushTable()` against a mocked Supabase response, and asserts on what landed in `synced_at`.

```
  the right shape — integration with real SQLite, mocked network

  seed real SQLite (3 rows; varying updated_at / synced_at)
       │
       ▼
  call pushTable(entriesSyncable)  ← real function under test
       │  (Supabase upsert mocked to succeed)
       ▼
  assert: synced_at stamped on the dirty rows
  assert: synced_at unchanged on the clean rows
       │
       └─ realism: real SQLite. mocked only the network call. minimal
          mocking, maximum coverage of real code.
```

**Scanners — pure unit (the exception).** `scanTodosFromText(prose, priorScan?) → TodoItem[]` is a pure function. No DB, no network. A unit test feeds prose, checks the array. Simple, fast, the right level.

**Reconcile + writers — integration with real SQLite.** Same shape as sync — touches the DB. Mock the network if sync is involved.

**E2E — last priority.** Detox or Maestro on Android. Cover the critical user flow once the unit + integration suite is mature. The cost is high (device farm, slow CI); the value is "did all the parts compose correctly." Important eventually; not urgent.

### Move 3 — the principle

Match the test level to the unit's natural shape. Pure functions get unit tests; DB-touching code gets integration with a real DB; multi-system flows get e2e. Heavy mocking is a code smell — the test ends up verifying the mock. Buffr's biggest value-per-test lives at the integration level because the highest-blast-radius code crosses modules.

## Primary diagram

```
  buffr's recommended test-level allocation, by priority

  ─ unit (Jest)                                     fund THIRD
     scanTodos / scanNutrition (pure)
     heuristicClassify regex set (pure)
     chooseWinner (pure)
     validate.ts (pure, schema-driven)

  ─ integration (Jest + expo-sqlite in-memory)       fund FIRST ★
     pushTable / pullTable against mocked network
     reconcileTodoMetaForEntry across edits
     database.ts writers + sync side effects

  ─ e2e (Detox or Maestro on device)                 fund LATER
     write entry → derived todos appear
     interpret chain → ai_summaries cached
     sync push debounce timing
```

## Implementation in codebase

### The right first test — integration with real SQLite

```
  proposed: tests/integration/sync-push.test.ts

  describe('pushTable', () => {
    beforeEach(async () => {
      await openTestDb(':memory:');   // real expo-sqlite, in-memory
      await runMigrations();          // real migration runner
    });

    it('stamps synced_at on the dirty rows; leaves clean rows alone', async () => {
      // seed: A (clean), B (dirty), C (dirty)
      await seedEntries([
        { id: 'A', updated_at: '2025-12-01', synced_at: '2025-12-01' },
        { id: 'B', updated_at: '2025-12-02', synced_at: '2025-12-01' },
        { id: 'C', updated_at: '2025-12-03', synced_at: null },
      ]);

      mockSupabaseUpsert.mockResolvedValueOnce({ /* success */ });
      const result = await pushTable(entriesSyncable);

      expect(result.succeeded).toBe(2);
      const rows = await db.getAllAsync('SELECT * FROM entries ORDER BY id');
      expect(rows[0].synced_at).toBe('2025-12-01');  // A unchanged
      expect(rows[1].synced_at).not.toBe('2025-12-01');  // B stamped
      expect(rows[2].synced_at).not.toBeNull();           // C stamped
    });
  });
       │
       └─ real SQLite + mocked network. minimal mocking. covers the
          highest-priority logic in one test.
```

## Elaborate

The test pyramid framing comes from Mike Cohn's *Succeeding with Agile* (2009) and has been the canonical shape ever since — many fast tests, few slow ones, the costs scale roughly with the pyramid's height. The "mocking tests the mock" anti-pattern comes from the same era of post-mortems on Java codebases overrun by per-class mocks.

Hamel Husain's eval-focused work on LLM testing reinforces the "minimal mocking" pattern — the deterministic harness around an LLM feature is integration-shaped (the deterministic seams ARE the boundary tests), not unit-shaped.

## Interview defense

**Q [mid]:** Where would you start writing tests?

**A:** Integration first, then unit, then e2e — unusual order but right for buffr. The highest-blast-radius code is the sync engine (silent failure class with two incidents) and the prose scanners (silent drop drift). Both are integration-shaped: they touch SQLite and produce state changes. Pure-unit testing them would require mocks that carry as much logic as the functions. The first test ships against real expo-sqlite in-memory.

```
  the order, drawn

  integration (sync, reconcile, scanners)    ─ fund first ★
  unit (chooseWinner, validate, regex)        ─ fund third
  e2e (full Android flow)                     ─ fund later

  one-line anchor: "match the test level to the unit's natural shape"
```

**Q [senior]:** When IS unit testing the wrong tool?

**A:** When the code under test is mostly orchestration of other modules. `pushTable()` reads SQLite, calls Supabase, writes back to SQLite — the function's value is the coordination. A unit test would mock SQLite (lose realism) and mock Supabase (lose realism); what remains is "did pushTable call mocks in the right order," which is testing the orchestration of mocks, not the real behavior. Integration with real SQLite + mocked network captures the actual contract.

**Q [arch]:** What would your e2e strategy look like once the unit + integration suite is mature?

**A:** Three E2E flows on Android (Detox or Maestro): (1) write a new entry → derived todos appear in the journal screen; (2) interpret chain triggers → AI summary lands in `ai_summaries`; (3) trigger debounced push → assert push fires 5s after last keystroke. Each is slow (10–30s); they run on CI on Android emulator; they cover the cross-module composition that integration tests can't.

## Validate

### Level 1 — reconstruct the diagram

Sketch the pyramid (e2e small, integration medium, unit large) and place buffr's first 4–5 test targets.

### Level 2 — explain it out loud

Under 90 seconds: explain why integration is the right first level for buffr (not unit) and what the anti-pattern would be.

### Level 3 — apply to a new scenario

A new contributor proposes writing 20 unit tests for `database.ts` that mock the SQLite client. Walk the audit's response.

Reference the proposed `tests/integration/sync-push.test.ts` shape as the contrast.

### Level 4 — defend the decision

Defend or oppose: "Unit tests are fastest, so we should write only unit tests until they cover 80% of the code."

Reference the sync engine's integration-shape and the heavy-mocking anti-pattern.

## See also

- [`01-what-is-tested-and-what-isnt.md`](./01-what-is-tested-and-what-isnt.md) — the priority list this concept allocates levels to.
- [`04-determinism-isolation-and-flakiness.md`](./04-determinism-isolation-and-flakiness.md) — what would flake at each level.
- [`07-testing-red-flags-audit.md`](./07-testing-red-flags-audit.md) — the heavy-mocking and inverted-pyramid red flags.
