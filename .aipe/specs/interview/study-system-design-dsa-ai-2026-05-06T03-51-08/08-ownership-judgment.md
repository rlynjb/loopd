# Chapter 8 — Ownership and judgment

This is the most important chapter. Everything in the previous chapters is *what the codebase looks like.* This chapter is *which decisions weren't obvious, and how I made them.* In an interview, this is where senior thinking becomes visible. A candidate who can recite their architecture sounds competent. A candidate who can name three decisions they almost got wrong, and how they noticed, and what they'd do differently — that's the senior signal.

I'm going to walk through five judgment calls. Each one had a defensible alternative. I'll name the alternative, name the reason I picked the actual answer, and name what I'd revisit at higher scale.

## Concept 1 — Choosing prose-is-canonical over a structured editor

**Shape.** Three pieces: the user types prose into one big `TextInput`, the scanner runs at commit time and emits `TodoItem[]` / `NutritionRow[]` / `ThreadMention[]` from marker syntax, the dashboard / list views render from the derived rows.

**Rule.** The user only ever types in *one* surface — the journal entry's prose textbox. There is no "add a todo" form. There is no "log a meal" form. There is no "create a thread mention" form. Everything happens by typing inline markers (`[]`, `** food N kcal`, `#tag`) into the prose.

**Failure mode.** The structured-editor alternative: separate forms for todos, nutrition, and threads, each writing to its own table directly. The failure mode of *that* design: the user has to context-switch between "writing my journal" and "logging a todo" — three taps to add a todo means todos don't get added; the friction beats the feature. With prose-is-canonical, the user is already typing, the markers are ergonomic, and the derived state is a free benefit of the existing gesture.

**Contrast.** Habits *don't* follow this rule — they're toggled via the schedule grid, no inline syntax. The constraint that distinguishes: habits don't have a natural prose form. "I worked out today" is not the same thing as "I checked my workout habit"; the former is text the user might naturally write, the latter is a structured signal. Drops live in prose because they coexist with sentences; habits live as gestures because there's nothing to coexist with.

**The judgment.** I almost built the structured editor. Three days into the prototype I had separate "add todo" and "add nutrition" forms. The friction was visible by day five — I was logging fewer todos than I would in a paper notebook. I deleted the forms and built the marker syntax. Two weeks later the marker syntax had ~3× the engagement of the form-based version. The lesson: ergonomic friction beats feature richness for daily-use tools. Where I'd revisit at scale: with a multi-user collaborative version, prose becomes harder to merge (CRDT layer needed), and at that point the structured editor's simpler merge semantics start being attractive again.

## Concept 2 — The manual-touch deviation in `thread_mentions`

**Shape.** Three pieces: `thread_mentions` is normally a derived table (`scanThreadsFromText` in `src/services/threads/scanThreads.ts` rebuilds it from prose); the schema requires *only one of* `entry_id` / `todo_id` to be set (line-level mention vs todo-level mention); the `services/threads/touch.ts:toggleThreadTouchToday` function inserts a row with **both NULL**.

**Rule.** Mentions derived from prose set exactly one of the two FKs. The manual-touch deviation sets neither. The schema permits it (no CHECK constraint enforces "at least one set"); the staleness math composes uniformly because both `entry_id` and `todo_id` are nullable everywhere.

**Failure mode.** The "no deviation, dashboard touch must round-trip into prose" alternative: if the user taps the thread on the dashboard to mark it "done today," the system writes `[#thread] touched` to today's entry, runs the scanner, and the resulting mention has an `entry_id`. The failure: it pollutes the user's prose with a marker they didn't type. They open the journal, see `[#thread] touched`, and either delete it (which un-marks the thread, surprising) or are confused. The dashboard touch is a *different gesture* from inline tagging — it deserves a different storage shape.

**Contrast.** Todos *do* round-trip dashboard mutations into prose — toggling a todo's `done` state on the dashboard rewrites the `[]`/`[x]` line in `entries.text`. Why allow round-trip there but not for thread touches? Because the prose marker for a todo *already exists* (the user typed `[]` to create it); we're toggling its state, not creating new prose. The thread-touch case has no pre-existing prose to mutate. The deviation only permits prose pollution where no pre-existing marker exists.

**The judgment.** I noticed this case while writing the threads spec. The principle "mentions are derived from prose" is clean; this case is genuinely outside it. I had three options: (1) violate the principle by writing to prose, (2) add a separate `thread_touches` table just for this case, (3) accept the deviation and document it as "Principle 11" — the only deviation, with a written justification. I picked (3). Adding `thread_touches` would be a new sync table, new mapper, new reconciler — overkill for one feature. Documenting the deviation puts the engineer (future me, or anyone reviewing) on notice without forcing a structural reorganization. The discipline of *naming the deviation as a principle* is what keeps it from quietly turning into "we have lots of exceptions." There is exactly one. It is documented. That's what makes it not chaos.

## Concept 3 — Deferring hard delete (vacuum)

**Shape.** Three pieces: every delete stamps `deleted_at` (soft delete); reads filter `WHERE deleted_at IS NULL`; the cloud sync propagates tombstones forever, and the local DB never drops them. The "30-day vacuum" — a periodic pass that hard-deletes rows older than 30 days — was specced but isn't built.

**Rule.** Soft delete forever, in practice. The hard-delete vacuum is on the deferred backlog and may stay there indefinitely.

**Failure mode.** The "no deferral, ship vacuum at v1" alternative: the vacuum runs periodically (boot-time? once a day?), hard-deletes tombstones older than 30 days, and the cloud + local agree they're gone. The failure mode is the multi-device case I'm not in yet: device A vacuumed an old row last week, device B hasn't synced for 31 days, device B comes online and *re-sends* the row to the cloud (because device B still has it locally with `deleted_at < 30 days ago` from B's perspective). The cloud gets the row back. Device A's next pull undoes the vacuum. Without per-row authoritative tombstones in a separate "vacuum log," the architecture can't safely drop rows from devices that might come back.

**Contrast.** The Notion-era `sync_deletions` table was supposed to be the vacuum log — but Notion's sync semantics didn't support tombstones cleanly, so the table became a hack. With Supabase, soft delete via `deleted_at` is structurally correct; the vacuum is the *next* layer of optimization, not the foundation. The Notion approach got it backwards.

**The judgment.** Not building vacuum is a *positive* decision, not an oversight. The cost of soft delete forever, at solo scale, is bounded — maybe 100 deleted rows per year, maybe 50KB additional storage per year. At 10 years of usage that's a half MB. The cost of a wrong vacuum is data loss across devices. The asymmetry is huge: ship vacuum carelessly and lose data; defer vacuum and pay 50KB/year. So the vacuum is on the backlog with the explicit constraint "do not ship until I have a proven multi-device tombstone protocol." That constraint is what makes the deferral honest rather than negligent. Where I'd revisit: at 100K users, storage cost compounds; the vacuum becomes worth building correctly with a proper tombstone log per user.

## Concept 4 — `user_overridden_type` lock semantics

**Shape.** Three pieces: `todo_meta.user_overridden_type` (boolean, default false), the type-picker UI in `app/todos.tsx` that sets it to true on manual selection, and the LLM classifier path which *checks* the lock before re-classifying.

**Rule.** Once the user manually picks a thinking-mode type for a todo, the LLM classifier never overrides it. The lock is `user_overridden_type = true`; once set, the classifier will not write to that row's `type` field.

**Failure mode.** The "always classify" alternative: the classifier runs on every catch-up pass and updates `type` based on its current confidence, regardless of past user actions. The failure mode: a user manually picks `decision` for a todo because *they* know the context ("this is the decision I'm making about the apartment lease"). The classifier sees only the text "Renew lease" and picks `todo`. The next boot's catch-up overwrites the user's `decision` with `todo`. The user's intent is silently lost. The lock fixes this — once they overrode, the LLM is permanently out of that row's classification.

**Contrast.** Other AI-touched fields don't have an equivalent lock. `todo_meta.expanded_md` is freely re-generated; the user doesn't override it manually. `ai_summaries.summary_json` is a wholesale re-compose; the user doesn't edit individual fields. The constraint that distinguishes: classification is *categorical* (one right answer per todo from the user's perspective); expansion and summary are *generative* (the AI's output is a draft, not a fact). User override is meaningful only for categorical decisions where the user has independent ground truth.

**The judgment.** The lock semantic is the kind of decision that's invisible if you get it right and very loud if you get it wrong. The "always classify" version would have the user discovering their type changes mysteriously every few days; they'd lose trust in the system fast. The lock is the cost of "we're using AI but the user is still the final arbiter." Where I'd revisit: the lock could become a *soft* lock at scale — display a UI hint when the classifier disagrees with a user override ("the model thinks this is `idea`, you marked it `decision` — keep your choice?"), allowing the user to revisit if they were wrong. Today's hard lock is the right v1.

## Concept 5 — Single hardcoded `PHASE_A_USER_ID`

**Shape.** Three pieces: the constant `PHASE_A_USER_ID` in `src/services/sync/client.ts`, every cloud `localToCloud` mapper sets `user_id: PHASE_A_USER_ID`, and Supabase RLS is scaffolded but disabled (`supabase/migrations/0002_rls.sql`).

**Rule.** Phase A is single-user. The user_id is a constant. Auth doesn't exist on the device. RLS is disabled.

**Failure mode.** The "ship auth from day one" alternative: integrate Supabase Auth, sign-in screen, JWT in every request, RLS enforced. The failure mode: weeks of work building auth UX that has zero users, every new feature has to reason about auth state, every cloud-sync test has to manage a token lifecycle. The complexity tax on every feature in Phase A is real — and I'd be paying it for a single-user app where I am the only person using the cloud. The risk hedge is the schema-level `(user_id, id)` PK, which means the schema is *ready for* multi-user even though the runtime isn't enforcing it.

**Contrast.** A typical SaaS would ship auth in week one because *the product* is multi-user. buffr is *not* multi-user — it's a private journaling app where the cloud is a personal backup. The constraint that distinguishes: whether other users' data is in the same logical store. SaaS yes; buffr no, today.

**The judgment.** Phase A's hardcoded user_id is a *deferral*, not an oversight. The deferral is honest because the schema is structured for the eventual multi-user version: composite PKs, RLS scaffolded, sync layer parameterized by user_id (just plumbed with a constant today). Switching to real auth is "remove the constant, plumb auth.uid() through the mappers, enable RLS, add sign-in." That's two days of work, not two weeks. The gap is bounded and known. Where I'd revisit: shipping a public version means flipping this on day one of public launch — there's no scenario where the public version stays Phase A.

## Three interview questions

### `[mid]` — "Pick a decision in this codebase that wasn't obvious. Walk me through the alternatives you considered."

The 4-variant tonal caption pipeline (commit `152071f`) is a good one. The alternatives I considered: (a) one LLM call emitting a single caption, (b) four separate LLM calls each generating one variant, (c) one call with all four variants in the response. I shipped (c).

(a) was the v0 — one caption. The user would read it and either ship it or compose by hand. The friction: the "compose by hand" rate was higher than I wanted because the model's single voice didn't always match the day. Some days called for terse axioms; others called for reflective long-form. One caption couldn't cover both.

(b) was the obvious extension — four prompts, four calls, get four voices. The cost was 4× API calls and 4× latency, plus the four versions might disagree on what the day was about. Each call would *independently* select a topic from the raw log; if the log had three topics, four calls might pick three different topics across the four variants. The user would see four captions about subtly different days, which feels broken.

(c) is what shipped — one prompt, one call, all four variants in JSON. The model picks the topic *once*, then re-voices it four ways. The user sees four captions that all describe the same day in different tones. Latency: 1× (slightly higher per-call max_tokens but one round trip). Cost: ~1× because the prompt is shared. The tradeoff: the system prompt is ~100 lines instead of 25, and prompt-engineering is harder because it has to specify four voices precisely. Worth it for the single-topic guarantee.

The judgment that mattered: noticing that "different voices for the same day" is fundamentally one task, not four — the voicing is a render of a single decision. That's the architectural framing that made (c) the right answer.

### `[senior]` — "Tell me about a time you reversed a decision. Why did you reverse it?"

The Notion sync layer (deleted in commit `dc8483a`). I shipped Notion sync first — the idea was that the cloud mirror would be Notion (the user already uses it, free for personal use, has a decent API). I built `services/notion/` — `api.ts`, `config.ts`, `mapper.ts`, `sync.ts`, `todosMapper.ts` — about 1,500 lines.

The reversal happened over six weeks, in three stages. Stage 1: I noticed the Notion API's rate limits were tight (3 requests per second per integration) and the per-request latency was 200-400ms. A boot-time pull of 30 days of journal data was 8 seconds of network time. That's slow but not fatal. Stage 2: I tried to ship soft-delete via Notion. Notion has `archived: true`, which felt like a fit, but Notion's sync semantics don't surface archived rows in normal queries — they're invisible. I'd have to query archived rows separately, which doubled the boot-time pull cost. Worse, an archived-then-restored row had no clean signal — Notion didn't expose "restored at" timestamps. The conflict resolution semantics were genuinely wrong. Stage 3 (the breaking point): I needed bulk operations. The user adds a habit; the cloud needs to know about every entry's habit log update. Notion's API doesn't have a bulk upsert; I had to chain individual requests. At 30 days × 5 habits = 150 individual API calls per habit-add. Unworkable.

The reversal: ship Supabase as a direct mirror (M0-M7, eight commits over four weeks). The Postgres model has clean tombstones (just a `deleted_at` column), proper bulk upsert (Supabase's `upsert` with `onConflict`), high rate limits, and a real conflict-resolution primitive (`updated_at` last-write-wins). Everything Notion couldn't give me cleanly, Postgres gives me by default.

The lesson: the Notion decision was an *availability heuristic* — "the user already has Notion, so Notion is the default." That's not an architectural reason; it's a marketing one. The actual question is "what's the right primitive for sync semantics," and the answer is "a relational DB with clean conflict resolution," not "an API on top of an opinionated document store." I should've asked the architectural question first; I asked it after building.

What I'd do differently: spend two days writing a "what does the sync engine actually need from its backend" doc *before* picking the backend. Bullet list: bulk upsert, soft-delete with tombstones queryable, bounded latency, server-time RPC, append-only migrations. Six bullets. Notion fails three; Supabase passes all six. The doc would have surfaced this in two days instead of six weeks.

### `[arch]` — "Pick the most expensive architectural decision you'd revisit at 10× scale."

The "AI keys live in `expo-secure-store` on each device" model. At solo scale this is correct — the user holds their own key, pays their own bill, has zero cost from me. At 10× scale (1K active users) the friction of "you must provide an API key" cuts the conversion rate by maybe 80%. Most users don't have an Anthropic key, don't want to get one, and don't trust putting it in someone else's app even if it's stored on-device. The model is correct for the technical bar I optimized for; it's wrong for the product bar at scale.

The architectural revision: keys move to a server. The server holds my Anthropic / OpenAI key, proxies prompts on behalf of the user, and bills me. The user just signs in (free tier: limited compose / month, paid tier: unlimited). The proxy is a Supabase Edge Function in front of the AI providers. The architecture grows: an authn layer (Supabase Auth — already scaffolded), a per-user usage ledger (probably a `ai_usage` table), and the device's `services/ai/` files swap their direct API calls for calls to my Edge Function endpoint.

The cost of the revision: at $0.01 average per compose × 30 composes / month per active user × 1K users, that's $300/month of AI spend. Manageable. But the budget gate has to be load-bearing — if the free tier doesn't enforce, the worst case is 1K users × 1000 composes = $10K of unbudgeted spend in a bad month. So the proxy needs strict per-user rate limits, not advisory ones.

What I'd keep: the provider switch (Anthropic vs OpenAI) at the service-layer abstraction. That stays valuable at every scale — strategic insurance against single-vendor pricing changes. The on-device structured-summary validator stays — moving validation to the server doesn't help, the device still has to render the result. The 4-variant caption pipeline stays — it's a single API call structurally, doesn't change.

What I'd revisit *as part of* this revision but not standalone: the prompt-caching optimization. With keys on the server, I have control over prompt-cache markers in the system prompt. The structured-summary system prompt is ~80 lines, identical across every call — cacheable. Adding `cache_control: { type: 'ephemeral' }` markers cuts per-call cost by ~50% after the first call in a 5-minute window. At 1K users this is meaningful spend reduction; at solo scale it's pennies. The reason it isn't done now is that the cost isn't worth the prompt-engineering attention. At scale it'd flip.

## The hard question — "Tell me about a decision you got wrong, and how you noticed."

The dashboard's `HabitHeatmapRow` and the streaks math (deleted in commit `c9f7d38`). I shipped a dense calendar heatmap on the dashboard that visualized habit completion across 90 days, with a streaks counter. It looked great in screenshots. It was wrong for the product.

How I noticed: I stopped looking at it. After two weeks of having it on my dashboard, I realized I never actually consulted it. The information was there but not actionable — I couldn't change the past, and the streak counter created a perverse incentive (don't break the streak, even if today is genuinely an off-day). When I checked my own usage telemetry (just `console.log` events, since I don't have real telemetry), I had glanced at the heatmap maybe 10 times in 14 days. It was decoration, not a tool.

The decision to delete: the dashboard is a focus surface, not an analytics surface. The point is "what should I do today" — open todos, today's habits, today's threads, the AI summary preview. A 90-day heatmap is asking the user to reflect on the past at the moment they should be acting on the present. The streaks counter is worse — it pressures consistency over honesty.

The deletion happened in commit `c9f7d38`. The component file got removed; the streaks math (`computeStreak`, `getStreakStats`) became orphaned and was deleted with it. The dashboard's vertical real estate freed up; it now shows the weekly schedule grid (more actionable — *today's column* is highlighted) instead of the 90-day backlog.

What I learned. First, the bias toward "more visualization is better." A dashboard that shows everything teaches the user nothing; a dashboard that shows what matters teaches them what matters. Second, the trap of streak metrics. Streaks reward continuity over accuracy — a user who skips a workout for a legitimate reason (injury, travel) still feels the loss of the streak as a failure. The product becomes adversarial to its user's actual life. Third, the cost of delete is low when the discipline of soft-launch is high. The heatmap was on the dashboard for two weeks, in only my hands; deleting it cost nothing. Had it been in production for 1K users for six months, deleting it would be a data-migration concern (cached heatmap views, user expectation, etc.).

What I'd do differently: ship the heatmap and the streaks counter as a *separate screen* (`/insights` or similar) from day one. Optional, opt-in, surfaced if the user asks for analytics. Not on the dashboard. The mistake wasn't building it; the mistake was placing it where it crowded out the focus surface. When I revisit analytics for buffr, that's where it'll live.
