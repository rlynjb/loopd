# 11 — Defending AI-assisted work

> **The hardest interview tightrope.** Demonstrate that I architected, judged, debugged, and owned the product, while being honest that AI wrote a lot of the code. Ownership shows in the *decisions*, not the LOC count.

The trap with this conversation is over-claiming or under-claiming. Over-claim and the interviewer asks one specific implementation question that exposes the gap. Under-claim and you sound like you were just along for the ride. The right tone is calm, specific, and grounded in named decisions. AI was a tool. I was the engineer.

Six questions in this chapter, in roughly the order an interviewer asks them. Each answer is a *talking point*, not a script — internalize the shape, say it in your own words.

## "How much did you actually write versus the AI?"

LOC-wise, the AI wrote maybe 60-70% of the lines. Architecturally, I made every decision. Both numbers are accurate and the second one is the one that matters.

The way to think about it: every file in this repo exists because I decided what it should do, where it should live, and what it should *not* do. The AI is a fluent code generator; I'm the engineer who knows when to keep it on the rails. I can name three specific places I overrode the AI's first instinct:

- The original drops spec proposed a Next.js / Netlify stack because that was the AI's default from the project template. I rewrote the entire plan against React Native + Expo + SQLite before any code was written. That's documented in the repo's history — [`docs/spec.md`](../spec.md) is the rewrite.
- The implementation plan for thinking-modes recommended flattening both the dashboard and `/todos` to chronological order. I pushed back and kept the dashboard ranked while flattening only `/todos`, with reasoning written down in [`docs/concepts.md`](../concepts.md) so the call survives me.
- The expansion view started as a bottom-sheet modal. I shipped it, opened it on the device, saw it overlap the Android system gesture bar, and decided the modal was the wrong primitive. Converted it to a full-page route at `app/todos/[id].tsx`. The AI wrote the refactor faster than I would have, but the *judgment* was mine.

LOC is the wrong metric. The metric is *who decided*. The decider was me, and I can prove it from the spec docs and the commit history.

## "How do you know the code is correct if AI wrote it?"

Three layers. **Strict TypeScript** catches the class of bugs AI commonly introduces — wrong arity, mistyped fields, null vs undefined confusion. Every file in the project passes `npx tsc --noEmit` before any rebuild. **Schema-level enforcement** — CHECK constraints in SQLite catch enum violations at insert time, not at render time, so a typo in a literal-union type fails fast in dev. **Manual end-to-end testing** on a physical Android device after every meaningful change. I install the release APK and run the actual user flow. This catches integration bugs that unit tests would miss.

Where I'm honest about gaps: I don't have automated tests, and the AI sometimes generates plausible-looking code that has subtle off-by-one errors. The only protection against that is reading every diff before I commit. I read every line. If I don't understand what a function does, it doesn't ship — and I push back on the AI to simplify until I do.

The deeper answer: code review is the same skill whether the author is a human or an AI. I review AI-generated code the same way I review a junior engineer's PR. Some things land cleanly. Others I send back for rewrites. The judgment is the constant; the author varies.

## "What would you do if the AI got something wrong?"

I have a real example. The AI initially proposed the expansion view as a bottom-sheet modal. I shipped it, opened the app on my phone, and immediately noticed the modal's bottom edge overlapping the Android system gesture bar. I could have told the AI to fix the modal — adjust z-index, add safe-area padding, fight with `react-native-modal`. Instead I recognized that the modal was the *wrong primitive entirely* — content that needs to scroll freely shouldn't be in a sheet that fights the system UI. Converted it to a full-page route at `app/todos/[id].tsx`.

The pattern: if AI-generated code compiles but feels wrong on the device, I trust the feeling. The discomfort usually traces to a missing constraint I hadn't articulated to the AI. My job is to articulate the constraint, not to debug the AI's output line-by-line. In that case the constraint was "this view needs to scroll without fighting system gestures" — once stated, the right primitive is obvious.

The other version of this question is "what if the AI generates code you don't understand?" Answer: I don't ship it. I push back until either the code simplifies enough to read, or I learn enough to read it. There's no third option where I commit code I can't explain.

## "What did you learn from building this?"

Three things, ranked by impact on how I work now.

**The cost of ambiguity in specs is much higher than I thought.** The AI follows the spec — if the spec is wrong, the code is wrong, but it ships fast and the wrongness compounds. I'm now much more rigorous about spec-then-build, and I've started writing explicit *rejection sections* in plans ("we are NOT building X because Y") because the AI will otherwise infer features into existence to fill gaps in the spec. Plans like [`docs/loopd-thinking-modes-spec.md`](../loopd-thinking-modes-spec.md) include both what to build and what to deliberately skip.

**Heuristic-first is a real product decision, not just an optimization.** The cost of every LLM call adds up at scale, and the deterministic path lets you ship features that wouldn't survive on AI alone. I'd been treating AI as the path; building this taught me to treat AI as the fallback when the deterministic path abstains. That mental shift — heuristic *before* LLM, not LLM *with heuristic backup* — changed how I'd architect any AI feature now.

**AI is best at the things I'm fluent in, worst at the things I'm not.** I'm fluent in TypeScript and React, so the AI was leverage in those areas — fast generation following my direction, with me catching subtle issues immediately. I'm not fluent in FFmpeg or `react-native-reanimated` or Android Gradle config, and the AI's output in those areas needed much more verification because I couldn't catch wrongness from a quick read. The takeaway: AI amplifies your existing skills more than it expands them. The skills still have to be there.

## "How is this different from just using a template?"

A template gives you starter code. This codebase has *decisions*. Concretely:

- **Prose-canonical drops with two-pass matching** is a non-obvious architectural choice. No template would do that; in fact most production templates do the opposite (structured fields). The decision is documented in [`docs/spec.md`](../spec.md) and the reasoning is in [`docs/concepts.md`](../concepts.md).
- **Cost-tiered LLM strategy with heuristic-first fallback** is a non-obvious AI-engineering choice. Templates that use AI just call one model. I have three at three cost tiers, gated by a deterministic classifier.
- **The 1:1 invariant between `todos_json` and `todo_meta`** without a real foreign key is a deliberate normalization tradeoff. Templates default to either fully-normalized or fully-JSON; I picked a hybrid because the entry-edit path is the hot loop and full normalization would fight autosave.
- **The `sync_deletions` queue with `entity_type` discriminator** is a CQRS-style pattern I learned and applied here. Templates don't tell you to do this — you have to know to reach for it.

The simplest test: ask me about any decision in this codebase, and I'll tell you (a) what I chose, (b) what I rejected, (c) what I'd do at scale. A template-user can't do that. They tell you what the template did and they're stuck when you ask why.

## "How is this different from copying StackOverflow?"

Both AI and StackOverflow give you code. The difference is *integration cost*. StackOverflow snippets are context-free — the developer has to do the work of fitting the snippet into their codebase, understanding the side effects, and ensuring it doesn't conflict with surrounding patterns. AI-assisted development front-loads the same integration work into the prompt: I describe the constraints, the existing patterns, the data model, and the AI generates code that fits. The integration cost moves earlier; the responsibility for understanding doesn't move at all.

The thing that's *worse* with AI: silent confidence. StackOverflow answers come with comments saying "this might not work for your case" or "edited 2019 — see updated answer." AI presents output with the same fluency whether it's correct or hallucinated. The mitigation is what I described above — read every diff, push back on code I don't understand, trust the feeling on the device. Skepticism scales; AI fluency does not.

What's *better* with AI: the cost of trying an alternative is lower. I can ask "what would this look like with a different state model" and get a real answer in 30 seconds, not the half-day it takes to refactor by hand. That changes how aggressively I can explore the design space — which means more decisions get *made* deliberately instead of by accident. The architectural quality of this codebase is partly a function of cheaper exploration.

## The hard question

> "If I gave you this codebase right now and told you to add a new feature, would you know how?"

Walk through any feature in this codebase, and I'll tell you which files to touch and in what order. Pick one — todo deletion, nutrition autocomplete, the markdown renderer in the expansion modal. The architecture is layered cleanly enough that a new feature lands in three places: a service module under `src/services/`, a hook adapter in `src/hooks/`, and a screen or component in `app/` or `src/components/`. The data model's nine tables have clear domain boundaries; if a feature needs new state, it goes in the table whose lifecycle matches.

For an actual demo: the heuristic verb list at [`heuristicClassify.ts:10-24`](../../src/services/todos/heuristicClassify.ts#L10-L24) is hard-coded right now. If you wanted me to make it user-configurable, I'd add a `heuristic_overrides` table with `(verb, classified_as)` rows, expose a settings screen at `app/settings/heuristic.tsx`, and modify `heuristicClassify` to consult the overrides before falling through to the static list. I'd reach for the existing CRUD pattern from `nutrition` (table + CRUD helpers + settings screen) because it's the closest analog. I'd ship Phase A as just the table + a hardcoded UI to bootstrap the override list, and Phase B as the actual settings screen. End-to-end maybe 4-6 hours.

That's the test of whether the codebase is *mine*. If I can sketch a feature on a whiteboard with file paths and time estimates, the architecture is in my head. The AI helped me get the code on disk; the architecture is what I built.

→ [12 — What I'd do differently](./12-what-id-do-differently.md)
