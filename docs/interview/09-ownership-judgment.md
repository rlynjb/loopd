# 09 — Ownership and judgment

> **The most important chapter.** This is where senior thinking becomes visible — the decisions that weren't obvious, the things I tried and abandoned, the calls I'd defend even when they go against common practice. If you only have time to internalize one chapter beyond the preface, make it this one.

What separates a senior engineer from someone who just shipped a working app is the ability to articulate *why* the code is shaped the way it is — not just defending the surface of the architecture, but defending the negative space too. The decisions you didn't make. The features you cut. The patterns you walked away from when they didn't fit. This chapter is loopd's negative space.

Three decisions in this codebase are the kind that will land on an interviewer's whiteboard. First, removing the `pinned` feature when the new thinking-modes architecture made it redundant. Second, rewriting the original drops spec from scratch when the AI proposed a Next.js / Netlify stack that didn't match the actual platform. Third, keeping the dashboard ranked while flattening only `/todos` — going against the implementation plan that suggested flattening both. None of these were obvious. All of them are defensible. All three are documented in the spec docs and in this guide so the reasoning survives me.

The pattern across all three: I made the call after the easier path was visible, with full awareness of what I was giving up. That's the senior signature — willingness to delete features when they're subsumed, willingness to push back on a plan when the plan is wrong, willingness to keep complexity in one place so simplicity wins somewhere else.

```
        Phase shipping discipline — thinking-modes feature

  spec written
       │
       ▼
  ┌─────────────────────────────────────────────────────┐
  │ Phase A — heuristic + table + UI restructure       │
  │  ───────────────────────────────────────────────    │
  │  • todo_meta SQLite migration + CHECK constraints   │
  │  • heuristicClassify (pure function, ~50 verbs)     │
  │  • reconcileTodoMetaForEntry (1:1 invariant)         │
  │  • TypeBadge, TypeChangePicker UI                    │
  │  • /todos restructured: flat list + filter chips    │
  │  • Dashboard kept ranked (pushback #1)               │
  │                                                      │
  │  Ship: every todo categorized, manual override       │
  │        works, NO LLM cost yet                       │
  │  Time: ~12-15h                                       │
  └────────────────────┬────────────────────────────────┘
                       │
                       │ shippable on its own
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │ Phase B — LLM classifier                            │
  │  • classify.ts (Haiku 4.5 / 4o-mini)                │
  │  • boot-time catch-up via classifyAmbiguousMeta     │
  │  • toast UX for in-flight progress                   │
  │  • Skip done todos (cost discipline)                 │
  │                                                      │
  │  Ship: ambiguous todos auto-classified               │
  │  Time: ~7-10h                                        │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │ Phase C — expansion (per-type prompts)              │
  │  • Six expansion shapes + JSON schemas              │
  │  • expand.ts (Sonnet / 4o, 3-concurrent cap)        │
  │  • Full-page /todos/[id] route (not modal)          │
  │  • Reasoning preambles per type                      │
  │                                                      │
  │  Ship: tap [expand] on any non-todo                  │
  │  Time: ~10-15h                                       │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │ Phase D — Notion sync extension                     │
  │  • Mapper handles 5 new properties                   │
  │  • Schema-gap tolerance (older DBs still sync)       │
  │  • Per-field merge rules (Title prose-canonical)     │
  │                                                      │
  │  Ship: thinking-mode fields round-trip to Notion    │
  │  Time: ~5-8h                                         │
  └─────────────────────────────────────────────────────┘

  Each phase shipped a complete, defensible feature.
  After Phase A, no LLM cost incurred yet — but the feature works.
  After Phase B, automation lands without changing the UI shape.
  After Phase C, the expensive AI feature is opt-in (user-tap only).
  After Phase D, persistence story is complete.

  The discipline: slice by value-delivery, not by layer.
```

## Interview questions

### Q1 [senior] What's a decision you made that you'd defend even though it goes against common practice?

I deliberately removed the `pinned` feature from the todos system and replaced it with the new thinking-modes architecture (type + stage + AI-classifier-with-user-override).

Common practice for todo apps is to keep the pin/star primitive forever because users expect it. I removed it because the new architecture made it redundant. A pinned todo was effectively a manually-prioritized one — and the new `position` column does that better with explicit reorder. The `type` column captures *what kind of todo* it is. The `stage` column captures *workflow state* (open / in-progress / backlog). Together those three dimensions express everything pin used to express, plus more.

The cost was a destructive-ish migration — I had to delete the column, update the migration, and remove every reference in the UI. The benefit was one fewer dimension of state to reason about, and a simpler mental model for the user.

The deeper thing this shows: I'm willing to delete features when they're subsumed, even if some users (in this case, me) had them. Many engineers won't. The instinct to add primitives is much stronger than the instinct to consolidate them, and consolidation almost always lands on the long-term-correct shape. I documented the principle that fell out of this in CLAUDE.md as principle 9: *"Classifier output is editable; user override is permanent."* That's a more general formulation of what `pinned` was trying to do.

### Q2 [senior] What's the worst tradeoff in this codebase?

The lack of automated tests for the scanner-and-reconcile pipeline. It's the *highest-risk code* in the project — bugs would silently corrupt user data — and it's the *most testable* code (pure functions, clear input/output). I've shipped it and iterated on it heavily, and I'm one refactor away from breaking the two-pass matching subtly without noticing until the user reports orphaned todos.

The reason I haven't fixed it: at solo-app scale, my "test" is dogfooding on my own data, and bugs surface within a day. At any larger scale, this is the first thing I'd build. Fixture-based tests for [`scanTodos.ts`](../../src/services/todos/scanTodos.ts) covering: edit-in-place, delete-line, insert-line, reorder-lines, identical-text-twice, empty-content. Maybe 30-50 cases, all derived from real edits I've seen. A day's work.

Owning the tradeoff: I made it deliberately because the cost of a bug at solo-scale is bounded — I'm the only user, I can fix forward. At a job, this is non-negotiable. The right time to write parser tests isn't when you have time; it's the day before someone else needs to refactor your parser.

### Q3 [arch] If you started over today, what would you change?

Three things, in priority order.

**Test fixtures from day one.** The argument I made above. The cost is one day; the benefit is confidence on every scanner change. There's no reason this isn't the first thing in the project.

**A tighter type-state coupling.** Today `TodoType`, `TodoStage`, and `ClassifierConfidence` are TS string-literal unions, and CHECK constraints in SQLite mirror them — but the link is *manual*. If I added a new value I'd need to update both. I'd extract a single source of truth — one TypeScript file that exports both the union and the SQL CHECK string, with codegen producing the migration fragment. This is a 2-3 hour refactor that I haven't done because I add types rarely. At any larger scale, with multiple contributors adding types, this would be Day-1 work.

**A queue worker for Notion writes.** Right now `syncAllTodos` is a synchronous loop that pushes everything dirty in one call. At any meaningful scale, that's a cliff. I'd refactor to a `drop_write_queue` pattern (which I outlined in the original drops plan but didn't ship) where each Notion write is a queued op processed asynchronously, with retry-after backoff and dead-letter handling for permanently-failed writes.

What I *wouldn't* change: the prose-canonical drops idiom and the heuristic-first classifier. Those are the two non-obvious decisions that make this app feel different from a normal todo tracker, and I'd defend them at any scale. Prose-canonical is the difference between "capture is filing" and "capture is a separate step." Heuristic-first is the difference between "AI is the path" and "AI is the fallback."

The architectural thing I'm most proud of is that the spec docs make all this defensible *without me being in the room*. [`docs/spec.md`](../spec.md), [`docs/concepts.md`](../concepts.md), and the chapters in this folder all encode the reasoning. A new contributor could read them and understand not just *what* the code does but *why* it's shaped that way. That's the artifact I'd carry forward to any new project.

## The hard question

> "What did you actually decide vs what did the AI decide?"

This is the question every interviewer wants to ask and most candidates dodge. The honest answer is that the AI wrote a lot of the code and I made every architectural decision. The way to think about it is that LOC is the wrong metric. The metric is *who decided*.

I can prove this with specific examples. The drops spec the AI initially produced assumed a Next.js / Netlify stack — the AI defaulted to the previous project's stack because that's what the spec template said. I rewrote the entire plan against React Native + Expo + SQLite before a single line of code was written. That's documented in this repo's history.

The implementation plan for thinking-modes recommended flattening *both* the dashboard and `/todos` to chronological. I pushed back on that and kept the dashboard ranked while flattening only `/todos`. Different surfaces, different intents — the dashboard answers "what should I attend to right now?" (wants ranking), the page answers "what's been captured?" (wants chronology). I wrote the four pushbacks in [`docs/concepts.md`](../concepts.md) explicitly so the reasoning survives.

The ExpansionModal as a bottom-sheet was the AI's first cut. I shipped it, opened it on the device, realized it overlapped the Android system gesture bar, and decided the modal was the wrong primitive. Converted it to a full-page route at `app/todos/[id].tsx`. The AI wrote the refactor faster than I would have, but the *judgment* — recognizing the UX problem on the device, deciding the modal was wrong, directing the change to a route — was mine.

The phasing of thinking-modes into 4 ship-able phases was my call against an originally-monolithic 33-50h plan. The decision to use heuristic-first instead of just calling the LLM on every classification was my call. The decision to remove `pinned` was my call. The decision to keep `notionPageId` only on `TodoItem` and not duplicate it on `TodoMeta` (avoiding drift) was my call.

The general pattern: I'm fluent in TypeScript and React, so the AI was leverage in those areas — fast code generation following my direction. I'm not fluent in FFmpeg or Reanimated, and the AI's output in those areas needed much more verification because I couldn't catch subtle wrongness. The takeaway from building this: AI amplifies the skills you already have more than it expands the skills you don't. The skills still have to be there. The judgment still has to be there. I read every diff before I commit; if I don't understand a function, it doesn't ship.

→ [10 — Data structures and algorithms](./10-dsa.md)
