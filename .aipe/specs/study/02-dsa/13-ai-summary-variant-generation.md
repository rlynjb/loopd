# AI summary variant generation — 4-variant caption fan-out

**Industry name(s):** Multi-output prompt fan-out, structured-output caption variants
**Type:** Project-specific

> Single LLM call emits four tonal variants (`clean | smoother | reflective | punchy`) of the same day, plus a `detectedTheme` key. Persisted as `variants` + `variantsTheme` on `ai_summaries.summary_json`.

**See also:** → [10-heuristic-first-classifier](./10-heuristic-first-classifier.md) · → [03-ai-engineering/](../03-ai-engineering/)

---

## Quick summary
- **What:** `generateCaption(input)` calls Claude Sonnet 4.6 (or GPT-4o) with one prompt that emits all four variants in a single JSON object, then validates the shape and persists into the existing `ai_summaries` row.
- **Why here:** the four variants describe the *same* day in different voices — a single call keeps them consistent (same facts, same nouns) and costs one round-trip instead of four.
- **Tradeoff:** if any one variant comes back malformed, the entire output is discarded (`parseAndValidate` returns `null`). Partial JSON = no variants. Cheaper and safer than reconciling four parallel calls.

**Real operation:** `generateCaption` in `src/services/ai/caption.ts`; persistence in `src/services/ai/summarize.ts` L87–L96.

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

- **Single call, four outputs** — gives: noun consistency, one round-trip, one bill. Costs: any malformed variant invalidates the whole response.
- **Strict validation (`parseAndValidate`)** — gives: never persists partial state. Costs: one bad JSON token means we silently drop all four variants and the editor falls back to `summary.summary`.
- **Caption failure doesn't fail summarize** — gives: editor always has *some* text overlay. Costs: a permanent caption-failure mode (bad API key, model deprecated) is silent except for `console.warn`.

---

## Interview defense

### What an interviewer is really asking
The probe is whether I understand that "four variants of the same day" is a *consistency* problem, not a *fanout* problem. A naive engineer reaches for `Promise.all([call('clean'), call('smoother'), …])` because it parallelises. The right move is structured-output single-call because the variants must share nouns, mood, and facts — and only a shared context guarantees that. The interviewer wants to hear that I picked the shape for *output coherence*, not for *latency*.

### Likely questions

[mid] Q: What happens if Claude returns only three of the four variants?
      A: `parseAndValidate` runs `CAPTION_VARIANT_KEYS.some(k => !variants[k])` — if any key is missing or `normalizeVariant` returns null for it (empty, non-string, no lines), the whole output is rejected. `generateCaption` returns `{ output: null, error: "Could not parse caption JSON" }`. In `summarize()` that means `output` is falsy at L90, so `summary.variants` and `summary.variantsTheme` stay undefined; the structured summary is still saved (caption is wrapped in its own try/catch at L87). The editor falls back to displaying `summary.summary` (the regular caption field).

[senior] Q: Why one LLM call for all four variants instead of four parallel calls?
         A: Two reasons. First, consistency: the prompt spec says "all four variants describe the SAME day. Don't shift the topic between voices. Only the surface changes." A single shared context guarantees the four outputs use the same nouns (e.g., "the morning workout" in all four), the same mood, the same facts. Parallel calls would give you four independent interpretations of the rawLog. Second, cost — four parallel calls means four times the system-prompt tokens (the system prompt is ~600 tokens) for very similar work. One call costs one system prompt; four calls cost four. At Sonnet 4.6 pricing that's the difference between $0.012 and $0.056 per day-summary.

[arch] Q: How do you handle the case where the variant generation succeeds for one tone but the model drifts on another?
       A: The validator is strict-shape, not per-variant tolerant. If `clean` and `smoother` are good but `reflective` came back as an empty string or markdown-wrapped, `normalizeVariant` returns null and the whole `parseAndValidate` returns null. I picked all-or-nothing over partial because the UX is "user picks a voice" — if only some voices are available, the picker is misleading. The alternative (return what parsed, mark missing variants as unavailable) is one extra column in the schema and one extra UI state I'd rather not introduce. At single-user scale, a malformed response is rare; the failure mode is "the four-variant feature didn't run today" which is exactly the message in the editor's fallback path.

### The question candidates always dodge
Q: You ship `variantsTheme` as part of the same call — but you could detect theme deterministically from the variants client-side. Why a 6-way categorical from the LLM?

A: I could keyword-match the output to assign a theme (`clarity` if "understanding" appears, `growth` if "learning" appears, etc.) and skip the LLM's `detectedTheme` field. The reason I don't is that the LLM has the full rawLog context — it can see "morning workout, struggled to focus, finally clicked at noon" and pick `shift` even when the variants don't say the word "shift." Keyword-matching would only see the variant text. The cost of the extra theme key in the JSON is negligible (one short string, ~10 tokens). The benefit is the theme reflects the day, not the chosen wording. The honest version of the answer is also that I haven't measured whether the LLM's theme is better than keyword-matching on my actual journal data — it might be a wash. But shipping the LLM version costs nothing extra and the worst case is "fall back to default `'clarity'`" which is what `parseAndValidate` does at L193 anyway.

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
