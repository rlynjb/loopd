# buffr — Caption Variants Implementation Plan

Replaces the current 2-variant relatable-caption pass (PRIMARY + ALT) with a **4-variant pass** that emits four tonal styles for the vlog editor's "Regenerate with AI" button. Each variant is the same 3-line body, same day, different voice.

This patch supersedes parts of [`relatable-caption-spec.md`](./relatable-caption-spec.md) — specifically the JSON output shape and the generator's system prompt. The voice rules, forbidden patterns, and theme detection from that spec are preserved.

---

## 1. The four variants

Each variant produces a 3-line body. The day title (from `day_meta.title`) is prefixed by the editor when rendering — the LLM only generates the body. All four describe the **same day** from the same raw log; the only thing that changes is the voice.

### `clean` (default — "best fit")
Present-progressive, observational, plain. Direct sentences, no hedging. The default choice when in doubt.

> Realizing how much words shape understanding
> Spent the morning digging into technical terms and concepts
> Starting to see communication as the bridge between thought and expression

### `smoother`
Slightly conversational, gentle hedging, comma-friendly. Reads like talking to a friend.

> Been realizing how important words are in shaping understanding
> Spent the morning studying technical concepts and terminology
> Communication really feels like the bridge between ideas and expression

### `reflective`
Contemplative. Mixes past-tense action with present-tense realization. Slower, more "weight" in the language.

> Starting to appreciate the weight words carry
> Morning spent learning technical concepts and terminology
> Realizing communication is what connects thoughts to expression

### `punchy`
Axiomatic, parallel structure, terse word groups. Each line stands on its own.

> Words shape understanding
> Concepts shape thinking
> Communication bridges both

The four are tonal siblings — same content, different surface. A user who feels the `clean` version sounds too plain on a heavy day can swap to `reflective`; a user who wants something to share quickly can swap to `punchy`.

---

## 2. System prompt for the LLM

The prompt the new caption pass will send. Follows the existing relatable-caption-spec voice rules but emits four variants in one call. Single LLM call, single JSON object — no per-variant fanout.

```
You generate four variant captions for a daily vlog from the user's raw log.
Each variant is the same 3-line body about the same day, written in a
different tonal voice. The user picks which voice to publish.

OUTPUT: a single valid JSON object with EXACTLY this shape:

{
  "clean":      "Line1\nLine2\nLine3",
  "smoother":   "Line1\nLine2\nLine3",
  "reflective": "Line1\nLine2\nLine3",
  "punchy":     "Line1\nLine2\nLine3",
  "detectedTheme": "growth" | "discipline" | "clarity" | "struggle" | "shift" | "curiosity"
}

No prose preamble, no markdown fences, no commentary. JSON only.

VARIANT VOICES — distinct per key:

clean (default voice):
  Present-progressive, observational, plain. Direct sentences.
  No hedging like "really" / "kind of". No "feels like".
  Example body:
    Realizing how much words shape understanding
    Spent the morning digging into technical terms and concepts
    Starting to see communication as the bridge between thought and expression

smoother:
  Conversational, slightly hedged, gentle. Use "really" / "kind of"
  / "feels like" sparingly to soften observations.
  Example body:
    Been realizing how important words are in shaping understanding
    Spent the morning studying technical concepts and terminology
    Communication really feels like the bridge between ideas and expression

reflective:
  Contemplative. Mix past-tense action ("Spent the morning…", "Morning
  spent…") with present-tense realization ("Realizing…", "Starting to
  appreciate…"). Slower pace, longer phrasing.
  Example body:
    Starting to appreciate the weight words carry
    Morning spent learning technical concepts and terminology
    Realizing communication is what connects thoughts to expression

punchy:
  Axiomatic and terse. Parallel structure across the three lines —
  same grammatical shape repeated. 2–5 words per line. No filler.
  Example body:
    Words shape understanding
    Concepts shape thinking
    Communication bridges both

UNIVERSAL RULES (apply to all four variants):
- Exactly 3 body lines, separated by a single newline.
- First-person implied — never write "I" / "you" / "we".
- No hashtags. No emojis. No "today I…" / "Today was…" framings.
- No questions, no exclamations.
- No motivational platitudes ("trust the process", "embrace the journey").
- Use specific nouns from the raw log when natural — "technical concepts",
  "the morning workout", "the buffr codebase". Don't invent details.
- All four variants describe the SAME day. Don't shift the topic between
  voices. Only the surface changes.

THEME DETECTION:
Pick one detectedTheme that best matches the day:
  growth      — learning, breakthrough, leveling-up
  discipline  — habits, repetition, showing up
  clarity     — understanding, finding the right framing
  struggle    — friction, blocked, pushing through
  shift       — pivot, realization, changed direction
  curiosity   — exploring, asking questions, going wide

INPUTS YOU'LL RECEIVE:
- date: YYYY-MM-DD
- rawLog: bullet list of lines from the user's day (entry text + done todos)
- mood: optional — a word like "fired up" / "steady" / "low energy"
- recentCaptions: last 5 published captions for tonal continuity
- themeHint: optional — if set, prefer this theme

If the rawLog is sparse (1–2 short lines), still emit four valid variants
but keep them tight. Don't pad with invented content.

If you can't form a coherent caption from the raw log, return:
  { "error": "insufficient-input" }
…with no other keys.
```

The prompt assumes the call site (`caption.ts`) sends a user message containing the structured input as JSON or labeled sections.

---

## 3. Architecture changes

### 3.1 New types — [`src/types/ai.ts`](../src/types/ai.ts)

```ts
export type CaptionVariantKey = 'clean' | 'smoother' | 'reflective' | 'punchy';

export const CAPTION_VARIANT_KEYS: CaptionVariantKey[] = [
  'clean', 'smoother', 'reflective', 'punchy',
];

export type CaptionVariantOutput = {
  /** 4 variants keyed by style. Each value is the 3-line body, no title. */
  variants: Record<CaptionVariantKey, string>;
  detectedTheme: string;
};
```

The existing `CaptionOutput` (`{ caption, alternate, detectedTheme }`) is **retained** for backward-compat reads of cached AISummary rows. New writes use `variants`.

### 3.2 Extended `AISummary`

```ts
export type AISummary = {
  // ... existing core fields unchanged ...

  // Legacy 2-variant fields (read-only post-migration; populated only on
  // pre-2026-05-05 cached rows). New code reads `variants` first and falls
  // back to these.
  caption?: string;
  captionAlternate?: string;
  captionTheme?: string;

  // New 4-variant payload. Optional (older rows pre-date this).
  variants?: Record<CaptionVariantKey, string>;
  variantsTheme?: string;
};
```

### 3.3 Updated [`src/services/ai/caption.ts`](../src/services/ai/caption.ts)

`generateCaption(input)` returns `CaptionVariantOutput | null`. The function:
1. Sends the new system prompt + structured user message.
2. Parses the JSON response.
3. Validates: all four keys present, each is a 3-line string, theme is one of six.
4. On `{ "error": "insufficient-input" }` returns `null` (caller falls back to summary).

Failure modes (insufficient input, malformed JSON, missing variant) are swallowed by `summarize.ts` the same way today's 1-pair version is — caption failure does not fail the structured-summary chain.

### 3.4 Updated `summarize.ts` chain

After the structured summary call:
1. Build `CaptionInput` (date, rawLog, recentCaptions, mood) — unchanged.
2. Call `generateCaption(captionInput)`.
3. If result, attach `variants` + `variantsTheme` to the `AISummary` before caching.
4. Continue to `upsertAISummary(date, JSON.stringify(summary), model)`.

### 3.5 Updated [`compose.ts`](../src/services/ai/compose.ts)

The auto-compose default body for the text overlay picks `variants.clean` if available, falling back to:
1. Legacy `caption` field (existing 1-variant cache)
2. Sentence-broken `summary.summary` (the structured fallback)

Order: `variants.clean ?? caption ?? sentenceBroken(summary)`.

### 3.6 Editor TEXT tab — variant chip group

[`app/editor/[date].tsx`](../app/editor/[date].tsx) currently renders 3 chips: `PRIMARY` / `ALT` / `SUMMARY`. New chips:

```
┌──────┬─────────┬──────────┬────────┬─────────┐
│CLEAN │ SMOOTH  │ REFLECT  │ PUNCHY │ SUMMARY │
└──────┴─────────┴──────────┴────────┴─────────┘
```

Active chip highlighted in amber. State `captionVariant: CaptionVariantKey | 'summary'`. Defaults to `'clean'` on regenerate / auto-compose. Each chip renders only when its variant is present on the cached AISummary; SUMMARY is always available.

For older cached rows that have `caption` / `captionAlternate` but no `variants`: show a 3-chip fallback (`PRIMARY` / `ALT` / `SUMMARY`) as today. The first regenerate after this patch lands populates the new 4-variant set and the chip group expands to 5.

### 3.7 Updated [`validate.ts`](../src/services/ai/validate.ts)

`validateSummary` round-trips both the legacy fields and the new `variants` block. Soft-validates each variant string is non-empty 3-line content; drops malformed entries.

---

## 4. Migration / backward-compat

| Cached row state | Read behavior | Display |
|---|---|---|
| Has `variants` (new) | Read all 4 + SUMMARY | 5-chip group |
| Has `caption` + `alternate` only (legacy) | Read PRIMARY + ALT + SUMMARY | 3-chip group |
| Has neither | SUMMARY only | 1-chip group |

No data migration required. The next "Regenerate with AI" tap on a legacy day rewrites the AI summary with 4-variant output, and from that point forward the day shows 5 chips.

The legacy `caption` / `captionAlternate` fields stay readable indefinitely on old rows. They're not written by new code — but they're not deleted either, so a user who never re-generates a day's caption keeps the 3-chip experience for that day forever. Acceptable trade-off; cleaner than a forced eager backfill.

---

## 5. Implementation order

| Step | What | Est. |
|---|---|---|
| 1 | Add `CaptionVariantKey` + `CaptionVariantOutput` types; extend `AISummary` with `variants?` field | 0.5h |
| 2 | Rewrite `caption.ts` system prompt + JSON parser + 4-variant validator | 1.5h |
| 3 | Update `summarize.ts` chain to attach `variants` to the cached AISummary | 0.5h |
| 4 | Update `compose.ts` default-body picker to prefer `variants.clean` | 0.5h |
| 5 | Update `validate.ts` to round-trip `variants` + `variantsTheme` | 0.5h |
| 6 | Editor TEXT tab: 5-chip group + state machine + backward-compat 3-chip fallback for legacy rows | 2–3h |
| 7 | Test pass: regenerate on a fresh day → 4 variants generated; switch chips → overlay updates correctly; regenerate on a legacy day → upgrades to 4-variant cache | 1–2h |
| 8 | Build + install + dogfood for one day | 0.5h |

**Total: ~7–9h.**

The work is concentrated in `caption.ts` (the prompt + parser, ~150 lines change) and the editor (chip group, ~80 lines change). Everything else is type-system plumbing.

---

## 6. Open questions

1. **Default chip on a fresh regenerate** — `clean` per the user's "best fit" label. Confirm.
2. **Chip labels** — proposed `CLEAN` / `SMOOTH` / `REFLECT` / `PUNCHY` / `SUMMARY` (all uppercase, monospace, ~7 chars max to fit in the editor's chip row). Alternatives: `PRIMARY` / `SOFT` / `DEEP` / `TIGHT` / `SUMMARY`.
3. **Single-call vs. four-call generation** — single call is simpler and ~1/4 the cost. Risk: the LLM might miss tonal distinctions when generating all four at once. If quality is poor in dogfooding, we could split into 4 separate calls (more expensive but cleaner outputs). Default: single call, revisit after testing.
4. **Theme storage** — proposed new field `variantsTheme` so legacy `captionTheme` doesn't get clobbered. Cleaner alternative: write to both fields for forward+backward compat. Confirm.
5. **Cost** — current pass uses the primary tier (Sonnet 4.6 / GPT-4o). 4 variants in one call is roughly the same token cost as the existing 2-variant call (output is ~2× longer but input is identical). Should still cost ~$0.04 per regenerate.

---

## 7. What this patch does NOT cover

- **Per-variant theme detection.** All four variants share one detected theme.
- **User-configurable variant set.** The four are hardcoded. Adding a 5th later is a code change.
- **Streaming output.** The chip group only renders when the LLM call completes — no progressive reveal.
- **Cross-day variant continuity.** `recentCaptions` still uses the published variant from previous days (whatever was last shown). No "always include the clean variant in continuity" rule.
- **Editor manual edits.** The TEXT overlay is still freely editable; tapping a variant chip overwrites the current text, same as today.
