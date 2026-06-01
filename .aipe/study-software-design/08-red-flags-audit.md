# Red flags audit — the consolidated checklist

**Industry name(s):** APOSD red flags (consolidated review), code review checklist
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

Ousterhout's red flags are the practical output of *A Philosophy of Software Design*: a short list of patterns that, when they fire, almost always signal a design problem. This concept walks the list against buffr — fires / doesn't fire / N/A — with the location and the one-line fix when it fires. This is the capstone of the audit: the index the rest of the guide feeds.

```
  Zoom out — the audit by primitive, rolled into one checklist

  ┌─ UI ─────────────────────────────────────────────────┐
  │  no red flags fire here at this scale                 │
  └────────────────────┬─────────────────────────────────┘
                       │
  ┌─ Service ──────────▼─────────────────────────────────┐
  │  ai/        one flag: provider-dispatch shallow x5    │
  │  todos/     no flags                                  │
  │  threads/   no flags                                  │
  │  sync/      ★ TWO FLAGS: silent-error guard;          │
  │             cognitive-load cluster of 12 files        │
  │  database.ts  one mild flag: cross-cutting bookkeeping│
  └──────────────────────────────────────────────────────┘
```

Use this file as the code-review companion: open it next to the diff and walk the checklist.

## Structure pass

The axis is **severity**. Trace it across the flags — which fires would survive past a PR review without being caught?

```
  axis = "if this flag fires, who is positioned to catch it?"

  ─ severity HIGH: load-bearing line; unknown-unknown bug class
  ─ severity MED:  cross-file change-amplification; deepens with growth
  ─ severity LOW:  duplication that's currently affordable; refactor later
  ─ severity N/A: this codebase too small / too uniform to exercise the flag
```

Severity is what tells you which flag to fix first when you can only fix one.

## How it works

### Move 1 — the flag list (the pattern)

```
  APOSD's red flags, applied as a one-pass review checklist

  ┌─ each flag has the same shape ─┐
  │  pattern  ─────►  symptom       │
  │     │              location     │
  │     ▼              fix           │
  │  one-line          one-line     │
  │  signal             move          │
  └─────────────────────────────────┘
```

### Move 2 — the buffr-specific scorecard

Each flag with severity, location, and fix. Findings re-stated from concepts 01–07 with the source file noted.

**1. Shallow module / classitis.** FIRES (LOW). Location: the 6-line provider-dispatch block in `src/services/ai/{summarize,caption,expand,classify,interpret}.ts`. Fix: extract `callModel(provider, model, messages, tool)` helper in `src/services/ai/_callModel.ts`. Concept: 02.

**2. Information leakage (the same knowledge edited twice).** FIRES (MED). Location: `user_overridden_type` semantic, known in `classify.ts`, `database.ts setTodoType()`, and `reconcileMeta.ts`. Fix: deepen `database.ts` with `setLLMType()` vs `setUserType()`; user_overridden_type flips inside, callers never see it. Concept: 03.

**3. Pass-through method / pass-through variable.** AUDIT PENDING. Location: `src/hooks/*` — any hook that returns a callback wrapping one service function without adding state or subscription. Fix: inline into the component or upgrade to a query-cache hook. Concept: 04.

**4. Avoidable config exposed to users.** FIRES (LOW). Location: `config.provider` read by five chain files. Fix: same as flag 1 — `callModel` helper absorbs the read. Concept: 05.

**5. Try/except everywhere / special-case sprawl.** DOESN'T FIRE. Reason: buffr defines errors out in scanners (two-pass matching) and masks low in chains (validate.ts → compose.ts catch). The one exception is the silent-error guard, which is a different flag (#6). Concept: 06.

**6. Errors hidden at the wrong layer (silent-failure observability gap).** FIRES (HIGH). Location: `src/services/sync/orchestrator.ts:49` and `:72`. The success-only log guard hid two production sync freezes (RLS-drift / migration 0009; PGRST106 / schema-not-exposed after migration 0010). Fix: extend the guard to fire on `r.error` too. Ten-line change. Concept: 01.

**7. Cognitive-load cluster (a module nobody wants to touch).** FIRES (MED). Location: `src/services/sync/` — 12 files at the boundary between Service and Storage. Each file is small and single-purpose; the load is structural. Fix: no single refactor; recognize that the sync layer is genuinely-complex essential work and invest in the per-file docstring + cross-references. Concept: 01.

**8. Change amplification (one conceptual change → many files).** FIRES (MED). Location: documented in `.aipe/project/context.md` as "Common pitfalls" — adding a column to `todo_meta` requires six file edits. Fix: deepen `database.ts` with a `withSyncBookkeeping(table, op, body)` wrapper that absorbs the cross-cutting steps. Concept: 02.

**9. Vague names (data, obj, tmp, manager).** DOESN'T FIRE. Reason: buffr's names are intent-named throughout (`chooseWinner`, `heuristicClassify`, `reconcileTodoMetaForEntry`, `scanTodosFromText`). Concept: 07.

**10. Missing interface comments.** FIRES (LOW). Location: load-bearing call sites (`chooseWinner`, `reconcileTodoMetaForEntry`, `throw new ChainValidationError` sites, `touch.ts`). Fix: one-line `// principle #N — see docs/spec.md` comments at each. Concept: 07.

**11. Comments that restate the code.** DOESN'T FIRE. Reason: the few comments that exist describe load-bearing constraints (principle references, the manual-touch deviation), not the mechanism.

**12. Inconsistent conventions.** DOESN'T FIRE. Reason: kebab-case routes, camelCase functions, PascalCase types, snake_case DB columns — held throughout.

**13. Hidden control flow.** FIRES (LOW). Location: `validate.ts` throw sites → `compose.ts` catch. A reader of one chain file doesn't see the catch path. Fix: one-line comment at each throw site naming the catch location. Concept: 07.

**14. Adjacent layers offering the same abstraction.** AUDIT PENDING. Location: `src/hooks/*` (same audit as flag 3). Concept: 04.

### Move 3 — the principle

Red flags are a code-review accelerator, not a perfection target. Walk the list with each PR; fix the high-severity ones first; let the low-severity ones accumulate until the cost is felt. Buffr's high-severity finding is one line at one location (`orchestrator.ts:49,72`); the medium-severity ones are documented (context.md pitfalls); the low-severity ones cluster around comments and the provider dispatch. Fix in that order.

## Primary diagram

```
  buffr's red-flags scorecard — ranked

  HIGH SEVERITY (fix next)
  1. ★ silent-failure observability gap
     orchestrator.ts:49,72; fix = `|| r.error` on the log guard
     ←  this one already fired twice in production. Ten-line change.

  MED SEVERITY (refactor in the next pass)
  2. override-lock leak (user_overridden_type semantic in 3 files)
  3. cognitive-load cluster (sync/ 12 files; structural, not refactorable)
  4. change amplification (column-add → 6 file edits; deepen database.ts)

  LOW SEVERITY (track; fix when convenient)
  5. shallow provider-dispatch (5 chain files; extract callModel helper)
  6. avoidable config exposed (same fix as #5)
  7. missing interface comments (one-line // principle #N at 4 call sites)
  8. hidden control flow (one-line comment at validate.ts throws)

  AUDIT PENDING (not walked yet)
  9. pass-through methods (need src/hooks/* walk)
  10. adjacent same-abstraction layers (same audit)

  DOESN'T FIRE (praise findings)
  ─ vague names; comments restating code; inconsistency; try/except scatter
```

## Implementation in codebase

### The top 3 fixes, ranked

```
  top 3 fixes, in order, with file:line and one-line move

  1. orchestrator.ts:49,72  → success-only log → fire on r.error
                              prevents next silent freeze
                              effort: ten lines; impact: HIGH

  2. database.ts             → add setLLMType() / setUserType()
                              removes override-lock leak (3 files → 1)
                              effort: ~30 lines; impact: MED

  3. _callModel.ts (new)     → extract provider dispatch from 5 chains
                              removes shallow duplication AND
                              avoidable config exposure
                              effort: ~50 lines; impact: LOW (today)
                              but MED as soon as a 3rd provider is added
```

## Elaborate

The red-flags consolidation is the operational output of *A Philosophy of Software Design*. Ousterhout's framing is that complexity manifests in a few recurring patterns, each with a clear signal — the value of the list is that any reviewer can apply it without re-deriving the framework. Buffr's findings cluster around two genuine issues (the silent-error guard and change amplification on the sync columns) and one repeatable refactor (the provider dispatch). The rest of the codebase is at the "praise finding" end — most flags don't fire, which is the honest top-line.

For the conceptual depth of any single flag, the canonical reference is Ousterhout's chapter for that primitive (deep modules ch. 4, errors ch. 10, readability ch. 12–18) — read the book, then bring the lens here.

## Interview defense

**Q [mid]:** Walk me through the worst red flag in this codebase.

**A:** The success-only log guard in the sync orchestrator at `orchestrator.ts:49,72`. It's two lines that hid two production sync failures by treating errors-as-data as zero-activity events. The fix is `|| r.error` on the guard — ten lines, immediate impact, the most leverage-per-line change in the whole codebase. I'd fix this before any of the other findings.

```
  the top finding — one diagram

  before:  if (succeeded || failed) log(...)        ◀── HIDES error-as-data
  after:   if (succeeded || failed || r.error) log(...)

  10 lines.
  prevents the next silent sync freeze.
  HIGH severity for a reason.

  one-line anchor: "silent failure at a boundary IS the bug class"
```

**Q [senior]:** What's a flag this codebase rightly doesn't have?

**A:** Vague names. Every function name in `src/services/` is intent-named — `chooseWinner`, `heuristicClassify`, `reconcileTodoMetaForEntry`, `scanTodosFromText`. None of the APOSD vague-name failure modes (`data`, `obj`, `tmp`, `manager`) appear. Naming is one of the things this codebase does as well as anything you'll see; it's worth saying out loud as a praise finding because praise findings teach as much as critique findings.

**Q [arch]:** If you were leading the next refactor cycle on buffr, what would you sequence?

**A:** Three fixes in order. (1) Silent-error guard at orchestrator.ts:49,72 — HIGH severity, ten lines, prevents the next freeze. (2) Override-lock leak — deepen `database.ts` with `setLLMType()` vs `setUserType()`, ~30 lines, removes the three-file constraint. (3) `_callModel.ts` helper — extract provider dispatch from five chain files, ~50 lines, low impact today but already partially shallow. Past those three, the next pass is the per-hook pass-through audit. None of these are urgent; all of them improve the next-quarter cost curve.

## Validate

### Level 1 — reconstruct the diagram

Draw the scorecard severity ladder (HIGH → MED → LOW → AUDIT PENDING → DOESN'T FIRE) and place buffr's findings.

### Level 2 — explain it out loud

In under 90 seconds: name the single highest-severity finding, what the fix is, and why it's HIGH.

### Level 3 — apply to a new scenario

A new contributor opens a PR adding a `cancelAllSyncs()` function. Walk the checklist — which flags would you check against the diff?

Open `src/services/sync/orchestrator.ts:49,72` to verify your reasoning matches the existing pattern.

### Level 4 — defend the decision

Defend or oppose: "The provider-dispatch shallowness should be fixed before the silent-error guard. Refactoring is cheaper than fighting fires."

Reference the severity ranking above and the two-production-fires history.

## See also

- [`01-complexity-in-this-codebase.md`](./01-complexity-in-this-codebase.md) — the diagnostic this audit feeds from.
- [`02-deep-vs-shallow-modules.md`](./02-deep-vs-shallow-modules.md) — flags 1, 4 source.
- [`03-information-hiding-and-leakage.md`](./03-information-hiding-and-leakage.md) — flag 2 source.
- [`06-errors-and-special-cases.md`](./06-errors-and-special-cases.md) — flags 5, 6 source.
- [`07-readability.md`](./07-readability.md) — flags 9–13 source.
