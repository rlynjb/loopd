# Errors and special cases

**Industry name(s):** Defining errors out of existence (APOSD ch. 10), masking errors low, special-case sprawl
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

The cheapest error to handle is the one you defined out of existence — by choosing a representation in which the error condition isn't even expressible. The next cheapest is the one masked at a low layer so the high layer never sees it. The most expensive is a special case scattered across many call sites. APOSD's heuristic: prefer the first, accept the second, refactor the third.

```
  Zoom out — where errors are handled in buffr

  ┌─ UI ────────────────────────────────────────────────┐
  │  errors mostly absorbed by hooks; UI rarely branches│
  └──────────────────────┬──────────────────────────────┘
                         │
  ┌─ Service ────────────▼──────────────────────────────┐
  │  ai/validate.ts  THROWS typed errors; chains absorb │ ◐ partially
  │  todos/scanTodos  TWO-PASS MATCHING defines out the  │ ★ DEFINED OUT
  │                   "edited marker" special case        │
  │  sync/orchestrator  SUCCESS-ONLY LOG (the silent     │ ★ THE BUG
  │                     error guard — concept 01 finding) │
  │  database.ts  errors throw; callers wrap in try     │ ◐ scattered
  └─────────────────────────────────────────────────────┘
```

The audit names buffr's strongest example of "defining errors out" (the two-pass scanner pattern), its weakest (the silent-error guard, already named in concept 01), and one scattered try/except pattern in the writers.

## Structure pass

The axis is **failure containment** — where does an error become a value the next layer can handle?

```
  axis = "where does an error stop being an exception and become data?"

  AI chain throws ChainValidationError
       │
       ▼  seam: orchestrator catches, falls back to cache or empty state
  service returns typed AISummary | null
       │
       ▼  seam: hook receives null, sets isError state
  UI renders error state

  the chain is the boundary that defines errors-into-data. validate.ts
  throws, orchestrator catches, downstream sees a clean value.
```

The seam matters: when an error escapes the layer that should have contained it, the special case sprawls. Buffr's chains do this well (validate-or-throw is contained in the chain, fallback in the orchestrator). The sync layer does it badly (errors as data slip past a success-only log guard).

## How it works

### Move 1 — three error-handling patterns (the pattern set)

```
  ┌─ best: DEFINE THE ERROR OUT OF EXISTENCE ──────────┐
  │  pick a representation where the bad case can't     │
  │  exist. two-pass matching: a malformed marker just  │
  │  doesn't derive a record — no error to handle.       │
  └─────────────────────────────────────────────────────┘

  ┌─ next: MASK ERRORS LOW ─────────────────────────────┐
  │  catch and recover at a low layer; the high layer    │
  │  sees a clean value. validate.ts throws typed;       │
  │  orchestrator catches and falls back.                 │
  └─────────────────────────────────────────────────────┘

  ┌─ worst: SPECIAL CASES SCATTERED EVERYWHERE ────────┐
  │  the same `if (err)` check repeated at every caller. │
  │  every new path is a new bug surface.                 │
  └─────────────────────────────────────────────────────┘
```

### Move 2 — buffr's three patterns, walked

**Pattern 1 (best) — two-pass matching defines errors out.** Every prose scanner in buffr (`scanTodos`, `scanNutrition`, `scanThreadMentions`) runs two passes: first an exact match against the prior scan, then a line-index fallback if exact fails. A malformed marker — partial syntax, unicode anomalies, mid-edit corruption — just doesn't produce a record. No error to catch, no special case to handle.

```
  the scanner — pseudocode

  for each line in entry.text:
    if line matches a prior scan's exact text:
      reuse the prior derived record (preserve metadata)
    elif line matches a prior scan's line index:
      treat as edit; rebuild record
    else:
      try to parse as a fresh marker
      if it parses → derive record
      if not → SILENTLY SKIP   ← ★ this IS the error-defined-out ★
                                  no exception; no special case;
                                  the line simply doesn't derive anything
```

This is the cleanest error-handling pattern in the codebase: the failure mode "user typed an invalid marker" doesn't exist as an error; it exists as "no record derived."

**Pattern 2 (good) — validate.ts masks low.** The four JSON chains throw `ChainValidationError` when the parsed result doesn't match the Zod schema. The orchestrator (`compose.ts`) catches the throw and falls back to whatever's cached or to an empty state. The UI never sees a `ChainValidationError`.

```
  src/services/ai/compose.ts (~L60, the mask)

  try {
    const summary = await summarize(entry, lastNDays);  ← may throw
    cache.set(date, summary);                           ── ChainValidationError
    return summary;
  } catch (err) {
    if (err instanceof ChainValidationError) {           ← caught LOW
      return cache.get(date) ?? null;                    ← fall back; never
    }                                                    ── reaches UI
    throw err;  // unexpected — let it propagate
  }
```

Good shape; the high layer is shielded from schema errors.

**Pattern 3 (bad) — the silent-error guard (concept 01 finding repeated).** The sync orchestrator's success-only log at `orchestrator.ts:49,72` is the inverse of "mask low": it doesn't mask the error, it *hides* it. The fix is the same one named in concept 01.

**Pattern 4 (mild) — try/except in some database.ts writers.** Some writers wrap SQLite ops in try/except that catches and rethrows after logging. Mild scatter — not a real special-case problem at buffr's scale, but worth noting.

### Move 3 — the principle

The error-handling cost ladder runs from cheap (define out) to expensive (special-case scatter). Buffr does well at the cheap end (scanners), well at the middle (chain throw + orchestrator catch), and badly at one specific point (success-only logging). The audit lesson is to ask, for every error: could a different representation eliminate the case?

## Primary diagram

```
  buffr's error-handling shapes — by cost

  CHEAPEST — error defined out of existence
   ─ two-pass scanners (scanTodos, scanNutrition, scanThreadMentions)
     malformed markers just don't derive records; no exception path

  MEDIUM — error masked at a low layer
   ─ validate.ts throws → compose.ts catches → UI sees null
     ChainValidationError never escapes the service layer

  EXPENSIVE — error hidden at the wrong layer (THE BUG)
   ─ src/services/sync/orchestrator.ts:49,72
     errors returned as data slip past success-only log guard
     "hidden" ≠ "masked"; masked is principled, hidden is a bug

  MILD — try/except scatter in writers
   ─ some database.ts writers wrap SQLite ops in try/log/rethrow
     not a real problem at single-user scale; audit if scale grows
```

## Implementation in codebase

### The best pattern — two-pass scanner

```
  src/services/todos/scanTodos.ts (~L30–L80, simplified)

  // pass 1: exact-match against the previous scan
  for line in entry.text:
    prior = prior_scan.findByText(line)
    if prior:
      result.push(prior)         // preserve identity + metadata
      continue

  // pass 2: line-index fallback (treat as edit)
  for line at index i in entry.text:
    prior = prior_scan.findByLineIndex(i)
    if prior and similar(line, prior.text):
      result.push({ ...prior, text: line })   // edit in place
      continue

  // pass 3: parse fresh; if invalid, skip
  if line matches /^\s*\[\s*\]/:
    result.push(new_todo_from_line(line))
  // else: silently skip — error defined out
       │
       └─ NO try/except anywhere. A malformed marker doesn't throw;
          it doesn't exist. That's the cheapest error to handle.
```

### The worst pattern — success-only log (concept 01)

```
  src/services/sync/orchestrator.ts:49,72  (same finding as concept 01)

  if (r.succeeded > 0 || r.failed > 0) {       ← logs only on activity
    console.log(`[buffr sync] push ${r.tableName}: ...`);
  }
                                                ← errors-as-data slip past
                                                  the fix: || r.error
```

## Elaborate

The "define errors out of existence" framing comes from APOSD chapter 10 — Ousterhout's strongest design recommendation around errors. The lesson is that error handling is a *design* problem, not a runtime problem: change the representation so the error doesn't arise.

The two-pass-matching pattern in buffr's scanners is a direct application — and crucially, it's the same shape across three different domains (todos, nutrition, thread mentions). The pattern's deepest version would be to extract it into a `twoPassScan(prior, next, parseFn)` higher-order function that the three scanners reuse. (That refactor is named in `study-system-design-dsa/02-dsa/01-two-pass-scan-todos.md` and elsewhere.)

## Interview defense

**Q [mid]:** What's the cleanest error-handling pattern in buffr?

**A:** The two-pass scanners. Three scanners — todos, nutrition, thread mentions — handle "user typed an invalid marker" by simply not deriving a record. There's no exception, no special case, no error path. The failure mode was defined out of existence by choosing a representation where the bad case can't happen. That's the cheapest error to handle.

```
  the cleanest pattern — one diagram

  user types prose
       │
       ▼  scanner: pass 1 exact-match → pass 2 line-index → pass 3 fresh
       │  invalid? → SKIP. no record derived. no exception. no path.
       ▼
  todos_json (records that derived)

  one-line anchor: "the cheapest error is the one you defined out of existence"
```

**Q [senior]:** What's the worst pattern, and how would you fix it?

**A:** The success-only log guard in the sync orchestrator. Same finding as concept 01: errors returned as data (PostgREST in the response body, not a throw) produce zero counts and log nothing. Two production fires already. Fix is ten lines — extend the guard to fire on `r.error` too. The deeper lesson: error-as-data needs the SAME observability path as error-as-exception.

**Q [arch]:** When does defining out NOT apply?

**A:** When the error genuinely communicates information the system needs to act on. A network timeout is a real signal (retry; back off; alert). An auth denial is a real signal (refresh token; log out). You don't define these out; you mask them at the right low layer. The two-pass scanner case is different — the "error" is a no-op data event, not a signal.

## Validate

### Level 1 — reconstruct the diagram

Sketch the cost ladder (define-out → mask-low → scatter) and place buffr's three patterns.

### Level 2 — explain it out loud

In under 90 seconds: explain why the scanner pattern is define-out, why validate.ts is mask-low, and why the silent-error guard is hide-at-the-wrong-layer.

### Level 3 — apply to a new scenario

A new feature: the user can manually retry a failed AI chain. Where does the error path live — in the chain, in `compose.ts`, in the UI, all three?

Reference `src/services/ai/compose.ts` (~L60) and `src/services/ai/validate.ts` (the existing throw-catch shape).

### Level 4 — defend the decision

Defend or oppose: "Every chain should retry up to 3 times with exponential backoff before throwing. The orchestrator just sees a clean value."

Reference the existing throw-catch pattern in `compose.ts` and the concept-01 silent-error finding.

## See also

- [`01-complexity-in-this-codebase.md`](./01-complexity-in-this-codebase.md) — the silent-error guard finding originates here.
- [`03-information-hiding-and-leakage.md`](./03-information-hiding-and-leakage.md) — masking low is information hiding for errors.
- [`08-red-flags-audit.md`](./08-red-flags-audit.md) — "try/except everywhere" and "special-case sprawl" as checklist items.
