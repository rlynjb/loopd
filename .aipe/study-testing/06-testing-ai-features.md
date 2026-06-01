# Testing AI features

**Industry name(s):** Deterministic harness around probabilistic core, the test-vs-eval seam
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

LLM features have a deterministic harness wrapped around a probabilistic core. The harness — prompt assembly, schema parsing, output validation, cache write — is testable like any other code. The core — the model's actual output — needs evaluation, not testing. The audit names buffr's deterministic seams (testable here) and points at the eval surface (covered in study-ai-engineering).

```
  Zoom out — the chain anatomy, by determinism

  ┌─ DETERMINISTIC (testable here) ──────────────────────┐
  │  buildSummaryPrompt(entry, lastNDays) → messages[]    │
  │  validate.validateAISummary(parsed) → typed result    │
  │  ai_summaries cache write                              │
  │  provider dispatch (config.provider toggle)            │
  └────────────────────┬──────────────────────────────────┘
                       │
  ┌─ PROBABILISTIC (eval territory) ─────────────────────┐
  │  Anthropic / OpenAI model output content              │
  │  ─ "is this summary good?"                            │
  │  ─ "did this caption variant repeat?"                 │
  │  ★ THIS IS study-ai-engineering/05-evals territory    │
  └───────────────────────────────────────────────────────┘
```

The seam matters: each finding must state which half it belongs to.

## Structure pass

The axis is **determinism** — given known input, is the output known?

```
  axis = "given known input, is the output deterministic?"

  unit                                            deterministic?    fund here?
  ────                                            ──────────────    ──────────
  buildSummaryPrompt(entry, lastNDays)            YES                ✓ test
  validate.validateAISummary(parsed)              YES                ✓ test
  provider dispatch (config switch)               YES                ✓ test
  ai_summaries cache key + write                  YES                ✓ test
  model.messages.create(...) output               NO                 → eval
  caption variant content quality                  NO                → eval
```

## How it works

### Move 1 — the deterministic-around-probabilistic pattern

```
  every LLM feature has this shape

  ┌─ deterministic prep ─┐
  │  buildPrompt(...)    │  ← TEST: given entry, prompt is this
  │  schemas, fixtures   │
  └──────────┬───────────┘
             │
             ▼  ★ probabilistic call ★
       ┌─────────────┐
       │ model API   │  ← EVAL: was the output good?
       │ (HTTP)      │     (golden set + LLM-as-judge)
       └─────┬───────┘
             │
             ▼  deterministic again
  ┌─ deterministic check ─┐
  │  validate(parsed)     │  ← TEST: malformed → throw
  │  cache write          │  ← TEST: cache key shape; write succeeds
  └───────────────────────┘
```

Tests sit on either side of the probabilistic call. The call itself is what evals measure.

### Move 2 — buffr's testable AI seams

**Prompt assembly — fixtures + literal-string assertion.** `buildSummaryPrompt(entry, lastNDays)` is pure. Given a known entry, the messages array is deterministic. Test fixture: known entry, expected messages array. Catches prompt regressions, model-version-pinned changes, lost-in-the-middle layout shifts.

```
  proposed: tests/ai/prompt-assembly.test.ts

  it('summarize: entry text appears in the user message', () => {
    const entry = { id: 'e1', text: 'shipped auth flow today' };
    const messages = buildSummaryPrompt(entry, []);
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('shipped auth flow today');
  });
       │
       └─ catches: someone refactors buildSummaryPrompt and accidentally
          drops the entry text. zero LLM calls; deterministic.
```

**validate.ts — schema enforcement.** Given a typed result, validate returns it; given an off-schema object, validate throws. Pure tests.

**Cache layer — `ai_summaries` write shape.** When the chain succeeds, the result lands in `ai_summaries.summary_json` keyed by `(user_id, date)`. Integration test: chain output flows through the cache write. Mock the chain call (return a known result); verify the cache row matches.

**Provider dispatch — config toggle.** When `config.provider = 'anthropic'`, the anthropic SDK is called; when `config.provider = 'openai'`, the fetch path is called. Both branches testable with mocks.

**What's NOT tested here:** "is this summary good." Evals measure that, not tests. See `study-ai-engineering/05-evals-and-observability/`.

### Move 3 — the principle

LLM features split cleanly: the deterministic harness around the model is testable like any other code, and the model's output content is evaluated separately. Naming which half a finding belongs to is the discipline. Buffr's chains have substantial deterministic seam — prompt assembly, validation, caching, dispatch — and zero current tests on any of them. The first AI-side tests should be on the deterministic seams; the eval side ships when there's an eval harness to wire it into.

## Primary diagram

```
  buffr's AI feature test strategy

  TEST HERE (deterministic)
   ─ buildSummaryPrompt, buildCaptionPrompt, etc.
     literal-string assertions on the messages array
   ─ validate.validateAISummary (and the 3 other validators)
     throws on schema violation; passes on valid input
   ─ compose.ts orchestration — cache hit, cache miss
     mocked chain returns known data; cache write verified
   ─ provider dispatch in each chain
     config.provider switches; both branches called correctly

  EVAL HERE (probabilistic; not in this guide)
   ─ chain output content quality (golden set)
   ─ caption anti-repetition (cross-call drift)
   ─ classify accuracy on labelled todos
   ─ interpret depth + accuracy

   → see .aipe/study-ai-engineering/05-evals-and-observability/
```

## Implementation in codebase

### The deterministic boundary test — prompt assembly

```
  proposed: tests/ai/build-prompt.test.ts

  describe('buildSummaryPrompt', () => {
    it('includes entry text verbatim in the user message', () => {
      const entry = { id: 'e1', text: 'shipped the auth flow' };
      const messages = buildSummaryPrompt(entry, []);
      expect(messages).toMatchObject([
        { role: 'system', content: expect.stringContaining('Summarize') },
        { role: 'user', content: expect.stringContaining('shipped the auth flow') },
      ]);
    });

    it('includes last-N-days entries as additional context', () => {
      const entry = { text: 'today' };
      const lastN = [{ text: 'yesterday' }, { text: 'two days ago' }];
      const messages = buildSummaryPrompt(entry, lastN);
      expect(messages[1].content).toContain('yesterday');
      expect(messages[1].content).toContain('two days ago');
    });
  });
       │
       └─ pure-function tests. zero LLM calls. catches prompt-template
          regressions. the kind of test that prevents a 3-week "why is the
          summary suddenly worse" debugging session.
```

### The validate.ts test — schema enforcement

```
  proposed: tests/ai/validate.test.ts

  describe('validateAISummary', () => {
    it('returns typed AISummary for valid input', () => {
      const result = validateAISummary({
        headline: 'auth shipped', narrative: '...', tone: 'positive', tags: []
      });
      expect(result.headline).toBe('auth shipped');
    });

    it('throws ChainValidationError for missing required fields', () => {
      expect(() => validateAISummary({ headline: 'partial' }))
        .toThrow(ChainValidationError);
    });

    it('throws for off-schema tone value', () => {
      expect(() => validateAISummary({
        headline: 'h', narrative: 'n', tone: 'hacked', tags: []
      })).toThrow(ChainValidationError);
    });
  });
```

## Elaborate

The test-vs-eval seam framing is Hamel Husain's contribution to LLM testing discipline (2023 onward). The lesson is that throwing all LLM work into one bucket ("we'll test the AI features") collapses two genuinely different activities — deterministic-correctness verification and probabilistic-quality evaluation — into a confused mush. Separating them lets each be done properly with tools appropriate to the half.

Buffr's chain design (cleanly separated prompt build, validate, cache, dispatch) makes this separation natural. The chains aren't testable as a whole, but every seam IS — that's another deep-modules payoff.

## Interview defense

**Q [mid]:** How do you test code that calls an LLM?

**A:** Split it. The deterministic boundary around the LLM (prompt assembly, schema validation, cache writes, provider dispatch) is unit-testable like any other code. The LLM output itself is evaluation, not testing — golden set + LLM-as-judge + regression suite, separate harness. Naming which half a finding belongs to is the discipline. Most teams collapse them and end up testing nothing well.

```
  the seam, drawn

  test:  buildPrompt → output messages[]
   ✓ deterministic; literal-string assertion

  eval:  model output → quality rubric
   ◐ probabilistic; LLM-as-judge

  test:  validate(parsed) → typed result OR throw
   ✓ deterministic; schema check

  one-line anchor: "deterministic harness, probabilistic core — test the first, eval the second"
```

**Q [senior]:** What deterministic seams in buffr would you test first?

**A:** Three. (1) `buildSummaryPrompt` and the equivalents for the four other chains — pure functions, literal-string assertions catch prompt-template regressions. (2) `validate.validateAISummary` and three siblings — throws on off-schema input, passes on valid; cheap to write, catches the runtime validation contract. (3) `compose.ts` orchestration with a mocked chain return — cache hit returns cached; cache miss runs the (mocked) chain and writes. Together: ~30 tests, ~300 lines, deterministic seams covered.

**Q [arch]:** What about the chain output content?

**A:** Eval territory, not test territory. The pipeline is: chain returns a value → validate.ts confirms shape → eval harness measures quality. Buffr has zero evals today (study-ai-engineering's Phase 3 builds them). The deterministic side ships first because it's cheap and doesn't depend on a golden set; the eval side ships when the golden set is curated.

## Validate

### Level 1 — reconstruct the diagram

Sketch the chain anatomy (deterministic prep → probabilistic call → deterministic check) with one test target and one eval target marked.

### Level 2 — explain it out loud

Under 90 seconds: explain the test-vs-eval seam and name three deterministic seams in buffr.

### Level 3 — apply to a new scenario

A new chain `themesAcrossEntries(entries) → string[]` is proposed. Walk the test plan vs the eval plan.

Reference the existing chains in `src/services/ai/` for the seam shape.

### Level 4 — defend the decision

Defend or oppose: "We should evaluate prompt templates instead of testing them — eval covers everything."

Reference `buildSummaryPrompt` as the example (test catches "the entry text was removed from the prompt"; eval doesn't).

## See also

- [`02-test-design-and-levels.md`](./02-test-design-and-levels.md) — these are unit + integration tests.
- [`07-testing-red-flags-audit.md`](./07-testing-red-flags-audit.md) — "no test at the boundary of an LLM feature" red flag.
- `.aipe/study-ai-engineering/05-evals-and-observability/` — the eval side of the seam.
