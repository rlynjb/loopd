# Prompt chaining

**Industry name(s):** Prompt chaining, multi-step LLM pipeline, sequential chains
**Type:** Industry standard · Language-agnostic

> The summarize chain runs first and produces structured editor data; the caption chain runs second, taking the day's content and the prior 5 captions to write four tonal variants.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [13-ai-summary-variant-generation (DSA)](../02-dsa/13-ai-summary-variant-generation.md) · → [18-forbidden-patterns-rotation](./18-forbidden-patterns-rotation.md)

---

## Why care

You write a prompt that needs to do two things at once: produce a structured object AND a human-feeling sentence about the same input. The model can do both, but neither comes out as cleanly as when you ask for one. The structured output drifts toward chatty; the chatty output drifts toward bullet-pointy. The prompt that tried to be two prompts becomes one mediocre prompt.

Prompt chaining splits a multi-job task across two or more LLM calls, each with one job. It belongs to the family of "compose small things rather than build one big thing" patterns alongside pipe in shell, the middleware chain in Express, function composition in functional programming — wherever a single transformation grows too complex, decomposing it into sequential stages makes each stage debuggable. The same pattern shows up in image-to-image pipelines (segment → mask → fill), in compiler stages (lex → parse → optimize → emit), in ETL (extract → transform → load). Here's how that actually works in this codebase.

---

## How it works

A two-station kitchen line. Station one chops the vegetables and weighs the ingredients; station two takes those measured ingredients and turns them into a finished plate. Each station has one job; each plate is the same dish whether it goes through both stations or one. Two operations welded together in a single prompt (extract structure AND write voice) split apart into two stations with one job each.

### Step 1 — `summarize()` produces structured editor data

The first chain is `summarize(date)` in `summarize.ts` L42–L105. It reads the day's entries from SQLite, builds a prompt that asks for a structured `AISummary` object (headline, summary, mood, clipOrder, clipTrims, textOverlays, filterPreset), calls Claude or OpenAI, parses the JSON, and validates against the typed contract. If you're coming from frontend, this is the same shape as the first step of a multi-step form — you collect the structured data first, before you ask the user to write any free-text fields. Practical consequence: the editor needs `clipOrder` and `mood` to start composing the vlog video; those fields exist after this call regardless of whether step 2 succeeds. Boundary: this call is the load-bearing one — if it fails, the chain stops. Step 2 is best-effort.

### Step 2 — `generateCaption()` produces 4 tonal variants

The second chain is `generateCaption(captionInput)` in `caption.ts` L201–L223. It runs *inside* `summarize()` at L87–L96 — after step 1's `summary` object has been validated. It takes the day's raw log + the mood from step 1 + the last 5 captions for rotation, calls the LLM with a different system prompt (the 4-voice prompt at `caption.ts` L24–L100), and returns four variants + a detected theme. If you're coming from frontend, this is the shape of a follow-up RPC that runs once the user has confirmed the form data — a second-stage call shaped by the first stage's output. Practical consequence: the caption call sees what the summary call extracted, so the four variants describe the same day the structured summary describes. Boundary: this call is best-effort; failures don't fail the parent chain. If the caption call throws, the editor falls back to the structured summary's `summary` field as the text overlay.

### The hand-off — what step 2 sees from step 1

The `buildCaptionInput` helper in `summarize.ts` L111–L163 is the seam. It takes `entries` (the same input step 1 saw), `summary.mood` (the output of step 1), and assembles a `CaptionInput` shape: `{ date, rawLog, recentCaptions, mood: moodLabel, themeHint: null }`. The `mood` is the most interesting field — step 2 doesn't re-derive it; it inherits it. Practical consequence: the four caption variants are constrained by the mood step 1 already chose. If step 1 picked `mood='flat'`, step 2 writes flat-feeling captions. The chain consistency is enforced by passing the mood through, not by asking step 2 to re-classify it. Boundary: if step 1 misclassifies mood, step 2 inherits the misclassification.

### Why two calls instead of one — the actual win

A single prompt asking for both structured fields AND four tonal variants would carry a system prompt 150+ lines long. Worse, the model's attention would split: the structured JSON shape and the four variant voices compete for the same context budget. The two-chain split lets each call be focused: step 1's system prompt (`prompt.ts` L4–L27) is 23 lines and only talks about JSON shape + tone rules; step 2's system prompt (`caption.ts` L24–L100) is 77 lines and only talks about the four variant voices + forbidden patterns + rotation. If you're coming from frontend, this is the same shape as a single big component vs two focused components — `Form` that does layout, validation, submission, AND rendering becomes `<FormProvider>` + `<FormFields>` + `<FormSubmit>`, each with one responsibility. Practical consequence: each chain is independently debuggable. If captions are bad, you check `caption.ts`; if structured data is wrong, you check `prompt.ts`. The blast radius is one chain.

### Move 2.5 — How the chain evolved

**Phase A (pre-2026-05-08):** `summarize` was a single call that returned the structured editor data + a single `caption` string in the same JSON object. The chain was one stage.

**Phase B (2026-05-08 onward):** the caption became four tonal variants and the prompt for "four tonal variants" got long enough that bundling it with the structured editor prompt would have exceeded what fits cleanly in one system prompt. The chain split into two calls — summarise first, caption second.

**What didn't have to change:** the storage layer. Both `caption` (legacy single string) and `variants` (the new 4-variant object) live on the same `summary_json` blob in `ai_summaries`. The two-stage chain produces the same shape the single-stage chain produced; the validator (`validate.ts:validateSummary`) round-trips both old and new shapes. The architectural payoff: splitting one chain into two didn't require a schema change, didn't require a migration, didn't change any caller. The change was contained to `summarize.ts` and `caption.ts`.

This is what people mean by "small focused stages beat big general-purpose stages." Each stage is something the model is good at when asked nothing else; chaining them is something your code is good at. Separation of concerns at the LLM layer, the same way it works at every other layer. The full picture is below.

---

## Prompt chaining — diagram

```
                The two-stage caption pipeline

  ┌─ Caller (e.g. editor screen, after the day's entries exist) ─┐
  │   const { summary } = await summarize('2026-05-11')           │
  └────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
  ┌─ Stage 1: summarize() — structured editor data ───────────────┐
  │                                                               │
  │  src/services/ai/summarize.ts L42–L105                        │
  │                                                               │
  │  buildPrompt(entries, clips, habits, date)                    │
  │   → system: "produce structured vlog summary JSON"            │
  │   → user:   entries + clips + habits                          │
  │                                                               │
  │  callClaude / callOpenAI                                      │
  │   → text response                                             │
  │                                                               │
  │  validateSummary(parsed)                                      │
  │   → AISummary { headline, summary, mood, clipOrder,           │
  │                 clipTrims, textOverlays, filterPreset }       │
  └────────────────────────┬──────────────────────────────────────┘
                           │  summary.mood (and more)
                           │
                           ▼
  ┌─ Hand-off: buildCaptionInput(date, entries, summary.mood) ────┐
  │                                                               │
  │  src/services/ai/summarize.ts L111–L163                       │
  │                                                               │
  │  Assemble CaptionInput {                                      │
  │    date,                                                      │
  │    rawLog,           ← derived from entries (same input)      │
  │    recentCaptions,   ← last 5 captions from DB                │
  │    mood: moodLabel,  ← INHERITED from stage 1                 │
  │    themeHint: null                                            │
  │  }                                                            │
  └────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
  ┌─ Stage 2: generateCaption() — 4 tonal variants ───────────────┐
  │                                                               │
  │  src/services/ai/caption.ts L201–L223                         │
  │                                                               │
  │  buildUserPrompt(captionInput)                                │
  │   → system: "generate 4 tonal variants + theme"               │
  │   → user:   rawLog + mood + recentCaptions rotation block     │
  │                                                               │
  │  callClaude / callOpenAI                                      │
  │   → text response                                             │
  │                                                               │
  │  parseAndValidate(text)                                       │
  │   → CaptionVariantOutput {                                    │
  │       variants: { clean, smoother, reflective, punchy },      │
  │       detectedTheme                                           │
  │     }                                                         │
  └────────────────────────┬──────────────────────────────────────┘
                           │  graceful failure: try/catch → log + continue
                           ▼
  ┌─ Merge — summary.variants = captionOut.variants ──────────────┐
  │                                                               │
  │  src/services/ai/summarize.ts L90–L93                         │
  │                                                               │
  │  if (captionOut) {                                            │
  │    summary.variants = captionOut.variants                     │
  │    summary.variantsTheme = captionOut.detectedTheme           │
  │  }                                                            │
  └────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
                  upsertAISummary(date, JSON.stringify(summary), model)
                           │
                           ▼
                  Returned to caller
```

---

## In this codebase

**Chain orchestrator (the two-call sequencer):**
**File:** `src/services/ai/summarize.ts`
**Function / class:** `summarize(date)` — runs stage 1, then `generateCaption()` for stage 2 in the inner try/catch.
**Line range:** L42–L105 overall; L87–L96 is the stage-2 invocation.

**Stage 1 — structured editor data:**
**File:** `src/services/ai/prompt.ts` + `src/services/ai/summarize.ts`
**Function / class:** `buildPrompt` (prompt) + `callClaude`/`callOpenAI` + `validateSummary` (parse/validate)
**Line range:** `prompt.ts` L4–L58; `summarize.ts` L12–L40 (call) + L68–L78 (parse/validate)

**The hand-off (assembles stage 2's input from stage 1's output):**
**File:** `src/services/ai/summarize.ts`
**Function / class:** `buildCaptionInput(date, entries, mood)`
**Line range:** L111–L163

**Stage 2 — 4 tonal variants:**
**File:** `src/services/ai/caption.ts`
**Function / class:** `generateCaption(input)` — internal `callClaude`/`callOpenAI` + `parseAndValidate`
**Line range:** L201–L223 (entry point); L123–L154 (calls); L169–L199 (parse/validate)

---

## Elaborate

### Where this pattern comes from
Prompt chaining was named in the early LangChain documentation (2022–2023) but the pattern predates LLMs. Pipe operators in Unix (`grep | sort | uniq -c`), function composition in functional languages (`f >> g >> h`), the middleware pattern in HTTP servers — all formalize "compose small stages, run them in order, hand the output of one as input to the next." LLMs adopted it once practitioners discovered that single-prompt mega-chains drift more than single-purpose chains run in sequence. The first widely-cited use was OpenAI's own "summarize then translate" cookbook (~2023); the pattern has been industry standard since.

### The deeper principle
**Each stage gets less ambitious; the chain as a whole gets more reliable.** A prompt asked to do two things produces output worse than two prompts each asked to do one. The reason isn't the model's capacity — it's the attention budget. The model has finite context-window attention, and asking it to balance two goals in one call divides that attention. Two calls double the API cost but each call gets the full attention budget for one focused task. The reliability gain almost always exceeds the cost gain.

### Where this breaks down
- **Latency-sensitive paths** — chains are sequential. Two stages take ~2× the latency of one. For real-time UIs (chat), this is the main reason to prefer one well-tuned chain over two focused ones.
- **State-heavy hand-offs** — if stage 2 needs everything stage 1 saw plus everything stage 1 produced, the user message for stage 2 carries the world. The token cost compounds quickly.
- **Strongly coupled goals** — if the two "jobs" share more state than they separate, the artificial split forces the system to serialize what could be one decision. Example: classifier + per-type expansion can be two chains, but only because the classifier output is small (single enum value) and the expansion only depends on that enum.
- **More than ~3 stages** — three chains is usually the practical limit. Past that, the orchestration overhead (error handling per stage, intermediate state to track, debug paths to verify) outpaces the per-stage reliability gain.

### What to explore next
- [Single-purpose chains](./02-single-purpose-chains.md) → the principle that each stage in this chain follows.
- [AI summary variant generation](../02-dsa/13-ai-summary-variant-generation.md) → the DSA-side view of stage 2 (multi-output prompt fan-out).
- [Failure modes](./11-failure-modes.md) → why stage 2 fails gracefully without failing the chain.

---

## Tradeoffs

The codebase uses a 2-stage chain for the summary-then-caption flow. The cost is double the API call latency and roughly double the cost; the win is each chain is focused and debuggable.

### Comparison table — both costs in one frame

```
┌────────────────────┬────────────────────────────┬────────────────────────────┐
│ Cost dimension     │ Path taken (2-stage chain) │ Alternative (single mega-  │
│                    │                            │ chain returning both)      │
├────────────────────┼────────────────────────────┼────────────────────────────┤
│ API calls per      │ 2                          │ 1                          │
│  generation        │                            │                            │
│ Total latency      │ ~2–4s (sequential)         │ ~1.5–2.5s (single call,    │
│                    │                            │ longer output)             │
│ API cost per       │ ~$0.012 (Sonnet)           │ ~$0.008 (Sonnet)           │
│  generation        │                            │                            │
│ System prompt      │ 23 lines (stage 1) +       │ ~120+ lines combined       │
│  length            │ 77 lines (stage 2)         │                            │
│ Failure isolation  │ stage 2 can fail without   │ one failure fails the      │
│                    │ failing stage 1            │ whole generation           │
│ Per-stage          │ each stage has a focused   │ debugging output requires  │
│ debuggability      │ prompt and a focused       │ understanding both jobs    │
│                    │ validator                  │ in one prompt              │
│ Output coherence   │ stage 2 inherits mood from │ both fields produced       │
│ (mood ↔ caption    │ stage 1 — forced coherence │ together — natural         │
│  tone)             │ via hand-off               │ coherence (sometimes)      │
│ Mid-flow editing   │ users can regenerate just  │ regenerating one field     │
│                    │ captions without re-running│ re-runs the whole prompt   │
│                    │ the summary                │                            │
└────────────────────┴────────────────────────────┴────────────────────────────┘
```

### What we gave up

We pay 2× the latency and roughly 1.5× the API cost per summary generation. For a daily-generation app with low traffic that's pennies per user per month — invisible at solo scale. The user-visible cost is the ~1–2 seconds of additional waiting after the structured summary returns; today the editor shows the structured summary immediately and the caption variants arrive a beat later. That UX is fine for a daily action.

We gave up the ability to have the caption affect the structured summary. Today the chain is one-way: mood flows from stage 1 to stage 2, not the reverse. If stage 2 generates four caption variants and notices the day's content actually feels more `discipline` than the `flat` mood stage 1 picked, there's no way to propagate that back. The structured `mood` field is the only mood the editor sees; the `detectedTheme` from stage 2 is informational, not authoritative.

We gave up bundled error handling. Today stage 1 failing fails the chain; stage 2 failing degrades the chain to "no variants today." If both failures shared one call, we'd handle them once. With two calls, the error paths fork at two points: `summarize.ts` L101–L104 (stage 1 throw) and L94–L96 (stage 2 throw). The total branching is small (3 paths total) but real.

### What the alternative would have cost

If we had used a single mega-chain, the system prompt would be ~120+ lines and every change to one job's behaviour would risk regressing the other. A new tonal voice for captions would mean editing a prompt that also defines `clipTrims` validation; a tweak to the `mood` enum would mean editing a prompt that also defines the four caption voices. The chain would be cheaper per call but more expensive per change. Given that we ship prompt changes more often than we ship user-visible features, the per-change cost outweighs the per-call cost.

If we had used three stages (summarize → mood-refine → caption), the chain would be more "correct" by some metric but the latency and complexity would compound. Two stages is the empirically right number for this feature; one is too few, three is too many.

### The breakpoint

Fine until the chain grows past two stages. The day the caption stage needs to be split further (e.g., "decide theme" + "write variants in that theme" as two separate calls), the orchestration cost of three stages becomes visible: more places for errors to occur, more intermediate state to log, more "did this stage run?" questions when debugging. The fix at that point isn't fewer stages — it's better orchestration tooling (a typed pipeline DSL, structured logs per stage, retry policies per stage).

Also fine until per-call latency becomes UX-critical. The current chain runs once per day per user; even 4 seconds total is fine. The day this chain runs on every keystroke (it doesn't, and shouldn't, but for argument's sake), the 2-stage shape would need to collapse to 1.

### What wasn't actually a tradeoff

"Run both stages in parallel" was never a real option. Stage 2 takes `mood` as input from stage 1's output; parallelisation would mean stage 2 either guessing the mood (defeating the inheritance) or running with no mood input (degrading the caption's tonal grounding). The sequential dependency is in the data, not the implementation.

---

## Tech reference (industry pairing)

### In-code sequential chaining (the await pattern)

- **Codebase uses:** plain `await` in `summarize.ts` L88–L89 — `await buildCaptionInput(...)` → `await generateCaption(captionInput)`. No DSL, no framework.
- **Why it's here:** the simplest possible chaining shape — sequential `await`s in a function body. No state machine, no chain abstraction, no graph.
- **Leading today:** plain `async/await` chaining — `adoption-leading` for two-three stage chains in production code, 2026.
- **Why it leads:** zero framework cost, every TS engineer reads it without docs, error handling is plain try/catch at each step. The dominant shape for simple chains.
- **Runner-up:** Vercel AI SDK / LangChain LCEL (LangChain Expression Language) — `innovation-leading` for 4+ stage chains with retry / fallback / parallel branches. Adds a DSL the chain author has to learn; pays off when chain count gets high.

### Per-stage system prompts (focused jobs)

- **Codebase uses:** distinct `SYSTEM` / `SYSTEM_PROMPT` constants per chain file — `prompt.ts` L4 (summarize), `caption.ts` L24 (caption), `classify.ts` L12 (classify), `interpret.ts` L19 (interpret), `expand.ts` (5 per-type prompts).
- **Why it's here:** each chain owns its system prompt; no shared prompt template; each can be tuned independently.
- **Leading today:** per-chain system prompts colocated with the call site — `adoption-leading` for small chain counts, 2026.
- **Why it leads:** the prompt is right next to the validator that consumes its output and the call shape that sends it; everything you need to understand one chain lives in one file.
- **Runner-up:** prompt-template files in a shared directory (e.g. `prompts/`) — `adoption-leading` for >10 chain codebases; centralization helps once you have shared prompt components (e.g., a shared role-of-loopd preamble) to extract.

---

## Summary

Prompt chaining splits a multi-job LLM task across two or more focused calls run in sequence. In this codebase, the summary-then-caption flow is the canonical example: `summarize(date)` produces a structured `AISummary` object (headline, mood, clipOrder, …) in stage 1; `generateCaption(captionInput)` produces four tonal variants + a detected theme in stage 2. The hand-off is `buildCaptionInput(date, entries, summary.mood)` — stage 2 inherits the mood from stage 1, ensuring the captions and the structured editor data agree on the day's emotional shape. The constraint that shaped this is that a single mega-prompt for both jobs was ~120+ lines and the model's attention split between the two; two focused prompts each get their full attention budget. The cost is 2× latency and ~1.5× API spend per generation; the win is two independently-debuggable chains and graceful failure on the caption stage without losing the structured editor data.

Key points to remember:
- Sequential — stage 2 waits on stage 1; mood flows from stage 1 to stage 2 via `buildCaptionInput`.
- Stage 1 is load-bearing (failure fails the chain); stage 2 is best-effort (failure degrades to "no variants today").
- Each stage has its own system prompt, its own validator, its own call site — co-located by chain.
- The orchestrator is plain `async/await` in `summarize.ts`; no chain framework involved.
- Splitting one chain into two doesn't require a schema change — both shapes round-trip through `validateSummary`.

---

## Interview defense

### What an interviewer is really asking
Prompt chaining is the test of whether the candidate understands "compose small things" at the LLM layer. The instinct of a new LLM dev is to write one prompt that does everything; the instinct of someone who's shipped is to break it into stages. The interviewer wants to hear evidence that you've felt the pain of single-prompt drift and built the split that fixes it. Bonus: do you know when chaining is the wrong move (real-time UIs, parallel-friendly jobs)?

### Likely questions

[mid] Q: Walk me through the summarize-to-caption flow.

A: `summarize(date)` reads the day's entries from SQLite, runs the structured-summary chain with the `prompt.ts:SYSTEM` system prompt, gets back JSON with fields like `headline`, `mood`, `clipOrder`. `validateSummary` narrows it to the `AISummary` type. Then inside the same function, `buildCaptionInput(date, entries, summary.mood)` assembles a `CaptionInput` shape carrying the day's raw log + the inherited mood + the last 5 captions for rotation. `generateCaption(captionInput)` runs the 4-variant chain with the `caption.ts:SYSTEM_PROMPT`, returns four tonal variants + a detected theme. The variants get merged onto the summary object at L90–L93. Final shape persists to `ai_summaries` with both the structured editor data and the variants on the same row.

```
[summarize-to-caption flow]

  summarize(date)
       │
       ▼
  buildPrompt + callClaude/OpenAI → text
       │
       ▼
  validateSummary(parsed) → AISummary (mood, clipOrder, ...)
       │
       ▼
  buildCaptionInput(date, entries, summary.mood)
       │
       ▼
  generateCaption(input) → CaptionVariantOutput
       │
       ▼  merge: summary.variants = captionOut.variants
       │
       ▼
  upsertAISummary(date, JSON.stringify(summary), model)
```

[senior] Q: Why split this into two calls instead of one mega-chain?

A: Attention budget. A single prompt for both jobs would be ~120+ lines — 23 lines for the structured-summary shape plus 77 lines for the four-voice caption prompt plus the rotation block. The model's attention divides across both jobs and neither comes out as good as when asked alone. The split also lets each chain be debugged in isolation: bad captions are a `caption.ts` problem, bad clipTrims are a `prompt.ts` problem. The cost is 2× latency and ~1.5× spend, which for a daily-generation app is invisible. If captions were generated per-keystroke I'd reconsider.

```
                Path taken (2-stage chain)             Alternative (single mega-chain)
                ──────────────────────────────         ──────────────────────────────
system prompt   23 + 77 lines (each focused)           ~120+ lines (mixed jobs)
attention       full budget per job                    split across both jobs
output quality  each stage gets its A-game             both stages get B-game
debug surface   2 files, 2 validators                  1 file, 1 mega-validator
failure         stage 2 can fail without              one failure kills both
isolation       failing stage 1
latency         2× sequential                          1×
cost            ~1.5× API spend                        1×
ship cadence    can tune one stage without            any change risks the other
                touching the other
```

[arch] Q: How does this chain handle failure?

A: Two layers. Stage 1 (`summarize`) is load-bearing — if `callClaude`/`callOpenAI` throws, the whole `summarize()` function returns `{ summary: null, error: msg }` and the caller (the editor) shows "AI is unavailable, try again." Stage 2 (`generateCaption`) is wrapped in its own try/catch inside `summarize()` at L87–L96; if it throws, the parent function logs a warning and continues with the structured summary minus the variants. The editor's text-overlay code (`compose.ts`) reads variants first, falls back to the legacy single `caption` field, and finally falls back to `summary.summary` (the structured prose). Graceful degradation at three layers. The trade is more error-handling code (3 paths total) for a feature that keeps working when half of it is broken.

```
At chain-failure time:

  ┌─ summarize() outer try/catch ──────────────────┐
  │ stage 1 throws → return { summary: null, error }│
  │                  → caller shows "AI unavailable"│
  └─────────────────────────────────────────────────┘  ◀── load-bearing
                            │
  ┌─ inner try/catch around generateCaption ───────┐
  │ stage 2 throws → console.warn + continue        │
  │                  → summary persisted without     │
  │                    variants                      │
  └─────────────────────────────────────────────────┘  ◀── best-effort
                            │
  ┌─ Editor's compose.ts fallback chain ───────────┐
  │ summary.variants[picked]                        │
  │   → summary.caption (legacy)                    │
  │     → summary.summary (structured prose)        │
  └─────────────────────────────────────────────────┘  ◀── three layers
                                                          deep, never
                                                          shows "nothing"
```

### The question candidates always dodge
Q: Stage 2 inherits `mood` from stage 1, but what if stage 1 picks the wrong mood? Doesn't that propagate the error?

A: Yes — and that's a real cost I'd own. Stage 1's `mood` is one of five enum values picked by the LLM from the day's text + clips + habits. It's right most of the time; it's wrong some of the time. When it's wrong, stage 2 writes four captions in the wrong tone — `flat` captions on what was actually a `fired` day. The user notices because the variants feel off. The fix in the current chain shape is to let the user override mood in the editor and regenerate captions with the override; today, the override path exists for the structured summary but the regenerate-captions-only path doesn't — clicking "regenerate" re-runs the whole chain. The deeper fix would be a third stage: mood-refine that takes stage 1's mood and the user's edits and decides whether to keep or override. I haven't built it because the cost (third call, third validator, third failure mode) isn't worth it for what's currently a ~10% miss rate on a single-user app.

```
                Path taken (mood inheritance)          Alternative (3-stage with refine)
                ──────────────────────────────         ──────────────────────────────
stages          2                                      3
mood source     LLM in stage 1, inherited by 2         LLM in stage 1, refined in
                                                       stage 2 with user input,
                                                       used by stage 3
miss propagation when stage 1 misclassifies, stage     stage 2 can correct
                2 propagates the miss
user fix today  regenerate the whole chain             regenerate stage 3 only
miss rate       ~10% of generations                    near-zero (user gates)
ship cost       0 (already shipped)                    3rd chain + 3rd validator
                                                       + UI for the refine step
when to build   when daily generation grows past one   already worth it at moderate
                user                                   user count
```

### One-line anchors
- "Each stage gets less ambitious; the chain gets more reliable."
- "Two focused 23-line + 77-line prompts beat one 120-line prompt — attention is the budget."
- "Stage 1 is load-bearing; stage 2 is best-effort. Failure modes diverge intentionally."
- "Mood flows from stage 1 to stage 2 via the hand-off; consistency is enforced by passing, not re-deriving."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the two-stage caption pipeline from memory: caller → stage 1 → hand-off (with what's in the hand-off) → stage 2 → merge → persistence.

Open the file. Compare.

✓ Pass: your diagram names both stages, the hand-off function (`buildCaptionInput`), and what flows between (mood, recentCaptions, rawLog).
✗ Fail: re-read the "How it works" section, wait 10 minutes, try again.

### Level 2 — Explain it out loud
Explain prompt chaining to an imaginary colleague who just asked "why do you make two LLM calls when one prompt could in principle do both jobs?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific files? → `summarize.ts` (orchestrator + stage 1) and `caption.ts` (stage 2)
- Name the hand-off function? → `buildCaptionInput(date, entries, summary.mood)`
- Name the failure mode each stage is responsible for in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

You're adding a third stage to the chain — a "regenerate caption only" path that takes an existing `AISummary` (with mood already set) and a user-supplied `themeHint`, and returns new four variants. Walk what you'd reuse from the current chain (which functions, which validators) and what you'd add new. Specifically: where does the user override mood vs override theme, and how does the regenerate-only path skip stage 1 entirely?

Write your answer. Then open `src/services/ai/summarize.ts` L42–L105 and `src/services/ai/caption.ts` L201–L223 to verify your plan matches the existing call shape.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this feature today, would you split it into two chains or write a single mega-chain? Why or why not? What would the cost difference be?"

Reference the actual code:
→ Point to `src/services/ai/summarize.ts` L42–L105 + L111–L163 + `src/services/ai/caption.ts` L201–L223 to support the 2-stage approach
→ Point to where a single mega-chain would live (a fused `summarize.ts` with both system prompts concatenated) if you chose the alternative

There is no right answer. The point is specificity. "Two chains is more modular" is vague; "120 lines of system prompt in one call split the model's attention to where each output drifts by ~10%, while two 23+77-line prompts each get full attention" is specific.

### Quick check — code reference test
Without opening any files, answer:
- Which file holds the chain orchestrator?
- Which function is the hand-off between stages?
- What field does stage 2 inherit from stage 1's output?

Then open `summarize.ts` to verify.

✓ Pass: you named `summarize.ts` (orchestrator), `buildCaptionInput` (hand-off), and `mood` (inherited field).
✗ Fail: that's a sign this concept hasn't fully landed yet — re-read the "Stage 2 inherits the mood" sub-section.
