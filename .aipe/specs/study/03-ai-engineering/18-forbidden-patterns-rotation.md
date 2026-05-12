# Forbidden patterns and rotating formulas

**Industry name(s):** Anti-repetition, rotation prompting, forbidden-pattern conditioning, in-context decoding bias
**Type:** Industry standard · Language-agnostic

> The 4-variant caption chain feeds the last 5 captions back to the model with a "don't repeat these phrasings" instruction — anti-repetition by negative example.

**See also:** → [13-ai-summary-variant-generation (DSA)](../02-dsa/13-ai-summary-variant-generation.md) · → [17-anatomy-of-prompt](./17-anatomy-of-prompt.md) · → [02-single-purpose-chains](./02-single-purpose-chains.md)

---

## Why care

You give an LLM the same generation task ten days in a row and by day three every output starts the same way — "Today I worked on…" or "Today was a day of…". The model isn't broken; it's converged. There's a single most-natural opening for the prompt and the model finds it every time. You're staring at the same caption with different content underneath.

Anti-repetition prompting is what stops that convergence. It belongs to the family of "make the model see what it already produced" patterns alongside diversity penalties in beam search, the `presence_penalty` parameter on OpenAI's API, and chat-conversation history that gives the model context for what's already been said. Wherever a generator needs to *not sound like itself again*, the fix is the same — let the generator see its prior output and instruct it to drift. The pattern shows up everywhere creative variation matters: image generators with seed-shifting, music generators with style transfer, even web crawlers that randomise their User-Agent. Here's how that actually works in this codebase.

---

## How it works

A short-story writer at a literary magazine who's been asked to write the lead piece every issue for a year. By month three the editor pins their last five openings on the wall and says: "Don't open any new piece the way you opened these." The writer can still write; they just can't write the way they wrote *before*. The constraint is generative, not restrictive — it forces variance the writer wouldn't have produced from scratch. Two operations welded together in a naive prompt ("generate four captions in different voices") split apart into two: generate four captions, but with awareness of the last five captions you produced.

### The data — fetching prior captions

When the summarize chain assembles the caption input, it calls `getRecentAISummaries(date, 5)` to pull the last five cached `AISummary` rows from SQLite. For each row, it tries to extract the legacy `caption` field (the single string from the pre-4-variant era). If you're coming from frontend, this is the same shape as React Query's `useInfiniteQuery` reading the last page of cached data to render alongside the new request — past state and current state living in the same call. Practical consequence: the captions are pulled from the device's SQLite, not from a remote source — `getRecentAISummaries` is just a `SELECT ... ORDER BY date DESC LIMIT 5` against the `ai_summaries` table. Boundary: this only works because every prior `AISummary` is cached locally; if the user reinstalls the app, the rotation history resets.

### The injection — adding them to the user message

The caption's user-message builder (`buildUserPrompt` in `caption.ts` L102–L121) appends a rotation block at the end of the message:

```ts
if (input.recentCaptions && input.recentCaptions.length > 0) {
  lines.push('');
  lines.push('Recent captions (avoid repeating phrasing or formula):');
  lines.push(input.recentCaptions.join('\n---\n'));
}
```

If you're coming from frontend, this is the same shape as passing `previousData` to a form's defaultValues — what the user did last time becomes context that shapes what they do this time. Practical consequence: the model now sees five prior captions inside the same context window as the current request, and the instruction "avoid repeating phrasing or formula" sits one line above them. The model attends to both.

### The constraints — explicit forbidden formulas in the system prompt

The system prompt at `caption.ts` L73–L82 lists `UNIVERSAL RULES (apply to all four variants)` — a constraints block:

- *"First-person implied — never write 'I' / 'you' / 'we'."*
- *"No hashtags. No emojis. No 'today I…' / 'Today was…' framings."*
- *"No questions, no exclamations."*
- *"No motivational platitudes ('trust the process', 'embrace the journey')."*

These are the static forbidden formulas — patterns the model converges on by default that must be killed before they ship. They never change. The dynamic forbidden formulas (the last 5 captions) live in the user message and rotate with each call. Two layers, working together. If you're coming from frontend, this is the same shape as a lint rule (`no-console`, static) plus an eslint-disable comment with a date (dynamic, per-file). Together they constrain behaviour at two timescales. Practical consequence: the model never opens with "Today I…" because the static constraint kills it, AND the model never opens the way it opened yesterday because the dynamic constraint shows yesterday's opening as a forbidden example.

### What the model does with it

The model treats the system-prompt constraints as hard rules — they're written as "never X" and the training prior on negative instructions is strong. The user-message rotation block ("avoid repeating phrasing or formula") is read as soft guidance — the model attends to the prior captions when picking openings but doesn't treat them as a strict block-list. The combination is exactly what you want: hard rules where shape matters, soft guidance where novelty matters. Practical consequence: caption N+1 reliably opens differently from captions N, N-1, N-2, N-3, N-4, but the model isn't paranoid about exact substring matches — if "Spent the morning…" is in the rotation history but "Spent the afternoon…" is the natural opening for today's log, the model will use it.

### Move 2.5 — How the rotation evolved

**Pre-2026-05-08:** captions were a single string per day (`caption` field on `AISummary`). The rotation block existed and fed the last 5 single-string captions back.

**2026-05-08 onward (4-variant era):** captions became four tonal variants (`clean`, `smoother`, `reflective`, `punchy`) plus a `detectedTheme`. The rotation block still pulls the legacy single `caption` field from old rows for tonal continuity. New 4-variant rows don't currently get their variants fed back as rotation history — only the legacy `caption` field is read in the rotation loop (summarize.ts L132–L140).

**The gap (what's actually true today):** the rotation history is dominated by pre-2026-05-08 single captions for users with long history; new 4-variant users get an empty rotation block on their first ~5 days because there are no legacy captions to read. The bug is harmless (the model still converges to good variants on its own) but real — the rotation feature degraded slightly during the variant migration and hasn't been re-tuned.

**What didn't have to change:** the prompt structure. The "Recent captions (avoid repeating phrasing or formula):" line in `buildUserPrompt` works for both single captions and (if ever wired up) variant captions; the change is in what `summarize.ts` decides to push into `recentCaptions`. The architectural foresight is that the rotation block is a list of strings — what you put into the strings is a downstream decision.

This is what people mean by "anti-repetition is a UX concern as much as a prompt one." The model doesn't know which of its outputs the user has seen recently; you have to tell it. Whichever past outputs you decide to surface become the negative space for the next generation. The full picture is below.

---

## Forbidden patterns and rotating formulas — diagram

```
                The two-layer anti-repetition pattern

  ┌─ Static constraints (system prompt, never changes) ──────────┐
  │                                                              │
  │  caption.ts L73–L82 — UNIVERSAL RULES:                       │
  │   - Never write 'I' / 'you' / 'we'                           │
  │   - No hashtags, no emojis                                   │
  │   - No "today I…" / "Today was…" framings                    │
  │   - No questions, no exclamations                            │
  │   - No motivational platitudes                               │
  │                                                              │
  │  Effect: kills the patterns the model converges on by        │
  │  default. Applies to every call.                             │
  └──────────────────────────────────────────────────────────────┘
                              +
  ┌─ Dynamic rotation (user message, rotates per call) ──────────┐
  │                                                              │
  │  Recent captions (avoid repeating phrasing or formula):      │
  │  ────────────────────────────────────────────────            │
  │  caption from day N-1                                        │
  │  ---                                                         │
  │  caption from day N-2                                        │
  │  ---                                                         │
  │  caption from day N-3                                        │
  │  ---                                                         │
  │  caption from day N-4                                        │
  │  ---                                                         │
  │  caption from day N-5                                        │
  │                                                              │
  │  Effect: kills the patterns the model converged on yesterday.│
  │  Applies to this call only.                                  │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                Generation that drifts intentionally
```

```
              The data flow per call

  ┌─ Storage layer (loopd.db) ────────────────────────────────┐
  │  ai_summaries table — last 5 rows                          │
  │   each carrying summary_json (parsed AISummary)            │
  └─────────────────────┬─────────────────────────────────────┘
                        │  getRecentAISummaries(date, 5)
                        ▼
  ┌─ Service layer (summarize.ts L128–L140) ──────────────────┐
  │  For each row:                                              │
  │    JSON.parse(row.summaryJson)                              │
  │    if parsed.caption → push to recentCaptions               │
  │  Result: string[] of up to 5 captions                       │
  └─────────────────────┬─────────────────────────────────────┘
                        │  recentCaptions: string[]
                        ▼
  ┌─ Prompt layer (caption.ts:buildUserPrompt L102–L121) ─────┐
  │  Append:                                                    │
  │    "Recent captions (avoid repeating phrasing or formula):" │
  │    captions joined by "\n---\n"                             │
  └─────────────────────┬─────────────────────────────────────┘
                        │  composed user message
                        ▼
  ┌─ Provider layer ──────────────────────────────────────────┐
  │  Claude / OpenAI sees:                                     │
  │   system: 4-section prompt with UNIVERSAL RULES            │
  │   user:   raw log + mood + rotation block                  │
  └─────────────────────┬─────────────────────────────────────┘
                        │  generated 4 variants
                        ▼
                  Validated, persisted
```

---

## In this codebase

**Static forbidden patterns (the UNIVERSAL RULES block):**
**File:** `src/services/ai/caption.ts`
**Function / class:** `SYSTEM_PROMPT` constant (the `UNIVERSAL RULES (apply to all four variants):` block)
**Line range:** L73–L82

**Dynamic rotation block (the recent-captions injection):**
**File:** `src/services/ai/caption.ts`
**Function / class:** `buildUserPrompt(input)`
**Line range:** L113–L117

**Rotation data source (the assembly):**
**File:** `src/services/ai/summarize.ts`
**Function / class:** `buildCaptionInput(date, entries, mood)`
**Line range:** L128–L140 (the `recentCaptions` loop)

**The DB read used by the rotation:**
**File:** `src/services/database.ts`
**Function / class:** `getRecentAISummaries(date, limit)`
**Line range:** see file (returns the last N `ai_summaries` rows before `date`).

---

## Elaborate

### Where this pattern comes from
Anti-repetition in generative models predates LLMs by a decade. n-gram blocking was the standard fix in early neural machine translation — "don't repeat the same 4-gram you generated 100 tokens ago." Beam search diversity penalties (Vijayakumar et al., 2016) formalised it. The LLM era moved the responsibility from the decoder to the prompt: in-context examples of what NOT to produce are cheaper to add than a custom decoder. OpenAI's `presence_penalty` and `frequency_penalty` parameters are decoder-level remnants of the same idea; the prompt-level rotation is the modern application-layer version.

### The deeper principle
**The model's strongest prior is the one you have to actively fight.** Default behaviour comes from training data; if the most common form of "write a daily summary" in the training data opens with "Today I…", that's the form the model emits unless you push against it. Pushing requires two things: making the default visible (the constraints section names it) and making the alternative attractive (the example voices in the task section show what good output looks like instead). One without the other doesn't work — naming "never write 'today I'" without showing what to write instead produces models that hedge.

### Where this breaks down
- **Rotation history that's too short** — 2 past captions can't represent the space of what the model has been doing; 5 is the minimum for meaningful drift.
- **Rotation history that's too long** — 50 past captions consume context budget the model needs for the current task. ~5–10 is the practical range.
- **High-variance generation tasks** — long-form prose (interpret) is inherently varied; rotation is overkill. Short, formula-prone tasks (captions, headlines, tweets) are where it earns its weight.
- **Exact-match avoidance vs phrasing-pattern avoidance** — the model treats the rotation as "don't sound like these" not "don't include these exact words." If you need exact-match dedup, you need a separate post-generation check.
- **Empty rotation history (cold start)** — the first 5 captions a new user produces have no rotation history. They tend toward the model's default openings until the history fills.

### What to explore next
- [AI summary variant generation](../02-dsa/13-ai-summary-variant-generation.md) → the DSA-side view of the same chain (multi-output prompt fan-out).
- [Anatomy of a production prompt](./17-anatomy-of-prompt.md) → why the static forbidden patterns live in the constraints section.
- [Single-purpose chains](./02-single-purpose-chains.md) → why caption is its own chain rather than rolled into summarize.

---

## Tradeoffs

The codebase uses the two-layer pattern (static UNIVERSAL RULES + dynamic recent-captions block) on the caption chain. The cost is per-call tokens; the win is captions that don't all sound like each other.

### Comparison table — both costs in one frame

```
┌────────────────────┬────────────────────────────┬────────────────────────────┐
│ Cost dimension     │ Path taken (system rules + │ Alternative (frequency_    │
│                    │ user-message rotation)     │ penalty / presence_penalty)│
├────────────────────┼────────────────────────────┼────────────────────────────┤
│ Provider support   │ works on every provider    │ OpenAI only; no Anthropic  │
│                    │ that has a system prompt   │ equivalent                 │
│ Granularity        │ patterns + specific past   │ token frequency, blind     │
│                    │ outputs                    │ to semantic content        │
│ Rotation tokens    │ ~200–500 per call          │ 0                          │
│  per call          │                            │                            │
│ Cost per call      │ +~$0.001 input on Sonnet   │ $0                         │
│                    │ for 300 tokens             │                            │
│ Effectiveness on   │ high — model sees actual   │ low — penalises tokens not │
│ phrasing-repetition│ past phrasings             │ phrasings                  │
│ Effectiveness on   │ low — model can still      │ medium — directly raises   │
│ exact substring    │ technically repeat exact   │ unique-token rate          │
│ avoidance          │ wording                    │                            │
│ Provider-agnostic  │ yes — works on both Claude │ no — would need different  │
│                    │ and OpenAI                 │ pattern on Anthropic       │
│ Cold start         │ no rotation for first N    │ works from call 1          │
│                    │ calls (no history yet)     │                            │
└────────────────────┴────────────────────────────┴────────────────────────────┘
```

### What we gave up

We pay ~200–500 tokens per caption call to carry the rotation block. At Sonnet pricing that's ~$0.001 per call in input cost. For a solo user generating one caption a day, that's $0.36/year — invisible. The cost only matters at scale, and at single-user scale it doesn't.

We gave up exact-substring deduplication. The rotation block tells the model to "avoid repeating phrasing or formula" but doesn't prevent the model from emitting the exact same words as a prior caption. A user generating two captions for similar days can technically get the same opening twice. The deeper problem is that semantic similarity ≠ string similarity — if I want "never emit the same caption twice" I'd need a post-generation embedding check against history, which is a separate chain.

We gave up the ability to control rotation strength. Currently it's binary (the rotation block is there or not). A more sophisticated implementation would temperature-tune the rotation (more aggressive for tasks with stronger priors, less aggressive when the model's default is already fine), but we don't.

### What the alternative would have cost

If we had used `frequency_penalty` and `presence_penalty` instead, we'd carry zero rotation-block tokens — the penalty is decoder-side, not prompt-side. But the penalty operates on tokens, not phrasings. A model penalised for emitting "today" again would just emit a different opener that *means* the same thing — the semantic repetition continues, only the surface form changes. For caption variants where the surface form IS the point, decoder penalties are the wrong tool.

If we had used semantic embedding-based rejection (generate caption, embed it, compare to last 5 caption embeddings, reject if cosine > threshold, regenerate), we'd carry per-call extra cost (one embedding call + comparison) and added latency (one extra LLM round trip on rejection). The current pattern bakes anti-repetition into the prompt for one call; the rejection-based pattern adds at least one full retry per ~10% of calls. The math: 200–500 rotation tokens upfront is cheaper than 100% of an embedding call plus 10% of a regenerated caption.

### The breakpoint

Fine until the rotation history grows past ~10 captions per call. At that point the rotation block dominates the user message and the model loses focus on the actual day's content. Fine until rotation is needed at sub-day granularity (multiple captions per day — already true if a user generates and regenerates) — the current implementation reads `getRecentAISummaries(date, 5)` which gets the last 5 *days*, not the last 5 *generations*. The day a user regenerates 3 times in one session and the model gives them the same opening twice, the breakpoint hits and the fix is to make rotation per-call rather than per-day.

### What wasn't actually a tradeoff

Removing the rotation entirely was never a real option. Captions without rotation converge to the same opening within 3–5 generations; the user notices immediately because they read every caption their app produces. Rotation isn't a nice-to-have; it's load-bearing for the caption feature.

---

## Tech reference (industry pairing)

### Inline rotation in user message

- **Codebase uses:** `buildUserPrompt` in `caption.ts` L102–L121 appends `"Recent captions (avoid repeating phrasing or formula):" + lastN.join('\n---\n')` to the user message before sending.
- **Why it's here:** the simplest, most provider-agnostic way to inject "don't repeat these" into context. Works on every provider that takes a string user message.
- **Leading today:** in-context rotation via user message — `adoption-leading` for application-level anti-repetition, 2026.
- **Why it leads:** zero infrastructure, works on every provider, semantic-aware (the model attends to phrasing, not just tokens).
- **Runner-up:** OpenAI `frequency_penalty` / `presence_penalty` — `adoption-leading` for token-level repetition control. Operates at the decoder layer; cheaper at runtime but coarser in effect.

### Static forbidden patterns in system prompt

- **Codebase uses:** `UNIVERSAL RULES` block in `caption.ts` SYSTEM_PROMPT L73–L82 — five "never" rules + the "first-person implied" rule.
- **Why it's here:** kills the patterns the model converges on by default. Static — applies to every call, every variant.
- **Leading today:** negative-instruction constraints in the system prompt — `adoption-leading` for shape control, 2026.
- **Why it leads:** the model treats "never X" as a hard rule; the prior on negative instructions is strong; works across providers.
- **Runner-up:** few-shot examples of good output — `adoption-leading` for tone control. Different lever: shows what good looks like rather than what bad looks like. Works in parallel with negative constraints, not instead of them.

---

## Project exercises

**Status:** `learn-only` (`[C1.7]` prompt-engineering detail). The pattern is already in the caption chain; the curriculum doesn't tag a dedicated `[Bx.y]` because it's a sub-discipline pattern. The work that *would* move the pattern forward, surfaced explicitly by this file's "what's missing today" line in Tradeoffs:

### Feed the 4 caption variants back into the rotation history

- **Exercise ID:** *cross-cutting (depends on caption + summarize)*
- **What to build:** Today `getRecentAISummaries(date, 5)` reads legacy single captions only. After loopd shipped the 4-variant chain (clean/smoother/reflective/punchy), the rotation history stopped including those four — meaning the rotation feature is degrading silently as the legacy column gets stale. Update the rotation source to read from `variants` (and pick one variant deterministically, e.g., `clean`) so the rotation block carries actual recent phrasing.
- **Why it earns its place:** the file's Tradeoffs section names this gap explicitly: *"the gap today is that 4-variant captions aren't being fed back to the rotation history, only legacy single captions are."* Fixing it is the smallest possible exercise that turns a documented gap into closed work.
- **Files to touch:** `src/services/ai/summarize.ts:buildCaptionInput()` (specifically `getRecentAISummaries` consumer at L131), check `src/services/ai/caption.ts` `buildUserPrompt` L113–L117.
- **Done when:** the rotation block in caption prompts reads from `variants.clean` for any AISummary newer than the cutover date and falls back to legacy `caption` for older rows; a captured prompt on a fresh day shows variant-derived captions in the LAST_5_CAPTIONS block.
- **Estimated effort:** `<1hr` to `1–4hr` depending on backfill ambition.

---

## Summary

Forbidden patterns + rotation is the two-layer anti-repetition shape: static "never" rules in the system prompt kill default convergence (no "Today I…", no first-person pronouns, no platitudes), and the dynamic last-5-captions block in the user message kills the model's drift toward yesterday's phrasing. In this codebase only the caption chain uses both layers: the `UNIVERSAL RULES` block in `caption.ts` L73–L82 holds the static constraints, and `buildUserPrompt` L113–L117 injects the rotation block. The data source is `getRecentAISummaries(date, 5)` reading the last 5 cached `AISummary` rows. The constraint that shaped this is that captions are formula-prone — humans notice when "Today I…" opens every entry — so the cost of carrying ~200–500 tokens of rotation per call is worth it. The cost is per-call tokens; the gap today is that 4-variant captions aren't being fed back to the rotation history, only legacy single captions are.

Key points to remember:
- Two layers: static "never" rules in system prompt + dynamic last-N captions in user message.
- The rotation history is the last 5 days' captions, pulled from local `ai_summaries` via `getRecentAISummaries`.
- Only the legacy `caption` field is read into rotation today; 4-variant captions are not — known gap from the 2026-05-08 migration.
- ~200–500 tokens of overhead per call; at single-user scale this is invisible.
- The pattern is provider-agnostic — works on Claude and OpenAI alike because it lives in the prompt, not in API parameters.

---

## Interview defense

### What an interviewer is really asking
Anti-repetition is the test of whether the candidate has shipped a creative-output LLM feature and watched it fail. Anyone can write a prompt; few have felt the moment where every output starts the same and realised the model needs to see its own history. The interviewer wants to hear evidence the candidate has dealt with model convergence in production, not just read about it.

### Likely questions

[mid] Q: Walk me through how a caption gets generated for day N.

A: `summarize.ts:buildCaptionInput` calls `getRecentAISummaries(date, 5)` to pull the last 5 cached `AISummary` rows. For each row it `JSON.parse`s `summaryJson` and pushes the legacy `caption` field into a `recentCaptions: string[]` array. Then `generateCaption(captionInput)` runs: the caption chain's `buildUserPrompt` appends a "Recent captions (avoid repeating phrasing or formula):" block joining the captions with `---` separators. The model sees the four-section system prompt (with the static UNIVERSAL RULES forbidden-patterns block) plus the user message containing today's raw log + mood + the rotation block. It returns 4 tonal variants + a detected theme. The validator narrows to `CaptionVariantOutput` and the editor renders the user's chosen variant.

```
[caption generation flow]

  summarize() day N
      │
      ▼
  getRecentAISummaries(date, 5) → 5 prior rows
      │
      ▼
  for each row: JSON.parse → push parsed.caption to recentCaptions
      │
      ▼
  generateCaption({ rawLog, mood, recentCaptions, ... })
      │
      ▼
  buildUserPrompt appends rotation block to user message
      │
      ▼
  Claude / OpenAI with system prompt (UNIVERSAL RULES block)
      │
      ▼
  Returns 4 variants + theme → validated → stored
```

[senior] Q: Why use the prompt to carry rotation rather than OpenAI's `frequency_penalty` parameter?

A: Two reasons. First, `frequency_penalty` only exists on OpenAI; Claude has no equivalent. Using it would mean the OpenAI branch of caption.ts gets anti-repetition and the Claude branch doesn't — two patterns in one chain, divergent behaviour. Second, `frequency_penalty` operates on token frequencies, not on phrasings. If the model wants to open every caption with the structure "Verb-ing the X" (a phrasing pattern), the penalty doesn't catch that because the actual tokens differ each time. Prompt-based rotation lets the model see the *phrasings* it's been emitting, not just the tokens. The 200–500 token cost is worth that distinction.

```
                Path taken (prompt rotation)           Alternative (frequency_penalty)
                ──────────────────────────────         ──────────────────────────────
provider        works on Claude and OpenAI             OpenAI only
support
granularity     phrasing / formula                     token frequency
per-call tokens 200–500                                0
catches         "Verb-ing the X" repeating across      same-token repetition within
                calls                                  a single call
maintenance     one path, two providers                two paths, one provider each
                                                       (or one provider only)
correctness     model sees actual past captions        decoder penalises blind
                                                       to semantic content
```

[arch] Q: What changes if you went from one user to 10,000 users? Does this pattern scale?

A: The rotation pattern scales fine; the data layer becomes the bottleneck. Each call needs the last 5 captions; today that's a local SQLite query (`getRecentAISummaries`). At 10k users on a server, that's 10k DB reads per generation cycle — fine on a sized database. The token cost scales linearly: 10k captions/day × 300 rotation tokens = 3M tokens/day in rotation overhead alone. At Sonnet $3/1M input, that's ~$9/day, or $270/month — non-trivial but manageable. The pattern that wouldn't scale is reading 50 past captions per call; capping at 5 is what keeps the math sane.

```
At 10,000 users:

  ┌─ User layer ────────────────────────────────┐
  │ same — 1 caption per user per day            │
  └─────────────────────────────────────────────┘
                       │
  ┌─ Storage layer ────────────────────────────┐
  │ 10k DB reads / generation cycle              │  ◀── BREAKS FIRST without
  │ each pulls last 5 captions for that user     │     indexed query (need
  │                                              │     index on (user_id, date DESC))
  └─────────────────────────────────────────────┘
                       │
  ┌─ Service layer ────────────────────────────┐
  │ same — append rotation to user message       │
  └─────────────────────────────────────────────┘
                       │
  ┌─ Provider layer ───────────────────────────┐
  │ ~3M rotation tokens / day                   │
  │ ~$9 / day at Sonnet input pricing           │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You said only the legacy `caption` field is read into rotation, not the 4-variant captions. Doesn't that mean the rotation is currently broken for new users?

A: It's degraded, not broken. New users with no pre-2026-05-08 history get an empty rotation block on their first ~5 days — the model converges to its defaults, then the rotation reads its own variant captions… except it doesn't, because `summarize.ts:buildCaptionInput` L132–L140 only reads `parsed.caption`, never `parsed.variants`. The bug is invisible (the model still produces decent variants on its own because the static UNIVERSAL RULES block kills the worst patterns), but it's real — captions for new users have less drift than captions for old users who have legacy single-captions in history. The fix is two lines: read `parsed.variants?.clean` or the user's last-picked variant key instead. I haven't shipped it yet because the cost of the bug is small (slightly less diverse openers for new users) and the cost of the fix requires a decision (which variant to seed the rotation with — the user's picked one? the clean one? all four?).

```
                Path taken (legacy-only rotation)      Alternative (read variants)
                ──────────────────────────────         ──────────────────────────────
new user        empty rotation for first 5             rotation populated from day 2
days 1–5
new user        rotation reads prior days' single      rotation reads prior days'
day 6+          captions (none exist) → empty          variants → populated
old user        rotation reads prior single captions   rotation reads either; current
                from 2026-05-07 and earlier            implementation regresses
                                                       for these users on migration
visible bug     subtle — less drift than expected      same coverage everywhere
ship cost       0 (already shipped)                    needs a "which variant key
                                                       to seed with" decision
                                                       + 2 line change
```

### One-line anchors
- "Anti-repetition is two layers — static 'never' rules + dynamic last-N rotation."
- "The model can't see its own history unless you put it in context — that's your job, not the model's."
- "Five past outputs is the practical minimum for meaningful drift; ten is the practical maximum before token cost dominates."
- "Provider-agnostic prompt rotation beats provider-specific decoder penalties when the goal is phrasing variance, not token variance."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the "two-layer anti-repetition pattern" diagram from memory: static constraints in system prompt, dynamic rotation in user message, both feeding the generator.

Open the file. Compare.

✓ Pass: your diagram has both layers labelled with what each contains and what each fights against.
✗ Fail: re-read the "How it works" section, wait 10 minutes, try again.

### Level 2 — Explain it out loud
Explain the rotation pattern to an imaginary colleague who just asked "how do you stop the LLM from giving the same response every day?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file? → `caption.ts` (the system prompt + buildUserPrompt) and `summarize.ts:buildCaptionInput`
- Name the data source for the rotation history? → `getRecentAISummaries(date, 5)`
- Name the gap (variants not yet fed back) in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

You're adding a "daily-thought-of-the-day" chain that emits a one-line philosophical observation. After a week of testing, every output starts with "It strikes me…". Walk what you'd add to fix it: the static constraints in the system prompt (give 2 specific "never" rules), the rotation block in the user message (how many past outputs, formatted how), and the data layer (how would you store and fetch past outputs given the codebase's existing patterns).

Write your answer. Then open `src/services/ai/caption.ts` L73–L82 + L113–L117 to compare with the existing implementation.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this caption feature today, would you use prompt-based rotation or would you implement an embedding-based rejection loop (generate → embed → compare to history → reject + regenerate if too similar)? Why or why not? What would the cost difference be?"

Reference the actual code:
→ Point to `src/services/ai/caption.ts` L113–L117 to support what exists (the prompt rotation)
→ Point to where an embedding-rejection loop would live (a new `caption-dedup.ts` service) if you chose the alternative

There is no right answer. The point is specificity. "Prompt rotation is simpler" is vague; "200–500 tokens upfront beats 100% of an embedding call + 10% of a regeneration call, but only if exact-substring repetition is acceptable" is specific.

### Quick check — code reference test
Without opening any files, answer:
- Which file has the UNIVERSAL RULES forbidden-patterns block?
- Which function builds the rotation block into the user message?
- Which function pulls the rotation data from the database?

Then open `caption.ts` and `summarize.ts` to verify.

✓ Pass: you named `caption.ts` (L73–L82 for UNIVERSAL RULES, L113–L117 for the rotation injection) and `summarize.ts:buildCaptionInput` (L128–L140) reading from `getRecentAISummaries`.
✗ Fail on lines: that's fine. File and function names are what matter.
