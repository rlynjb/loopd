# Chapter 7 — Developer process

The development process is **spec-driven AI-assisted solo development**. There is one engineer. The codebase is built by alternating between Claude.ai (for design conversations + spec writing) and Claude Code (for implementation against the spec). The discipline that keeps the codebase coherent is `docs/spec.md` — the canonical architecture reference that gets refreshed after every meaningful feature lands — plus the per-feature design docs in `docs/` that capture the intent before code gets written.

```
The loop, every feature

  ┌──────────────────────────────────────────────────────┐
  │  1. Brainstorm in Claude.ai                          │
  │     "I want to add weekly schedule grids."           │
  │     "Should habits and threads share rows?"          │
  │     Output: a clear understanding of the user value, │
  │     the edge cases, and what to build vs defer.      │
  └──────────────────────┬───────────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────────┐
  │  2. Write the spec                                   │
  │     Save to docs/buffr-<feature>-spec.md             │
  │     Sections: motivation, principles, schema,        │
  │     UX, edge cases, deviations from defaults.        │
  │     The spec is the contract before code exists.     │
  └──────────────────────┬───────────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────────┐
  │  3. Implement in Claude Code                         │
  │     "Implement docs/buffr-<feature>-spec.md."        │
  │     Iterate at the file level, review every diff,    │
  │     reject changes that violate the spec.            │
  │     Run npx tsc --noEmit; manual e2e on device.      │
  └──────────────────────┬───────────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────────┐
  │  4. Update spec.md and .aipe/ context                │
  │     Refresh docs/spec.md to reflect the new state.   │
  │     Update .aipe/project/context.md if anything      │
  │     architectural changed (a new principle, a new    │
  │     dead column, a new sync table, etc).             │
  │     Commit. Move on to the next feature.             │
  └──────────────────────────────────────────────────────┘
```

The interview point is: this isn't "I asked an AI to build the app." This is "I designed the system, wrote a spec for each feature, and used AI to translate the spec into code under continuous review." The AI's role is *implementation acceleration*; the engineer's role is *every architectural decision, every spec, every review of every diff*.

## Concept 1 — `.aipe/project/context.md` as durable AI context

**Shape.** Three pieces in `.aipe/project/`: `context.md` (architecture, data model, file structure, what-must-not-change), `rules.md` (coding style, file naming, testing, non-negotiables), `stack.md` (dependency pins). These are loaded into every Claude Code session by the AIPE plugin.

**Rule.** The AI does not have to be told the architecture every session. The context files capture the *durable* facts: what's canonical, what's derived, what's deprecated, what's a deliberate non-decision. The session-specific facts (the current task, the latest diff, the immediate goal) are what fits in the prompt; the durable facts are what fits in the project context.

**Failure mode.** Without `context.md`, every session starts cold. I'd have to explain the prose-is-canonical rule, the soft-delete invariant, the 1:1 between todos_json and todo_meta, every session. By the time I've described the architecture, I've burned 30 minutes of iteration time and the AI has a partial understanding because I forgot to mention the `user_overridden_type` lock. With the context file, the AI starts every session knowing the rules, and I can spend the session actually building.

**Contrast.** The `docs/buffr-<feature>-spec.md` files are *session-specific*: they describe one feature, get implemented, and then the spec is folded into `docs/spec.md` (the canonical reference) which then informs future `context.md` updates. The constraint that distinguishes: per-feature specs are tactical (this is what we're building right now); `context.md` is strategic (this is what's true about the system).

## Concept 2 — Spec before code

**Shape.** Three pieces: a Claude.ai brainstorming session that surfaces the design space, a written spec saved to `docs/buffr-<feature>-spec.md` covering motivation/schema/UX/edge cases, and a Claude Code session that implements the spec end-to-end with the spec as the contract.

**Rule.** No feature gets implemented without a written spec. Every spec answers four questions: what's the user value, what's the data model, what's the UX flow, what are the edge cases I've thought through. The spec gets written *before* the code, not after.

**Failure mode.** "Just start coding" with AI assistance produces working code that doesn't match a coherent design. The AI fills in plausible-looking defaults for any decision the engineer didn't make explicit. After three features, the codebase has three slightly-different patterns for the same problem — three error-handling styles, three state-management approaches, three sync-side mappers. The architecture decays. With a spec, every feature is forced through the same architectural lens before it touches code, and the AI's defaults get rejected when they violate established patterns.

**Contrast.** Bug fixes don't get specs. A bug fix is "the code does X, it should do Y, here's the patch." The constraint that distinguishes: a feature is a design decision (multiple valid implementations); a bug is a correctness gap (one valid implementation). Specs are for design; tests would be for correctness, and since there are no tests, manual verification on the device closes the loop.

## Concept 3 — `docs/spec.md` as the canonical refresh target

**Shape.** Three pieces: per-feature spec files (`buffr-cloud-sync-spec.md`, `buffr-thinking-modes-spec.md`, `buffr-daily-schedule-grid-spec.md`, etc.), `docs/spec.md` (the canonical "this is what buffr is, end-to-end"), and the periodic "refresh spec.md from current code state" commits (commit `1fdb7a3` is the most recent).

**Rule.** After every meaningful feature lands, `docs/spec.md` gets refreshed. The per-feature specs are *historical artifacts* — they capture the intent at the time of writing. `spec.md` is *current* — it reflects what the code does today. The two diverge over time as features evolve; that's expected.

**Failure mode.** Without periodic refresh, `spec.md` becomes "the spec as of 6 months ago." A new contributor (or a future me) reads it and gets confused when the code doesn't match. Worse, AI sessions that load `spec.md` as context get *stale* facts injected, and the AI's suggestions start violating principles that were quietly retired. The refresh discipline keeps the canonical doc honest.

**Contrast.** The per-feature spec files are *not* refreshed. They're write-once. The constraint that distinguishes: per-feature specs are append-only because they capture a moment of decision; `spec.md` is mutable because it captures a moment of state. Same principle as Postgres migrations being append-only (decisions) vs SQLite local migrations being feels-forward (state).

## Concept 4 — `npx tsc --noEmit` as the only mandatory gate

**Shape.** Three pieces: TypeScript strict mode in `tsconfig.json`, no-emit type-check (`tsc --noEmit`) is the gate before commit (`.aipe/project/rules.md`), and the type system is leaned on heavily — discriminated unions, generic constraints, mapped types — to catch regressions the test suite doesn't.

**Rule.** Every commit must pass `npx tsc --noEmit` cleanly. This is the single automated gate. There's no lint, no test runner, no prettier. The compiler is the bar.

**Failure mode.** Without strict TypeScript, the AI's plausible-looking code that doesn't compile would still get committed and cause runtime crashes. With strict TypeScript, the compiler catches the common AI mistakes — passing `string | undefined` where `string` is required, indexing into a possibly-empty array, calling a method on a nullable type. Strict mode is the AI-collaboration safety net the codebase relies on.

**Contrast.** A real test suite would catch behavior regressions (the scanner returns the wrong todos for input X); the type system only catches type regressions. The constraint that distinguishes: the type system is *cheap* — it runs in seconds, has no flake, has no maintenance cost beyond writing the types. A test suite is *expensive* — runners, fixtures, mocks, flake. For solo velocity at this scale, the type system pays for itself; a test suite would pay for itself if there were a team or if user-facing bugs were costly. The deferred backlog acknowledges this asymmetry.

## Three interview questions

### `[mid]` — "Walk me through how you'd add a new feature like 'pinned' on todos."

The pin feature actually shipped in commit `a7d6044`. Here's the real flow.

Step 1: Decide the feature is wanted. The trigger was that the deprecated `position` column on `todo_meta` (manual reorder) was being abandoned because dragging-to-reorder on a long list was ergonomic friction. The replacement: a single boolean `pinned` per todo, with pinned-first sort everywhere.

Step 2: Brainstorm in Claude.ai. The conversation surfaced edge cases: "what if the user pins a todo and then completes it — does it stay pinned?" "Yes — pinned beats done; the pinned-first sort applies regardless of done state, completion drops it from the dashboard's ranked list after 2s." Also: "should pinned be sticky across reorder of unpinned items?" "Yes — pinned items are sorted by createdAt DESC among themselves, just like unpinned items, just at the top of the list."

Step 3: Write the spec. In this case the feature was small enough that the spec lived inline in the PR description and the deferred backlog rather than its own file — the threshold for a separate spec doc is "is this big enough that I'll want to refer back to the design intent later?" Pin was small. Cloud sync wasn't.

Step 4: Implement in Claude Code. The implementation touches: `supabase/migrations/0005_todo_meta_pinned.sql` (new column with default false), `src/services/database.ts` (the `TodoMetaRow` type, `insertTodoMeta`, `updateTodoMeta` mappers), `src/types/todoMeta.ts` (the type), `src/services/sync/tables/todoMeta.ts` (the local↔cloud mapper), `app/todos.tsx` (the pin button + sort), `src/components/home/SmartTodoList.tsx` (the dashboard sort to match). About 8 files. AI generates the diffs, I review every one against the spec.

Step 5: Verify. `npx tsc --noEmit` clean. Manual end-to-end on device: create a todo, pin it, see it move to the top; create another todo (unpinned), see the pinned one stay at the top; complete the pinned one, see it drop after 2s on the dashboard; check the cloud sync round-trip via the dev menu.

Step 6: Update `.aipe/project/context.md` to mention pin replaced position. Commit. Done.

What I'd want an interviewer to notice: the spec wasn't "add a pinned column"; the spec was "this is the decision, here's why the alternative (drag-to-reorder) was retired, here are the sort tiebreaks, here's where it has to land in five files for consistency." The AI did the typing; I did the reasoning.

### `[senior]` — "How do you keep the AI from drifting the architecture as the codebase grows?"

Three controls.

First, **`.aipe/project/context.md` is the durable load-bearing context.** Every session starts with the AI knowing the architecture's principles. When I ask for a new feature, the AI's first-pass diff doesn't violate "prose is canonical" or "soft delete only" because the rules are in its working memory. The context file is itself a discipline — when an architectural rule changes, I update the context file *first*, and only then update the code. The doc lags reality only at the moment I'm changing reality, not after.

Second, **review every diff at the file level, never accept whole-feature batches blind.** The AI's plausible defaults are wrong about 20-30% of the time on subtle architectural points — it'll add a try/catch where the codebase relies on the throw, or add a new write site that doesn't call `schedulePush`, or add a SQL query that doesn't filter `deleted_at`. The cost of catching these at PR time vs at first-merge is order-of-magnitude. So I read every line. The AI accelerates typing; it doesn't accelerate judgment.

Third, **the canonical spec.md is refreshed periodically and informs context.md updates.** As the architecture evolves, `spec.md` is updated to reflect the new state, and any new principles get propagated to `context.md`. The recent example: cloud sync M0-M7 added 12 files of sync infrastructure plus 5 Supabase migrations plus a new "cloud is a sync mirror, never canonical" principle. After the milestone landed, `spec.md` got the §10 principle list extended, and `context.md` got the new sync-related "what must not change" entries (`(user_id, id)` PK, append-only migrations, `schedulePush()` from every write site).

The pattern that works: AI is a *force multiplier on a clear architecture*. AI without an architecture produces drift. The way to avoid drift is to have the architecture be a written, refreshed, AI-loaded document — and to enforce it manually at review time.

### `[arch]` — "If you were onboarding a second engineer, what would change about your process?"

Five changes, in priority.

First, **a real test suite.** Today's "manual e2e on device" works because I am the only person editing the code and I run the manual pass after every change. With a second engineer, their changes can't trigger my manual pass. I'd add Vitest with a fixture suite for the pure functions (`scanTodosFromText`, `chooseWinner`, `computeStaleness`, `cellStateFor`, the validators in `services/ai/validate.ts`), React Native Testing Library smoke tests on the top 3 screens (dashboard, journal, /todos), and a single Detox journey test ("create entry, type a `[]`, leave screen, return, see the todo on dashboard"). Gate merges on green CI.

Second, **PRs replace direct-to-main commits.** The current repo has commits going straight to main because there's no one to review them. With two engineers, every change is a PR with a description that links to the relevant `docs/buffr-*-spec.md` or backlog entry, and is reviewed before merge. The review checklist is the implicit one I run on AI-generated diffs: "does this violate the spec? does this add a write site that skips `schedulePush`? does this read a synced table without `deleted_at IS NULL`?"

Third, **observability and crash reporting on the device.** Today's reliability story relies on me being the only user — when I crash, I see the redbox. With a second engineer also using the app, I need Sentry / PostHog so their crashes surface to me too. This converges with the production-readiness gap from Chapter 6.

Fourth, **`docs/spec.md` becomes the onboarding artifact.** The spec at its current size (~600 lines) is enough to onboard a competent engineer in a half-day. I'd point them at it on day one, expect them to read it, and then hand them a small bug-fix or polish task that walks them through the codebase via the spec's structure.

Fifth, **the AI context becomes a shared tool, not a personal one.** Right now `.aipe/project/context.md` reflects how I think about the system. With a second engineer, both of us should be editing it and reviewing each other's changes to it — same as the code. The context file becomes "the team's shared mental model of the architecture, externalized."

What stays. The spec-driven loop stays — it scales to a small team better than to a solo. The single-write-site discipline (every SQL goes through `database.ts`) stays — it's actually more important with two engineers because the cost of a missed `schedulePush` call is higher when neither of us is the sole reviewer. The strict TypeScript stays — same reasoning, more important with more contributors. The 12 architectural principles in `docs/spec.md §10` stay — they're the architectural contract; their value is they're written down.

## The hard question — "How much of this codebase did the AI write vs you?"

Honestly, the AI typed roughly 80% of the lines. I wrote, reviewed, and decided 100% of them.

The breakdown: scaffolding (file boilerplate, type definitions, `StyleSheet.create` blocks, repeated CRUD patterns) — almost entirely AI. Architectural decisions (what's canonical, what's derived, where the 1:1 invariant lives, how sync is shaped, why the caption pipeline is its own call) — entirely me, often after multiple Claude.ai brainstorming sessions where I argued through the alternatives. Implementation of architectural decisions (translating "todo_meta is a real table because the classifier writes to it asynchronously" into the actual tables, mappers, reconciler) — AI types, I review and reject when wrong.

The interesting question isn't "who wrote the lines" — it's "who would catch a regression." That answer is: only me. If the AI's next diff weakens an invariant — say, removes the `WHERE deleted_at IS NULL` filter from a read because it's "simplifying" — only my review catches it. The AI doesn't have a stake in the architecture. The AI doesn't remember the bug from three months ago that motivated the invariant. I do.

The signals I'd point an interviewer at to verify the claim:

1. **Every architectural principle is written down before the code that enforces it.** The 12 principles in `docs/spec.md §10`, the per-feature specs in `docs/`, the `.aipe/project/context.md` "what must not change" section. These are written by me, in my voice, and predate the code. The AI fills them in; I write them.
2. **The deferred backlog (`docs/buffr-deferred-backlog.md`) lists things the AI didn't suggest.** Hard delete (vacuum), test suite, observability, multi-device CRDTs. These are gaps I identified by thinking about "what would break at scale" — the AI doesn't volunteer architectural gaps unless asked.
3. **The bug history in `git log` reflects judgment calls the AI couldn't make.** The "manual-touch deviation" in `services/threads/touch.ts` — writing a `thread_mentions` row with NULL `entry_id` AND NULL `todo_id` to mark a thread "done today" — violates the otherwise-tight invariant that mentions are derived from prose. I made that decision; the AI would've followed the original invariant and produced a worse UX. The deviation is documented in `spec.md §10 Principle 11`.
4. **The "what's deliberately kept simple" decisions are mine.** No event bus. No service container. No state management library. No automated tests. No backend. Each of these is a thing the AI would happily build if I asked it to; each is a thing I declined to build because it'd buy ceremony, not utility.

The honest framing: AI raised my throughput by maybe 3-5×. It did not raise my judgment. The codebase is good *because the architectural decisions are good* — and those came from a human reasoning carefully about a domain.
