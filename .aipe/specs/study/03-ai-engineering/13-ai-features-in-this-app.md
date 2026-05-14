# How this codebase uses AI specifically

**Industry name(s):** AI feature catalogue, per-feature pattern map
**Type:** Project-specific

> Per-feature: prompt shape, input, output. Five chains, each one-job — four emit JSON, one (interpret) emits markdown.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [03-context-window](./03-context-window.md) · → [04-provider-abstraction](./04-provider-abstraction.md) · → [08-validation-gate](./08-validation-gate.md)

---

## Why care

A small kitchen runs a five-recipe binder. Each recipe has its own ingredients, its own oven setting, its own expected dish, its own serving instructions. The cook flips to the recipe the order calls for, follows it, plates it, moves on. Walk in and ask "what does the kitchen serve?" and the cook hands you the binder — you can see the soup is leek-and-potato, the pasta is carbonara, the bread is sourdough. None of that information is hidden inside the cook's head; it's named on the page.

A per-feature AI catalogue is that binder. Not "we added AI" — five named recipes, each with a prompt template, a model choice, an output contract, and a place in the UI. Naming each feature this way is what makes cost, latency, blast radius, and provider-swap decisions tractable.

**What depends on getting this right:** the ability to reason about any single AI feature without re-deriving the whole product. The codebase ships five chains: `summarize.ts` (Sonnet/GPT-4o, structured editor JSON + freeform summary into `ai_summaries.summary_json`), `caption.ts` (Sonnet/GPT-4o, 4 tonal variants `clean/smoother/reflective/punchy` into `summary_json.variants`), `classify.ts` (Haiku/GPT-4o-mini, 1-of-5 mode label into `todo_meta.type` + `classifier_confidence='haiku'`), `expand.ts` (Sonnet/GPT-4o, per-type typed JSON for `idea/knowledge/study/reflect` into `todo_meta.expanded_md`), `interpret.ts` (Sonnet/GPT-4o, long-form markdown into a modal, NOT persisted). The two-tier model split (Sonnet for content, Haiku for labels) keeps classify at ~$0.0004 instead of ~$0.01 per call — 25× the cost ratio that tracks 25× the output-token-count difference. Drop the catalogue and "we added AI" becomes the only available description; cost analysis, model-version migration, and "which feature breaks if Anthropic deprecates Sonnet 4.6?" all become re-discovery exercises every time they're asked.

Without the per-feature map:
- "How much does AI cost per active day?" → "let me trace the chains" → 30-minute archaeology
- Switching `classify` from Haiku to GPT-4o-mini means opening five files to find the one that needs the model flip
- A new contributor doesn't know whether `interpret` persists or is ephemeral until they grep `database.ts`

With the per-feature map:
- Five named recipes, each ~150-300 LOC, each owning prompt + parser + persister
- Persisted four (`summary_json`, `type`, `expanded_md`) feed downstream UI; `interpret` is ephemeral by design
- Model split (Sonnet for content, Haiku for labels) is one line in `config.ts:getProvider()`-adjacent code per chain

Five recipes, one binder — every AI feature in this codebase has a named page.

---

## How it works

A small recipe binder with five named recipes — one for each AI feature. Each recipe has its own ingredients (prompt template), oven setting (model choice), expected dish (output shape), and serving instructions (where it lands in the UI). The cook (the codebase) doesn't improvise — every dinner is one of the five recipes, made exactly the way the binder says. If you're coming from frontend, this is the same shape as a typed set of `useMutation` hooks, one per server action — each has its mutation function, its onSuccess, its inputs, and they don't cross-call each other.

### The five recipes — what each AI feature does and why

```
  ┌────────────────────┬──────────────────┬─────────────────────────────────────┐
  │ Feature            │ Pattern          │ Why this pattern                     │
  ├────────────────────┼──────────────────┼─────────────────────────────────────┤
  │ Day summarize      │ Single chain     │ one job: structured editor JSON     │
  │                    │ Sonnet/4o        │ + freeform summary text             │
  │ 4-variant caption  │ Single chain     │ one job: 4 tonal voices of one day  │
  │                    │ Sonnet/4o        │ with theme detection                 │
  │ Todo classify      │ Heuristic + LLM  │ heuristic catches obvious; Haiku/   │
  │                    │ Haiku/4o-mini    │ mini handles the rest cheaply       │
  │                    │                  │ (5 modes as of 2026-05-10:           │
  │                    │                  │ todo/idea/knowledge/study/reflect)  │
  │ Todo expand        │ Per-type chain   │ 4 typed schemas: idea / knowledge / │
  │                    │ Sonnet/4o        │ study / reflect. Each schema has a  │
  │                    │                  │ different system prompt with its    │
  │                    │                  │ own JSON shape. TYPE selects chain. │
  │                    │                  │ ('todo' is the non-expandable       │
  │                    │                  │ default — no shape to expand into.) │
  │ Interpret          │ Single chain,    │ Long-form markdown reflection on a  │
  │                    │ markdown out     │ journal entry. User taps button,    │
  │                    │ Sonnet/4o        │ modal opens, markdown renders,      │
  │                    │                  │ result is NOT persisted.            │
  └────────────────────┴──────────────────┴─────────────────────────────────────┘
```

Concrete consequence: the codebase has five AI files, each ~150-300 LOC, each owning one of these recipes. Adding a sixth feature means writing a sixth file with its own prompt + parser + persister; it does NOT mean adding a new branch to an existing chain. Boundary: this works as long as the recipes stay small enough that the duplication is cheaper than abstracting them.

### The split between persisted and ephemeral

Four of the five recipes persist their output to SQLite (`ai_summaries.summary_json`, `todo_meta.type`, `todo_meta.expanded_md`); one (interpret) doesn't. The persisted four feed downstream UI surfaces — the editor reads `summary_json`, the dashboard's todo cards read `type` and `expanded_md`. Interpret's output is shown once in a modal and discarded; the user reads it, dismisses the modal, never sees it again. Think of it like the difference between a `useMutation` that updates the React Query cache vs one that fires a side-effect without caching — same call shape, different lifecycle. Concrete consequence: a user runs interpret on the same entry tomorrow; the codebase calls the LLM again from scratch (no cache, no DB column). Costs another ~$0.005. The recipe is deliberately ephemeral because the user reads interpretations and moves on; caching would store data nobody re-reads. Boundary: this works because interpret is rare (user-triggered), not background. If interpret were running on every entry automatically, the cost would justify caching.

### The two-tier model split — Sonnet for thinking, Haiku for routing

The codebase uses Claude Sonnet 4.6 (or GPT-4o) for the recipes that produce *content* (summarize, caption, expand, interpret); Claude Haiku 4.5 (or GPT-4o-mini) for the recipe that produces a *label* (classify). The split tracks the task — Sonnet is good at writing, reasoning, multi-step output; Haiku is good at fast classification. If you've worked with React's tiered hooks (`useState` for sync state, `useTransition` for async non-urgent state), this is the same instinct — match the tool to the task's shape. Concrete consequence: classifying a todo costs ~$0.0004 with Haiku; summarising a day costs ~$0.01 with Sonnet. The 25× cost ratio reflects the 25× difference in output token count and reasoning depth. If classify had been built on Sonnet, the codebase would spend $0.10/day classifying todos that Haiku does for $0.004/day. Boundary: the model split assumes the two providers' model tiers track similarly. If a future model rebalances the tier (e.g., a cheap Sonnet variant lands), the codebase would re-evaluate.

This is what people mean by "name the AI features and pick one pattern per feature." The temptation when adding AI to an app is to build one big assistant that does everything; the cheaper, more maintainable, and more debuggable shape is five small features each doing one thing well. The codebase's AI surface is five recipes, no more, no less — and the discipline of keeping it five rather than letting it grow into a generic "ask the AI" feature is what keeps the cost predictable, the failure modes named, and the testing tractable.

---

## Per feature: prompt shape, input, output

```
  Day summarize
  ─────────────
  System: "You are an editor for a daily-vlog app. Read the day's
           entries, clip list, and habits. Output a single JSON object:
           { summary, mood, clipOrder[], clipTrims[], filterPreset, ... }"
  Input:  buildPrompt(entries, allClips, allHabits, date)
  Output: AISummary JSON, validated by validate.ts:validateSummary
          (checks every clipId in clipOrder exists, trims fit clip duration, etc.)

  4-variant caption
  ─────────────────
  System: SYSTEM_PROMPT in caption.ts (the most opinionated prompt in the codebase).
          Specifies four named voices (clean / smoother / reflective / punchy)
          with example body lines for each, plus universal rules
          (no "I"/"you"/"we"; no hashtags; no questions; no platitudes).
  Input:  { date, rawLog[], recentCaptions?, mood?, themeHint? }
          (assembled by summarize.ts:buildCaptionInput() L111; recentCaptions
          come from getRecentAISummaries(date, 5) at summarize.ts:131)
  Output: { variants: { clean, smoother, reflective, punchy }, detectedTheme }
          All four variants required; partial output treated as malformed.
          Persisted by summarize.ts:91–92 as:
            summary_json.variants       ← captionOut.variants (pass-through)
            summary_json.variantsTheme  ← captionOut.detectedTheme (key RENAMED)

  Todo classify
  ─────────────
  System: "You classify short personal thoughts into one of FIVE thinking modes.
           Modes: todo / idea / knowledge / study / reflect.
           Output ONLY {"type":"<mode>","confidence":"high|medium|low"}"
  Input:  the todo text alone — no surrounding context (cost optimization)
  Output: { type, confidence, model }
  History: was 7 modes pre-2026-05-10. bug / question / decision / content
           dropped (engineering-flavored); study + reflect added (introspective).

  Todo expand (per type)
  ──────────────────────
  System: getSystemPrompt(meta.type) — one of 4 templates
          (idea / knowledge / study / reflect — 'todo' is non-expandable).
          ExpandableType = Exclude<TodoType, 'todo'> in src/types/todoMeta.ts.
  Input:  todo text + entry text + sibling todos + last 3 days of entries
          + cached summaries (from buildContext)
  Output: TodoExpansion union — validated against per-type required fields,
          serialized to markdown by serializeExpansion, persisted to
          todo_meta.expanded_md

  Interpret
  ─────────
  System: 32-line "emotionally intelligent journal interpreter" prompt.
          Prescribes a structural template (opening + numbered themes +
          healthy-side / part-to-watch / deeper-fear / honest-interpretation /
          strongest-line / final-thought sections, emoji H2 headings).
          Explicitly says "skip any section that doesn't fit; do not pad".
          Forbids clinical labels, motivational language, recommending tools.
  Input:  the journal entry's text (truncateTail to MAX_INPUT_CHARS = 2000;
          MIN_TEXT_LENGTH = 20 guard short-circuits below the cap)
  Output: markdown string — NOT JSON, NOT validated against a schema.
          cleanMarkdown strips outer ``` fences and rejects empty output.
          Wrapped in Interpretation { markdown, sourceText, generatedAt, model }
          and rendered in InterpretModal — never persisted to SQLite.
```

---

## In this codebase

**Day summarize:**       `src/services/ai/summarize.ts` → `summarize()` L42–L105 (helpers `callClaude` L12–L22, `callOpenAI` L24–L40, `buildCaptionInput` L111–L163)
**4-variant caption:**   `src/services/ai/caption.ts` → `generateCaption()` L201–L223 with the most opinionated structured `SYSTEM_PROMPT` at L24–L100; validator `parseAndValidate()` L169–L199 + `normalizeVariant()` L158–L167
**Todo classify:**       `src/services/todos/classify.ts` → `classifyTodo()` L90+ (`SYSTEM_PROMPT` L12–L25 — now 5 modes after the 2026-05-10 reduction)
**Todo expand:**         `src/services/todos/expand.ts` → `expandTodo()` L191+ with `getSystemPrompt(meta.type)` selecting one of 4 per-type chains in `src/services/todos/expandPrompts.ts:50` (PREAMBLES L6, SCHEMAS L15, TYPE_INTRO L43); serialised to markdown by `expandSerialize.ts:serializeExpansion`
**Interpret:**           `src/services/ai/interpret.ts` → `interpretEntry()` L114–L149 — 32-line `SYSTEM_PROMPT` L19–L50 (longest in the codebase); validator `cleanMarkdown()` L98–L108 (no JSON schema)
**Validators:**          `src/services/ai/validate.ts` → `validateSummary()` L12+ (caption + expand + interpret validators live in their own files)
**Type definitions:**    `src/types/todoMeta.ts` → `TodoType` L5+, `ExpandableType = Exclude<TodoType, 'todo'>` L101

---

## Elaborate

### Where this pattern comes from
The "per-feature spec sheet" approach is borrowed from API design — each endpoint gets its own request/response contract, and the docs are organised around the contract, not the code.

### The deeper principle
**The prompt is the contract.** Just like an API spec, the prompt + the JSON shape define what the feature commits to. Treat changes to either as a contract change.

### Where this breaks down
- A snapshot file like this rots fast when prompts change. Treat it as a starting point, not the truth.
- The actual prompts are in source — `caption.ts`'s SYSTEM_PROMPT is the most opinionated one and worth reading directly.

### What to explore next
- Read the actual `SYSTEM_PROMPT` in each file. They're more concrete than this summary.
- [02-single-purpose-chains](./02-single-purpose-chains.md) → the pattern these all follow.
- [08-validation-gate](./08-validation-gate.md) → how each output is checked.

---

## Tradeoffs

We traded a unified AI service (one chain that does many jobs) for five purpose-built chains — each with its own prompt, model, and output contract, optimized for cost-and-value asymmetry per feature.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (5 single-purpose   │ Alternative (unified general-  │
│                  │ chains)                        │ purpose chain)                 │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Money            │ Sonnet for 4 chains @ ~$0.04;  │ all on Sonnet = ~$0.04/call;   │
│ ($/call)         │ Haiku for classify @ ~$0.0001  │ classify volume × $0.04 ≈      │
│                  │ — 50× cheaper on the high-     │ $0.50/heavy-day vs $0.003;     │
│                  │ volume chain                   │ ~150× higher classify $        │
│ Latency          │ Haiku classify ~300ms;         │ Sonnet classify ~800ms-1.5s    │
│                  │ Sonnet ~800ms-5s elsewhere     │ on every call; slower default  │
│ Quality          │ each chain tuned for its job — │ generic prompt loses tonal     │
│ (% correct)      │ caption is most opinionated    │ specificity (caption variants  │
│                  │ (4 voices, no "I"); classify   │ feel generic); JSON contract   │
│                  │ has 5-mode schema              │ less stable                    │
│ Provider features│ structured outputs per chain;  │ shared interface forces lowest │
│ used             │ caption uses 4-variant union;  │ common denominator across all  │
│                  │ classify uses confidence union │ chains                         │
│ Failure          │ each chain fails independently │ shared chain failure affects   │
│ isolation        │ — caption fail doesn't kill    │ all features; one bug          │
│                  │ structured summary             │ propagates across product       │
│ Doc cost         │ 5 prompts to keep in sync with │ 1 prompt — but it's a giant    │
│                  │ source; this catalogue rots    │ multi-purpose prompt that      │
│                  │                                │ also rots, harder to update    │
│ Cognitive load   │ "this feature → this chain →   │ "one chain → many features →   │
│                  │ this prompt" — direct mapping  │ which prompt branch?" — extra  │
│                  │                                │ indirection                    │
│ New feature cost │ new feature = new chain        │ new feature = new branch in    │
│                  │ (clear isolation)              │ shared chain (coupling risk)   │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up shared prompt logic and any economy of scale on prompt maintenance. Each chain has its own SYSTEM_PROMPT — caption is the most opinionated at 80+ lines (specifying 4 named voices and universal rules); interpret is the longest at 32 lines (structural template with emoji H2 headings); classify is the shortest at ~13 lines (5-mode taxonomy). When the writing style of one needs updating, it's a per-chain change. There's no shared "loopd voice" prompt fragment that propagates everywhere — each chain decides its own tone.

We pay for 4 per-type expand sub-chains (idea / knowledge / study / reflect — `'todo'` is non-expandable). Each has its own SYSTEM_PROMPT and required-fields schema in `expandPrompts.ts`. When the taxonomy reduced from 6 to 4 types in 2026-05-10 (bug / question / decision / content dropped), each removed type also removed its prompt + schema. The maintenance cost scales linearly with type count, which is why the doc explicitly warns "the doc is a snapshot."

The biggest cost is doc drift: this very catalogue is a snapshot, and when the SYSTEM_PROMPT constants in source change, this file silently rots. A snapshot test that hashes the prompt constants and fails CI on undocumented changes would catch this — but it's not built, and solo dev means I rely on remembering to revisit. That's a real fragility I'd rather name than pretend the doc is auto-true.

### What the alternative would have cost

A unified AI service (one chain with a giant prompt that branches by feature) would have looked tidier from the outside — fewer files, one entry point, one place to add cross-cutting features. The hidden cost is that the unified prompt is the union of all per-feature prompts, which means it's longer (worse context-window pressure), less specific (each feature loses its tuned voice), and more expensive to debug (when caption variants come out generic, is it the unified prompt or the feature-specific branch?).

The deeper cost is forced lowest-common-denominator on model choice. Today caption / summarize / expand / interpret use Sonnet 4.6 for output quality, while classify uses Haiku 4.5 because the 5-mode label problem doesn't justify Sonnet's cost. A unified chain would have to pick one model — Sonnet (~50× more expensive on classify) or Haiku (~quality drop on caption / interpret). Either way, half the chains pay a tax for the other half. Today the 5-chain shape lets each one pick its model.

Failure isolation also collapses. With 5 chains, a caption schema drift breaks captions but the structured summary still saves; a Sonnet upgrade that breaks summarize doesn't affect classify (different model anyway). With a unified chain, a bad upgrade or prompt edit can cascade across all features. The shared-utility benefit is real but bounded; the failure-blast cost is unbounded.

### The breakpoint

The pattern flips at ~10+ AI features. Today 5 chains are individually readable; at 10+, the per-chain prompt files and validators start to feel like duplication of structure (every chain has the same "branch on provider, call, parse, validate, persist" shape). At that point, a shared `runChain(featureSpec)` utility — where `featureSpec` carries the prompt + model + validator — would pay back, *without* unifying the prompts themselves. That's a different shape: shared *infrastructure* (the runner), not shared *prompt* (the content).

A secondary trigger: when classify volume jumps 10×. Today classify is the highest-volume chain (~30 calls/heavy-day) and the cost asymmetry between Sonnet ($0.04) and Haiku ($0.0001) is what justifies the model split. At 300 classify calls/day, the cost gap matters even more — Haiku saves ~$10/year per user vs Sonnet. The breakpoint shifts up as Haiku gets cheaper relative to Sonnet.

The doc-drift breakpoint is concrete: the day the SYSTEM_PROMPT in `caption.ts` changes and this catalogue isn't updated, a reader will trust the catalogue and be wrong. Snapshot tests would catch that; we don't have them. The day I have a teammate, that's the first thing I'd build.

### What wasn't actually a tradeoff

Per-feature vs per-domain organization wasn't a real choice. The five chains naturally cleave along functional lines (summarize a day, caption a day, classify a todo, expand a todo, interpret an entry) — not domain lines. Domains (entries / todos / vlogs) don't map 1:1 onto chains; summarize touches entries and clips, caption touches summaries and recent captions, expand touches todos and entries. Per-feature is the natural shape; per-domain would have meant cross-cutting prompts that nobody asked for.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk / Claude Sonnet 4.6 + Haiku 4.5

- **Codebase uses:** `@anthropic-ai/sdk`; Sonnet 4.6 for `summarize`, `caption`, `expand`, `interpret`; Haiku 4.5 for `classify`.
- **Why it's here:** the per-feature pattern map is organised around which model each chain uses — Sonnet for output quality, Haiku for cheap high-volume labels.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling that wrappers sometimes flatten or delay.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures and `useChat` hook.

### Raw fetch to OpenAI `/v1/chat/completions`

- **Codebase uses:** raw `fetch`; `gpt-4o` for `summarize`/`caption`/`expand`/`interpret`, `gpt-4o-mini` for `classify` — branched in `callOpenAI()` per chain.
- **Why it's here:** OpenAI is the alternate provider across all 5 chains; model-choice reasoning (cost vs quality) applies equally to both providers.
- **Leading today:** OpenAI Node SDK — `adoption-leading`, 2026.
- **Why it leads:** typed request/response shapes, built-in retries, and the most-used OpenAI client in production.
- **Runner-up:** Vercel AI SDK — `innovation-leading` wrapper unifying OpenAI + Anthropic + others under one interface.

### @supabase/supabase-js

- **Codebase uses:** `@supabase/supabase-js`; Supabase mirrors the AI-derived rows (`ai_summaries`, `todo_meta`) that are written by the five chains.
- **Why it's here:** AI persistence is framed as "Supabase mirror + sync mapper" in the Tradeoffs — the cost of persisting a new feature (e.g. interpretations) is measured in Supabase migrations.
- **Leading today:** Supabase — `adoption-leading` for Postgres-as-a-service, 2026.
- **Why it leads:** managed Postgres + auth + RLS + Storage in one console; no separate infra for each primitive.
- **Runner-up:** Neon + Drizzle — `innovation-leading` typed SQL with serverless branching and zero-cold-start Postgres.

---

## Project exercises

**Status:** `learn-only` — this file is the catalogue, not a single concept with a `[Bx.y]` exercise. Every Phase 1 build item touches at least one row of this catalogue; the exercises that *maintain* the catalogue are:

### Keep the catalogue in sync with the chains

- **Exercise ID:** *cross-cutting (depends on `[B1.1]` typed contracts)*
- **What to build:** A small CI check (or a manual pre-merge step) that asserts every chain file in `src/services/ai/*.ts` has a row in this catalogue and vice versa — no orphan chain, no orphan row. When `[B1.1]` lands, the check can additionally assert the schema referenced in the catalogue matches the Zod schema in code.
- **Why it earns its place:** doc drift is the named cost of this pattern (called out in the Tradeoffs section). A check turns the cost from "always present" to "caught at PR time."
- **Files to touch:** new `scripts/check-ai-catalogue.mjs`; runs against this file + `src/services/ai/`.
- **Done when:** the script exits non-zero if (a) a chain in code has no catalogue row, (b) a catalogue row references a chain that doesn't exist, or (c) a referenced model is no longer in `src/services/ai/config.ts`.
- **Estimated effort:** `1–4hr`.

---

## Summary

The per-feature pattern map is a system-inventory catalogue — one row per AI-touching feature with prompt shape, input, output contract, and model choice, organised like an OpenAPI spec rather than a tutorial. In this codebase five chains do five jobs: `summarize.ts` (day summarize, Sonnet/4o, structured JSON), `caption.ts` (4-variant caption, Sonnet/4o, the most opinionated prompt with `parseAndValidate`), `classify.ts` (5-mode classify, Haiku/4o-mini, heuristic-gated), `expand.ts` (per-type expand with 4 schemas, Sonnet/4o, `MAX_CONCURRENT = 3`), and `interpret.ts` (markdown reflection, Sonnet/4o, ephemeral). Four chains emit JSON for derived state; `interpret` emits markdown the user reads. The constraint that drove it is cost-and-value asymmetry: Sonnet for output quality where it earns its keep, Haiku for cheap labels, no surrounding context for classify because half the volume gets caught by the heuristic. The cost is doc drift — this catalogue is a snapshot, and when SYSTEM_PROMPTs change the file must be re-checked.

Key points to remember:
- Five chains, five jobs — four JSON contracts plus one markdown contract for interpret.
- Sonnet 4.6 for summarize/caption/expand/interpret; Haiku 4.5 for classify.
- Classify taxonomy is 5 modes (todo/idea/knowledge/study/reflect); was 7 pre-2026-05-10.
- Expand has 4 per-type sub-chains (idea/knowledge/study/reflect — `'todo'` is non-expandable).
- The doc is a snapshot; the SYSTEM_PROMPT constants in source are the truth.

---

## Interview defense

### What an interviewer is really asking
On the per-feature reference page, the interviewer is testing whether I can move from "I built five AI features" to "I can defend each prompt + input + output contract specifically". They want concrete details: what system prompt does caption use, what fields does validateExpansion check for 'idea' (or 'reflect', or 'study'), what's the model choice and why per chain, why interpret's contract is markdown instead of JSON. Hand-wavy "we summarise the day" answers fail this question.

### Likely questions

[mid] Q: Walk me through `caption.ts`'s SYSTEM_PROMPT — what does it actually constrain?
      A: It's the most opinionated prompt in the codebase. It defines four named voices (clean / smoother / reflective / punchy) with example body lines for each, plus universal rules: no "I"/"you"/"we", no hashtags, no questions, no platitudes. It takes `{ date, rawLog[], recentCaptions?, mood?, themeHint? }` as input and demands `{ variants: { clean, smoother, reflective, punchy }, detectedTheme }` — all four variants required; partial output is treated as malformed by `parseAndValidate`. The opinionation matters because caption output is the most user-visible AI artifact: bad voice consistency would be obvious every day. The 4-variant shape lets the user pick rather than locking them into one tone.

```
[caption.ts chain — most-opinionated prompt + most-user-visible output]

  buildCaptionInput(date, summary)
        │
        ▼  { date, rawLog[], recentCaptions[5], mood?, themeHint? }
  call Sonnet/4o with SYSTEM_PROMPT (80+ lines, 4 voices)
        │   no "I"/"you"/"we"; no hashtags; no questions; no platitudes
        ▼
  parseAndValidate (caption.ts L169-L199)
        │   all 4 variants required → reject partial as malformed
        ▼  { variants: { clean, smoother, reflective, punchy }, detectedTheme }
  summarize.ts L91-92 persists:
    summary_json.variants       ← captionOut.variants (pass-through)
    summary_json.variantsTheme  ← captionOut.detectedTheme (key RENAMED)
```

[senior] Q: Why Sonnet 4.6 for summarize/caption/expand but Haiku 4.5 for classify? Walk me through the model-choice reasoning.
         A: Cost and task complexity. Summarize, caption, and expand all produce ~1024-token structured JSON with real reasoning content — clip orderings, tonal voice variants, typed expansions with multiple required fields. Sonnet at ~$0.04/call earns its keep on output quality. Classify is a 7-class label problem with ~50 tokens out — Haiku 4.5 (or gpt-4o-mini on the OpenAI side) handles it cheaply. The cost asymmetry is roughly 50×: Sonnet calls are dollars per heavy day if I let them rip, Haiku calls are cents. The model choice mirrors the value asymmetry — caption quality matters per-day, classify accuracy matters per-todo and the heuristic already filters half.

```
                  Path taken (Sonnet for quality;       Alternative (Sonnet for all 5)
                  Haiku for high-volume classify)
                  ─────────────────────────────────     ─────────────────────────────────
$ per call        Sonnet ~$0.04 × 4 chains              Sonnet ~$0.04 × 5 chains
                  Haiku ~$0.0001 × classify             classify pays ~150× more for
                                                        marginal quality gain
$/heavy-day       ~$0.20 (4 Sonnet) + $0.003 (Haiku    ~$1.20+ (all 5 on Sonnet,
                  × 30 classify) = ~$0.20                30 classify calls × $0.04)
$/year per user   ~$0.50-$1                             ~$5-$10
classify quality  Haiku handles 5-mode labels well     Sonnet would do marginally
                  (~95% accuracy)                       better (~97%) — gain not worth
                                                        50× cost
caption quality   Sonnet earns its keep — 4 distinct   same — unchanged
                  voices, tonal variety user notices
output volume     ~50 tokens (classify) vs ~1024       ~1024 across all — wasted
                  tokens (summarize/caption/expand)    capacity on classify
asymmetry         model cost mirrors task complexity   uniform model, asymmetric cost
                  AND output value                      vs value
```

[arch] Q: How would you redesign these five features if cost dropped 100× — say Sonnet at $0.0004/call?
       A: I'd merge less, not more. The current splits exist because of failure isolation (caption split out of summarize) and cost pressure (no surrounding context for classify). At 100× cheaper, I'd send classify the surrounding entry text — accuracy goes up at no real cost. I'd drop the heuristic gate because it stops paying back. I might add a new feature like "weekly synthesis" that today would be too expensive to run automatically. The single-chain shape stays — that's about debuggability and failure isolation, not cost — but the inputs grow.

```
At 100× cost drop (Sonnet at $0.0004/call):

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — same 5 chains, same modal/badge │
  └─────────────────────────────────────────────┘
              │
  ┌─ Single-chain shape ────────────────────────┐
  │ STAYS — debuggability + failure isolation   │
  │ are independent of cost                     │
  └─────────────────────────────────────────────┘
              │
  ┌─ Inputs / context budget ──────────────────┐
  │ classify gets surrounding entry text         │  ◀── GROWS FIRST
  │ (accuracy ↑ at zero $ cost)                  │     (cost no longer
  │ heuristic gate DROPPED — stops paying back   │      gates input size)
  │ expand context grows from 3 days → 7 days   │
  └─────────────────────────────────────────────┘
              │
  ┌─ New features unlocked ─────────────────────┐
  │ "weekly synthesis" chain                     │
  │ "compare today to last month" chain         │
  │ — automatic runs become affordable           │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Your "per-feature spec" reads like documentation — but documentation rots fast. How do you keep this in sync with the actual prompts in `caption.ts` and `expandPrompts.ts`?

A: I don't, automatically. The doc warns the reader at the top: "this is a snapshot — when prompts change, this file should be re-checked", and the truth lives in source. The honest answer is that doc drift is real and I haven't built tooling to prevent it. The two mitigations are: one, the prompt-shape summaries here are deliberately *abstract* — I describe what the prompt enforces, not the exact wording, so small phrasing tweaks don't break the doc; two, I point readers to read `caption.ts:SYSTEM_PROMPT` and `expandPrompts.ts:getSystemPrompt` directly because those are concrete and authoritative. If I were running a team, I'd add a snapshot test that hashes the SYSTEM_PROMPT constants and fails CI when they change without a doc update — forcing the conversation. Solo dev, I rely on remembering to revisit. That's a real fragility and I'd rather name it than pretend the doc is auto-true.

```
                  Path taken (abstract prompts +        Suggested (snapshot test in CI)
                  pointer to source)
                  ─────────────────────────────────     ─────────────────────────────────
doc accuracy      ~70% — prompt-shape summaries are    ~99% — hash mismatch fails CI
                  stable across small phrasing edits   on every undocumented change
new tooling       0 LOC                                snapshot test file +
                                                       hash-of-SYSTEM_PROMPT constant
                                                       check + CI hook
team fit          works for solo — I remember to       essential for any team — no
                  revisit on prompt edits              individual is the doc-keeper
drift cost        real — silent until a reader        zero — drift is caught
                  trusts the doc and is wrong          immediately
false-positive    none                                 hash changes on whitespace tweak
risk                                                   in the prompt; CI noise unless
                                                       hash is whitespace-normalized
phase-A fit       YAGNI is the right answer for       ship the day I have a teammate
                  solo dev
honest framing    real fragility I'd rather name      shipping it before need is
                  than hide                            premature; shipping it after
                                                       drift bites is too late
```

### One-line anchors
- "Five chains, five jobs — four JSON contracts plus one markdown contract."
- "Sonnet for output quality, Haiku for cheap labels. The model mirrors the value."
- "Caption is the most user-visible artifact — that's why its prompt is the most opinionated."
- "The doc is a snapshot. The prompt files are the truth."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the per-feature shape from memory (5 features × pattern × why). Label every column.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the five AI features to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → name all 5 chain files, plus the model used for each
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

List the 5 features and the model used for each. Then explain why classify uses Haiku/4o-mini while expand and interpret use Sonnet/4o, given that classify is per-todo (high-volume) while interpret is per-tap (user-controlled). What's the per-call cost asymmetry, what's the per-call output volume asymmetry, and what's the role of the `MAX_CONCURRENT = 3` cap on expand specifically? Why does classify NOT have a similar cap, and why does interpret not need one either?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/summarize.ts`, `src/services/ai/caption.ts`, `src/services/todos/classify.ts`, and `src/services/todos/expand.ts` (especially L25 for `MAX_CONCURRENT`) to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/caption.ts:SYSTEM_PROMPT` L24–L100 (the most opinionated prompt, validated by `parseAndValidate`) to support what exists
→ Point to where a snapshot test that hashes SYSTEM_PROMPT constants and fails CI on undocumented changes would land (a new `src/services/ai/__tests__/prompt-snapshot.test.ts` plus a CI step) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — features grew from 4 to 5 (added Interpret); thinking-mode taxonomy reduced from 7 to 5; expand types reduced from 6 to 4. See `14-interpret.md` for the new chain.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block; bumped Level 1/Level 2/[arch] interview-Q wording 4→5 features; added caption persistence-key mapping (`detectedTheme` → `summary_json.variantsTheme` at summarize.ts:91–92; `variants` is pass-through to `summary_json.variants`) plus the buildCaptionInput input-assembly note.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk, raw fetch to OpenAI, @supabase/supabase-js.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: renamed `## Features overview` to `## How it works`; added Move 1 mental-model opening (recipe-binder metaphor with frontend bridge to typed useMutation hooks); added 2 layered sub-sections — persisted vs ephemeral split, two-tier Sonnet/Haiku model split — each with frontend bridges and concrete consequences; closed with principle paragraph on naming AI features and one-pattern-per-feature.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (small-kitchen-five-recipe-binder scenario → "five named recipes, each with prompt+model+contract+UI place" pattern naming → bolded stakes pivot to all five chains anchored to `summary_json.variants`, `todo_meta.type`, `todo_meta.expanded_md`, `classifier_confidence`, and the Sonnet/Haiku tier split → before/after bullets on undocumented vs catalogued → one-line "every AI feature has a named page" metaphor).
