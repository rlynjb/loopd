# Deep vs shallow modules

**Industry name(s):** Deep modules (APOSD ch. 4), information hiding · interface vs implementation, classitis (the anti-pattern)
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

A *deep* module hides a lot of behaviour behind a small interface — high functionality-to-interface ratio. A *shallow* module's interface is nearly as complex as its implementation — its existence buys you almost nothing. APOSD's prescriptive heuristic: **build deep modules**; that's where the real complexity reduction lives.

```
  Zoom out — deep vs shallow, layer by layer in buffr

  ┌─ UI layer ────────────────────────────────────────────┐
  │  components: thin and well-layered — shallow by need   │
  │  (presentation has a small body and a small API; the   │
  │  "deep" critique doesn't apply at the leaf)            │
  └──────────────────────┬────────────────────────────────┘
                         │
  ┌─ Service layer ──────▼────────────────────────────────┐
  │  ai/         ★ DEEP CLUSTER ★    ← we are here         │
  │   validate.ts   tiny API; deep validation behaviour    │
  │   compose.ts    tiny API; deep orchestration            │
  │   heuristicClassify.ts  tiny API; deep regex set        │
  │  sync/       DEEP at orchestrator boundary, but the     │
  │              cluster as a whole is structurally complex  │
  │  database.ts  DEEP (per-entity API hides bookkeeping)    │
  │                                                        │
  │  ★ SHALLOW HOTSPOT ★                                    │
  │   provider-dispatch block repeated in 5 chain files     │
  └──────────────────────┬────────────────────────────────┘
                         │
  ┌─ Storage ────────────▼────────────────────────────────┐
  │  SQLite, Supabase Postgres                            │
  └───────────────────────────────────────────────────────┘
```

This concept is the inventory — modules ranked by depth, the deepest celebrated (praise *is* a finding), the shallowest named with a fix. Buffr's design is mostly deep; the one repeatable shallowness is interesting because it's a 6-line dispatch copied across five chain files.

## Structure pass

The axis for this concept is **interface size vs functionality**. We trace it across the service layer's modules.

```
  axis = "how much does a small interface hide?"

  layer (Service)        ─ a layer that EXISTS so depth can live in it
       │
       │  seam: each module's public API surface
       ▼
  module surface         ─ small (functions named once, narrow)
       │
       │  seam: implementation depth
       ▼
  module body            ─ HUGE (state, branches, edge cases, hardening)

  the seam between surface and body is the design payoff. Wide surface +
  thin body = shallow (refactor target). Narrow surface + thick body =
  deep (the kind of module that pays back).
```

In a deep module, you can change a lot inside without callers noticing. In a shallow one, almost any internal change leaks through the interface. The cost of a shallow module is paid every time you touch it.

## How it works

### Move 1 — the depth ratio (the pattern)

```
  the depth of a module = "how much does its API hide?"

  ┌─ deep module ────────────────────────────────────────┐
  │  small interface (a few named functions)              │
  │  ▼                                                    │
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  body       │
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (lots      │
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  hidden)    │
  └──────────────────────────────────────────────────────┘

  ┌─ shallow module ─────────────────────────────────────┐
  │  interface (lots of named parameters, types, knobs)   │
  │  ░░░░ body (almost as visible as the interface)        │
  └──────────────────────────────────────────────────────┘

  rule of thumb: read the public API in one breath.
  if you can't, the module is leaky or shallow.
```

### Move 2 — buffr's deep modules (the praise findings)

Praise is a finding too. Three buffr modules that are textbook-deep, with the tiny interface and the substantial body it hides.

**`src/services/ai/validate.ts` — small API, deep validation behaviour.**

```
  validate.ts — interface surface

  validateAISummary(parsed: unknown): AISummary  ◀── one function per chain
  validateCaptionVariants(parsed: unknown): CaptionVariants
  validateExpansion(parsed: unknown): ExpandedTodo
  validateClassification(parsed: unknown): ThinkingMode

  body hides:
   ─ Zod schemas (one per chain)
   ─ safeParse + typed-error construction
   ─ ChainValidationError class
   ─ schema-shape vs content-quality distinction
```

The caller asks "is this a valid AISummary?" and gets a typed result or a typed error. The caller never touches Zod, never constructs an error, never knows about safeParse. That's the deep-module payoff: shape change inside (add a field, change a type) doesn't ripple.

**`src/services/todos/heuristicClassify.ts` — single function, deep regex set.**

```
  heuristicClassify.ts — interface surface

  heuristicClassify(text: string): 'todo' | null  ◀── one function, two outcomes

  body hides:
   ─ IMPERATIVE_VERBS set (~70 verbs)
   ─ MODAL_STARTS / QUESTION_STARTS / SPECULATIVE_STARTS regex arrays
   ─ DEADLINE_PATTERNS regex array
   ─ first-match-wins order (speculative → modal → imperative → deadline)
   ─ ~70 lines of patterns
```

The classifier dispatch at `classify.ts:25–40` just asks "did the heuristic match?" and gets `'todo'` or `null`. If the patterns change, callers don't notice. Pattern-change-without-leak is the deepest property a module can have.

**`src/services/database.ts` — typed per-entity API, hides cross-cutting bookkeeping.**

```
  database.ts — interface surface

  insertEntry(...)    updateEntry(...)    softDeleteEntry(...)
  insertNutrition(...) updateNutrition(...) softDeleteNutrition(...)
  insertTodoMeta(...)  updateTodoMeta(...)  setTodoType(...)
  ... (one cluster per synced entity)

  body hides:
   ─ raw SQLite statements (expo-sqlite)
   ─ updated_at = now() stamp on every write
   ─ schedulePush() dispatch
   ─ deleted_at tombstone (never DELETE)
   ─ synced_at preservation (never overwrite outside sync path)
```

The caller asks "save this entity" — bookkeeping invisible. Move 2 below in the audit shows the one bookkeeping leak that *almost* breaks the depth (callers must remember to call `reconcileMeta` when prose changes); see concept 03.

### Move 2 — buffr's shallow hotspot (the refactor finding)

One genuinely shallow pattern in buffr — the same 6-line provider-dispatch block copied across all five chain files. Each chain branches on `provider === 'anthropic'` vs `'openai'`, builds the right SDK call, parses the response. The block isn't *complex*, but it's identical in shape across five files, and the "interface" of each chain leaks the dispatch into the chain body.

```
  the shallow pattern — five copies of the same dispatch

  summarize.ts                caption.ts                  ...
  if (provider === ...) {     if (provider === ...) {
    // 6 lines                  // 6 lines
  } else {                     } else {
    // 6 lines                  // 6 lines
  }                           }

  the interface of each chain LEAKS the provider check.
  add a third provider (Google Gemini) → edit five files.
  classic change-amplification.
```

**The deep version (the fix):** extract a `callModel(provider, model, messages, tool): Promise<ParsedOutput>` helper in `src/services/ai/_callModel.ts`. Five chain files lose their dispatch blocks; each becomes a thin wrapper around `callModel` plus the chain-specific prompt and validation.

The breakeven: at 2 providers × 5 chains the inline dispatch is acceptable (30 lines of duplication, no abstraction tax). At 3 providers × 5 chains, or 2 providers × 10 chains, the wrapper wins decisively.

### Move 3 — the principle

The deepest abstraction is the one whose interface you can read in one breath and whose body you don't need to. Build modules that *hide* behaviour, not modules that *expose* it. Most class/interface debates miss this — depth is the only metric that matters at the module boundary, and a "well-designed" module by every other heuristic can still be shallow.

## Primary diagram

```
  buffr's modules ranked by depth — the audit's recommendation list

  DEEPEST (best — keep)
   ─ src/services/ai/validate.ts        per-chain validator, Zod hidden
   ─ src/services/todos/heuristicClassify.ts  binary gate, regex hidden
   ─ src/services/ai/compose.ts          per-day cache + chain dispatch
   ─ src/services/database.ts            per-entity writer, sync hidden

  WELL-PROPORTIONED (good)
   ─ src/services/ai/{summarize,caption,expand,classify,interpret}.ts
     each chain hides prompt + provider call + validation
   ─ src/services/sync/orchestrator.ts   pushAll/pullAll, REGISTRY hidden

  SHALLOW HOTSPOT (refactor target)
   ─ provider-dispatch block (5 copies, one per chain file)
     fix: extract callModel(provider, model, messages, tool)

  THIN BY DESIGN (not classitis — leave alone)
   ─ src/types/*.ts                      type declarations are the API
   ─ src/utils/generateId.ts              one-liner with one job
   ─ app/_layout.tsx                     route-level wiring
```

## Implementation in codebase

### Praise — the deepest module

```
  src/services/ai/validate.ts  (interface, ~10 lines for a five-chain validator)

  export function validateAISummary(parsed: unknown): AISummary {
    const result = AISummarySchema.safeParse(parsed);
    if (!result.success) {
      throw new ChainValidationError(           ← typed error class —
        'summarize',                              ── callers branch on .chain
        result.error.message                      ── rather than parsing strings
      );
    }
    return result.data;                          ← typed AISummary returned;
  }                                              ── callers consume directly,
                                                    no `as` cast needed
       │
       └─ the Zod schema is co-located but PRIVATE to this file.
          A schema change is internal. A new field appears in the typed
          return automatically. The caller never sees Zod.
```

### Refactor target — the shallow provider-dispatch

```
  src/services/ai/summarize.ts (the dispatch block — copy ~1 of 5)

  if (config.provider === 'anthropic') {
    const resp = await anthropic.messages.create({...});  ← 3 lines
    return parseAnthropicToolUse(resp);                   ← 1 line
  } else {
    const resp = await fetch(OPENAI_URL, {...});           ← 3 lines
    return parseOpenAITool(await resp.json());             ← 1 line
  }

  ... same block in caption.ts, expand.ts, classify.ts, interpret.ts ...

  the deep refactor — one new file:

  src/services/ai/_callModel.ts
  export async function callModel(
    provider, model, messages, tool
  ): Promise<unknown> {
    if (provider === 'anthropic') { ... }       ← the dispatch lives ONCE
    else { ... }
  }

  then summarize.ts shrinks to:
    const parsed = await callModel('anthropic', 'claude-sonnet-4-6', messages, summaryTool);
    return validateAISummary(parsed);
```

## Elaborate

The deep-modules-as-the-weapon framing comes from APOSD chapter 4 — Ousterhout's most repeated lesson. Most "clean code" advice runs in the opposite direction (small classes, narrow interfaces per class, lots of named units), which is what APOSD calls **classitis**: lots of shallow modules nominally "well-factored" but adding up to more interfaces and less depth.

The praise findings are intentional — celebrating depth where it exists makes the lesson stickier than only criticizing shallowness. Buffr is genuinely a deep-module codebase, which is a real architectural strength worth naming.

## Interview defense

**Q [mid]:** What makes a module "deep"?

**A:** Functionality divided by interface size. A function exported with a small signature that hides a substantial body — schemas, branches, retries, cross-cutting bookkeeping — is deep. In buffr, `validateAISummary(parsed) → AISummary` is a one-line API hiding Zod schemas, typed error construction, and chain-attribution. A "well-factored" five-line function with five-parameter signature isn't deep; it's shallow factoring.

```
  the depth test, drawn:

  ┌─ small interface ─┐    ──── hides ────►   ┌─ big body ─┐
  │ validateAISummary │                       │ schema +    │
  │   (parsed)        │                       │ safeParse + │
  │   → AISummary     │                       │ typed-error │
  └──────────────────┘                        │ construction│
                                              └─────────────┘
  one-line anchor: "the API you can read in one breath; the body you don't have to"
```

**Q [senior]:** Where is buffr genuinely deep, and where could it be deeper?

**A:** Genuinely deep: `validate.ts` (Zod hidden behind chain-typed validators), `heuristicClassify.ts` (~70 regex hidden behind a binary gate), `database.ts` (sync bookkeeping hidden behind per-entity API). One shallow hotspot: the provider-dispatch block, copied identically across five chain files — that 30 lines collapses to a single `callModel` helper, and the chain files lose the leak.

**Q [arch]:** When is shallowness acceptable?

**A:** When the interface IS the body — pure type declarations (`src/types/*.ts`), one-liner utilities (`src/utils/generateId.ts`), route-level wiring (`app/_layout.tsx`). These aren't classitis; they're leaves where there's nothing to hide. The classitis red flag fires when a module has both a wide interface and a thin body — neither buffr's chain files nor its type files match that.

## Validate

### Level 1 — reconstruct the diagram

Sketch the depth-ratio diagram (small interface, large body) and place buffr's deepest modules and shallow hotspot on opposite sides.

### Level 2 — explain it out loud

In under 90 seconds: explain why `validate.ts` is deep and why the chain provider-dispatch block is shallow. Use the phrase "shape change inside doesn't ripple."

### Level 3 — apply to a new scenario

A new feature: buffr should add semantic search over journal entries (Phase 2A). Where in the layered design should the depth live — in a `searchEntries(query)` deep function inside services, or distributed across the UI layer's hooks?

Open `src/services/ai/validate.ts` (the deep-module template) and verify the proposed `searchEntries(query)` shape matches its depth ratio.

### Level 4 — defend the decision

Defend or oppose: "The provider-dispatch block in five chain files is fine as-is — at 2 providers × 5 chains, the duplication cost is lower than the abstraction cost."

Reference `src/services/ai/summarize.ts` (the dispatch block, ~20 lines) and the proposed `_callModel.ts` extraction.

## See also

- [`01-complexity-in-this-codebase.md`](./01-complexity-in-this-codebase.md) — the deep-module fix applies to hotspots 2 and 3 (database.ts, reconcileMeta.ts).
- [`03-information-hiding-and-leakage.md`](./03-information-hiding-and-leakage.md) — the leakage that the chain-dispatch pattern shows.
- [`05-pull-complexity-downward.md`](./05-pull-complexity-downward.md) — the same principle applied to configuration knobs.
- [`08-red-flags-audit.md`](./08-red-flags-audit.md) — classitis as a checklist item.
