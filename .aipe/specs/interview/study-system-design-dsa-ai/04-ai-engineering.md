# Chapter 4 — AI Engineering

## Opening — what you're looking at

The AI surface in buffr lives under `src/services/ai/` (vlog summary, relatable caption) and `src/services/todos/` (classifier, six per-type expansions). It is provider-agnostic: the user picks Claude (Sonnet 4.6 + Haiku 4.5) or OpenAI (GPT-4o + GPT-4o-mini) in `app/settings/ai.tsx`, and `src/services/ai/config.ts` resolves the key from `expo-secure-store`. The Anthropic path uses `@anthropic-ai/sdk` (lazy-imported); the OpenAI path is a raw `fetch` against `api.openai.com`.

Two architectural decisions shape every AI feature in the codebase. The first is *heuristic before LLM* — Principle 10 in `docs/spec.md` §10. Any classification, scoring, or routing decision tries a deterministic function first, and only falls through to a model when the heuristic is uncertain. `heuristicClassify.ts` resolves ~80% of new todos to `'todo'` for free; the model never sees them. The second is *user override is permanent* — Principle 9. Once the user manually picks a type via the picker, `user_overridden_type=1` and the row is locked from future re-classification. AI output is editable; user override is the floor.

The features themselves come in three shapes: a *cheap fast classifier* (one-shot JSON, Haiku 4.5 / GPT-4o-mini, runs fire-and-forget after every commit), a *quality summary chain* (two LLM calls in `summarize.ts` — structured summary then relatable caption — with the second wrapped in try/catch so a caption failure doesn't fail the chain), and *six per-type expansion prompts* in `expandPrompts.ts` with chain-of-thought preambles, validated against discriminated-union TypeScript shapes, with malformed-JSON auto-retry once. There is no LangChain. There is no agent. There is no tool use. The model produces JSON, the code parses and validates it, and the validated result writes to a typed column.

### ASCII diagram — classifier flow on a new todo

```
   reconcileTodoMetaForEntry()      (fire-and-forget after commit)
        │
        ▼
   for each NEW TodoItem in todos_json:
        │
        ▼
   ┌───────────────────────────┐
   │ heuristicClassify(text)   │   src/services/todos/heuristicClassify.ts
   │  - 'todo' if imperative   │   - pure function, ~50 verbs
   │  - 'todo' if modal start  │   - never returns non-todo type
   │  - null if speculative    │
   │  - null if question-shape │
   └─────────┬─────────────────┘
             │
       ┌─────┴─────┐
       ▼           ▼
     'todo'       null
     │             │
     │             ▼
     │   if todo.done → STOP   (done todos never classify)
     │             │
     │             ▼
     │   ┌──────────────────────┐
     │   │ classifyTodo(text)   │  src/services/todos/classify.ts
     │   │  Haiku 4.5 / 4o-mini │
     │   │  one-shot JSON       │
     │   │  {type, confidence}  │
     │   └─────────┬────────────┘
     │             │
     │             ▼
     │   updateTodoMeta(todoId,{
     │     type, classifierConfidence,
     │     classifierModel,
     │   })
     │
     ▼
   updateTodoMeta(todoId, {
     type: 'todo',
     classifierConfidence: 'heuristic',
     classifierModel: 'heuristic',
   })

   In both branches:  user_overridden_type=0 stays
   user_overridden_type=1 → ROW IS LOCKED, both branches no-op
```

The classifier is module-level state: an in-flight `Set<string>` exposed via `CLASSIFY_PROGRESS_EVENT` so the `/todos` page can show a "classifying N todos…" toast without the toast caring about the classifier internals. This is the same pattern as the expansion module's `_inFlight` set in `src/services/todos/expand.ts`.

---

## Concepts (four-part structure)

### 1. Heuristic-before-LLM as a cost ceiling

**Shape.** Two layers cooperate: `heuristicClassify(text)` returns `'todo' | null` from a pure pattern match against imperative verbs, modal starts, question shapes, and deadline patterns. `classifyTodo(text)` calls Haiku 4.5 / `gpt-4o-mini` for a one-shot `{type, confidence}` JSON. The orchestrator (`reconcileTodoMetaForEntry` in `src/services/todos/reconcileMeta.ts`) calls the heuristic first and only fires the LLM when the heuristic returns null AND the todo isn't done.

**Rule.** Heuristic returning `'todo'` ends the classification. Heuristic returning null *and* todo not done fires the cheap-model LLM. Done todos never classify (they're already resolved). The heuristic intentionally over-fires on null — false negatives cost a cheap model call, false positives cost a manual override.

**Failure mode.** Without the heuristic gate, every new `[]` line fires the LLM. A user typing 30 todos in a single journal session generates 30 cheap-model calls. With the gate, ~80% resolve free; only ambiguous lines (`"this whole feature feels off"`) pay the model cost. The classifier toast becomes visible only when there's actually something ambiguous, which is when the user gets value from seeing it.

**Contrast.** The vlog summary has no heuristic layer. There is no cheap deterministic approximation of "pick clip order, write a caption, choose a filter preset." The constraint that distinguishes them: classification is a labeling problem with strong textual priors (verb shape predicts type); composition is a generation problem with no prior. Heuristic-first only helps when the heuristic has signal.

### 2. User override as permanent lock

**Shape.** Three pieces enforce override: the `todo_meta.user_overridden_type` integer column (0 or 1), the `TypeChangePicker` UI in `src/components/todos/TypeChangePicker.tsx` which sets the column to 1 on change, and `reconcileTodoMetaForEntry` which checks the column before re-classifying.

**Rule.** Once `user_overridden_type=1`, no AI path may re-write the row's `type` column. Ever. Not on the next commit, not on classifier catch-up at boot, not on a re-classification trigger from a feature-flag flip. The user is the ceiling.

**Failure mode.** Without the lock, the classifier would re-fire on the next entry edit and could flip the user's manual `'idea'` back to `'question'`. The user would experience this as "the AI keeps overriding me," which destroys trust in every AI affordance in the app. The lock makes the classifier output a *suggestion* the user can ratify or replace, not a *decision* the AI imposes.

**Contrast.** The `expanded_md` column has a softer override pattern. The "re-expand" button in `app/todos/[id].tsx` overwrites it after an Alert confirm. Expansion is regenerated on demand; classification is automatic. The constraint that distinguishes them: classification fires ambiently as a side effect of typing, so the user has to be protected from re-firing; expansion is an explicit user gesture, so re-running it is the user's decision.

### 3. Quality chain with caption-failure firewall

**Shape.** Three things participate in the vlog summary: `summarize.ts` orchestrates two LLM calls, `validateSummary` clamps clip ranges and drops unknown clip IDs, `generateCaption` (in `src/services/ai/caption.ts`) runs the second pass with its own forbidden-pattern prompt. The merged result writes to `ai_summaries.summary_json`.

**Rule.** The structured summary call ships first and is the canonical contract. The relatable caption is wrapped in `try/catch` — if it throws, `console.warn` and the editor falls back to `summary.summary` for the overlay body. The merged JSON has optional `caption?`, `captionAlternate?`, `captionTheme?` fields; older rows pre-dating that feature still parse.

**Failure mode.** Without the firewall, a caption-prompt failure (timeout, malformed JSON, rate limit) would fail the whole summarize call and the editor would mount with no summary at all. The user would see "AI failed" instead of "AI shipped a fine summary, just no relatable caption today." Decoupling the calls means each one fails independently; the worst case is a fallback to the structured summary text, which is still a coherent overlay.

**Contrast.** The classifier does *not* have a similar firewall — if `classifyTodo` throws, the error is logged and the row keeps `classifierConfidence=null`. The next boot's catch-up pass re-fires it. The constraint that distinguishes them: the summary path is user-blocking (the user is on the editor screen waiting for it), so a graceful degradation matters; the classifier is fire-and-forget, so there's no user to disappoint and a retry-on-next-boot is fine.

### 4. Per-type expansion with discriminated-union validation

**Shape.** Three components produce a structured expansion: `expandPrompts.ts` exposes six system prompts (one per non-todo type) with chain-of-thought preambles and JSON schemas; `expand.ts` calls Sonnet 4.6 / GPT-4o, parses the JSON, and runs `validateExpansion(type, data)` against a discriminated union; `expandSerialize.ts` renders the validated typed object to compact markdown stored in `expanded_md`.

**Rule.** A 3-concurrent cap (`MAX_CONCURRENT = 3`) limits in-flight expansions across the app. Malformed JSON from the model retries once with a stricter "respond with JSON only" prompt. The validator returns null on shape mismatch; caller catches the null and surfaces an error to the UI rather than persisting garbage.

**Failure mode.** Without the cap, three users tapping "expand" on three different todos in quick succession could stack ~$0.15 of LLM spend in seconds — fine for a personal app, ruinous for a multi-tenant system. Without per-type validation, a malformed `BugExpansion` (missing `repro_steps`) would write to `expanded_md` and the rendering markdown template would fail mid-paint. The validator catches the bad case before persistence; the user sees "expansion failed, try again."

**Contrast.** The classifier output uses Zod-style runtime validation in `classify.ts` but on a much smaller schema (`{type, confidence}`). The expansion validator is heavier because the union is six distinct shapes with different required fields. The constraint that distinguishes them: classifier output is one of seven enums + one of four enums (small, easy); expansion output is six different deeply-shaped objects (complex, needs per-type validation).

---

## Interview questions

### [mid] How does the classifier toast know how many todos are in flight?

**Model answer.**

`src/services/todos/classify.ts` keeps module-level state: a `Set<string>` of `todoId`s currently being classified. `classifyTodo(text, todoId)` calls `_inFlight.add(todoId)` before the LLM call and `_inFlight.delete(todoId)` in a finally block. Each transition emits `CLASSIFY_PROGRESS_EVENT` via the small event bus in `src/utils/events.ts`. The `/todos` page subscribes in a `useEffect`, reads the in-flight count, and renders the toast when count > 0.

The pattern keeps the classifier itself unaware of UI. The toast is debounced so a single fast classification (under ~150ms) doesn't flicker. The same shape is used for the expansion in-flight set (`isExpanding(todoId)`) and the cross-screen `EXPAND_PROGRESS_EVENT`, which is how the full-page expansion view at `app/todos/[id].tsx` knows when a background expansion finishes.

### [senior] Why do you use the cheaper model (Haiku / 4o-mini) for the classifier, but the primary model (Sonnet / 4o) for expansion?

**Model answer.**

Cost and quality scale differently with the task. Classification is a labeling problem: the model sees a single line of text and picks one of seven enum values. Sonnet 4.6 doesn't classify *more correctly* than Haiku 4.5 here — both are far above the noise floor on a task with strong text priors. The marginal cost difference is roughly 10× per call; at the volume the classifier runs (every ambiguous new todo), Sonnet would burn the per-key rate limit before the user noticed any quality lift.

Expansion is a generation problem with much higher quality variance. Sonnet's output for a `BugExpansion` reads like a senior engineer's bug ticket — it includes plausible repro steps, hypothesised root causes, suggested next checks. Haiku's output for the same prompt is syntactically valid JSON but the prose is shallower; the user could write it themselves. The user *opens* the expansion view to get something they couldn't easily produce, so the floor matters. Sonnet is not optional there.

The decision is encoded in the file structure: `classify.ts` and `expand.ts` are siblings, each with their own model constant. Anyone reading the code sees both choices side by side and can change either one independently. The cheap-and-fast vs deep-and-slow split is also why the classifier runs fire-and-forget on commit (no UI dependency on it finishing) while expansion runs on a tap (the user is waiting on it and a 1.2s wait is acceptable for the quality lift).

### [arch] How would you turn the AI surface into a multi-tenant service that scales across users?

**Model answer.**

Three problems show up at scale that the device-direct architecture hides. The first is the API key. Today every device holds its own Anthropic key in `expo-secure-store`. At multi-tenant scale, that's untenable: most users won't have an OpenAI account, and the key-per-device pattern doesn't compose with subscription billing. The architectural move is a server-side gateway. A Cloudflare Worker or Supabase Edge Function holds the org-level keys, accepts authenticated requests from devices (Supabase JWT in the Authorization header), and forwards to Anthropic with cost tracking per `user_id`. The device sends `{prompt, model, todoId}` and gets back `{output, usage}`. The classifier and expansion calls move behind this gateway; the device-side `@anthropic-ai/sdk` import goes away.

The second is rate limit isolation. One user batch-expanding 50 todos shouldn't starve a hundred other users of caption generation. The gateway needs per-user rate limits *and* a small queue with priority — interactive (expand) at high priority, background (classifier catch-up) at low. The cheapest implementation is a token-bucket per-user (Cloudflare Durable Object or a Redis hash on the Worker side) plus a simple priority queue for the background path.

The third is prompt versioning. Today the prompts live in `src/services/todos/expandPrompts.ts` and ship with each device build. At scale, I want to A/B-test prompts and roll them back without an app release. The gateway carries the prompt template; the device sends only the inputs (`{todoText, contextBlock}`). The gateway interpolates the current production prompt, increments a `prompt_version` field on the persisted output, and exposes a `/prompts/active` endpoint the device can poll daily for cache. This also lets me do the classic "gold dataset" loop — collect (input, output, user-override) triples in Postgres and run prompt evaluations against them offline.

What does *not* change: the heuristic-before-LLM pattern. The heuristic stays on-device because it costs nothing and the user benefits from instant classification on common cases. The gateway is a fallback for the ambiguous cases, just at a different layer of the stack. Same with `user_overridden_type` — that's a data invariant on the row, regardless of where the AI lives.

---

## The hard question

### "How do you know your prompts are actually better than just calling the model with no prompt engineering at all?"

**Model answer (≥200 words).**

I don't have rigorous evals. That's the honest answer. What I have is: a closed-enum schema for outputs (`TodoType`, `CaptionTheme`, six expansion shapes), runtime validators that reject malformed JSON, and a chain-of-thought preamble in each system prompt that primes the model toward the structure I want. The validators tell me when output is *malformed*. They don't tell me when output is well-formed but unhelpful.

What I've done in practice is structural: chain-of-thought preambles and explicit forbidden patterns. The relatable-caption prompt in `src/services/ai/caption.ts` (driven by `docs/relatable-caption-spec.md`) lists specific patterns to avoid — generic platitudes, "I am hustling" energy, hedging adverbs — because the unguarded baseline produces those patterns reliably. The expansion prompts include "think step by step" preambles followed by "now respond as JSON" because models reliably skip reasoning when asked for JSON directly. These choices come from observation across a few hundred journal-day inputs in my own data — not from formal evals against a held-out test set.

What I'd build first to fix this: a small evaluation harness that runs every prompt against a curated set of (input, expected-output-shape, expected-tone) triples and produces a pass/fail per axis. The evaluation would live in `scripts/evals/` and run on every prompt change. The bar I'd set: structural validation 100%, tone validation by LLM-as-judge above 85% with the previous prompt as a baseline. This is a few days of work and it's on the deferred-work backlog at `docs/backlog.md`. It's not in v1 because the cost of a bad prompt right now is bounded — only one user, who can re-tap "expand" if the output is shallow. At multi-tenant scale, this would be the first piece of infra to land before the gateway.

What I will not pretend to: the current prompts are heuristics layered on top of taste. They work well enough that the system ships, and they're recoverable when they fail (the user can override or re-expand). Calling the model with no prompt engineering would produce: shallower expansions, generic captions, and classifier outputs without confidence levels. The prompts add structure and constraint; the structure is what makes the output usable as data, not just text. That's the floor I'm defending, even without formal evals proving it.
