# 05 — AI engineering

> **The high-leverage chapter for AI-engineering interviews.** loopd has four LLM calls across three cost tiers, and the architectural decisions around them are what separates this from "I called the OpenAI API."

Most projects with AI in them call one model for one job. loopd has four calls in three roles, and the choice of *which model for which job* is a deliberate product decision, not a default. The vlog editor's auto-compose runs **two LLM calls back-to-back**: a structured-summary call producing the typed `AISummary` (clip order, trims, mood, filter preset) and a relatable-caption call producing 2–4 line first-person captions per [docs/relatable-caption-spec.md](../relatable-caption-spec.md) — both primary-tier (Sonnet 4.6 or GPT-4o). The thinking-mode classifier on every captured todo uses cheap-tier reasoning (Haiku 4.5 or GPT-4o-mini). The expansion modal on non-todo rows uses primary-tier again. Four calls, three cost tiers, four failure modes.

Underneath the cost tiering is a deeper principle: heuristic-first cost discipline. The classifier doesn't run on every captured todo — it runs only when a deterministic regex-based heuristic at [`heuristicClassify.ts`](../../src/services/todos/heuristicClassify.ts) returns `null`. The heuristic catches roughly 70-80% of captures (anything starting with an imperative verb, modal phrase, or deadline keyword) for free. The LLM only sees the genuinely ambiguous 20%. This wasn't an optimization I added later — it was the original design. Build the cheap deterministic path first; use the LLM where the heuristic abstains.

The third architectural concern is JSON output validation. LLMs return malformed JSON often enough that a naive `JSON.parse` would explode in production. The expansion path at [`expand.ts:228-247`](../../src/services/todos/expand.ts#L228-L247) parses, validates against a per-type shape, and on mismatch retries *exactly once* with a stricter system instruction. The retry catches ~95% of fence-wrapped or preamble-laden outputs. More retries would burn budget on cases where the model is fundamentally confused; better to surface "AI returned an invalid response" and let the user re-trigger explicitly.

```
                      Cost-tiered LLM dispatch

                        New todo committed
                              │
                              ▼
                  ┌─────────────────────────┐
                  │ heuristicClassify(text) │
                  │ ~50 verbs + modal +     │
                  │ deadline patterns       │
                  │ ~0.1ms, FREE            │
                  └────────────┬────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
          returns 'todo'                 returns null
          (~70-80% of cases)             (the ambiguous 20%)
                │                             │
                │                             │  (skip if todo.done — never
                │                             │   burn tokens on completed)
                │                             ▼
                │              ┌────────────────────────────────┐
                │              │ scheduleClassify (async)       │
                │              │ Tier 1: Haiku 4.5 / 4o-mini    │
                │              │ ~$0.0001 per call              │
                │              │ ~50 tokens out, JSON validated │
                │              └──────────┬─────────────────────┘
                │                         │
                ▼                         ▼
          stop here                  type assigned
          confidence='heuristic'     classifier_confidence='high|medium|low'
                                          │
                                          │
                                          │
                              ──── user taps [expand] ────
                                          │
                                          ▼
                              ┌────────────────────────────────┐
                              │ expandTodo                     │
                              │ Tier 2: Sonnet 4.6 / GPT-4o    │
                              │ ~$0.04 per call                │
                              │ MAX_CONCURRENT=3 cap           │
                              │ Auto-retry once on bad JSON    │
                              └──────────┬─────────────────────┘
                                         │
                              ┌──────────┴──────────┐
                              ▼                     ▼
                       valid JSON            malformed
                              │                     │
                              ▼                     ▼
                       serialize MD         retry with stricter
                       write to DB          system instruction
                                                    │
                                                    ▼
                                     if STILL bad → ExpandResult.malformed
                                                    → modal shows [try again]

  Three tiers, three cost points, three failure modes.
  Heuristic abstains → cheap LLM picks.
  Cheap LLM is wrong → user override locks the row.
  Expensive LLM is wrong → bounded retry, user-visible error.
  Manual-only on the expensive path so the user always knows
  when they're spending money.
```

## Interview questions

### Q1 [senior] You have three LLM integrations. Walk me through why each uses a different model.

Three jobs, three cost tiers. **Classification** at [`classify.ts:9-10`](../../src/services/todos/classify.ts#L9-L10) uses Haiku 4.5 (Anthropic) or GPT-4o-mini (OpenAI), ~$0.0001 per call. The prompt is ~250 tokens in, ~50 tokens out, just `{type, confidence}` JSON. Haiku is fine for this; Sonnet would be 30x the cost for indistinguishable accuracy on a task this constrained.

**Expansion** at [`expand.ts:20-21`](../../src/services/todos/expand.ts#L20-L21) uses Sonnet 4.6 (Anthropic) or GPT-4o (OpenAI), ~$0.04 per call. Per-type prompts include a chain-of-thought reasoning preamble, and the output is structured JSON with 4-6 fields plus arrays. The reasoning quality difference between Haiku and Sonnet *does* matter here. I tested both during development — Haiku's expansions were generic; Sonnet's pulled out the right axes for each type.

**Vlog summary** at [`summarize.ts`](../../src/services/ai/summarize.ts) is the same primary tier as expansion. Day-summary is reasoning-heavy and quality matters because the output drives the vlog editor's auto-compose. The summary call is followed by a second primary-tier call to [`caption.ts`](../../src/services/ai/caption.ts) which generates a 2–4 line relatable caption per the spec — the two calls are kept independent (one prompt, one validation, one set of failure modes each) and the caption failure is *swallowed* in [`summarize.ts`](../../src/services/ai/summarize.ts) so a caption error doesn't fail the whole compose chain. The editor's TEXT tab surfaces the result through three variant chips — PRIMARY (relatable caption), ALT (shorter relatable variant), SUMMARY (the structured summary as a fallback for days the relatable pass doesn't feel authentic).

The principle: *pick the tier per workload shape, not per brand*. Within Anthropic's lineup, Haiku is for triage, Sonnet is for reasoning. Within OpenAI's, mini is for triage, 4o is for reasoning. I budget by tier — classifier costs ~$0.01/month at my usage, expansion ~$1-2/month. At product scale these cost shapes generalize: someone running 10x my volume pays 10x more per tier, but the *ratio* of cheap-to-expensive calls stays roughly the same as long as the heuristic-first discipline holds.

### Q2 [arch] Why heuristic-first instead of just calling the LLM?

Two reasons: cost discipline and latency.

The heuristic at [`heuristicClassify.ts:71-102`](../../src/services/todos/heuristicClassify.ts#L71-L102) is ~50 imperative verbs (`fix`, `email`, `schedule`, `reply`, etc.) plus modal phrases (`gotta X`, `need to X`, `should X`) plus deadline patterns (`by today`, `eod`, `tomorrow`). It catches roughly 70-80% of captured todos and returns `'todo'` for them. On those, the user sees no spinner, the app does no API call, the cost is zero.

I deliberately tuned the heuristic to over-fire on `null` (return ambiguous) rather than over-fire on `'todo'` (false positive). The cost asymmetry is interesting: a false-null sends the line to a cheap LLM call that costs ~$0.0001, but a false-`todo` requires the user to manually correct it via the type-change picker. I optimized for accuracy over the marginal LLM cost. At scale that calculation might flip — the override-rate-times-user-count might dominate — but at this scale, accuracy first.

The architectural principle beyond this app: *AI is expensive and slow*. Build the cheap deterministic path first; use the LLM only where the heuristic abstains. This is now CLAUDE.md principle 10 ("Heuristic before LLM") — promoted from a tactical decision into a project-wide rule.

### Q3 [arch] How do you handle malformed LLM output?

Three layers, in order. **Schema validation** — [`validateExpansion`](../../src/services/todos/expand.ts#L77-L142) checks the parsed JSON against a per-type shape and returns `null` on mismatch instead of letting bad data into the DB. The validator is shape-driven: if the expansion is an `idea` but the JSON is missing `firstStep`, it's null. If the `confidence` field on a question expansion is something other than `high`/`medium`/`low`, it's null.

**One-shot retry** — if the first call returns null, [`callOnce`](../../src/services/todos/expand.ts#L228-L247) is invoked again with a stricter system instruction appended: *"Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema."* This catches around 95% of fence-wrapped or preamble-laden outputs in practice.

**Discriminated-union result** — [`ExpandResult`](../../src/services/todos/expand.ts#L201-L203) is `{ ok: true, ... } | { ok: false, reason: 'no-ai' | 'in-flight-cap' | 'wrong-type' | 'malformed' | 'network' | 'not-found' }`. The caller can map each failure to a precise UI message. The expansion modal at [`app/todos/[id].tsx`](../../app/todos/[id].tsx) shows `"AI returned an invalid response. Try again."` for `malformed`, and a `[try again]` button that re-triggers the call.

What I deliberately *didn't* do: retry more than once. More retries would burn budget on cases where the model is fundamentally confused with the input. Better to surface the error and let the user explicitly re-trigger. **Tradeoff named:** I trade a small percentage of total failures (the 5% that survive both attempts) for predictable bounded cost.

At scale, I'd layer in tool-use / function-calling mode. OpenAI's `response_format: 'json_object'` is already in [`classify.ts:51`](../../src/services/todos/classify.ts#L51). Anthropic's tool-use would replace the JSON-parsing for expansion entirely. Both push malformed-output rates to near-zero by making the schema part of the API contract instead of a post-hoc validation. I haven't done this for expansion yet because the JSON-parsing approach works at 95% — but it's the next thing I'd ship if I were building toward production.

## The hard question

> "How do you actually know your classifier is accurate?"

Honest answer: I don't measure it formally. I've eyeballed it on my own ~100 captures and corrected the obvious mistakes via the manual override picker. There's no eval harness, no labeled corpus, no precision-recall numbers. At my scale, the cost of a wrong classification is one tap to override; the cost of building an eval harness is a day of fixture work plus integration with the test suite I also don't have. So I haven't done it.

What I'd do at any larger scale: build a labeled fixture set of 100-200 hand-categorized lines covering each type, run the classifier, compute precision and recall per type, and gate prompt changes on the eval result. The fixture set itself is the hard part — it needs to be a real distribution of captures, not synthetic, which means I'd dogfood for a month, label, and then freeze. I'd also want to track *override rate* per type as a proxy for misclassification — if 30% of "idea"-classified todos get manually changed to something else, the prompt needs work.

The thing I can articulate clearly even without the numbers: I know the failure modes. The classifier is best at imperative-verb-leading lines (which the heuristic should have caught anyway), and worst at lines that mix categories — "should we ship the auth migration this week?" is half-question, half-decision, and the model picks one essentially at random. For those, the user override is the right escape hatch. The system is honest about its uncertainty — `classifier_confidence: 'low'` shows a `?` mark next to the badge — and the manual override locks the row from future re-classification.

The deeper truth here: I'm optimizing for a one-user system where the cost of wrong is one tap. At 10k users that calculation is different and I'd build the eval harness on day one.

→ [06 — Data modelling](./06-data-modelling.md)
