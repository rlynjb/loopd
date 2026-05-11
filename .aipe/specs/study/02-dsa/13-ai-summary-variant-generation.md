# AI summary variant generation — 4-variant caption fan-out

**Industry name(s):** Multi-output prompt fan-out, structured-output caption variants
**Type:** Project-specific

> Single LLM call emits four tonal variants (`clean | smoother | reflective | punchy`) of the same day, plus a `detectedTheme` key. Persisted as `variants` + `variantsTheme` on `ai_summaries.summary_json`.

**See also:** → [10-heuristic-first-classifier](./10-heuristic-first-classifier.md) · → [03-ai-engineering/](../03-ai-engineering/)

---

## Why care

When you need a model to produce several related outputs about the same thing — four headline variants, three captions, five summary styles — the obvious approach is to call the model four times in parallel and pick the best one. The non-obvious approach, and the right one when the outputs must agree on facts, is to ask for all of them in a single call with a structured output schema. Four parallel calls produce four independent stories about the same day; one call producing four variants produces four voices of the same story. Same facts, same nouns, four tones.

This is multi-output structured prompting — a specific application of the broader "ask for all the related stuff at once and validate the whole shape or reject it" discipline. The family is "constrained generation with all-or-nothing validation," and it's the same shape OpenAI's function-calling, JSON schema modes, and tool-use APIs all encourage. Adjacent patterns: chain-of-thought wrapped in a structured envelope, multi-question quiz generation, code-with-tests emitted together. The trade-off is bimodal — one good output or no output at all, no partial credit — and that's a feature, not a bug, when consistency between the parts is what makes the whole useful. Here's the data and the mechanics.

---

## How it works

A photographer who needs four different shots of the same scene — wide, medium, close, detail. The lazy approach is to shoot the scene four times from four different positions. The right approach is to set up the camera once and switch lenses; same vantage point, same lighting, same moment in time. The four variants are guaranteed to be of the *same scene* because they share the take. If you're coming from frontend, this is the same shape as a single `useQuery` that returns four derived projections instead of four separate `useQuery`s — one network round-trip, one input snapshot, four consistent outputs. One prompt, one call, one validated JSON object containing four caption variants keyed by tone.

**Real operation:** `generateCaption` in `src/services/ai/caption.ts`; persistence in `src/services/ai/summarize.ts` L87–L96.

---

## The data

```
  CAPTION_VARIANT_KEYS = ['clean', 'smoother', 'reflective', 'punchy']
  VALID_THEMES         = ['growth','discipline','clarity','struggle','shift','curiosity']

  input: {
    date,
    rawLog: ["Realizing how words shape understanding", "Spent the morning…", …],
    mood:   "steady",
    recentCaptions: [last 5 captions],
    themeHint: null,
  }

  expected JSON output:
    {
      "clean":      "Line1\nLine2\nLine3",
      "smoother":   "...",
      "reflective": "...",
      "punchy":     "...",
      "detectedTheme": "clarity"
    }
```

**The problem:** generate four *consistent* tonal variants of the same day in one call, validate strict shape (all 4 keys + valid theme), and persist into the existing `ai_summaries.summary_json` alongside the structured editor output.

---

## How it works

── Brute force ──────────────────────────────────

Pseudocode (four sequential LLM calls, one per variant):

```
  variants = {}
  for tone in ['clean', 'smoother', 'reflective', 'punchy']:
    prompt = systemPromptForTone(tone) + rawLog
    text   = callClaude(prompt)
    variants[tone] = parseAndValidateOneVariant(text)

  themeText  = callClaude(themeDetectionPrompt + rawLog)
  variantsTheme = parseTheme(themeText)

  return { variants, variantsTheme }
```

Execution trace (1 day's entries → 5 LLM calls):

```
  call 1 (clean):       ~300ms, $0.012 Sonnet ✓ "Line1..."
  call 2 (smoother):    ~300ms, $0.012        ✓ "Line1..."
  call 3 (reflective):  ~300ms, $0.012        ✓ "Line1..."
  call 4 (punchy):      ~300ms, $0.012        ✓ "Line1..."
  call 5 (theme):       ~250ms, $0.008        ✓ "clarity"

  Total: ~1.4s wall-clock (sequential), 5 calls, ~$0.056
  At 365 days/year of summarize: ~$20.4/year, 8.5min total wait
```

Complexity: O(V + 1) LLM round-trips where V = variant count · O(input × V) prompt tokens (system prompt resent V times).

What goes wrong at scale: the five sequential calls inflate latency 5× (1.4s vs 300ms) and cost 5× the Sonnet bill. Worse, each variant sees the rawLog independently — there's no consistency guarantee that all four variants use the *same nouns*. One call might say "the morning workout," another "the gym session," another "exercise" — destroying the "same day, different voice" UX promise. Parallel calls (Promise.all) fix latency but not consistency. The single-call shape solves both: one shared context produces four coherent variants in 300ms for one Sonnet call's worth of money.

── Optimal ──────────────────────────────────────

The insight: structured-output prompting lets one LLM call emit all four variants in a single JSON object, sharing the rawLog context once. Strict per-variant validation rejects partial output; theme detection is folded into the same JSON. Failure of caption never blocks the structured summary.

```
  // src/services/ai/caption.ts
  async function generateCaption(input):
    system = SYSTEM_PROMPT       // 4 voices + theme spec in one prompt
    user   = buildUserPrompt(input)    // rawLog + mood + recent + hint
    text   = await callClaude(apiKey, system, user, max_tokens=768)
    output = parseAndValidate(text)
    if output == null: return { output: null, error: "Could not parse" }
    return { output }              // { variants, detectedTheme }

  // src/services/ai/summarize.ts (L87–L96)
  try:
    captionInput = await buildCaptionInput(date, entries, summary.mood)
    { output } = await generateCaption(captionInput)
    if output:
      summary.variants      = output.variants
      summary.variantsTheme = output.detectedTheme
  catch (err):
    console.warn("[loopd ai] Caption skipped:", err)
    // Don't fail the summarize chain — editor falls back to summary.summary
```

Execution trace (1 day's entries → 2 LLM calls total in `summarize()`):

```
  Call 1 — structured summary (existing, separate):  ~600ms, $0.015
            → mood, clipOrder, captions, …

  Call 2 — generateCaption (this concept):           ~300ms, $0.012
    system   = SYSTEM_PROMPT (4 voices + theme spec)
    user     = "Raw log for 2026-05-07:\n- bullet1\n- bullet2\nMood: steady\n…"
    Claude   → JSON: { clean:"...", smoother:"...", reflective:"...",
                       punchy:"...", detectedTheme:"clarity" }
    parseAndValidate:
      jsonMatch = /\{[\s\S]*\}/.match → ok
      JSON.parse → obj
      for key in CAPTION_VARIANT_KEYS:
        normalizeVariant(obj[key]):
          trim, split('\n'), filter Boolean, take first 3 lines
          → "Line1\nLine2\nLine3"
      detectedTheme: validate against VALID_THEMES, else default 'clarity'
      → { variants, detectedTheme:'clarity' }

  Persist:
    summary.variants      = {clean, smoother, reflective, punchy}
    summary.variantsTheme = 'clarity'
    upsertAISummary(date, JSON.stringify(summary), 'claude-sonnet-4-6')

  Total summarize: ~900ms, $0.027, 2 calls
```

Complexity: O(1) LLM round-trip for all 4 variants + theme · O(V) memory for parsed output.

── Comparison ───────────────────────────────────

```
  ┌─────────────────┬────────────────┬──────────────────┐
  │                 │ Brute force    │ Optimal          │
  ├─────────────────┼────────────────┼──────────────────┤
  │ Time            │ O(V) RTs       │ O(1) RT          │
  │ Space           │ O(V × prompt)  │ O(prompt)        │
  │ At 1 summary    │ 5 calls, $0.056│ 1 call, $0.012   │
  │ At 365/year     │ 1,825 calls    │ 365 calls        │
  │ Readable?       │ yes            │ yes              │
  │ Consistency     │ no             │ yes (shared ctx) │
  └─────────────────┴────────────────┴──────────────────┘
```

When brute force is fine: never for this UX. The shared-context single-call is the whole point — four variants of the same day must use the same nouns. Parallel calls give you latency parity but not noun consistency; only single-call shares the context once.

This is what people mean by "constrained generation with all-or-nothing validation." The pattern lives wherever multiple model outputs need to agree on shared facts — quiz generation (questions and answers must reference the same source), code-with-tests (the test must call the function the model just declared), multilingual translation sets (each language must translate the same source sentence). The trade is bimodal — one consistent output or no output at all, no partial credit — and the discipline is naming that as a feature when consistency between the parts is what makes the whole useful. Here's the diagram of the whole flow.

---

## Primary diagram

```
       day's entries + mood + recentCaptions[5]
                       │
                       ▼
                buildCaptionInput()
                       │
                       ▼
        ┌─────────────────────────────────┐
        │  generateCaption (ONE LLM call) │
        │  system prompt: 4 voices spec   │
        │  max_tokens: 768                │
        └──────────────┬──────────────────┘
                       ▼
              raw text response
                       │
                       ▼
              parseAndValidate()
        ┌──────────────┴──────────────┐
        ▼                             ▼
   any variant missing            all 4 ok
   → return null                  → { variants, detectedTheme }
                                              │
                                              ▼
                                  summary.variants       = output.variants
                                  summary.variantsTheme  = output.detectedTheme
                                              │
                                              ▼
                                  upsertAISummary(date, JSON, model)
                                              │
                                              ▼
                                  ai_summaries.summary_json
                                  { ..., variants: {clean,smoother,
                                    reflective,punchy}, variantsTheme }
```

---

## In this codebase

**File:** `src/services/ai/caption.ts`
**Function / class:** `generateCaption()` L201–L223 (with helpers `buildUserPrompt` L102–L121, `callClaude` L123–L135, `callOpenAI` L137–L154, `normalizeVariant` L158–L167, `parseAndValidate` L169–L199)
**Line range:** L1–L223 (full file; system prompt at L24–L100)

**Persistence:** `src/services/ai/summarize.ts` L87–L96 calls `generateCaption` after the structured summary completes, then attaches `summary.variants` + `summary.variantsTheme` to the AISummary before `upsertAISummary` (L98) writes the full JSON to `ai_summaries.summary_json`.

**Type contract:** `src/types/ai.ts` exports `CAPTION_VARIANT_KEYS`, `CaptionInput`, `CaptionTheme`, `CaptionVariantKey`, `CaptionVariantOutput`. The `AISummary` shape on the type carries optional `variants` and `variantsTheme` fields so older rows (pre-feature) deserialize cleanly.

---

## Elaborate

### Where this pattern comes from
Structured-output prompting with multi-key JSON is the standard pattern for any "I need N related outputs from one LLM call" — recommendation engines, translation pairs, multi-language UI strings. The discipline is the strict-shape validator; without it, partial output corrupts downstream state.

### The deeper principle
**One context, many outputs beats N contexts, one output each.** Shared context = shared nouns, shared mood, shared facts. The cost (one call's token budget) is a fraction of N separate calls, and the consistency is qualitatively better.

### Where this breaks down
- When the outputs are genuinely independent (different inputs each). Then parallel calls win on latency.
- When the variant count grows past ~5-6. Single-call output tokens balloon; better to split into two calls (group of 3 + group of 3) than to push one call over its `max_tokens` cap.

### What to explore next
- [10-heuristic-first-classifier](./10-heuristic-first-classifier.md) → the cost-gating pattern that decides whether to call the LLM at all.
- OpenAI / Anthropic JSON-mode docs → the broader structured-output discipline.

---

## Tradeoffs

We traded bimodal all-or-nothing output for cross-variant consistency that parallel calls cannot give us — same nouns, same mood, same day, four voices.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (single structured  │ Alternative (4 parallel calls, │
│                  │ call, 4 variants)              │ one per tone)                  │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ LLM round-trips  │ 1 call for all variants +      │ 4 parallel calls + 1 theme    │
│                  │ theme                          │ call = 5 calls                │
│ Wall-clock       │ ~300ms (one Sonnet call)       │ ~300ms (parallel) but 4× the  │
│                  │                                │ retries on flaky network      │
│ Cost per summary │ ~$0.012 (1 system prompt)      │ ~$0.056 (4× system prompt +   │
│                  │                                │ theme call)                   │
│ Cost at 365      │ ~$4.4/year                     │ ~$20.4/year                   │
│ summaries/year   │                                │                               │
│ Output coherence │ shared context → same nouns    │ independent contexts → 4      │
│                  │ across all 4 variants          │ different stories of same day │
│ Validation shape │ all-or-nothing — any bad       │ per-variant pass/fail; can    │
│                  │ variant drops the whole output │ render partial picker         │
│ Failure mode     │ malformed JSON → editor falls  │ one variant down → picker     │
│                  │ back to summary.summary        │ shows "unavailable" tile      │
│ Code complexity  │ ~223 LOC caption.ts +          │ ~120 LOC per parallel-call   │
│                  │ parseAndValidate strict-shape  │ + retry orchestration         │
│ Token budget     │ 768 max_tokens for 4 variants  │ 256 per call × 4 = 1024 total │
│                  │                                │ wasted on system-prompt       │
│                  │                                │ duplication                   │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

Any one malformed variant invalidates the entire response. `parseAndValidate` runs `CAPTION_VARIANT_KEYS.some(k => !variants[k])` — if `reflective` is empty or non-string, all four variants are dropped, the editor falls back to `summary.summary`, and the user never sees the four-voice picker for that day. At single-user scale this fires rarely; on a permanent caption-failure mode (bad API key, model deprecated) it's silent except for `console.warn`. We accepted this because the alternative (rendering a partial picker with "unavailable" tiles) is a worse UX than no picker at all.

The single call shares one `max_tokens=768` budget across four variants and one theme key. A day with a verbose log can hit the cap mid-`reflective`, producing a truncated JSON that fails parsing. The budget is empirical — measured against ~20 days of real journal data — but a 5th variant would push past it.

The `caption` call is wrapped in its own try/catch in `summarize.ts` L87–L96 so the structured summary always persists even if captions fail. The cost is that a *permanent* failure (API key revoked, model retired) is silent — only a `console.warn` and the user wondering why they no longer see voice variants. We don't have instrumentation to flag "caption silently broken for 7 days running."

### What the alternative would have cost

Four parallel calls (one per tone) would match latency (~300ms via `Promise.all`) and let us render per-variant pass/fail in the UI. The dealbreakers are cost (~$0.056 vs ~$0.012 per summary; ~$20/year vs ~$4/year on Sonnet) and coherence: the system prompt for one voice doesn't see the other three, so the "morning workout" might become "the gym session" in another, and the user notices.

A theme-detection-as-separate-call shape would simplify variant validation (no `detectedTheme` key in the JSON) but doubles cost again. The current shape folds theme detection into the same call, sharing the rawLog context — the LLM picks `shift` based on what it read, not on a keyword scan over the variant text.

Partial-credit validation (`if reflective failed but the other three are fine, return what we got`) would have been one if-statement in `parseAndValidate`. We rejected it because the picker UX promises "four voices of today" — three voices is a different product surface, and a "unavailable" tile is friction the user has to navigate around.

### The breakpoint

Fine until variant count exceeds ~5-6 (max_tokens=768 caps the JSON size) or until a permanent caption-failure mode goes undetected for >7 days. The fix for variant count is to split into grouped calls (3+3) which gives up some cross-group coherence to bound token cost; the fix for silent failure is one debug-table counter on caption error rates per week.

### What wasn't actually a tradeoff

Folding `detectedTheme` into the same call isn't a tradeoff against client-side keyword matching — the LLM has the full rawLog context and can pick a theme that doesn't appear literally in any variant text. A keyword matcher would only see the chosen wording, not the day. We pay ~10 extra tokens for the theme key and get a meaningfully better signal.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk (Claude Sonnet 4.6)

- **Codebase uses:** `@anthropic-ai/sdk` — Claude Sonnet 4.6 via `callClaude()` L123–L135 for variant generation.
- **Why it's here:** primary path for structured JSON output of four tonal variants + `detectedTheme` in one shared-context call.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures.

### OpenAI (callOpenAI / GPT-4o)

- **Codebase uses:** `callOpenAI()` L137–L154 — raw `fetch` to `/v1/chat/completions` as an alternative path.
- **Why it's here:** fallback provider path in `generateCaption`; Summary names "Claude Sonnet 4.6 (or GPT-4o)".
- **Leading today:** OpenAI Node SDK — `adoption-leading`, 2026.
- **Why it leads:** typed request/response shapes and built-in retries over raw `fetch` to `/v1/chat/completions`.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider wrapper with typed message structures.

---

## Summary

Multi-output structured prompting is the family of "ask the model for all the related outputs at once with a strict schema, validate the whole shape or reject it" — same discipline as OpenAI function-calling, JSON-mode generation, and tool-use APIs, applied here to caption variants. In this codebase `generateCaption` in `src/services/ai/caption.ts` calls Claude Sonnet 4.6 (or GPT-4o) with one system prompt that specifies four voices (`clean | smoother | reflective | punchy`) and a `detectedTheme` from a 6-way categorical; `parseAndValidate` then checks every variant key, normalises each to three lines, and validates the theme against `VALID_THEMES` — and `src/services/ai/summarize.ts` L87–L96 attaches `summary.variants` + `summary.variantsTheme` to the AISummary before `upsertAISummary` persists the row. The constraint is *output coherence*: the four variants must describe the *same* day with the same nouns, mood, and facts — only a single shared context guarantees that, parallel calls would produce four independent stories. The cost is bimodal: any one malformed variant invalidates the entire response (`parseAndValidate` returns `null` and the editor silently falls back to `summary.summary`), with no partial-credit recovery. At single-user scale a malformed response is rare; the single-call shape costs one Sonnet round-trip (~$0.012, ~300ms) versus five sequential calls (~$0.056, ~1.4s).

Key points to remember:
- One LLM call, four outputs in a single JSON object — shared context = shared nouns, shared mood.
- Strict-shape validation: missing any of the four variant keys or a non-string normalisation result means the whole output is discarded.
- Caption failure does not fail summarize — the call is wrapped in its own try/catch so the structured summary always persists.
- Pick the shape for output coherence, not for latency — parallel `Promise.all` would match latency but not noun consistency.
- Variant count past ~5–6 starts to push `max_tokens` (768 today); at that point splitting into grouped calls beats one over-stuffed call.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand that "four variants of the same day" is a *consistency* problem, not a *fanout* problem. A naive engineer reaches for `Promise.all([call('clean'), call('smoother'), …])` because it parallelises. The right move is structured-output single-call because the variants must share nouns, mood, and facts — and only a shared context guarantees that. The interviewer wants to hear that I picked the shape for *output coherence*, not for *latency*.

### Likely questions

[mid] Q: What happens if Claude returns only three of the four variants?
      A: `parseAndValidate` runs `CAPTION_VARIANT_KEYS.some(k => !variants[k])` — if any key is missing or `normalizeVariant` returns null for it (empty, non-string, no lines), the whole output is rejected. `generateCaption` returns `{ output: null, error: "Could not parse caption JSON" }`. In `summarize()` that means `output` is falsy at L90, so `summary.variants` and `summary.variantsTheme` stay undefined; the structured summary is still saved (caption is wrapped in its own try/catch at L87). The editor falls back to displaying `summary.summary` (the regular caption field).

```
[3-out-of-4 variants failure path]

  LLM returns: {clean:"L1...", smoother:"L2...", reflective:"", punchy:"L4..."}
        │
        ▼  parseAndValidate
  CAPTION_VARIANT_KEYS.some(k => !variants[k])
        │   reflective normalizes to null → true
        ▼
  return null   ◀── strict-shape rejection
        │
        ▼  generateCaption catches null
  { output: null, error: "Could not parse caption JSON" }
        │
        ▼  summarize.ts L87-L96 catches in its own try/catch
  summary.variants stays undefined; structured summary still upserts
        │
        ▼
  editor falls back to summary.summary text overlay
```

[senior] Q: Why one LLM call for all four variants instead of four parallel calls?
         A: Two reasons. First, consistency: the prompt spec says "all four variants describe the SAME day. Don't shift the topic between voices. Only the surface changes." A single shared context guarantees the four outputs use the same nouns (e.g., "the morning workout" in all four), the same mood, the same facts. Parallel calls would give you four independent interpretations of the rawLog. Second, cost — four parallel calls means four times the system-prompt tokens (the system prompt is ~600 tokens) for very similar work. One call costs one system prompt; four calls cost four. At Sonnet 4.6 pricing that's the difference between $0.012 and $0.056 per day-summary.

```
                  Path taken (single call, 4 outputs)  Alternative (4 parallel calls)
                  ────────────────────────────────────  ──────────────────────────────────
shared context    yes — 1 rawLog seen once             no — 4 independent reads
noun consistency  "morning workout" in all 4 voices    each call may call it different
                                                       names ("gym session", "exercise")
latency           ~300ms                                ~300ms parallel (parity)
cost              ~$0.012 (1× system prompt)            ~$0.056 (4× system prompt)
365 days/yr cost  ~$4.4                                 ~$20.4
failure shape     all-or-nothing                       per-variant pass/fail
verdict           consistency is the win; parallel     parallel matches latency but not
                  matches latency only                  coherence
```

[arch] Q: How do you handle the case where the variant generation succeeds for one tone but the model drifts on another?
       A: The validator is strict-shape, not per-variant tolerant. If `clean` and `smoother` are good but `reflective` came back as an empty string or markdown-wrapped, `normalizeVariant` returns null and the whole `parseAndValidate` returns null. I picked all-or-nothing over partial because the UX is "user picks a voice" — if only some voices are available, the picker is misleading. The alternative (return what parsed, mark missing variants as unavailable) is one extra column in the schema and one extra UI state I'd rather not introduce. At single-user scale, a malformed response is rare; the failure mode is "the four-variant feature didn't run today" which is exactly the message in the editor's fallback path.

```
[scale curve — what breaks first at 10× and 100× variant count or summary volume]

  variants × days   tokens     calls/year   $/year      breaks?
  ───────────────   ────────   ──────────   ────────    ──────────────────
  4 × 365 (real)    768 max     365          ~$4.4       no
  6 × 365           ~1100       365          ~$6        max_tokens=768
                                                          cap reached   ◀── BREAKS FIRST
  10 × 365          ~1800       365          ~$10        need to split into
                                                          grouped calls (3+3+4)
  4 × 10k users     768          3.6M         ~$44k       per-day call rate
                                                          dominates; not the
                                                          algorithm
```

### The question candidates always dodge
Q: You ship `variantsTheme` as part of the same call — but you could detect theme deterministically from the variants client-side. Why a 6-way categorical from the LLM?

A: I could keyword-match the output to assign a theme (`clarity` if "understanding" appears, `growth` if "learning" appears, etc.) and skip the LLM's `detectedTheme` field. The reason I don't is that the LLM has the full rawLog context — it can see "morning workout, struggled to focus, finally clicked at noon" and pick `shift` even when the variants don't say the word "shift." Keyword-matching would only see the variant text. The cost of the extra theme key in the JSON is negligible (one short string, ~10 tokens). The benefit is the theme reflects the day, not the chosen wording. The honest version of the answer is also that I haven't measured whether the LLM's theme is better than keyword-matching on my actual journal data — it might be a wash. But shipping the LLM version costs nothing extra and the worst case is "fall back to default `'clarity'`" which is what `parseAndValidate` does at L193 anyway.

```
                  Path taken (LLM detectedTheme)       Suggested (client keyword-match)
                  ────────────────────────────────────  ──────────────────────────────────
input signal      full rawLog context                  variant text only
worked example    rawLog says "struggled, clicked      no "shift" keyword in variants
                  at noon" → theme = 'shift'           → would mis-classify as 'clarity'
token cost        ~10 extra tokens in JSON             0 — purely client work
correctness       qualitative — reflects the day      lossy — reflects the wording
fallback          default 'clarity' if invalid        n/a — always picks something
                  theme returned
measured?         no — back-of-envelope better         could A/B in a debug build
verdict           LLM signal is strictly richer at    keyword match is cheap but
                  negligible cost                      strictly weaker signal
```

### One-line anchors
- "One context, four outputs — consistency is the win, not parallelism."
- "Strict-shape validation: any one bad variant invalidates the whole response."
- "Caption failure doesn't fail summarize — editor falls back to `summary.summary`."
- "Theme detection rides the same call because the LLM has the full context, not just the variant text."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain 4-variant caption generation to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/ai/caption.ts:generateCaption`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

`summarize('2026-05-07')` runs. The structured summary call succeeds. Then `generateCaption` runs and the LLM returns valid JSON for `clean`, `smoother`, and `punchy`, but `reflective` came back as an empty string. The `detectedTheme` field returns the string `"clarity"`. What value does `parseAndValidate` return, what fields does `upsertAISummary` actually persist, and what does the editor render when the user opens 2026-05-07?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/caption.ts` L158–L199 and check whether your answer matches what the code actually does.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/caption.ts:parseAndValidate` to support what exists
→ Point to `src/services/ai/summarize.ts:87–96` (the call-site that swallows caption failure) if you chose the alternative

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
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk, OpenAI (callOpenAI / GPT-4o).

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: wrapped algorithm body in a `## How it works` heading; added Move 1 mental-model opening (photographer-with-four-lenses metaphor + frontend bridge to single useQuery with derived projections) and Move 3 principle after the Comparison block.
