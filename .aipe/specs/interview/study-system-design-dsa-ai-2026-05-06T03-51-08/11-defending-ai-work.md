# Chapter 11 — Defending AI-assisted work

The AI question is going to come up. Probably as the first technical question, possibly as the last one. The interviewer will phrase it neutrally — "tell me about your AI workflow" or "how do you use Claude in your day-to-day" — but the subtext is "did you actually engineer this or did you just prompt an AI." This chapter is talking points for that conversation. Not a script. Words to say in your own phrasing, with the underlying substance ready to go.

## Talking point 1 — "How much did the AI write vs you?"

The AI typed roughly 80% of the lines. I wrote, reviewed, and decided 100% of them. The split is not "the AI did the work and I tweaked"; it's "the AI is a fast typist and I'm the architect."

The concrete breakdown. *Scaffolding* — file boilerplate, type definitions, repeated CRUD patterns, `StyleSheet.create` blocks — almost entirely AI. *Architectural decisions* — what's canonical, what's derived, where invariants live, how sync is shaped, why caption is its own pipeline — entirely me, often after multiple Claude.ai brainstorming sessions where I argued through the alternatives. *Translating decisions to code* — the mappers, reconciler logic, the sync table definitions — AI types, I review and reject when the AI's defaults violate the architecture.

The point I'd make to the interviewer: when the AI's diff weakens an invariant, only the engineer catches it. The AI doesn't have a stake in the architecture. The AI doesn't remember the bug from three months ago that motivated the invariant. The engineer does. So the *typing* is leverage; the *judgment* is non-transferable.

If they push back with "but you couldn't have built this without AI" — be candid. Yes, the velocity is AI-dependent. I could have built the same architecture without AI in maybe 3-4× the time. The judgment quality would be the same; the volume of code produced would be lower. AI changed the math on what's achievable solo, not the bar for what's good.

## Talking point 2 — "How do you know the AI didn't introduce subtle bugs?"

Three layers of defense. First, **strict TypeScript catches the common AI mistakes** — passing `string | undefined` where `string` is required, indexing into a possibly-empty array, calling methods on nullable types. Strict mode in `tsconfig.json` is non-negotiable; `npx tsc --noEmit` gates every commit. The AI's plausible-looking-but-wrong code that wouldn't compile gets caught here. This is maybe 70% of the catch rate.

Second, **I read every diff at the file level.** Not "review the PR description"; not "skim and approve." Read every line. The cost is significant — maybe 40% of my coding time is reading AI output rather than thinking about architecture. The benefit is catching the architectural-pattern violations that the type system can't catch: a new write site that doesn't call `schedulePush()`, a new query that doesn't filter `deleted_at IS NULL`, a try/catch that swallows an error the codebase relies on throwing. About 20% of AI diffs need a correction at this stage.

Third, **manual end-to-end on the connected device after every meaningful change.** Open the app, walk the affected screens, create the affected data, observe the behavior. About 90 seconds per pass. Catches the runtime regressions that compile cleanly and pass review — usually subtle UX issues like a state machine that's correct on entry but doesn't reset on focus, or an animation cleanup that fires but at the wrong time. Maybe 10% of regressions surface here.

The honest gap: this stack is *not* equivalent to a real test suite. A unit test for `scanTodosFromText` would catch regressions that even I miss in manual review. The deferred backlog has Vitest planned for exactly this reason. With AI velocity, the missing test layer is the highest-leverage gap to close — that's covered in Chapter 10.

## Talking point 3 — "What's the difference between your workflow and just using ChatGPT?"

Three things distinguish spec-driven AI development from raw prompting.

First, **the architecture is written down before the code is.** `docs/spec.md` is the canonical reference. `docs/buffr-<feature>-spec.md` files are the per-feature design docs. `.aipe/project/context.md` is the durable AI context. Every feature starts with a written spec; the AI implements against the spec, not against my in-the-moment instructions. The spec is the contract. When the AI's diff diverges from the spec, the diff is wrong — and that's a clear signal, not a fuzzy "this doesn't feel right."

Second, **the AI sessions don't start cold.** Claude Code loads `.aipe/project/context.md` at session start. The AI knows the architecture before I send the first prompt. I don't have to re-explain "prose is canonical" or "soft delete only" or "every write triggers `schedulePush`" every session. The durable rules live in the context file; the session-specific work fits in the prompt. This is a discipline most casual AI users don't have — they re-explain context every session and the AI's quality degrades over multi-week projects because the implicit-knowledge transfer never happens.

Third, **I separate brainstorming from implementation.** Claude.ai (the chat interface) is for design conversations — "should habits and threads share grid rows?" "What's the right tombstone semantic for the vacuum?" These are open-ended discussions where I want the AI to push back, raise alternatives, surface edge cases. Claude Code (the CLI) is for implementation — "implement docs/buffr-cloud-sync-spec.md M2." These are bounded coding tasks where I want execution against a spec. Mixing the two — using the implementation tool for design conversations — produces shallow design and bloated implementation. Keeping them separate produces better both.

The TL;DR for the interviewer: I treat Claude as a senior pair programmer who needs the architecture written down before they can be effective. The artifact (`docs/`, `.aipe/`) is what makes the workflow scale beyond toy features.

## Talking point 4 — "Show me a place where the AI got something wrong and you caught it."

Pick one specific example and walk through it concretely. Here's a real one from this codebase.

The reconciler in `src/services/todos/reconcileMeta.ts` originally (in an early AI draft) had this rough shape:

```typescript
// AI's first pass
for (const todo of currentTodos) {
  const existing = await getTodoMeta(todo.id);
  if (!existing) {
    await insertTodoMeta(...);
  } else {
    await updateTodoMeta(todo.id, ...);  // ← bug
  }
}
```

The AI wrote a "for each current todo, upsert its meta" loop. That looks right but is wrong: it *re-classifies every todo on every commit*, blowing away the user-overridden type lock and re-running the LLM classifier needlessly. The actual rule, from `.aipe/project/context.md`, is: existing matched todos are untouched. Only new todos get a fresh meta with classification; only disappeared todos get their meta deleted.

I caught it during diff review. The fix:

```typescript
// What shipped
for (const todo of currentTodos) {
  if (existingByTodoId.has(todo.id)) continue;  // ← preserve existing
  await insertTodoMeta(...);
  if (heuristic === null && !todo.done) scheduleClassify(...);
}
for (const meta of existing) {
  if (currentIds.has(meta.todoId)) continue;
  await deleteTodoMeta(meta.todoId);
}
```

The AI's draft was *plausible* — it would have shipped without compile errors, would have appeared to work in light testing, and would have silently destroyed the classifier-confidence and user-override states on every commit. The reason I caught it: the architecture rule "user_overridden_type lock semantics" is in `context.md`, and the AI's `updateTodoMeta(todo.id, ...)` line jumped at me as a violation. Without the written rule, I wouldn't have known to look.

The lesson I'd reinforce in the interview: the value of the written architecture is exactly that it makes AI-introduced architectural drift *visible at review time*. Without the written rule, AI's plausible defaults silently win.

## Talking point 5 — "Are you actually a senior engineer or did the AI just make you look like one?"

This is the question they won't ask out loud. Answer it anyway, by demonstrating things the AI can't do.

Demonstrate **judgment under uncertainty.** Walk through a deferred decision (Chapter 8: hard delete, Phase A user_id, no test suite) and explain why it's deferred — name the alternative, name the failure mode of shipping it now, name the trigger that would activate it. The AI doesn't reason about scope; it implements what's asked. The engineer chooses what to ask for.

Demonstrate **reasoning about scale.** Pick any system in buffr (sync, AI compose, dashboard ranking) and walk through how it changes at 10×, 100×, 1000× users. Be specific — name the bottleneck (push QPS, AI spend, sort cost), name the mitigation (rate limiting, prompt caching, SQL ORDER BY + LIMIT), name what stays the same and why. The AI can hand-wave about scale; the engineer can quantify it.

Demonstrate **knowing what was hard.** The "manual-touch deviation" in `services/threads/touch.ts` — a thread mention with both `entry_id` and `todo_id` NULL — is a deliberate violation of an otherwise-tight invariant. Explain why: the dashboard touch is a different gesture from inline tagging, and forcing it into prose pollutes the user's text. Three options were considered (round-trip into prose, separate `thread_touches` table, document the deviation as Principle 11); option 3 shipped. The AI doesn't *notice* that a tight invariant has a legitimate exception; the engineer does.

Demonstrate **understanding what was easy.** Half the codebase is mechanical CRUD. The split between `database.ts` and `services/sync/tables/<name>.ts`. The mappers. The type definitions. The `StyleSheet.create` blocks. None of this is hard. AI types it, I review it, it's correct. Owning the easy parts honestly is more credible than pretending everything was hard.

The framing that lands: "AI raised my throughput, didn't raise my judgment. The codebase is good *because the architectural decisions are good*. Those came from a human reasoning carefully about a domain. The AI did the typing."

## Talking point 6 — "What would you do differently with the AI workflow?"

Be specific. Three things.

First, **write the test suite from week one.** Vitest + fixtures for the pure functions. Without it, the AI's velocity outruns my verification capacity over multi-week projects. The catch rate at code review is high but not 100%; tests would close the last 10%. This is the highest-leverage change I'd make to my own workflow, and I'd apply it to the next project from day one. (Also covered in Chapter 10.)

Second, **invest in the architecture document earlier.** `docs/spec.md` started as informal notes and became the canonical reference around month 3. Before that, the AI's quality on long-running features was visibly worse — drift accumulated, patterns diverged, and I caught it later than I should have. The lesson: write the architecture document before writing the code that implements the architecture, even if the document is short. A 2-page architecture doc on day one is better than no doc and a 6-month accumulation of inconsistencies.

Third, **use Claude.ai for design conversations more aggressively.** I tend to skip the brainstorm and go straight to spec when I have a clear-enough design in my head. That's usually wrong. Even when I have a design in mind, talking it through with Claude.ai surfaces edge cases I'd missed and alternatives I hadn't considered. The cost is 30 minutes; the benefit is catching design issues before they become spec issues become code issues. I'd default to the brainstorm even when I think I don't need it.

## The hard question — "Why should I hire someone whose work product is 80% AI-generated?"

This is the version of the AI question with the gloves off. Answer it honestly.

The premise of the question is wrong, but the underlying concern is fair. The premise — that "80% AI-generated" means "80% AI judgment" — collapses if you understand the workflow. The AI types lines; I make decisions. Hiring me is hiring the decision-making, which is non-transferable, not the typing, which is replaceable by any AI tool.

The fair concern underneath: when AI does more of the work, the engineer's growth curve flattens. There's a real risk of becoming a *prompt manager* — someone who wrangles AI output but couldn't reproduce it from scratch. The way I'd address that concern, concretely:

First, I can walk any file in this codebase and explain what it does, why it's shaped that way, and what happens when each invariant breaks. That's the test of "did you author this." If I can pass that test cold — and I can — the AI-generation ratio is irrelevant.

Second, I can articulate what I deliberately *didn't* build and why. The deferred backlog is mine; the AI didn't suggest it. The 12 architectural principles are mine; the AI implemented them. The judgment about what to skip is the senior part of the work, and the AI didn't help with it.

Third, I'm transparent about the gaps. No test suite, no observability, no production-grade auth. I know each of those is a gap. I can explain why each is an acceptable gap *for this scope* and what the trigger to close each is. That's a senior framing — gaps are owned, not hidden.

The pitch: hire me because I can architect a system, defend my decisions, and ship. The fact that AI helped me ship faster doesn't make me less of an engineer; it makes me a more leveraged one. And every time you've worked with an engineer who built a thing they couldn't explain — that's the failure mode my workflow is specifically designed to prevent.

If they're still skeptical, offer the test: pick any function in the codebase, ask me to explain it cold. I'll walk through it. That's the proof, and it's a proof I can produce on demand.
