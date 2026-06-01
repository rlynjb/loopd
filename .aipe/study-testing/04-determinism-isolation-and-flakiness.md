# Determinism, isolation, and flakiness

**Industry name(s):** Flaky test, test isolation, deterministic time/order/state
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

A test is flaky when it passes / fails on rerun with no code change. Flaky tests train people to ignore red — the worst possible outcome for a suite. The audit walks where buffr's suite (once it exists) would be most at risk: time-dependent code, order-dependent ones, shared-state ones, network-dependent ones.

```
  Zoom out — buffr's flakiness sources (predicted)

  ┌─ time-dependent ────────────────────────────────────┐
  │  schedulePush 5s debounce                           │
  │  ai_summaries cache TTL                              │
  │  server-time RPC alignment                           │
  └─────────────────────────────────────────────────────┘
  ┌─ order-dependent ────────────────────────────────────┐
  │  sync push/pull interleaving                         │
  │  reconcileMeta after scanner                         │
  └─────────────────────────────────────────────────────┘
  ┌─ shared-state ───────────────────────────────────────┐
  │  the SQLite file (must isolate per-test)             │
  │  in-memory module state (provider config)            │
  └─────────────────────────────────────────────────────┘
  ┌─ network-dependent ──────────────────────────────────┐
  │  Anthropic / OpenAI calls (must be mocked)           │
  │  Supabase Postgres (must be mocked or test-instance) │
  └─────────────────────────────────────────────────────┘
```

The audit names the prevention pattern for each source: fake timers, in-memory SQLite per-test, mocked network. None require novel infrastructure; all require discipline at test-write time.

## Structure pass

The axis is **determinism** — does the test produce the same result on every run?

```
  axis = "what could vary across runs of this test?"

  source                                  prevention
  ──────                                  ──────────
  Date.now()                              jest.useFakeTimers + setSystemTime
  setTimeout / setInterval                jest.advanceTimersByTime
  random ID generation                    seed an RNG or mock generateId
  test ordering                           per-test fresh DB + globals reset
  shared SQLite file                      ':memory:' per test
  module-level provider state             reset config.provider per test
  network                                 mock fetch / SDK boundary
```

## How it works

### Move 1 — the flakiness pattern

```
  flakiness shape — any source of nondeterminism that the test doesn't control

  ┌─ test ────┐  ─►  ┌─ system under test ─┐  ─►  ┌─ assertion ─┐
  │           │     │   reads Date.now()     │     │             │
  │           │     │   reads random         │     │             │
  │           │     │   reads global state    │     │             │
  └───────────┘     └────────────────────────┘     └─────────────┘
                              ▲
                              │  any of these → flake risk
                              │  if the test doesn't control them
```

### Move 2 — buffr's predicted flakiness sources, with prevention

**Time — fake timers required.** `schedulePush` debounces 5 seconds. Tests need fake timers; nobody waits 5 seconds. `setSystemTime` to anchor `Date.now()` calls (the cursor advance in pull depends on this).

```
  test setup — fake timers + anchored Date.now

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });
       │
       └─ now every schedulePush(), every Date.now() in the system
          under test returns deterministic values. test can advance
          time manually: jest.advanceTimersByTime(5000)
```

**Order — fresh DB per test.** Each test seeds its own in-memory `expo-sqlite` instance. No test leaves state behind. No `tests run in this order` dependencies. The `beforeEach(openTestDb(':memory:'))` pattern eliminates the entire class.

**Shared state — reset module-level config.** `config.provider`, `config.<role>Model` are module-level state. Tests that change them need to reset in `afterEach`.

**Network — mock at the SDK boundary.** Don't mock `fetch` directly; mock the Anthropic SDK and the Supabase client. Higher-level mocking = more realistic; less leaks of HTTP semantics into the test.

```
  the network mock — boundary, not the wire

  // mock: anthropic.messages.create returns a structured AISummary-shaped response
  const mockAnthropic = {
    messages: { create: jest.fn().mockResolvedValue({
      content: [{ type: 'tool_use', input: { headline: 'mocked', ... } }]
    }) }
  };

  // mock: supabase.from(...).upsert(...) succeeds
  const mockSupabase = {
    from: jest.fn().mockReturnValue({
      upsert: jest.fn().mockResolvedValue({ data: [], error: null })
    })
  };
       │
       └─ realism: the chain code calls the same APIs it does in
          production. only the wire transport is mocked.
```

### Move 3 — the principle

Determinism is a property the test ENFORCES, not a hope. Fake timers, in-memory DB per test, boundary mocks for the network, explicit reset of module-level state — these are the four moves that prevent the flakiness class entirely. The cost is ~10 lines of `beforeEach` per test file; the benefit is a suite that never trains people to ignore red.

## Primary diagram

```
  buffr's flakiness-prevention recipe

  before every test (the four moves):
   1. openTestDb(':memory:') + runMigrations()
   2. jest.useFakeTimers() + setSystemTime(fixed date)
   3. reset config.provider, config.<role>Model to known defaults
   4. mock anthropic + mock supabase at SDK boundary

  after every test:
   ─ close the test DB
   ─ restore real timers
   ─ reset SDK mocks

  result: every test is hermetic. order doesn't matter.
          rerun is identical. flakiness class eliminated.
```

## Implementation in codebase

### The proposed test harness — beforeEach/afterEach template

```
  proposed: tests/helpers/setup.ts (does not exist yet)

  export async function setupTest(): Promise<TestContext> {
    const db = await openDatabaseSync(':memory:');
    await runMigrations(db);
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    return {
      db,
      mockAnthropic: createMockAnthropic(),
      mockSupabase: createMockSupabase(),
    };
  }

  export async function teardownTest(ctx: TestContext): Promise<void> {
    await ctx.db.closeAsync();
    jest.useRealTimers();
    jest.clearAllMocks();
  }
       │
       └─ every test file uses these two functions. consistent isolation;
          no test leaves state.
```

## Elaborate

Flakiness as the worst possible test-suite outcome is documented in Google's *Testing on the Toilet* series and Hyrum Wright's writing — a flaky test desensitizes developers to red, which is corrosive to the value of any test suite. The four moves (fake timers, in-memory DB, boundary mocks, explicit resets) are well-known mitigations; buffr's empty suite means there's no flakiness yet, just the pattern to follow when the first tests ship.

## Interview defense

**Q [mid]:** What would cause buffr's tests to be flaky?

**A:** Four predictable sources: real timers (schedulePush has a 5-second debounce; tests can't wait), shared SQLite file (one test's writes leak to the next), module-level config state (`config.provider`), and real network calls (Anthropic / Supabase). The four prevention moves are uniform: `jest.useFakeTimers()` + `setSystemTime`, `:memory:` DB per test, explicit config reset, boundary mocks. Together they eliminate the flakiness class.

```
  the four moves, drawn

  every test:
   1. fresh in-memory SQLite
   2. fake timers anchored to fixed date
   3. reset module config to defaults
   4. fresh SDK mocks (Anthropic, Supabase)

  result: deterministic, hermetic, rerun-identical.

  one-line anchor: "determinism is enforced, not hoped for"
```

**Q [senior]:** Why mock at the SDK boundary, not at fetch?

**A:** Mocking `fetch` leaks HTTP semantics into the test — status codes, headers, JSON parsing. Mocking the SDK boundary (`anthropic.messages.create`) keeps the test at the level of "given this provider response shape, the chain does X." The test exercises real chain code with a realistic response shape; it doesn't ALSO test the SDK's HTTP layer.

**Q [arch]:** What's the worst flakiness pattern you've seen, and how does it apply here?

**A:** Tests that depend on test ordering. One test seeds state; the next test depends on that state existing; in CI they run in different order and one fails inexplicably. The fix is the `:memory:` DB per test plus explicit reset of module-level state — every test starts from the same blank slate. For buffr's suite (when it exists), this discipline is mandatory; the SQLite-file-per-test pattern enforces it structurally.

## Validate

### Level 1 — reconstruct the diagram

Sketch the four flakiness sources (time, order, state, network) with one prevention per source.

### Level 2 — explain it out loud

Under 90 seconds: name the four prevention moves and why mocking at SDK boundary beats mocking fetch.

### Level 3 — apply to a new scenario

A new test asserts that `pushAll()` fires within 5 seconds of a write. Walk how to write this without using real time.

Reference the schedulePush.ts implementation and `jest.advanceTimersByTime(5000)` as the move.

### Level 4 — defend the decision

Defend or oppose: "Mock fetch directly — it's simpler than constructing SDK responses."

Reference the SDK-boundary mock recipe above.

## See also

- [`02-test-design-and-levels.md`](./02-test-design-and-levels.md) — flakiness risk varies by level.
- [`07-testing-red-flags-audit.md`](./07-testing-red-flags-audit.md) — flakiness as a checklist item.
