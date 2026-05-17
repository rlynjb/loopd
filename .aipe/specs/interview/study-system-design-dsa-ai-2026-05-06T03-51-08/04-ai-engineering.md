# Chapter 4 — AI engineering

buffr has three distinct AI surfaces: the **structured day summary** (`summarize`), the **4-variant tonal caption** (`generateCaption`), and the **todo type classifier** (`classifyTodo`). Each is in its own file under `src/services/ai/` or `src/services/todos/`, each has its own prompt, each runs on its own model. There is no LangChain, no chain composition, no agent loop. There are three function calls.

The architecture decision that matters: **single-purpose calls beat chained calls for reliability.** Every call has one job, one prompt, one strict output contract. If `generateCaption` returns malformed JSON, the editor falls back to the structured summary's caption field. If `summarize` fails, the editor opens with no AI assist and the user can compose by hand. If `classifyTodo` fails, the todo stays at `type='todo'` and `classifier_confidence=null`, and the next boot's catch-up retries. Each failure is local; none cascade. That's by design.

```
                 ┌─────────────────────────────────────────┐
                 │  User taps "compose" in editor          │
                 └──────────────────┬──────────────────────┘
                                    │
                                    ▼
                 ┌──────────────────────────────────────────┐
                 │  summarize(date) — src/services/ai/      │
                 │   summarize.ts                            │
                 │   Reads:                                  │
                 │     • getEntriesByDate(date)              │
                 │     • clip metadata + durations           │
                 │   System prompt: buildPrompt(...)         │
                 │   Model:  Claude Sonnet 4.6 (default)     │
                 │           or GPT-4o (if user prefers)     │
                 │   Output: AISummary JSON                  │
                 │   Validate: validateSummary(parsed,...)   │
                 │   Persist: upsertAISummary(...)           │
                 └──────────────────┬───────────────────────┘
                                    │ (best-effort, in same call)
                                    ▼
                 ┌──────────────────────────────────────────┐
                 │  generateCaption(input) — caption.ts     │
                 │   Inputs: rawLog (sentence-split),        │
                 │           recentCaptions[5] (anti-repeat),│
                 │           moodLabel                       │
                 │   Single LLM call; emits 4 variants:      │
                 │     {clean, smoother, reflective, punchy} │
                 │     + detectedTheme                       │
                 │   On failure: editor falls back to        │
                 │   summary.caption (single-line)           │
                 └──────────────────────────────────────────┘


              ┌────────────────────────────────────────────────┐
              │  Async, on every new ambiguous todo            │
              └─────────────────┬──────────────────────────────┘
                                │
                                ▼
              ┌────────────────────────────────────────────────┐
              │  reconcileTodoMeta inserts new meta with       │
              │  type='todo', classifier_confidence=null       │
              └─────────────────┬──────────────────────────────┘
                                │
                                ▼
              ┌────────────────────────────────────────────────┐
              │  scheduleClassify(todoId, text)                │
              │   classifyTodo(text) — src/services/todos/     │
              │     classify.ts                                 │
              │   Model: Claude Haiku 4.5 (cheap, fast)         │
              │   Output: { type, confidence, model }          │
              │   On success: updateTodoMeta(todoId, {type, …})│
              │   On failure: row stays ambiguous;             │
              │   next-boot catch-up retries.                  │
              └────────────────────────────────────────────────┘
```

Note the asymmetry. The compose pipeline is *synchronous from the user's gesture* — they tap "compose" and wait through both calls. The classifier is *asynchronous from any gesture* — the user types `[] something`, leaves the journal, the meta row is inserted with the heuristic-or-default type, and the LLM classifier fires in the background. The user never waits for the classifier; the classifier always works without the user. That's a deliberate split based on whether the AI is *creative* (compose, where the user wants the answer now) or *housekeeping* (classify, where the user shouldn't even know it ran).

## Concept 1 — Heuristic before LLM

**Shape.** Three pieces in `src/services/todos/`: `heuristicClassify(text)` returns a `TodoType | null` based on keyword regexes (e.g. lines starting with "should I" → `question`); `classifyTodo(text)` calls Claude Haiku for an LLM classification with confidence; `reconcileMeta.ts:reconcileTodoMetaForEntry` runs the heuristic inline and only fires `scheduleClassify` if the heuristic returned `null`.

**Rule.** The cheap classifier runs first. If it produces a confident-enough output (any non-null), the LLM is skipped. The LLM is the *fallback* for ambiguous cases, not the default.

**Failure mode.** The naive "always LLM" version classifies every new todo by calling Claude Haiku. With 100 todos per day, that's 100 API calls per day at $0.0001 each — $0.30 per user per month. Trivial cost-wise but the latency adds up: each call is ~300ms, and the AI configuration could be temporarily unavailable (network, rate limit, missing key). Fail-open with type='todo' would erase the classifier's value; fail-closed with a spinner would block the journal. The heuristic-first model handles ~40% of todos for free and zero-latency, so the LLM is reserved for the 60% where there's genuinely ambiguity to resolve.

**Contrast.** The compose pipeline does *not* heuristic-first. There is no algorithmic version of "summarize this user's day"; the only sensible output is from the LLM. The constraint that distinguishes them is *whether a deterministic alternative exists*. Classification is enumerable (7 types, finite keyword patterns); summarization is open-ended.

## Concept 2 — Structured output with validation, not prompt engineering

**Shape.** Three pieces in `src/services/ai/`: `prompt.ts:buildPrompt(...)` (assembles the system + user prompts with strict JSON schema instruction), `summarize.ts` (the call site, extracts JSON from the response), `validate.ts:validateSummary(parsed, clipIds, clipDurations)` (validates and clamps the parsed output, returning errors as warnings).

**Rule.** The output is parsed as JSON, validated against a schema, and any clip references are checked against the actual clip set. Prompt-level instructions are *suggestions to the model*, not contracts. The contract is enforced by the validator.

**Failure mode.** "Trust the prompt" looks like: regex-extract the JSON, parse, render. If the model emits a clip ID that doesn't exist in the input set (a hallucination), the editor renders a clip slot pointing at nothing. If the model emits a duration in seconds when the prompt asked for milliseconds (subtle but real with newer models drifting), the editor's timeline scales wrong. The validator's job is to *not crash* on either case — it logs a warning, drops the bad clip reference, and keeps the rest of the summary. The user sees a slightly incomplete suggestion instead of a broken screen.

**Contrast.** The classifier validates by enumeration (the `type` field must be one of seven strings) and refuses to apply if it's not. The compose pipeline validates by reference (clip IDs must match the input clips) and accepts a partial summary. The constraint that distinguishes: classification is binary truth (the model got the type right or it didn't), summary is gradient quality (a summary missing two clips out of ten is still mostly useful).

## Concept 3 — 4-variant tonal captions in one call

**Shape.** `src/services/ai/caption.ts:generateCaption(input)` makes a single LLM call (Claude Sonnet or GPT-4o) with a system prompt that defines four voices (`clean`, `smoother`, `reflective`, `punchy`) and instructs the model to return a JSON object with all four. The output is parsed by `parseAndValidate` which requires *all four* variant keys to be present — partial output is treated as malformed.

**Rule.** All four variants describe the same day. Only the surface changes between voices. Required fields: 3 body lines per variant, no first/second-person pronouns, no hashtags or emojis, no questions or exclamations, no motivational platitudes ("trust the process"). The `detectedTheme` field is one of six labels (`growth | discipline | clarity | struggle | shift | curiosity`).

**Failure mode.** The naive "four prompts, four calls" version runs the model four times. The same day gets described four times, but the model's per-call randomness means the four versions might disagree on what the day was *about* — `clean` mentions the morning workout, `punchy` doesn't, `reflective` mentions a different conversation. The user sees four captions that don't feel like the same vlog. One call with four required outputs forces the model to do the topic selection once and re-voice it; the surface changes, the substance stays.

The implementation cost: the system prompt is ~100 lines because each voice needs its example body and forbidden patterns. The `max_tokens: 768` allows headroom for verbose models. Output validation requires all four keys present — `parseAndValidate` returns `null` if any variant is missing, and the editor falls back to the structured summary's single-line caption.

**Contrast.** The structured summary's caption field is *one* line, and it's generated in the same call as the rest of the summary — no separate call. The four-variant call is its own pass. Why the split? Because the structured summary's prompt is hard-strict on JSON shape (clip IDs, mood enum, etc.) and the caption prompt needs creative flexibility plus its own forbidden-pattern list. Mixing them grew the system prompt to 200+ lines and the model started leaking caption forbidden-patterns into the structured prose, which is a regression. Separating the calls is an engineering decision that traded one extra API call for prompt quality on both sides.

## Concept 4 — Anti-repetition via recent-captions context

**Shape.** Three pieces in `summarize.ts:buildCaptionInput`: `getRecentAISummaries(date, 5)` fetches the last 5 cached `ai_summaries` rows, the function pulls each row's `caption` field, and passes them into the caption call as `recentCaptions: string[]`. The system prompt instructs: "Recent captions (avoid repeating phrasing or formula): ...".

**Rule.** The model sees the user's last 5 captions as anti-context. The new caption should not repeat phrasing patterns from those 5.

**Failure mode.** Without anti-context, the model converges on its favorite phrasings. After 30 days the captions all start with present-progressive verbs ("Realizing how much...", "Starting to see..."), or they all use the same metaphor ("the bridge between..."), or they all share the same 3-line shape. The result reads as auto-generated even when the underlying days are different. With the anti-context, the model is *steered away* from the patterns it just used. Empirically this works — captions over a week look more varied than they would without the prior-5 nudge.

**Contrast.** The structured summary doesn't get the same anti-context. There's no `recentSummaries` field. Why? Because the structured summary's outputs (mood enum, clip order, habit list) are *truth-functional* — there's a right answer for the day and the model should produce it. Diversifying mood enum values just to avoid repetition would be wrong. Captions are aesthetic choice; summaries are factual. Anti-repetition belongs only to the aesthetic side.

## Three interview questions

### `[mid]` — "Why do you make two LLM calls per compose instead of one?"

I split the compose into a structured-summary call (`summarize`) and a caption call (`generateCaption`) because the two outputs have different reliability requirements and different prompt complexity. The structured summary is JSON with strict shape — clip IDs that must reference actual clips, a mood field that must be one of five enum values, a habit list that must subset the day's actual habits. The validator in `src/services/ai/validate.ts` enforces all of this and drops bad fields. The caption is creative text in four tonal variants with its own forbidden-pattern list (no "I"/"you", no hashtags, no platitudes).

When I tried to combine them — one prompt, one call, both outputs — the system prompt grew to 200+ lines and quality on both halves regressed. The model started leaking caption forbidden-patterns into the structured summary's prose, and the structured-summary's strict-JSON discipline started constraining the caption's creative range. The two calls have different optimal prompt structures, so they live in separate prompts.

The cost is one extra API call per compose — about 300ms of additional latency and roughly $0.005 in Anthropic charges. I think that's a reasonable trade for a clean separation. The alternative — one call with worse output on both sides — would land the user with a worse-feeling app to save 300ms they're already waiting for the summary.

The fallback chain: if `summarize` fails, the editor opens with no AI assist (user composes by hand). If `summarize` succeeds but `generateCaption` fails, the editor uses the structured summary's `caption` field (single-line, less voice-rich, but always present). The caption call is wrapped in a try/catch in `summarize.ts:87` exactly so a caption-API regression can't fail the whole compose.

### `[senior]` — "How do you handle prompt drift across model versions?"

This is the question I think about most when shipping AI features. The answer in buffr is *defensive parsing plus explicit model pinning*, not prompt engineering.

Model pinning: `CLAUDE_MODEL = 'claude-sonnet-4-6'` is a constant in both `summarize.ts:9` and `caption.ts:21`. The OpenAI side uses `'gpt-4o'`. I don't auto-upgrade. When Anthropic ships a new model, I evaluate manually on a fixed set of test prompts before bumping the constant. The classifier uses `'claude-haiku-4-5'`. Three pinned constants, three independent upgrade decisions.

Defensive parsing: the response goes through `text.match(/\{[\s\S]*\}/)` to extract the first JSON-like substring, then `JSON.parse`. If either fails, I return a structured error and the caller falls back. The caption parser is stricter — it requires all four variant keys present and applies `normalizeVariant` (trim, take first 3 non-empty lines) so a model that emits 4 lines instead of 3 is silently truncated rather than rejected. The `detectedTheme` field is whitelisted against six valid strings; anything else falls back to `'clarity'`.

The pattern that I've found works: write the prompt to specify the contract, then write the validator assuming the contract will be violated. When a new model version drifts, the validator drops the bad fields and logs a warning, the user sees a slightly degraded output, and I get a console log that tells me the prompt needs tightening. The validator is what makes the compose pipeline robust to model changes; the prompt is just the polite request.

What I haven't done: golden-set regression tests. I'd want a fixture of 20 (entries → expected summary) pairs that I run before each model bump, with a similarity threshold on the caption output. That's on the deferred backlog. It's not done because manual evaluation has been sufficient for one-engineer velocity.

### `[arch]` — "How does the AI architecture change at 100K users?"

Three changes, in priority order.

First, **the user's keys move to a server.** Right now `expo-secure-store` holds each user's Anthropic / OpenAI key on-device. With 100K users, the cost of "user must provide key" is friction-fatal — most users won't. The keys move to my backend (Supabase Edge Function or a dedicated proxy), my account pays for the calls, and the per-user cost becomes a budget I have to model. At average ~$0.01 per compose × 30 composes/month per active user × 100K users, that's $30K/month of AI spend. The architecture grows a budget gate: per-user compose limits (free tier: 5/month, paid tier: unlimited), a rate limiter on the proxy, and prompt caching to cut Anthropic costs by ~50% on repeated structured-summary instructions.

Second, **classification moves to a batch / queue model.** Today's classifier fires per-todo on the device. At 100K users with ~20 ambiguous todos per day per user, that's 2M classifier calls daily — well above any sensible per-user concurrency limit and a reasonable fraction of Anthropic's per-org rate limit. The architecture shifts: the device emits "classify this todo" events into a queue (Supabase realtime / a job table), a worker batches 50 todos at a time into one structured-output call, and writes back the results. The user's UI doesn't change — the classifier still runs eventually. The cost drops because batched calls amortize fixed overhead across 50 outputs.

Third, **prompt caching becomes load-bearing.** The Anthropic API supports prompt caching with a 5-minute TTL on cached prefixes. The structured-summary system prompt is ~80 lines and is identical across every compose call — that's a perfect cache target. Adding `cache_control: { type: 'ephemeral' }` markers in the system prompt cuts the per-call cost by ~50% after the first call in a 5-minute window. At 100K users this is meaningful spend reduction; at solo scale it's pennies. The reason it isn't done now: the cost isn't worth the prompt-engineering attention.

Two things stay. The provider switch (Anthropic vs OpenAI) at the service-layer abstraction stays — that's a strategic insurance against single-vendor pricing changes and I'd want it even at scale. And the heuristic-first / LLM-fallback pattern for classification stays, because no amount of cost reduction makes "always LLM" cheaper than "free heuristic when available."

## The hard question — "How do you know the LLM output is good? Where's the eval set?"

There isn't one. There is no automated eval, no golden set, no regression suite for any of the three AI surfaces. The verification I have is *me reading the output* over months of using the app on my own data.

The honest gap: when I bump the Claude model from Sonnet 4.6 to Sonnet 4.7, I will not know how that affects compose quality without manually composing some days and reading the result. If 4.7 starts emitting captions in second-person ("you spent the morning...") in 5% of cases, I'll find out when a user reports it, not before. The classifier catch-up will catch type drift on the next boot's pass — a Haiku regression could re-classify hundreds of existing todos and silently change them in the cloud, since `user_overridden_type=false` is the default and means "the LLM is allowed to revise this." That's a real risk I haven't mitigated.

What I've done that's not nothing: the `validate.ts` and `parseAndValidate` paths check structural invariants. A model that returns malformed JSON, or a clip ID that doesn't exist, or a mood enum value outside the five allowed, gets dropped or warned about. So *catastrophic* output (rendering a vlog with a broken clip pointer) is prevented; *subtle* quality regression (captions getting a touch worse, classifier bias creeping in) is not.

What I'd build for production:

1. **Golden-set regression for compose.** 20 hand-picked (date, entries) pairs with hand-written expected summary structure. Before each model bump, run all 20 through the new model and compare structured fields exactly + caption output via embedding similarity (>0.85 to last-known-good). Fail the bump if any of 20 regresses.
2. **Classifier confusion matrix.** Sample 500 user-overridden classifications (where the user manually picked a type, indicating the LLM was wrong) and compute confusion-matrix entries. A spike in any cell indicates the classifier is systematically wrong on that pair.
3. **Caption quality survey.** A `❤️` / `👎` button on each caption variant in the editor, persisted to a local "caption_feedback" table. Aggregated client-side; surfaces to me on the dev menu. Cheap signal of "do users like the variants the model is generating."

None of these are built. I know they should be. They're below the line because solo-use has been my own eval set, and the failure mode of shipping each is "I notice within a week and revert the model bump." That math changes the moment a real user base is reading the output.
