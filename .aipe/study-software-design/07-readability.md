# Readability — names, comments, consistency, obviousness

**Industry name(s):** Readability (APOSD ch. 12–18), naming precision, comments-as-design, consistency
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

Readable code is code where the next reader can predict what each piece does without re-deriving the design. APOSD's framing breaks readability into four facets — naming, comments, consistency, obviousness — and each has its own failure mode. The audit walks all four against buffr.

```
  Zoom out — readability lives at every layer

  ┌─ UI ─────────────────────────────────────────────┐
  │  short names, kebab-case routes; readable        │
  └────────────────────┬─────────────────────────────┘
                       │
  ┌─ Service ──────────▼─────────────────────────────┐
  │  ai/        named precisely (chain verbs)         │
  │  todos/     ★ scanTodos / classify / reconcile    │
  │  sync/      pushAll / pullAll / chooseWinner     │
  │  database.ts  per-entity insert/update/softDelete │
  │                                                   │
  │  ★ MINOR DRIFT ★                                  │
  │   docstrings sparse in places; load-bearing       │
  │   comments would help on principle-#11 calls      │
  └───────────────────────────────────────────────────┘
```

Buffr's design overall reads well — names are precise, conventions hold, the surprise points are documented in `docs/spec.md` as principles. The audit's main finding is mild: a few load-bearing functions could use one-line "why this exists" comments.

## Structure pass

Pick the **trust** axis (does the reader trust the name to be accurate?). Trace it across the service layer.

```
  axis = "does the function name predict what the body does?"

  classify(text)        ─►  yes — classifies into a thinking mode
  heuristicClassify    ─►  yes — and signals "binary gate" via the prefix
  scanTodosFromText    ─►  yes — explicit input, explicit output
  reconcileTodoMetaForEntry  ─►  yes — explicit subject
  chooseWinner(local, cloud) ─►  YES — the "what to do" name beats
                                  "resolveConflict" by signalling intent
  pushAll / pullAll          ─►  yes — two cursors, two flows, named
```

Buffr's naming is consistently *what-it-does-named*, not framework-named. That's an under-recognized strength.

## How it works

### Move 1 — the four facets (the pattern)

```
  the four readability facets

  ┌─ names ───────────────────────────────────────────┐
  │  vague names (data, obj, tmp, manager) where      │
  │  precision would prevent bugs                      │
  └────────────────────────────────────────────────────┘
  ┌─ comments ────────────────────────────────────────┐
  │  comments that restate the code; missing           │
  │  interface comments; load-bearing comments absent  │
  └────────────────────────────────────────────────────┘
  ┌─ consistency ─────────────────────────────────────┐
  │  two conventions for one job                       │
  └────────────────────────────────────────────────────┘
  ┌─ obviousness ─────────────────────────────────────┐
  │  hidden control flow, surprises                    │
  └────────────────────────────────────────────────────┘
```

### Move 2 — buffr's four facets, walked

**Naming (strong).** Names like `chooseWinner(local, cloud)` for LWW arbitration, `heuristicClassify` for the binary gate, `scanTodosFromText` for the pure scanner, `reconcileTodoMetaForEntry` for the invariant enforcer — each name predicts the body. The `setTodoType` (vs the hypothetical `setLLMType`/`setUserType` from concept 03) is the one mild miss; it doesn't name *who* set the type, which is exactly the override-lock leak.

**Comments (mostly good with one gap).** The `docs/spec.md` principles are the load-bearing "why this exists" documentation, and they cover the surprises (DB single source of truth, prose canonical, 1:1 invariant, soft-delete only, two-pass matching, manual-touch deviation). But the *call sites* of those principles sometimes lack a one-line `// principle #11` comment — and one-line comments naming the principle by number would help the next reader. Small fix; high leverage.

```
  the load-bearing-comment gap — illustration

  src/services/sync/conflict.ts chooseWinner()
    // today: no comment naming the LWW rule
    // ideal: // principle #11 — LWW by updated_at; see docs/spec.md §10
    if (local.updated_at > cloud.updated_at) return 'local';
    else return 'cloud';
       │
       └─ the rule is documented in spec.md, but a one-line comment
          here points the next reader at the spec without making them
          grep. Cheap; high signal.
```

**Consistency (strong).** kebab-case routes (`app/journal/[date].tsx`), camelCase functions, PascalCase types, snake_case DB columns. The convention holds at every layer. `getEntriesForDate` vs `getEntryByDate` would be a consistency issue if both existed; they don't.

**Obviousness (one weak point).** The chain-output validation gate in `validate.ts` is a *hidden* control-flow gate — the chain throws, the orchestrator catches, the UI sees null. A reader who doesn't know the throw path can be surprised by the `catch (ChainValidationError)` block in `compose.ts`. A one-line comment at the throw site naming "compose.ts catches this and falls back" would close the loop. Same fix as the comments finding — small comment, high leverage.

### Move 3 — the principle

Readability is the design's promise to the next reader. Names predict bodies; comments name the load-bearing constraints; consistency removes false signals; obviousness avoids surprise. Buffr is strong on naming and consistency, has a documented surprise list (spec.md principles), and would benefit from one-line "// principle #N" comments at the call sites where those principles are enforced.

## Primary diagram

```
  buffr's four-facet readability scorecard

  NAMES         ★★★★★  precise, what-it-does verbs throughout
  COMMENTS      ★★★★☆  spec.md is excellent; call-sites could cite principles
  CONSISTENCY   ★★★★★  conventions hold across layers (kebab/camel/snake)
  OBVIOUSNESS   ★★★★☆  one hidden control-flow gate (validate.ts throws)

  TOP FINDING:
   ─ add one-line "// principle #N — see docs/spec.md" comments at:
     ─ src/services/sync/conflict.ts chooseWinner (principle #11 LWW)
     ─ src/services/todos/reconcileMeta.ts (1:1 invariant principle)
     ─ src/services/ai/validate.ts throw sites (caught by compose.ts)
     ─ src/services/threads/touch.ts (manual-touch deviation principle)
```

## Implementation in codebase

### Naming — the strongest pattern

```
  src/services/sync/conflict.ts (the load-bearing function)

  export function chooseWinner(
    local: Row, cloud: Row
  ): 'local' | 'cloud' {
    // ★ add: // principle #11 — LWW by updated_at; see docs/spec.md §10
    if (!cloud) return 'local';
    if (!local) return 'cloud';
    return local.updated_at >= cloud.updated_at ? 'local' : 'cloud';
  }
       │
       └─ name "chooseWinner" reads as INTENT (this picks which row wins).
          A name like "resolveConflict" or "mergeRows" would read as
          MECHANISM. Intent names beat mechanism names — the body is
          the mechanism.
```

### The mild comments gap

```
  src/services/todos/reconcileMeta.ts (~L1, header today)

  // (today: no module-level comment)

  // (ideal: header naming the 1:1 invariant principle)
  /**
   * Enforces the 1:1 invariant between entries.todos_json and todo_meta.
   * SQLite cannot FK to a JSON-array element; this function IS the
   * enforcement mechanism. See docs/spec.md principle #2 (prose canonical
   * for drops) and the 1:1 non-negotiable in .aipe/project/context.md.
   */
  export function reconcileTodoMetaForEntry(...) { ... }
       │
       └─ four lines of comment make this the documented enforcer.
          The next contributor reads the docstring and understands the
          single point of truth without needing to find spec.md first.
```

## Elaborate

The four-facet readability framing is APOSD chapters 12–18 — the longest stretch of the book. Each chapter is a single rule with examples (good names, what comments should say, design as documentation, consistency, code obviousness). The most-quoted insight: **comments should describe things that aren't obvious from the code** — interface contracts, invariants, "why this exists." Buffr's `docs/spec.md` is precisely this: the why-this-exists at the architectural level, but the call sites don't cross-reference it.

The "intent name beats mechanism name" lesson — `chooseWinner` vs `resolveConflict` — comes from Kent Beck's *Implementation Patterns* (2007) and is reinforced by APOSD chapter 14.

## Interview defense

**Q [mid]:** What makes buffr's naming strong?

**A:** The functions are named for *what they do*, not how. `chooseWinner(local, cloud)` says "pick which row wins" — the LWW mechanism is the body, not the name. `heuristicClassify` signals it's a binary gate by the prefix. `scanTodosFromText` is explicit about input and output. This reads as intent, not implementation, and intent names age better — the implementation can change without the name lying.

```
  intent vs mechanism naming

  intent name:    chooseWinner   (says WHAT)
  mechanism name: resolveConflictByLWW  (says HOW)

  intent name wins because the mechanism can change without renaming.

  one-line anchor: "names predict bodies; intent names age best"
```

**Q [senior]:** What's the smallest fix that would improve buffr's readability most?

**A:** One-line `// principle #N — see docs/spec.md` comments at the four load-bearing call sites: `chooseWinner` (LWW), `reconcileTodoMetaForEntry` (1:1 invariant), the `throw new ChainValidationError(...)` sites in `validate.ts` (caught by `compose.ts`), and `touch.ts` (manual-touch deviation). Each is a one-line comment; each saves the next reader a spec.md search.

**Q [arch]:** Where would buffr be most surprising to a new contributor?

**A:** The hidden control-flow path through `validate.ts → compose.ts catch`. A reader who opens a chain file sees a `throw`, looks for `try` and doesn't see one — the catch lives in the orchestrator one level up. That's APOSD's "hidden control flow" smell. The fix is a one-line comment at the throw site saying "compose.ts catches this and falls back to cache."

## Validate

### Level 1 — reconstruct the diagram

Sketch the four-facet scorecard (names / comments / consistency / obviousness) with one buffr example per facet.

### Level 2 — explain it out loud

In under 90 seconds: name buffr's strongest naming example and its one obviousness gap. Use the phrase "intent name beats mechanism name."

### Level 3 — apply to a new scenario

A new contributor adds a `processInput` function to one of the scanners. Why is the name wrong, and what would be better?

Open `src/services/todos/scanTodos.ts` (the existing function name) and compare.

### Level 4 — defend the decision

Defend or oppose: "Every public function in `src/services/` should have a JSDoc comment, even when the name is precise."

Reference `src/services/sync/conflict.ts:chooseWinner` (a function with no comment today but a precise name).

## See also

- [`03-information-hiding-and-leakage.md`](./03-information-hiding-and-leakage.md) — comments naming load-bearing invariants are part of how leaks are mitigated.
- [`06-errors-and-special-cases.md`](./06-errors-and-special-cases.md) — the hidden control-flow path through validate.ts.
- [`08-red-flags-audit.md`](./08-red-flags-audit.md) — vague names, missing comments, inconsistency as checklist items.
