# Chapter 10 — What I'd do differently

A retrospective is only useful if it's honest about which decisions were wrong, which were defensibly-imperfect, and which I'd leave alone. Pretending everything was right makes the retrospective fiction. Pretending I'd redo everything makes it self-flagellation. Both are useless.

I'm going to split this into three lists. Things I'd change immediately if rewriting today. Things I'd revisit at scale but not before. Things I'd leave alone — including some that look wrong but aren't.

## Things I'd change immediately if rewriting today

### 1. Pick Supabase from day one. Skip the Notion sync layer.

I spent six weeks building Notion sync (`services/notion/api.ts`, `mapper.ts`, `sync.ts`, `todosMapper.ts` — about 1,500 lines, all deleted in commit `dc8483a`). The motivation was "the user already uses Notion." The actual cost: rate limits, no bulk upsert, archived-rows-invisible-to-default-queries, no clean tombstone semantic. Six weeks of work, deleted.

What I should have done: spent two days writing "what does the sync engine actually need from its backend" before picking the backend. The list is six bullets — bulk upsert, soft-delete with queryable tombstones, bounded latency, server-time RPC, append-only migrations, conflict resolution by timestamp. Postgres passes all six; Notion fails three. Two days of architectural diligence would have saved six weeks of building-then-deleting.

The lesson generalizes: when picking a foundational dependency (DB, auth, AI provider), write the requirements list first. The decision becomes mechanical. The painful decisions are the ones where you didn't enumerate the requirements — you just liked the option's marketing.

### 2. Add Vitest with a fixture suite for the pure functions, week one.

There's no test suite. The pure functions in `services/` are the riskiest code in the codebase — `scanTodosFromText` (two-pass matching with subtle edge cases), `chooseWinner` (last-write-wins with tie-break), `cellStateFor` (cadence math), `computeStaleness` (date arithmetic), the validators in `services/ai/validate.ts` (LLM output gate). Each one has 5-10 edge cases I've manually walked. None are codified.

The cost of adding Vitest at week one is small — runner setup, a `tests/` directory, write 30 fixtures across the five functions, gate commits on green. Maybe three days. The benefit accumulates: every refactor afterward has a safety net, every model bump's effect on the validator is visible, every onboarding engineer has a runnable spec for the scanner's behavior.

The reason I didn't is reasonable but not great: at week one I was building the prototype and didn't know which functions would survive. By the time I knew, I had momentum and the cost-of-adding-now was higher than the marginal cost-of-not-having. Classic technical debt accumulation. The right answer is "add the test runner before the first non-trivial pure function exists, even if you only have one fixture."

### 3. Use `FlatList` with virtualization on `/todos` instead of `ScrollView`.

`app/todos.tsx` renders all matching rows inside a `<ScrollView>`. At today's row counts (couple hundred for me), that's fine. At 5K rows it's not. I'd write `FlatList` from day one. The cost is the same; the failure mode is different. `ScrollView` works at small scale and silently degrades at large scale. `FlatList` works at all scales.

This is a "default to virtualized lists in React Native" rule that I should have applied from day one. The reason I didn't: the `ScrollView` was simpler in the prototype (no `keyExtractor`, no `renderItem` prop function). The simplification cost me a future migration. `FlatList` from the start would have been roughly the same code volume and avoided the future cleanup.

## Things I'd revisit at scale but not before

### 4. Move AI keys server-side.

Today's "user holds their own Anthropic key in `expo-secure-store`" is correct for solo / power-user / private-beta scale. At public scale (1K+ users) the conversion friction is fatal — most users don't have a key, don't want to get one, don't trust putting it in a third-party app. The architectural revision: keys move to a Supabase Edge Function or dedicated proxy, my account pays, per-user budgets enforce.

I'd revisit this *only if* the app went public. Until then, the on-device-key model is genuinely better — zero AI cost to me, full privacy for the user, no auth UX to build. The cost-vs-benefit only flips at public scale, which is a deliberate scope decision rather than a deferred problem.

What I'd build alongside the migration: prompt caching markers in the system prompts (Anthropic's `cache_control: ephemeral`) to halve the per-call cost in 5-minute windows, per-user usage ledgers, soft rate limiting with exponential backoff. Each of these is an additional 1-2 days of work, all justified by the per-user spend at scale, none justified at solo.

### 5. Build the 30-day vacuum (hard delete) properly.

Soft delete via `deleted_at` is the correct primitive. The vacuum that turns 30-day-old tombstones into hard deletes is *additionally* correct, but only with a proven multi-device tombstone protocol. I haven't built that protocol because I have one device and one user.

At multi-device scale (the user has buffr on both phone and tablet, or with collaboration, multiple users), the vacuum needs: per-user vacuum logs with high-water-mark timestamps, vacuum-aware sync where pulling a row that the cloud has hard-deleted plus locally still has triggers a local hard-delete (not a re-push), clock-skew-tolerant tombstone TTLs (probably server-time-anchored). This is genuinely hard distributed-systems work. I'd revisit it when the per-user storage cost compounds enough to justify the engineering.

What I'd resist: shipping a naive vacuum that "looks right" at solo scale. The failure mode of "naive vacuum on a device that hasn't synced for 31 days" is data loss across devices, which is the worst-class error a data-management app can have. Soft-delete-forever is genuinely fine until storage growth is a problem.

### 6. Add a CRDT layer on `entries.text` for collaborative editing.

`chooseWinner` is last-write-wins by `updated_at`. For solo cross-device (phone + tablet, same user), this is fine — same user means edits are temporally separated, ties are rare, and on the rare same-second tie the loss is minutes of one device's recent typing, recoverable from memory. For collaborative editing (two users on the same entry), last-write-wins on prose is *wrong* — one user's words disappear because the other user's edit was 200ms later.

The fix is a CRDT (Yjs is what I'd use). The schema gains an `entries.text_crdt` binary column carrying the doc state; the scanner runs on the materialized text; the sync protocol upserts CRDT deltas instead of full text. This is real engineering — maybe 2-4 weeks for a clean implementation. Worth it only if the product becomes collaborative.

The reason I'd defer until then: CRDTs add complexity to every part of the stack — the device's edit path, the sync protocol, the merge logic, the recovery story. None of that complexity buys anything for a single-user app. Premature CRDT adoption is a real anti-pattern; I've seen teams build Yjs into solo apps and pay the complexity tax forever for a feature they never used.

## Things I'd leave alone

### 7. The "no global store, re-query on focus" pattern.

The pattern looks suspicious to engineers from web/SPA backgrounds — no Redux, no Zustand, no React Query, no QueryClient, no Context provider. Every screen owns its state. The dashboard re-queries on focus.

I'd leave it alone. It's correct for this app. Adding a global store solves problems I don't have (cross-screen state synchronization, optimistic updates with rollback, background refetch with stale-while-revalidate). It introduces bugs I don't want (subscription desync, mutation timing races, state-vs-DB drift). The "DB is the cache" model is genuinely simpler and genuinely correct here. At 100K users the math doesn't change — SQLite is still ms-not-seconds, focus events are still the right refetch trigger, screens still don't share mutable state.

The category I'd push back on: engineers who default to "we should add Redux" without articulating which specific bug Redux solves for the codebase in question. Redux is the right answer to a specific class of problems; it isn't a default.

### 8. The single `database.ts` file.

`src/services/database.ts` is 700+ lines with every SQL CRUD function in one file. It violates "small files" aesthetics. I'd leave it alone.

The reason: the file is the *single write site* for SQLite. Every write goes through it. Every read with `WHERE deleted_at IS NULL` lives there. Every `schedulePush()` call lives there. Splitting it by table (`entries.ts`, `todoMeta.ts`, etc.) loses the visual coherence — when I'm debugging a missed `schedulePush` call, I want every write site visible in one buffer, not fragmented across 12 files.

The aesthetic cost (long file) is small. The structural benefit (single source of CRUD truth) is large. Files with high cohesion and clear responsibility should be allowed to grow. The file-size aesthetic is a cargo cult when applied to coordination points.

### 9. The 4-variant caption pipeline.

Two LLM calls per compose (structured summary + 4-variant caption) costs ~2× the API spend of a single combined call. I'd leave it alone. The separation gives both halves a clean prompt, lets caption failure not fail summarize, and gives the caption call its own validator + fallback chain. The cost is bounded ($0.005 extra per compose) and the architectural cleanliness is high.

The case for collapsing them: prompt-engineering wonks who want every call to be a single super-prompt for cache efficiency. The argument has merit at very high scale where prompt caching dominates cost — but at that scale I'd cache *both* prompts independently, which preserves the separation. There's no scale at which collapsing them produces a strictly-better outcome.

### 10. The hardcoded `PHASE_A_USER_ID` constant.

It looks like a bug — a hardcoded user ID in production code. It isn't. It's a deliberate Phase A simplification with a clear migration path: replace the constant with `auth.uid()` from a Supabase session, enable RLS, plumb auth through the AI key prompts. Two days of work. The schema is structurally ready (composite `(user_id, id)` PKs everywhere).

Leaving it alone in Phase A is the right call because building auth UX before there are users to authenticate is busywork. The cost is one constant that needs replacing later. The benefit is weeks of feature velocity now. Sometimes the right architectural decision is "add the constant, defer the abstraction, document the migration path."

## The hard question — "If you could only fix one thing in this codebase right now, what would it be?"

Add a real test suite for the pure functions. Vitest, fixture-based, gating commits.

Why this one. Every other gap I've named — observability, vacuum, CRDTs, server-side keys — has either (a) a known migration path that activates at a specific scale trigger, or (b) a deliberate scope decision that's correct at current scale. The test suite has *neither*. It's a gap that hurts every change I make today, every refactor, every model bump. The marginal cost of every change is higher than it should be because I have to manually verify behavior that a fixture would catch in 50ms.

The cascade of benefits: with a test suite, I can refactor `database.ts` confidently. I can bump Claude models confidently. I can simplify `scanTodosFromText` without fear. I can onboard a second engineer with a runnable spec instead of a 500-line architecture doc. The leverage is enormous because the friction is everywhere.

The cost is bounded and small: three days to set up Vitest + write 30 fixtures across the five highest-risk pure functions (scanner, conflict resolver, cell-state, staleness, validators). Each fixture is 10-15 lines. The runner is `npm test`. Gate the merge on green.

The reason I haven't built it yet is the reason most people don't build their tests until late: each individual day's work feels more important. The lesson is to not let that math compound — write the test infrastructure when it's cheap, before the codebase makes it expensive. I didn't, and that's the gap that costs me most. Today I'd close it.
