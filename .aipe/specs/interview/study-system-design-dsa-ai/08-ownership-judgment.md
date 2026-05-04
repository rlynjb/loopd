# Chapter 8 — Ownership and Judgment

## Opening — what you're looking at

This chapter is the most important one in the prep guide. Architecture and DSA can be studied; ownership and judgment have to be visible in how I *talk* about what I built. The decisions in this chapter are the ones that weren't obvious — the moments where I picked something that diverges from a default, or kept something simple that "should" be more complex, or abandoned an approach after starting it. Being able to name those moments and explain the reasoning is what separates "I built this" from "I shipped this and I understand it."

Three specific decisions sit at the center of the codebase. The first is *prose-canonical with derived projections*. I could have built a "checkbox list" feature, a "nutrition tracker" feature, and a "thread tagging" feature as three separate UIs writing to three separate tables. Instead I chose to make the journal text the single authoritative source, with two-pass scanners deriving typed rows. That's a hard call — it makes the data model harder to reason about (rows are derived, not user-created) but it makes the UX much better (the user types into one surface, structure happens automatically). The cost was the entire two-pass scanner pattern; the benefit is that the journal feels like an editor, not a form.

The second is *cloud as sync mirror, never canonical*. I could have built loopd as a cloud-first app with Supabase as the source of truth, the way most modern apps are built. Instead I chose local SQLite as canonical with Supabase as a mirror. That's a deliberate cost: I had to build a sync layer (push/pull/conflict resolution) instead of just doing CRUD against Supabase. The benefit: the journal is fully usable offline, writes are durable in milliseconds, and a Supabase outage degrades to "no sync" instead of "no app." The cost was real (about a week of focused work on the sync orchestrator); the benefit is structural — the keystroke path never depends on the network.

The third is *heuristic before LLM*. I could have called the model on every new todo and gotten classification on every line. Instead I built a 50-verb heuristic that resolves ~80% of cases for free. That's a cost I'm still paying — the heuristic has false negatives (rare false positives from idiomatic phrasing), and tuning it would be ongoing work. The benefit: the classifier toast appears only when there's actually something ambiguous, the per-key rate limit doesn't bind on common cases, and the user gets instant feedback on the obvious lines. The decision wasn't "is the heuristic better than the LLM?" — it's "where do you put the LLM in the pipeline?" The answer is *behind* the heuristic, not *instead* of it.

### ASCII diagram — three decisions and their costs

```
   Decision                    Cost                Benefit
   ─────────────────────────────────────────────────────────────
   prose-canonical            two-pass scanners   single typing surface
   + derived projections      reconcile after     no form-filling
                              every commit        round-trip writes

   cloud as mirror            sync layer          offline-first UX
   not canonical              push/pull/conflict  writes ms-durable
                              resolution          outage = degraded sync

   heuristic-before-LLM       hand-tuned 50-verb  ~80% free classify
                              regex set, false    instant feedback on
                              negatives ongoing   common cases

   Each row is a ridge in the design space. None had a "correct"
   answer; all three were judgment calls with explicit trade-offs.
```

---

## Concepts (four-part structure)

### 1. The slug-rejected-on-pull rule for threads

**Shape.** Three pieces interact with this rule. The `threads.slug` column is unique and matches `#tag` mentions case-insensitively. The thread editor at `/more/threads` allows editing the slug. The cloud sync pull pipeline brings down updated thread rows.

**Rule.** Renaming a slug is a destructive operation: existing `thread_mentions` reconcile against the *old* slug. The pull-side handler rejects slug renames that would silently strand mentions. If an editor changes the slug, the system either rebuilds the mentions (expensive) or treats the rename as a delete-and-recreate (data-correct but disruptive). The current implementation rejects the rename in the pull path and surfaces a UI warning instead.

**Failure mode.** Without the rule, a user editing `#loopd` to `#shipping` on phone A — thinking they're just relabeling the thread — would lose the connection between every prose mention of `#loopd` and the renamed thread on phone B. Phone B's pull would update `threads.slug` to `'shipping'`, the next prose scan would not match `#loopd` mentions to it, and every mention would auto-create a new thread called `#loopd`. The user would see two threads where they intended one.

**Contrast.** Renaming the thread *display name* is fine — it has no derived state attached. The slug is the matching key for prose; the name is just the label. The constraint that distinguishes them is which field participates in scanner reconciliation. Display name doesn't; slug does.

### 2. The decision to bundle the prebuilt `android/` directory

**Shape.** Three things matter for the build setup: the Expo managed workflow (no `android/` directory needed), the bare workflow with prebuilt native (Expo + custom config plugins, `android/` committed), and the dev client deployment path (`eas build` for prod, `npx expo run:android` for dev).

**Rule.** loopd ships the `android/` directory committed to git. Custom native modules — `@wokcito/ffmpeg-kit-react-native`, the camera roll permissions, the SQLite native module — require config that the managed workflow can't apply. Committing `android/` is the cost of those features.

**Failure mode.** Without committing `android/`, every fresh clone would have to run `npx expo prebuild` to regenerate it, which depends on the user having the Android SDK and the right NDK version. The dev experience would degrade from "clone, install, run" to "clone, install, prebuild, hope the prebuild matches what the last contributor had, run." For a solo project, that's wasted complexity. For a team project, it forces alignment around exact tool versions or regenerates differently per contributor.

**Contrast.** The iOS workflow is *not* committed because iOS isn't supported. If iOS were ever in scope, I'd commit `ios/` for the same reason. The constraint that distinguishes "commit the native dirs" from "managed workflow" is whether any custom native module needs config that prebuild can't generate from `app.json` alone — and FFmpeg fits that.

### 3. The choice to keep the AI provider switchable

**Shape.** Three pieces hold the abstraction. `src/services/ai/config.ts` stores the active provider (`'claude' | 'openai'`) and per-provider API keys. The four AI files (`summarize.ts`, `caption.ts`, `expand.ts`, `classify.ts`) each have a `provider`-aware switch that picks Claude or OpenAI per call. The settings screen at `app/settings/ai.tsx` exposes the switch.

**Rule.** Every LLM call is provider-agnostic. There are model constants in each file (`CLAUDE_MODEL`, `OPENAI_MODEL`) for primary; the classifier files have separate constants (`claude-haiku-4-5-20251001`, `gpt-4o-mini`) for the cheap path. The provider switch is checked at call time, not at app boot, so the user can change providers and have the next call respect it.

**Failure mode.** Without the abstraction, the codebase is locked to one provider. If Anthropic raises rates, deprecates a model, or has an outage, every AI feature in the app fails until I ship a new build. With the switch, the user (or a future Phase B operator) can switch to OpenAI in 30 seconds. This isn't a hypothetical — Anthropic deprecated Sonnet 3.5 mid-development and the migration to Sonnet 4.6 was a one-line change in two files.

**Contrast.** The DB layer is *not* abstracted across multiple stores. There's no `Persistence` interface; `database.ts` directly imports `expo-sqlite`. The constraint that distinguishes them: provider switching is a real, near-term need (rate limits, deprecations, user preference); database switching is a hypothetical (porting to web, switching cloud sync targets). Abstractions earn their weight from probability of needing them, not from cleanliness.

---

## Interview questions

### [mid] What's something in this codebase you almost did but didn't, and why?

**Model answer.**

I almost made the classifier run synchronously on commit instead of fire-and-forget. The synchronous path was simpler: classify, then write the meta row with the result, return. The fire-and-forget path required a module-level in-flight set, a progress event, and a UI toast on the `/todos` screen. More moving parts.

I went with fire-and-forget because the synchronous path makes commit time depend on LLM latency. A 1.2-second Sonnet call would block the user from typing anything else for 1.2 seconds — terrible UX in the journal. The fire-and-forget path commits the meta row with `classifier_confidence: 'heuristic'` immediately if the heuristic returned `'todo'`, or with `classifierConfidence: NULL` if the heuristic was uncertain. The LLM call fires async; when it returns, an `updateTodoMeta` patch upgrades the row. The user sees the badge appear with a slight delay rather than waiting for everything to settle before they can type.

The cost was the toast UI and the in-flight tracking, which is ~30 lines of code. The benefit is the typing-blocking property of the journal stays intact. Same trade-off as DB-first autosave — give the user the immediate path, do the slower work async.

### [senior] What did you abandon during development and why?

**Model answer.**

The Notion sync layer. The first version of loopd (commits before `dc8483a`) had a Notion integration that pushed entries to a Notion database, with todos and habits as relations to other databases. The user could view their journal in Notion as a normal database. I built it because Notion is where my prose archive already lived; the migration path felt natural.

I deleted it for three reasons. The first is the Notion API rate limits. With multi-table relations and per-row updates, a single day of journaling generated ~20 API calls, and the Notion API caps at ~3 requests/second. Bursts triggered 429s; sustained syncs hit user-level quotas. The system was perpetually behind.

The second is the data shape mismatch. Notion is page-shaped, not row-shaped. A todo with an expansion fits a page better than a row, but the structured fields (type, stage, classifier_confidence) wanted columnar storage. I ended up with a two-tier design — a Notion DB row pointing at a Notion page — which doubled the API calls and the mental overhead.

The third is the canonical-source confusion. Once Notion held a copy of every entry, users (me) started editing in Notion. The sync had to handle Notion-as-write-source, which meant pulling from Notion → SQLite → re-running scanners. The bidirectional sync got complex; conflict resolution between the device's prose and Notion's edited prose required diffing, which was its own scanner. I was building a CRDT for two-app collaboration on text, and the user was one person.

Supabase replaced it. Same canonical-mirror split (SQLite local, cloud mirror) but with a schema I controlled, a row-shaped store that fit the data model, and a write rate that didn't hit ratelimits. The Notion code was deleted in commit `dc8483a` and good riddance. What I kept from the experience: the architectural principle that cloud is a mirror, never canonical. That came directly from the Notion mistake.

### [arch] What's something simple in the codebase that you've been tempted to over-engineer?

**Model answer.**

The rank function in `src/services/todos/rank.ts`. It's 50 lines of imperative TypeScript — flatten entries' todos, tag with source, sort by priority, filter done. I've been tempted multiple times to replace it with: an indexed SQL view, a configurable scoring function with weights, a pluggable strategy pattern, an async iterator over a chunked input. None of those have shipped, and every time I've considered them, the answer has been "the current version works at the current scale and the next refactor isn't urgent."

The temptation to over-engineer is real because the function *will* break at scale. At 10× journal entries, the in-memory flatten is too expensive (it's ranked at every dashboard mount) and the right answer is the indexed SQL view. But scaling 10× has not happened. Building the SQL view today would mean: design a `todos_with_meta_ranked` view in the migration, decide how the source-priority is represented in SQL (a CASE expression), wire the rank function to query the view instead of flattening, write a manual test to confirm the new path matches the old. That's a half-day of work for zero perceptible benefit until I have 1000+ entries.

The judgment is: write the simple version that works at current scale, write down "this won't scale past 10× entries" as a backlog item with the SQL replacement spec'd, ship. The architectural rule I'm satisfying: don't pre-optimize. The architectural rule I'm respecting: don't *forget* what won't scale. The backlog entry is the bookkeeping. When the entry count grows, the SQL replacement is one focused day of work, not a discovery exercise.

The same logic applies elsewhere. The `getThreadCards` aggregator in `src/services/threads/getThreadCards.ts` is intentionally a single SQLite-side query with JS post-processing rather than a stored procedure or a multi-query plan; I'd switch only when the post-processing dominates query time, which it doesn't. The classifier toast is a single absolutely-positioned component rather than a managed notification system; I'd switch only if I had three or four cross-cutting toasts to manage. Simplicity is the default; complexity is justified by a measurable need.

---

## The hard question

### "Pick the worst piece of code in this codebase and tell me why it's bad."

**Model answer (≥200 words).**

The cloud sync orchestrator's per-table push/pull walk in `src/services/sync/orchestrator.ts`. The function structure is a `for…of` loop over a hard-coded array of table adapters with try/catches around each. It works. It is not bad code. But it carries an architectural weakness: the order is hand-maintained (`pushOrder`, `pullOrder` are two separate arrays in the file), and the order is significant — pull order has to respect FK dependencies (threads before thread_mentions, entries before todo_meta), push order doesn't. Adding a new synced table requires editing both arrays.

The bad part: there's no compile-time check that the orders cover every adapter, or that an FK-dependent table comes after its parent. I could rename a table in `pullOrder` without renaming it in `pushOrder` and the type system wouldn't notice. The pull would silently skip the renamed table; rows would never reach the cloud. The next "I haven't seen this row on my second device" bug would take an hour to diagnose because the orchestrator would report no error.

The fix is straightforward: each `SyncableTable` adapter declares its dependencies (`dependsOn: ['threads']`), and the orchestrator topologically sorts at boot. Adding a table becomes a one-file change instead of three. I haven't done it because the current arrays have ten entries, fit on the screen, and have not produced a bug. The fix would take an hour. I should do it before the eleventh table is added — that's when "fits on the screen" stops being true.

Why this is the worst code: it's an architectural smell more than a bug. It's the place where the abstraction (`SyncableTable` interface) leaks back into the orchestrator's hand-maintained config. The interface promises "tables are plug-in," but the orchestrator's config breaks the promise. The fix is on the deferred backlog. The honest answer is: I noticed this, decided not to fix it now because the current shape has zero bugs, but every time I see it I feel the friction. That's exactly the state most "worst code" lives in — known, named, deferred. Pretending I have no bad code would be the worse answer.
