# 12 — What I'd do differently

> **Honest retrospective.** Not "everything was perfect." Not "I regret all of it." The real answer: what was a reasonable call at the time that I'd now change, what I'd fix first, and what I'd leave alone.

The temptation in retrospectives is performative humility — picking obvious weaknesses to flagellate yourself over and call it self-awareness. That's not what an interviewer wants and it's not honest about what I'd actually change. The useful retrospective names *specific* calls, says *why* they were reasonable then and *why* they look different now, and orders them by what I'd fix first.

Three things I'd change. Three things I'd leave exactly as they are. One thing I'd do differently structurally if I started the project tomorrow.

## What I'd change first

**Test fixtures for the pure parsers.** The argument I made in chapter 8 stands. The scanners in [`scanTodos.ts`](../../src/services/todos/scanTodos.ts) and [`scanNutrition.ts`](../../src/services/nutrition/scanNutrition.ts) are the highest-risk, highest-testability code in the project. They're pure functions with clear input/output. They sit on the autosave path so silent bugs corrupt user data. They're the kind of code that drifts subtly when you refactor. Fixture-based tests covering edit-in-place, delete-line, insert-line, reorder-lines, identical-text-twice — maybe 30 cases — would catch 90% of the bugs I'd worry about. I shipped without them because at solo-app scale my dogfood loop catches regressions within a day. At any larger scale this is non-negotiable Day-1 work, and it would have cost me one day to do.

**A single source of truth for type-and-schema enums.** Today `TodoType`, `TodoStage`, and `ClassifierConfidence` are TS string-literal unions, with CHECK constraints in SQLite mirroring them — but the link is *manual*. Adding a new value means updating both the union and the migration's CHECK clause, and there's no codegen or compile-time check that they're in sync. At one or two contributors, this is fine. At any team size, this is a foot-gun. I'd extract a `types-with-constraints.ts` file that exports both `type TodoType = 'todo' | 'idea' | ...` and `export const TODO_TYPE_CHECK = "type IN ('todo','idea',...)"` from the same source array, then consume the const from the migration and the type from the application code. Two-three hours.

**A queue worker for Notion writes.** Right now `syncAllTodos` is a synchronous loop that pushes everything dirty in one call, serialized through the rate limiter. This works at a few hundred dirty rows per sync; past that the user waits visibly. I'd refactor to a `drop_write_queue` pattern (which I outlined in the original drops plan but didn't ship) where each Notion write is a queued op, processed asynchronously by a background worker, with retry-after backoff and dead-letter handling for permanently-failed writes. The current implementation is *correct* — it just doesn't scale gracefully past about 1000 dirty rows. Buying that scale is maybe a week's work, including a worker abstraction reusable for future sync targets.

## What I'd leave alone

**The prose-canonical drops idiom.** This is the architectural decision the rest of the codebase orbits, and it's right. Capture-is-filing is the design thesis; the two-pass scanner makes it work; the round-trip into prose keeps the source canonical. I'd defend this at any scale. The cost is real (the scanner, the reconcile, the round-trip rewriter all exist because of this choice) and the benefit is what makes loopd different from a generic note app.

**Heuristic-first cost-tiered AI.** The three-tier model selection (heuristic / cheap classifier / primary expansion) is the AI architecture I'd carry forward to any future product. It scales — the cost ratios stay the same as user count grows. It degrades gracefully — if AI is unavailable, the heuristic path still produces a usable experience. It's auditable — every LLM call has a price tag I can articulate and a justification for which tier it's on. I'd reuse this pattern next time without changes.

**Local-first SQLite with optional bidirectional Notion sync.** This decision cost me real work — I had to write the merge logic, the deletion queue, the schema-gap tolerance, the rate limiter, all by hand. A "cloud-first" version would have shipped sooner. But a cloud-first version dies the day Notion changes an API. By making SQLite primary, I bought a kind of architectural insulation that's hard to retrofit later. I'd take this tradeoff again every single time.

## What was reasonable then but I'd change now

The four-phase ship plan for thinking-modes was the right *shape* — slice by value-delivery, ship Phase A standalone — but Phase B's classifier integration came too early. I shipped the LLM call before I had a reliable way to *evaluate* whether it was working. There's no eval harness for the classifier today (chapter 5 acknowledges this), which means every prompt change is a vibes-based judgment call. If I were doing thinking-modes again, I'd ship Phase A (heuristic + UI) exactly the same way, but I'd build a fixture-based eval *before* Phase B's classifier rather than alongside it. The lesson: when you're about to introduce non-determinism into a system, the eval harness is part of the feature, not optional polish.

Related: I shipped without per-feature cost telemetry. I have no visibility into LLM cost per call beyond what I see in the Anthropic billing dashboard once a month. A simple `events` table logging `{type, model, input_tokens, output_tokens, latency_ms, cost_usd}` would give per-feature analytics and let me see expensive-call regressions before they hit my credit card. This is half a day of work and I haven't done it because at this scale my monthly cost is a few dollars and I notice spikes by feel. At product scale, this would be Day-1 instrumentation.

## The structural change I'd make if starting tomorrow

I'd build the spec-and-plan workflow into the project from commit zero, with a discipline I only landed on midway through this build.

The version of this I'd commit to: every non-trivial feature begins with a plan document that has three explicit sections. **What we're building** — the user-facing surface and the data model. **What we're not building** — explicit non-goals that the AI won't infer-into-existence. **The phases** — slices of value that ship independently. The plan goes in the repo before any code lands. Pull requests for the feature reference the plan in their description.

This isn't novel — it's basically how product specs work at any mature company. What's new in an AI-assisted workflow is the *rejection section*. The AI will fill in gaps in the spec by inferring what looks reasonable; if the spec doesn't say "we are NOT building tags in this phase," the AI will probably build tags and you'll spend an hour ripping them out. The rejection section is cheap to write and prevents real lost work. I learned this the hard way during the drops feature when the AI's first output included a Notion-side schema for drop types that I didn't want and had to undo.

The other structural thing I'd start with: a daily-cost ceiling on the AI budget, hard-coded. Right now I have implicit cost discipline because I'm spending my own money; in a project where someone else's budget is on the line, I'd want a `MAX_DAILY_LLM_USD` constant somewhere visible. Costs are easier to control by *design constraint* than by *post-hoc analysis*.

## The honest closer

What this project taught me, more than any specific technical pattern, is that AI-assisted development is not faster than non-AI development by default. It's faster *if you have the architecture in your head*. If you don't — if you're hoping the AI will figure it out — the AI's outputs become technical debt at the speed of generation. The skills that matter most in an AI-assisted workflow are the ones that gate output quality: spec writing, architectural judgment, the willingness to push back on a plan when the plan is wrong, the willingness to delete code that was generated for a feature you decided not to ship.

I'm a better engineer for having built this. I have stronger opinions on architecture, sharper instincts about cost-vs-capability tradeoffs in AI integration, and a more disciplined relationship with specs and plans. The code is the artifact; the skills are the point.

→ [99 — Appendix: complexity cheat sheet](./99-appendix-complexity.md)
