# 01 — Agentic AI in loopd

This chapter covers how loopd uses LLMs in production. loopd is **not** an "AI agent" in the conversational-loop sense — it has no ReAct loop, no autonomous tool calling, no message history. What it has is something more practical: **a small number of well-defined LLM calls, each with a single job, chained where useful and cached when possible.** That is the dominant shape of "AI in production" right now, and it's exactly what you should learn first.

> If you came here expecting "let's build an agent that browses the web," that's a different curriculum. This one is about how a real product uses LLMs as **typed components in a typed pipeline** — which is the harder and more transferable skill.

---

## 1.1 LLM call vs. agent — and why loopd is the former

**Difficulty:** foundational

**What it is.** An LLM call is a stateless request: input text in, output text out, you parse it. An "agent" wraps that in a loop where the model can call tools, observe results, and decide its own next step. loopd uses zero agents and four kinds of LLM calls: classify, expand, summarize, caption.

**Where it lives.** All four call sites are in `src/services/`:
- Classify: `src/services/todos/classify.ts:90-120`
- Expand: `src/services/todos/expand.ts:211-266`
- Summarize: `src/services/ai/summarize.ts:42-104`
- Caption: `src/services/ai/caption.ts:139-159`

Read each file's first 20 lines. Notice: every call is a one-shot HTTP request. None of them keep a conversation. None of them ask the model what to do next.

**Why it exists.** Agents are powerful but expensive in latency, cost, and surprise. For a journaling app where each AI feature has a clear, narrow job ("classify this todo," "write a caption for this day"), a stateless call is faster, cheaper, easier to debug, and trivially retryable. The "decide what to do next" logic lives in **TypeScript**, not in the model.

**General rule.** Reach for an agent only when the problem genuinely requires the model to decide its own next step. For everything else — classification, extraction, transformation, generation against a known schema — write a one-shot call and keep the orchestration in your own code.

---

## 1.2 Heuristic-before-LLM (cheapest model path)

**Difficulty:** foundational

**What it is.** A discipline: when a problem can be partially or fully solved with a deterministic heuristic, run the heuristic first. Only fall through to an LLM call when the heuristic is uncertain. This is one of loopd's twelve architectural principles (Principle 10).

**Where it lives.** The cleanest example is the todo classifier, which is a two-stage system:

1. **`src/services/todos/heuristicClassify.ts:71-102`** — pure regex + word-list. Returns `'todo'` only when confident; returns `null` (uncertain) otherwise. Free, instant, deterministic. Catches imperative verbs (`fix`, `send`, `call`), modal phrases (`gotta call`, `need to fix`), deadline patterns (`by tomorrow`, `eod`). Bails on questions, speculation, observation.

2. **`src/services/todos/classify.ts:90-120`** — fires only when the heuristic returns null AND the todo isn't done. Uses the **cheapest** configured model (`gpt-4o-mini` or `claude-haiku-4-5-20251001`), not the primary one. Single-pass JSON output, ~50 tokens, ~$0.0001 per call.

The wiring sits in `src/services/todos/reconcileMeta.ts:55-82` — heuristic runs inline at commit time; LLM is fire-and-forget if heuristic returned null.

**Why it exists.** Most todos in a journal app are obvious (`fix the build`, `call mom`, `buy milk`). Sending every one to an LLM would be wasteful — slow on the user's perception, expensive on their key, and brittle on retry. The heuristic catches the obvious 60–70% for free; the LLM is reserved for the actually-ambiguous 30%.

**General rule.** Before reaching for an LLM, ask: *can a regex, a word list, or a 20-line function answer this most of the time?* If yes, write that first. The LLM becomes a **fallback** for the ambiguous tail, not the primary mechanism.

> Spec context: the heuristic is intentionally tuned to over-fire on `null` (false negatives → cheap LLM call; false positives → manual override). See the comment in `heuristicClassify.ts:1-7`.

---

## 1.3 Two-stage classification (cheap model → expensive model split)

**Difficulty:** intermediate

**What it is.** Splitting a single AI feature across two models of different price tiers, where each model has a different *job*. loopd does this for todos: a cheap classifier decides the **type** (`idea` / `bug` / `question` / `decision` / `knowledge` / `content` / `todo`), then later a primary model produces the **structured expansion** for that type.

**Where it lives.**
- Classifier: `claude-haiku-4-5-20251001` or `gpt-4o-mini` in `src/services/todos/classify.ts:7-8`. ~$0.0001 per call. Fires on every ambiguous new todo.
- Expander: `claude-sonnet-4-6` or `gpt-4o` in `src/services/todos/expand.ts:20-21`. ~$0.04–0.05 per call. Fires only when the user manually taps `[expand]` on a non-todo row.

The classifier is **eager** (runs automatically); the expander is **lazy** (runs only on user request). That's the second axis of the split: cost separation alone isn't enough — pair it with **trigger separation** so the expensive call gates on a real user signal.

**Why it exists.** Classifying a captured thought is high-volume (every `[]` line in the journal generates one). Expanding a thought into a structured "decision with reasons and a revisit-when condition" is high-value but rare. Using the same model for both would either overspend on classification or undershoot on expansion. The price-and-purpose split lets each tier do what it's good at.

**General rule.** If your AI feature has a high-volume, low-value step and a low-volume, high-value step, **split them across model tiers**. Cheap-model-as-router, expensive-model-as-worker is a powerful pattern — and it lets you afford to do *more* of the expensive thing because the cheap step has paid for itself many times over.

---

## 1.4 Provider abstraction (Anthropic vs OpenAI)

**Difficulty:** intermediate

**What it is.** A pattern where the same business-level function works against multiple LLM providers behind a thin compatibility layer. loopd lets the user pick Claude (default) or GPT-4o; the call site transparently uses whichever is configured.

**Where it lives.** The pattern repeats in **every** AI module:
- `src/services/ai/summarize.ts:12-40` — `callClaude` and `callOpenAI`, then `summarize` picks one based on `getProvider()`.
- `src/services/todos/classify.ts:40-69` — same shape, smaller models.
- `src/services/todos/expand.ts:31-60` — same shape again.
- `src/services/ai/caption.ts:84-113` — same shape, fourth time.

The provider is selected by `getProvider()` in `src/services/ai/config.ts`; keys are stored in SecureStore and fetched by `getAnthropicKey()` / `getOpenAIKey()`.

**Why it exists.** Two reasons: (a) the user might already pay for one provider but not the other — forcing them to sign up for Anthropic just to use loopd would be a bad onboarding; (b) provider outages happen, and being able to switch is a cheap form of insurance. The abstraction is **not** a future-proofing fantasy — it's a real product affordance exposed in `app/settings/ai.tsx`.

**General rule.** Abstract what changes; stabilize what doesn't. The shape "give me the model's text response for this system + user prompt" is stable across providers; the SDK and the JSON shape are not. Hide the unstable part behind two functions with the same signature, and the rest of your code never needs to know which provider is live.

> **Note on the abstraction's shape.** loopd uses **duplicated `callClaude`/`callOpenAI` pairs in each AI module** rather than a single shared `callLLM(provider, system, user)` helper. This is intentional pragmatism — the modules differ in `max_tokens`, `response_format`, and how they parse the response, so a "shared" helper would either be too rigid or take a dozen options. **Implementing a shared helper is a great learning exercise** — try it, then notice what you'd have to give up.

---

## 1.5 Prompt chaining (structured summary → relatable caption)

**Difficulty:** intermediate

**What it is.** Two LLM calls run sequentially against the same input, where each call has a single, narrow job. The output of the first becomes part of the input of the second.

**Where it lives.** The vlog AI flow in `src/services/ai/summarize.ts:42-104`:

1. **Call 1 (structured summary)** at `summarize.ts:68-78` — emits an `AISummary` JSON: headline, summary, mood, clip order, trims, text overlays, filter preset. Validated and clamped by `validateSummary`. This is the editor's "scaffold."
2. **Call 2 (relatable caption)** at `summarize.ts:85-95` — calls `generateCaption(input)` from `src/services/ai/caption.ts`. Takes the day's text + done-todos + last 5 cached captions for tonal continuity. Emits a 2–4 line `caption`, a 2-line `alternate`, and a `detectedTheme`. The caption fields are *added back onto* the structured summary before caching.

The second call is wrapped in `try/catch` and **doesn't fail the chain** — if the caption fails, the editor falls back to using the structured summary's `summary` field for the text overlay. See `summarize.ts:85-95` and `compose.ts` for how that fallback is consumed.

**Why it exists.** Each call has a different prompt discipline. The structured summary needs strict JSON shape and clip-ID validity. The caption needs voice rules ("never start with 'Today I…'", "no hustle language") and a detected theme. Cramming both into one prompt would make each part worse — the model would either over-formalize the caption or break the structured shape under voice constraints. Chaining two narrow prompts produces better output than one wide one.

**General rule.** One prompt, one job. When you find yourself adding a second concern to a working prompt, consider a second call instead. You will pay one extra round-trip; you will get back **two prompts that each stay tight**, plus the ability to retry, cache, or skip them independently.

---

## 1.6 Chain-of-thought reasoning preambles

**Difficulty:** intermediate

**What it is.** Embedding "before you answer, think about X, Y, Z" instructions in the **system prompt** to push the model through a deliberate reasoning step before it produces structured output.

**Where it lives.** `src/services/todos/expandPrompts.ts:7-14` — the `PREAMBLES` map. Each of the six expandable types (idea / bug / question / decision / knowledge / content) gets a custom 2–3 line preamble:

```ts
idea: `Before structuring this idea, think about: Is this solving a real problem
or just interesting? What's the simplest version of this? What existing patterns
relate to it? What would make this a bad idea?`,

bug: `Before writing the report, reason through: What component or layer is this
likely in, given the stack? What recent changes from the day's entries could have
caused this? Are any sibling todos related? What would you check first if
debugging this?`,
```

Folded into the system prompt by `getSystemPrompt(type)` at `expandPrompts.ts:66-78`.

**Why it exists.** A bug expansion that just spits "observed / expected / repro steps" without reasoning produces a less useful report. Forcing the model to consider "what could have caused this given recent context" before writing the structured output produces materially better expansions, even though the final JSON output doesn't include the reasoning.

**General rule.** Before structured output, ask the model to reason. The structured part stays clean; the reasoning happens in tokens that don't escape into your data layer. This works because modern models are better when they "think" before they "answer," even when only the answer is parsed.

---

## 1.7 Output validation + retry-with-stricter-instruction

**Difficulty:** intermediate

**What it is.** Defensive parsing of LLM output: parse the JSON, validate it against an expected shape, and on failure retry once with a stricter system-prompt addendum.

**Where it lives.** `src/services/todos/expand.ts:243-250`:

```ts
let expansion = await callOnce();
if (!expansion) {
  // Retry once with a stricter instruction.
  expansion = await callOnce('Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema. No commentary.');
}
if (!expansion) {
  return { ok: false, reason: 'malformed' };
}
```

The validation itself sits in `validateExpansion()` at `expand.ts:77-142` — a discriminated switch over the six expansion types, building a typed object and returning `null` on shape mismatch. The summary call has a similar pattern in `src/services/ai/validate.ts` (with clamping for clip ranges).

**Why it exists.** Models occasionally violate the JSON schema — extra prose around the JSON, missing required fields, wrong enum value. The retry-with-stricter-prompt pattern recovers most of those failures cheaply (one extra call). The double-fail then surfaces a typed error (`reason: 'malformed'`) the UI can show.

**General rule.** Treat LLM output as **untrusted input**. Validate against a schema; retry once with a hint when validation fails; surface a typed error on the second failure. Never trust that "the prompt says JSON" actually produces JSON.

---

## 1.8 In-flight concurrency cap + progress events

**Difficulty:** intermediate

**What it is.** A module-level counter (or set) that bounds how many simultaneous LLM calls can be active, paired with an event emitter so UI can show progress without coupling to internal state.

**Where it lives.**
- Classifier in-flight counter: `src/services/todos/classify.ts:36-38, 96-98, 117-119`. Single `_inFlight` integer; bumped/decremented in try/finally. UI subscribes to `CLASSIFY_PROGRESS_EVENT` to show a "classifying N todos…" toast.
- Expand in-flight set: `src/services/todos/expand.ts:25-28, 224-225, 263-264`. A `Set<string>` of todoIds, capped at `MAX_CONCURRENT = 3`. Calls beyond the cap return `{ ok: false, reason: 'in-flight-cap' }` immediately.

**Why it exists.** Two problems solved together: (1) preventing runaway concurrency on the user's API key (each expand is ~$0.05; stacking 20 in parallel is a rude bill); (2) decoupling the UI's "is anything happening" from the call-site code. UI subscribes to events; call sites just bump a counter.

**General rule.** Whenever a function spawns an external API call, track in-flight count at module scope and cap it. Emit progress events so consumers don't need to thread state through. The pattern is small, cheap, and makes runaway costs structurally impossible.

---

## 1.9 Caching LLM output (per-date AI summary cache)

**Difficulty:** foundational

**What it is.** Storing the LLM's parsed output in a local table keyed by some natural identifier, so re-mounting a screen or re-opening the app doesn't re-call the model.

**Where it lives.** The `ai_summaries` table in `src/services/database.ts` — `summary_json` (the merged structured + caption output as JSON), `generated_at`, `model`. Keyed by `date`. Written by `upsertAISummary(date, json, model)` at the end of `summarize.ts:97`. Read by `getAISummary(date)`. The editor's three caption variants (PRIMARY / ALT / SUMMARY) are all served from this single cached row — see `src/services/ai/compose.ts` and `app/editor/[date].tsx`.

**Why it exists.** A vlog summary call costs ~$0.05 and takes 3–8 seconds. The user re-enters the editor often (tweak a clip, scrub the timeline, come back tomorrow). Re-running the LLM each time would be slow, expensive, and produce subtly different output every time — which is *worse* than caching, because the user then can't reproduce what they saw yesterday.

**General rule.** If an LLM call's input is stable (or stable-enough), cache the output. Use a natural key (date, entity ID, content hash). The cache is also a determinism patch: if the model produces a slightly different answer on re-run, you've already committed to one — your user remembers *that* one.

---

## 1.10 Bounded context windows (cap context inputs by length)

**Difficulty:** intermediate

**What it is.** Hard caps on how much surrounding context you put into a prompt, regardless of how much is "available." Prevents the prompt from blowing up on heavy-data days.

**Where it lives.**
- Expansion context: `src/services/todos/expand.ts:147-199` builds the context block (entry text + 5 sibling todos + last 3 days of entries). The 1000-char-per-recent-entry cap is mentioned in the spec at §6.4 and cited in `expandPrompts.ts:97-98`.
- Caption context: `src/services/ai/summarize.ts:130-139` pulls the last 5 cached captions only. Five is a deliberate small number — enough for tonal continuity, not so many that anti-repetition becomes pointless.

**Why it exists.** A heavy journaling day could have 5000+ chars of entry text. A user with 90 days of usage could have hundreds of cached summaries. Without caps, the context grows unboundedly — costing more, slower, and eventually hitting model context limits. Bounded caps trade some context-quality for stable cost and latency.

**General rule.** When you assemble context from a growing dataset, cap the **per-item size** AND the **item count**. Both. Pick numbers based on what you can defend in token cost and what the prompt can productively use; revisit them when you change models or features.

---

## 1.11 Boot-time catch-up loop (reprocess incomplete state)

**Difficulty:** intermediate

**What it is.** A boot-time pass that walks rows in some "incomplete" state and re-runs the AI step that should have completed them. Self-quiet when no AI is configured.

**Where it lives.** `classifyAmbiguousMeta()` in `src/services/todos/migrateMeta.ts` (referenced from `app/_layout.tsx`). On every cold start, it:

1. SELECTs every `todo_meta` row with `classifier_confidence IS NULL`.
2. Skips rows that are done or `user_overridden_type = 1`.
3. For each remaining row, calls `classifyTodo(text)` and writes the result back.

If no AI key is configured, the function returns silently — no errors, no nags.

**Why it exists.** Three reasons: (a) the AI classifier may have been unconfigured when the user wrote the todo; (b) a previous classify call may have failed (network, rate limit); (c) a backfill migration only runs the heuristic, never the LLM, and leaves ambiguous rows for catch-up. Without the boot pass, those rows would stay unclassified forever or until the user manually edited them.

**General rule.** Any AI step that can fail (no key, network down, rate limit) should leave its row in a *recognizable incomplete state* — and the system should have a boot-time loop that picks up incomplete rows and retries. It's idempotent (if the row got completed since the last boot, the SELECT excludes it), self-quiet (nothing to log if there's nothing to do), and self-healing (eventually-consistent without user intervention).

---

## 1.12 Concepts not present (and why)

This codebase is **not** doing several things that often appear in "agentic AI" curricula. Naming them helps you recognize when you would need them:

- **No tool calling / function calling.** The AI never decides to "fetch the user's location" or "call an external service." All inputs to AI calls are gathered by TypeScript code first; the AI only sees prepared text.
- **No conversation memory.** Each AI call is one-shot. There's no thread of past turns sent on each call. The closest thing is "last 5 cached captions" passed as context, but that's a curated subset, not a conversation history.
- **No autonomous loop.** No "while not satisfied: call model, observe, act." Every flow has a fixed number of LLM calls (1 or 2), determined by code.
- **No vector search / RAG.** Context is assembled from the local SQLite database with simple WHERE-clauses, not embeddings. The dataset is small (single user, hundreds of entries); embeddings would be over-engineering.
- **No fine-tuning.** Prompts and provider settings are the only knobs.

If you came in wanting to learn agents-with-tools, this is a gap — but it's a **real-world** gap. Most production AI features look like loopd's, not like a ReAct loop. Learning to build narrow, validated, chained calls first is the right order.
