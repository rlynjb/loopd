# Chapter 01 — Agentic AI

This codebase is **not** a chat agent. There is no ReAct loop, no tool-calling planner, no autonomous orchestration. But it does run multiple LLM calls cooperatively, with a deliberate cheap-first / expensive-second pipeline that mirrors many of the patterns you'd see inside a real agent. Read this chapter as "how production AI workflows look when you strip away the agent framework and just write the code."

---

## 1.1 Heuristic-before-LLM gating · `foundational`

**What it is.** Before any LLM call is made, run a deterministic free function that may answer the question on its own. The model is invoked only when the heuristic returns `null` (uncertain). This is also called the "cheap path" or "deterministic prefilter" pattern.

**Where it lives.** `src/services/todos/heuristicClassify.ts:71-102`. The function `heuristicClassify(rawText)` returns `'todo' | null`. It checks question marks, speculative starts ("maybe", "what if", "noticed"), question-shape leads ("why", "how", "is"), modal verbs ("gotta", "need to"), deadline patterns ("by tomorrow", "EOD"), and a list of ~50 imperative verbs. Only if all of those fall through does it return `null`, at which point the LLM classifier in `src/services/todos/classify.ts` fires.

**Why it exists.** Two-stage classification is **principle 10** of the codebase ("heuristic before LLM" — see `docs/spec.md:461`). The heuristic is free, sub-millisecond, deterministic, and debuggable. The LLM is none of those. The spec accepts deliberate overfire on `null` (false negatives cost a cheap model call, false positives cost a manual user override) — the asymmetric cost is the design.

**General rule.** When a feature needs classification, scoring, or routing, write the deterministic version first. Only fall through to a model when the deterministic version is genuinely uncertain. You will be shocked how often the heuristic alone is enough — and on the calls that do hit the model, you will have a clean test set (the lines the heuristic couldn't decide) to evaluate against.

> **Go deeper.** Read `heuristicClassify.ts` end-to-end. Notice that it never returns a non-todo type (idea/bug/etc.) — those are *only* assignable by the LLM. That's a deliberate boundary: the heuristic restricts itself to the easy half of the problem.

---

## 1.2 Two-stage classifier → expander pipeline · `intermediate`

**What it is.** A two-call AI workflow where Stage 1 uses the **cheapest** available model to assign a category label, and Stage 2 uses the **most capable** model — and only on user demand — to expand the labeled item into a structured per-type output. The two stages run on different schedules and against different models.

**Where it lives.**
- Stage 1 (classify): `src/services/todos/classify.ts` — uses `gpt-4o-mini` or `claude-haiku-4-5-20251001`. Runs fire-and-forget after every entry commit, plus a boot-time catch-up pass via `classifyAmbiguousMeta()` in `src/services/todos/migrateMeta.ts`.
- Stage 2 (expand): `src/services/todos/expand.ts:211-266` — uses `gpt-4o` or `claude-sonnet-4-6`. Runs only when the user taps `[expand]` on a non-todo row. Capped at 3 concurrent (line 25, `MAX_CONCURRENT = 3`).

**Why it exists.** Classification is high-volume / low-stakes (every todo, automatic). Expansion is low-volume / high-stakes (one todo at a time, user-initiated, ~$0.04–0.05 per call per the comment at line 24). Using the same model for both would either waste money on classification or short-change quality on expansion. Splitting the pipeline lets each stage pick the right model for its cost/quality tradeoff.

**General rule.** Never spend GPT-4o money on a job that GPT-4o-mini can do. Identify the *cheapest model that meets the bar* for each stage of your AI pipeline and route accordingly. The cost difference between Haiku and Sonnet is roughly 10×; between mini and full GPT-4o, similar. Routing right is free money.

---

## 1.3 Structured-output prompting with per-type JSON schemas · `intermediate`

**What it is.** Instead of asking the model for free-form text and parsing it, hand the model an explicit JSON schema and instruct it to emit *only* that. Each task type gets its own schema (one for `idea`, one for `bug`, etc.) so each can be small and focused.

**Where it lives.** `src/services/todos/expandPrompts.ts:18-55` defines six per-type `SCHEMAS` and `getSystemPrompt()` injects the schema verbatim into the system message. The user message is built by `getUserMessage(todoText, ctx)` at line 98. Validation against the emitted shape happens in `src/services/todos/expand.ts:77-142` (`validateExpansion`).

**Why it exists.** Free-form text "explain this todo" wouldn't compose with the markdown renderer in `expandSerialize.ts`. By forcing the model to a `{ what, why, conditions, firstStep }` shape (for ideas), the downstream code can render predictably. Per-type schemas (instead of one big union) keep each prompt focused and measurable in isolation — when "bug" expansions degrade, you can iterate on just the bug prompt without regressions in the other five.

**General rule.** When the model output flows into code, demand structured output and validate it. When it flows to a human, free-form may be acceptable. The validate-and-retry loop (next concept) lets you stay strict about structure without an over-eager error path.

---

## 1.4 Validate-and-retry on malformed JSON · `intermediate`

**What it is.** After the first LLM call, parse the response. If it's malformed (not JSON, missing required fields, wrong enum value), call the model again with a stricter instruction tacked onto the system prompt. Once.

**Where it lives.** `src/services/todos/expand.ts:243-250`. The retry instruction is literally: `"Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema. No commentary."` After the second failure, the call returns `{ ok: false, reason: 'malformed' }` — no infinite loop.

**Why it exists.** Even a structured-output prompt occasionally gets a model that prepends "Sure, here's the JSON:" or wraps the output in fences. One retry with the stricter instruction recovers ~95% of those cases at the cost of one extra model call. Without it, the user sees a generic failure.

**General rule.** Retry once on validation failure with explicit feedback to the model about what was wrong. Do not retry indefinitely (cost runaway) and do not retry on transport errors with the same retry path (different failure mode, different fix).

---

## 1.5 Chain-of-thought reasoning preambles · `intermediate`

**What it is.** A short paragraph in the system prompt that tells the model what to *think about* before producing output, even though the output itself is constrained to the schema. The model's hidden reasoning tokens use the preamble as scaffolding.

**Where it lives.** `src/services/todos/expandPrompts.ts:7-14` — the `PREAMBLES` map. For example, the bug preamble is: *"Before writing the report, reason through: What component or layer is this likely in, given the stack? What recent changes from the day's entries could have caused this? Are any sibling todos related? What would you check first if debugging this?"*

**Why it exists.** Models produce noticeably better structured output when they're given a short reasoning-frame first, even when their visible output is tightly constrained. The preamble doesn't appear in the final markdown; it shapes the latent thinking that produces the JSON. Per-type preambles keep the framing relevant to the task at hand.

**General rule.** Free reasoning quality by adding 30 words of "things to consider before answering" to your system prompt. It is the cheapest model upgrade you can buy. Pair it with a tight output schema so the reasoning has somewhere to go.

---

## 1.6 Two-pass LLM chain (structured summary → relatable caption) · `intermediate`

**What it is.** A multi-call AI pipeline where the second call consumes the first call's output (and additional context) to produce a different, complementary artifact. Each call has its own system prompt, its own max tokens, its own validation. Failures in the second call are non-fatal.

**Where it lives.** `src/services/ai/summarize.ts:42-104`. Call 1 is the structured `AISummary` (headline / summary / mood / clip order / overlays / filter preset). Call 2 is `generateCaption()` from `src/services/ai/caption.ts`, which takes the structured summary's mood plus the day's raw log plus the **last 5 cached captions** for tonal continuity. The second call is wrapped in try/catch — if captioning fails, the structured summary still ships and the editor falls back to `summary.summary` for the overlay body.

**Why it exists.** Cramming both jobs into one prompt would force the model to balance two different objectives (structured composition vs. anti-cliché short copy). Splitting them lets each prompt stay strict on its own forbidden patterns. The non-fatal wrapping reflects that captions are nice-to-have but the summary is required for the editor to render anything at all.

**General rule.** One prompt, one job. Chain them rather than merging them. When the artifacts have different importance, wrap the optional one in a try/catch so its failure can't kill the required one — graceful degradation belongs at the call boundary, not inside the prompt.

---

## 1.7 Memory pattern: cached AI summaries as conversational context · `intermediate`

**What it is.** Instead of giving every LLM call a fresh blank slate, the app maintains a per-day cache of structured AI outputs in SQLite. Future calls read recent rows from that cache to inform tone, avoid repetition, and provide context. This is a poor man's "memory layer" without a vector database.

**Where it lives.**
- The cache: `ai_summaries` table (PK `date`) — stores `summary_json`, `generated_at`, `model` (see `docs/spec.md:197`).
- The reader: `getRecentAISummaries(beforeDate, limit)` (referenced in `summarize.ts:5`) feeds the last 5 captions into the next caption pass.
- The use: `src/services/ai/summarize.ts:130-139` extracts each prior `caption` field and passes them as `recentCaptions` to `generateCaption()`. Also used by `src/services/todos/expand.ts:147-199` (`buildContext`), which pulls the last 3 days of entries plus their cached AI summary for the expansion's surrounding-context block.

**Why it exists.** The model has no memory between API calls. To get tonal continuity across a week of vlogs, you have to *give* it the recent outputs. SQLite is right there; using it as a memory layer is free. The 1000-char cap per recent entry inside `expandPrompts.ts:127-130` keeps token usage bounded so a heavy journaling day doesn't blow up the context window (see `expandPrompts.ts:97`).

**General rule.** When a tool has no memory, you build the memory layer yourself. Persisted prior outputs + a small reader + a budget cap on what gets injected = a memory pattern that costs almost nothing and dramatically improves consistency.

---

## 1.8 Provider abstraction for swappable models · `foundational`

**What it is.** A single configuration point (`getProvider()`) decides whether the next LLM call goes to Claude or GPT, and downstream code reads the choice without knowing what's underneath. Both providers conform to the same `(system, user) → string` shape inside the call sites.

**Where it lives.** `src/services/ai/config.ts` (the provider/key store), then every call site picks the model based on `provider === 'openai'`:
- `src/services/ai/summarize.ts:42-71`
- `src/services/todos/expand.ts:220-238`
- `src/services/todos/classify.ts` (the cheap path)

**Why it exists.** Lets the user swap providers in `app/settings/ai.tsx` without touching the call sites. Also provides escape hatches for cost or capability differences — e.g., if Claude rate-limits, the user flips to GPT and the app keeps working. The trade is some ceremony at every call site (two function definitions: `callClaude` and `callOpenAI`) instead of one.

**General rule.** Abstract what changes (the provider), stabilize what doesn't (the call signature and the response parsing). The two-function-per-site pattern is fine when there are 2 providers and 4 call sites; if you grow to 5 providers and 30 call sites, promote the abstraction to a real factory.

---

## 1.9 Concurrency-capped fire-and-forget · `intermediate`

**What it is.** Background AI work is dispatched without `await` (so the UI doesn't block) but a module-level counter caps how many can run simultaneously. New requests bounce when the cap is hit.

**Where it lives.** `src/services/todos/expand.ts:25-29`:

```ts
const MAX_CONCURRENT = 3;
let _inFlight = new Set<string>();   // todoIds currently expanding
```

Then at line 212–214:

```ts
if (_inFlight.size >= MAX_CONCURRENT) {
  return { ok: false, reason: 'in-flight-cap' };
}
```

The classifier in `src/services/todos/classify.ts` uses the same module-level counter exposed via `CLASSIFY_PROGRESS_EVENT` so the UI can render a `classifying N todos…` toast.

**Why it exists.** Three concurrent expansions at $0.04 each is acceptable; thirty would be a $1.20 surprise. The cap is a hard ceiling on cost. The `_inFlight` set is a lightweight semaphore — no async library required, no persistent queue, just a module-scoped variable.

**General rule.** Background AI work needs a cost ceiling. A module-level counter + an event-emitter for UI progress is the simplest possible pattern that gets it right. Reach for queues / persistent workers only when you outgrow this.

---

## 1.10 What this codebase is *not* doing (and why that's a learning opportunity) · `advanced`

**What it is.** The honest gap. There is **no ReAct loop**, no tool-calling planner, no agent that decides what to do next. Every LLM call in this app is a single round-trip with a closed-form prompt → closed-form response.

**Where the gap lives.** Conceptually, in any place where a user might benefit from "the AI decides what to do." For example:
- The classifier could iteratively *ask* the user "is this a bug or an idea?" instead of guessing — a tool-calling pattern.
- The expander could *fetch* sibling entries via a tool call instead of being pre-loaded with a fixed context block in `buildContext`.
- The summarizer could *plan* a multi-day vlog instead of one day at a time.

**Why it doesn't exist (yet).** The single-round-trip pattern is dramatically simpler to debug, cheaper to run, and has no emergent failure modes. Adding agentic loops introduces termination problems (when does the agent stop?), context-window growth, and cost variance. For a solo-dev journaling app, the deterministic pipeline is the correct call.

**General rule.** "Agentic" is a feature, not a default. Start with the simplest pipeline (heuristic → cheap classifier → expensive expander on demand) and only add agent loops when you have a concrete reason. If you're studying this for an interview: be ready to explain why you *wouldn't* add a ReAct loop here, and what would have to change for it to be worth it.

> **Go deeper.** If you want to learn ReAct, the closest analog in this codebase is the validate-and-retry loop (§1.4). It is a bounded, single-iteration version of the "act, observe, decide" loop. Extending it to multi-iteration with a stop condition would be your study exercise.
