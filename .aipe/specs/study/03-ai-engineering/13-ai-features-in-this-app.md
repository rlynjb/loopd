# How this codebase uses AI specifically

**Industry name:** AI feature catalogue, per-feature pattern map
**Type:** Project-specific

> Per-feature: prompt shape, input, output. Five chains, each one-job — four emit JSON, one (interpret) emits markdown.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [03-context-window](./03-context-window.md) · → [04-provider-abstraction](./04-provider-abstraction.md) · → [08-validation-gate](./08-validation-gate.md)

---

## Quick summary
- **What:** five features — day summarize, 4-variant caption, todo classify, todo expand, interpret. Each maps to one chain in `src/services/ai/` or `src/services/todos/`.
- **Why here:** quick reference for the prompt shapes, input contracts, output JSON shapes (or markdown for interpret). Read this when you want to know "what does the model actually see for X?"
- **Tradeoff:** this is a snapshot — when prompts change, this file should be re-checked.

---

## Features overview

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

- **One chain per feature** — gives: clear contracts, independent failure. Costs: shared prompt logic must live in helpers.
- **Per-type expand sub-chains** — gives: each type can have a specific schema. Costs: 4 system prompts to maintain (was 6 pre-2026-05-10; bug/question/decision/content dropped).
- **No surrounding context for classify** — gives: cheap per-call. Costs: classify can't disambiguate based on context the user wrote in the same entry.
- **Interpret is markdown-out, not JSON-out** — gives: long-form prose the user reads, no schema to maintain. Costs: no structural validator beyond `cleanMarkdown` (11 lines); model drift shows up as visibly worse output, not as rejected calls.

---

## Interview defense

### What an interviewer is really asking
On the per-feature reference page, the interviewer is testing whether I can move from "I built five AI features" to "I can defend each prompt + input + output contract specifically". They want concrete details: what system prompt does caption use, what fields does validateExpansion check for 'idea' (or 'reflect', or 'study'), what's the model choice and why per chain, why interpret's contract is markdown instead of JSON. Hand-wavy "we summarise the day" answers fail this question.

### Likely questions

[mid] Q: Walk me through `caption.ts`'s SYSTEM_PROMPT — what does it actually constrain?
      A: It's the most opinionated prompt in the codebase. It defines four named voices (clean / smoother / reflective / punchy) with example body lines for each, plus universal rules: no "I"/"you"/"we", no hashtags, no questions, no platitudes. It takes `{ date, rawLog[], recentCaptions?, mood?, themeHint? }` as input and demands `{ variants: { clean, smoother, reflective, punchy }, detectedTheme }` — all four variants required; partial output is treated as malformed by `parseAndValidate`. The opinionation matters because caption output is the most user-visible AI artifact: bad voice consistency would be obvious every day. The 4-variant shape lets the user pick rather than locking them into one tone.

[senior] Q: Why Sonnet 4.6 for summarize/caption/expand but Haiku 4.5 for classify? Walk me through the model-choice reasoning.
         A: Cost and task complexity. Summarize, caption, and expand all produce ~1024-token structured JSON with real reasoning content — clip orderings, tonal voice variants, typed expansions with multiple required fields. Sonnet at ~$0.04/call earns its keep on output quality. Classify is a 7-class label problem with ~50 tokens out — Haiku 4.5 (or gpt-4o-mini on the OpenAI side) handles it cheaply. The cost asymmetry is roughly 50×: Sonnet calls are dollars per heavy day if I let them rip, Haiku calls are cents. The model choice mirrors the value asymmetry — caption quality matters per-day, classify accuracy matters per-todo and the heuristic already filters half.

[arch] Q: How would you redesign these five features if cost dropped 100× — say Sonnet at $0.0004/call?
       A: I'd merge less, not more. The current splits exist because of failure isolation (caption split out of summarize) and cost pressure (no surrounding context for classify). At 100× cheaper, I'd send classify the surrounding entry text — accuracy goes up at no real cost. I'd drop the heuristic gate because it stops paying back. I might add a new feature like "weekly synthesis" that today would be too expensive to run automatically. The single-chain shape stays — that's about debuggability and failure isolation, not cost — but the inputs grow.

### The question candidates always dodge
Q: Your "per-feature spec" reads like documentation — but documentation rots fast. How do you keep this in sync with the actual prompts in `caption.ts` and `expandPrompts.ts`?

A: I don't, automatically. The doc warns the reader at the top: "this is a snapshot — when prompts change, this file should be re-checked", and the truth lives in source. The honest answer is that doc drift is real and I haven't built tooling to prevent it. The two mitigations are: one, the prompt-shape summaries here are deliberately *abstract* — I describe what the prompt enforces, not the exact wording, so small phrasing tweaks don't break the doc; two, I point readers to read `caption.ts:SYSTEM_PROMPT` and `expandPrompts.ts:getSystemPrompt` directly because those are concrete and authoritative. If I were running a team, I'd add a snapshot test that hashes the SYSTEM_PROMPT constants and fails CI when they change without a doc update — forcing the conversation. Solo dev, I rely on remembering to revisit. That's a real fragility and I'd rather name it than pretend the doc is auto-true.

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
