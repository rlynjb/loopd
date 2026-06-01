# Pull complexity downward

**Industry name(s):** Pull complexity downward (APOSD ch. 8), avoiding configuration exposure
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

When a module has enough information to decide a knob, it should — exposing the knob to callers spreads complexity upward and forces every caller to know what to set. APOSD's heuristic: the module is the right place to absorb the complexity, not the API. The audit asks: which constants, knobs, or branches in buffr live at the call site that the module could decide itself?

```
  Zoom out — where buffr keeps knobs

  ┌─ UI ──────────────────────────────────────────────┐
  │  no knobs                                          │
  └──────────────────┬─────────────────────────────────┘
                     │
  ┌─ Service ────────▼─────────────────────────────────┐
  │  ai/   per-chain temperature SET INSIDE the chain  │ ★ GOOD
  │        provider toggle in config.ts (callers see)   │ ◐ partial
  │  sync/ BATCH_SIZE=50 internal to push.ts            │ ★ GOOD
  │        PAGE_SIZE=200 internal to pull.ts            │ ★ GOOD
  │        debounce=5000ms internal to schedulePush     │ ★ GOOD
  │  database.ts  cross-cutting bookkeeping inside       │ ★ GOOD
  └────────────────────────────────────────────────────┘
```

Mostly clean: buffr's sync constants, AI sampling parameters, and bookkeeping all live inside the modules that own them. One partial exposure — the provider toggle — is named in concept 02 as a shallowness pattern; the same issue from a different angle.

## Structure pass

The axis is **control** — who decides the knob's value? Trace it across buffr's chains.

```
  axis = "who decides this knob's value?"

  knob: "what temperature should the classifier use?"
       │
       ▼
  decided in:  src/services/ai/classify.ts (~L50, temperature: 0)
       │
       ▼  caller does not see this; it's internal.
       ▼  one writer; one fact; no leakage. GOOD.

  knob: "which provider should this chain call?"
       │
       ▼
  decided in:  src/services/ai/config.ts (provider flag)
       │
       ▼  but every chain reads config.provider and branches.
       ▼  the decision is centralized, but its READING is not.
       ▼  could be deepened — see Move 2 below.
```

A pushed-up knob isn't necessarily wrong — sometimes callers genuinely have information the module doesn't. The audit asks the question; the answer can be "keep it" with a documented reason.

## How it works

### Move 1 — the inversion (the pattern)

```
  pushing complexity UP — the bug pattern

  caller A  ─►  module M with knob K  ◄─ caller B
   sets K=1                                 sets K=2
                       │
                       ▼
   M's logic must defend against K=1, K=2, K=N, ...
   complexity at the boundary x N callers

  pulling complexity DOWN — the fix

  caller A  ─►  module M decides K internally  ◄─ caller B
                       │
                       ▼
   M's logic is uniform; callers know nothing.
   complexity contained inside ONE place.
```

### Move 2 — buffr's knobs, walked

**Inside the chains (per-chain temperature) — already pulled down.** Each chain in `src/services/ai/` sets its own temperature: `classify.ts` at 0 (deterministic), `summarize.ts` at 0.3, `caption.ts` varying per variant (clean=0.4 … punchy=0.85), `interpret.ts` at 0.7. Callers never set temperature. Good.

```
  the pulled-down knob

  src/services/ai/classify.ts (~L50)
    const resp = await callModel({
      model: 'claude-haiku-4-5',
      temperature: 0,            ← OWNED HERE; caller never sees it
      messages, tool
    });
```

**Inside the sync layer (batch sizes, debounce) — already pulled down.** `BATCH_SIZE = 50` in `push.ts:7`, `PAGE_SIZE = 200` in `pull.ts:23`, the 5-second debounce in `schedulePush.ts`. None of these surface to UI callers; the sync layer absorbs them.

**The provider toggle — partially pulled down.** `config.provider` is set once in `config.ts`, but every chain *reads* it and branches inline (the same 6-line dispatch block that concept 02 named as a shallowness pattern). The decision is centralized; the *reading* leaks into five files. The same fix applies: extract `callModel(provider, model, messages, tool)` so the read happens in one place.

```
  the partial leak — provider toggle

  config.ts                                src/services/ai/{summarize,caption,
    export const config = {                                expand,classify,interpret}.ts:
      provider: 'anthropic'                  if (config.provider === 'anthropic') { ... }
    }                                        else { ... }
       │                                          ▲
       │                                          │  five places read
       └──────────────────────────────────────────┘  and branch

  fix: callModel(provider, ...) helper. one read. four files lose the branch.
```

**Cross-cutting bookkeeping — already pulled down.** `database.ts`'s writers stamp `updated_at`, call `schedulePush()`, and never DELETE (soft-delete only). Callers don't know any of this. The depth named in concept 02 is what makes this work.

### Move 3 — the principle

A knob in the API is a tax on every caller — they need to know what to set, and the module needs to defend against every value. Move the decision down whenever the module has enough information; document the rare cases where you can't. The audit smell is uniform across primitives: if a parameter shows up in the same value at every call site, the module should own the value.

## Primary diagram

```
  buffr's knobs, classified

  PULLED DOWN (good)
   ─ per-chain temperature           inside each chain file
   ─ BATCH_SIZE = 50                  inside src/services/sync/push.ts
   ─ PAGE_SIZE = 200                  inside src/services/sync/pull.ts
   ─ schedulePush debounce 5s          inside src/services/sync/schedulePush.ts
   ─ sync bookkeeping (updated_at,    inside src/services/database.ts
     deleted_at, synced_at)

  PARTIALLY PULLED (refactor target)
   ─ provider toggle                  read by 5 chain files
                                      fix: callModel(provider, ...) helper

  RIGHTLY EXPOSED (caller info module lacks)
   ─ entry text                       only caller knows what to save
   ─ user_id                          only caller knows who's authenticated
   ─ date                             only caller knows which day to query
```

## Implementation in codebase

```
  src/services/sync/push.ts (line ~7, the constant pulled down)

  const BATCH_SIZE = 50;            ← OWNED HERE; no caller knows it
  // ...
  export async function pushTable(table) {
    const dirty = await table.localQueryDirty();
    for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
      const batch = dirty.slice(i, i + BATCH_SIZE);
      await pushBatch(batch);
    }
  }
       │
       └─ the caller (orchestrator) just calls pushTable(table).
          The batch size is a sync-layer concern; the caller has no
          information about why 50 is right. Complexity stays inside.
```

```
  the partial-pull — provider dispatch (same finding as concept 02)

  src/services/ai/summarize.ts (~L60, dispatch block)

  if (config.provider === 'anthropic') {
    const resp = await anthropic.messages.create({ /* ... */ });
    return parseAnthropicToolUse(resp);
  } else {
    const resp = await fetch(OPENAI_URL, { /* ... */ });
    return parseOpenAITool(await resp.json());
  }
       │
       └─ this dispatch reads config.provider and branches. Five chain
          files do this. The fix: callModel(provider, model, messages,
          tool) inside src/services/ai/_callModel.ts.
```

## Elaborate

The "pull complexity downward" framing is APOSD chapter 8 — Ousterhout's response to the over-configuration anti-pattern that proliferated in 2010s Java code. The rule generalizes: anything a module could decide for itself, it should. The classic counter-rule is "make it configurable for flexibility" — but flexibility is only a virtue when callers genuinely need to vary the knob; otherwise it's complexity tax.

Buffr's design is mostly disciplined here. The one partial leak (provider toggle) is the same fact viewed from a different primitive (shallow vs deep, push vs pull). Multiple APOSD primitives converging on one finding is a strong signal that the finding is real.

## Interview defense

**Q [mid]:** What's a configuration knob you'd pull down in buffr?

**A:** None right now — buffr is mostly disciplined. The sync batch sizes, debounce, and per-chain temperatures all live inside the modules that own them. The one partial leak is the provider toggle: it's set centrally in `config.ts`, but every chain reads it and branches inline. The fix is the `callModel` helper that concept 02 also identified — same finding, different angle.

```
  the partial-leak — one diagram

  before: config.provider read in 5 chain files
  after:  config.provider read once in _callModel.ts
                                       │
                                       └─ 5 dispatch blocks deleted

  one-line anchor: "any value the module knows, the caller shouldn't"
```

**Q [senior]:** When is exposing a knob to callers the right call?

**A:** When the caller has information the module doesn't. `database.insertEntry(text, date)` exposes `text` and `date` because only the caller knows those. But `database.insertEntry(text, date, useTransaction=true)` would be wrong — the module knows when transactions are needed (always for synced writes); the caller doesn't.

**Q [arch]:** How would you spot the next over-exposed knob?

**A:** Watch for parameters with the same value at every call site. If `pushTable(table, batchSize=50)` is called as `pushTable(table, 50)` everywhere, the 50 belongs inside. The audit step is mechanical: grep for the function, check for unique values in the parameter; non-unique → pull it down.

## Validate

### Level 1 — reconstruct the diagram

Sketch the inversion pattern (caller pushes K up vs module pulls K down) and place buffr's provider toggle and BATCH_SIZE on opposite sides.

### Level 2 — explain it out loud

In under 90 seconds: why is BATCH_SIZE good practice but the provider toggle a partial leak? Use the phrase "any value the module knows, the caller shouldn't."

### Level 3 — apply to a new scenario

A new feature: buffr should retry failed chain calls with exponential backoff. Should the retry count be a parameter to `callModel` or a constant inside it?

Open `src/services/sync/push.ts:7` (BATCH_SIZE) and verify your reasoning matches the existing pattern.

### Level 4 — defend the decision

Defend or oppose: "Per-chain temperature should be a parameter of `callModel`, not a constant inside each chain, so the same chain can be re-used at different temperatures."

Reference `src/services/ai/classify.ts:~L50` (temperature inside the chain).

## See also

- [`02-deep-vs-shallow-modules.md`](./02-deep-vs-shallow-modules.md) — the provider-toggle finding from the depth angle.
- [`04-layers-and-abstractions.md`](./04-layers-and-abstractions.md) — pass-throughs and pushed-up knobs are cousins.
- [`08-red-flags-audit.md`](./08-red-flags-audit.md) — "avoidable config exposed to users" as a checklist item.
